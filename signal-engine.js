/**
 * signal-engine.js — v10.96 Real Signal Generation
 *
 * Turns canonical live stats into stable, bounded model inputs and watch-only
 * live football signals. This module does not place bets and does not calculate stake.
 */
'use strict';

function num(v, fallback = null) {
  if (v == null || v === '' || v === '-') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, min = 0, max = 100) {
  const n = num(v, min);
  return Math.max(min, Math.min(max, n));
}

function round(v, dp = 2) {
  if (v == null || !Number.isFinite(Number(v))) return null;
  return Number(Number(v).toFixed(dp));
}

function per90(value, minute) {
  const m = clamp(num(minute, 1), 1, 120);
  const v = Math.max(0, num(value, 0));
  return v * 90 / m;
}

function splitTeamTotal(total, homeSharePct) {
  const t = num(total, null);
  const h = num(homeSharePct, null);
  if (t == null || h == null) return { home: null, away: null };
  const home = t * clamp(h, 0, 100) / 100;
  return { home, away: t - home };
}

function estimateXGProxy(stats) {
  const shots = Math.max(0, num(stats.shots_total, 0));
  const sot   = Math.max(0, num(stats.shots_on_target, 0));
  const corners = Math.max(0, num(stats.corners, 0));

  // Conservative xG-like proxy, not true xG:
  // SOT has biggest signal, total shots adds volume, corners add smaller pressure.
  const raw = sot * 0.32 + Math.max(0, shots - sot) * 0.055 + corners * 0.035;
  return clamp(raw, 0, 5);
}

function computeDataReliability(stats, minute) {
  let score = 0;
  const reasons = [];

  if (num(stats.shots_total) != null)      score += 28; else reasons.push('missing_shots_total');
  if (num(stats.shots_on_target) != null)  score += 25; else reasons.push('missing_shots_on_target');
  if (num(stats.corners) != null)          score += 14; else reasons.push('missing_corners');
  if (num(stats.possession_home) != null && num(stats.possession_away) != null) score += 18; else reasons.push('missing_possession');
  if (num(stats.yellow_cards) != null || num(stats.red_cards) != null) score += 5; else reasons.push('missing_cards');
  if (num(minute) != null) score += 10; else reasons.push('missing_minute');

  return { score: clamp(score, 0, 100), reasons };
}

function computeRealStatsSignals(match) {
  const stats = match && match.stats ? match.stats : {};
  const minute = clamp(num(match.minute, 45), 1, 120);
  const homeScore = num(match.match_hometeam_score, 0);
  const awayScore = num(match.match_awayteam_score, 0);
  const scoreDiff = homeScore - awayScore;

  const shots = Math.max(0, num(stats.shots_total, 0));
  const sot = Math.max(0, num(stats.shots_on_target, 0));
  const corners = Math.max(0, num(stats.corners, 0));
  const possHome = num(stats.possession_home, null);
  const possAway = num(stats.possession_away, possHome != null ? 100 - possHome : null);
  const cards = Math.max(0, num(stats.yellow_cards, 0)) + Math.max(0, num(stats.red_cards, 0)) * 2;

  const shotsPer90 = per90(shots, minute);
  const sotPer90 = per90(sot, minute);
  const cornersPer90 = per90(corners, minute);

  // 0..100 tempo based on event volume per 90.
  const tempoScore = clamp(
    shotsPer90 * 3.0 + sotPer90 * 7.0 + cornersPer90 * 2.3,
    0,
    100
  );

  // 0..100 pressure based on shot quality/volume + corners + possession imbalance.
  const possessionImbalance = possHome == null ? 0 : Math.abs(possHome - 50) * 0.65;
  const pressureScore = clamp(
    sotPer90 * 8.0 + shotsPer90 * 2.2 + cornersPer90 * 2.8 + possessionImbalance - cards * 0.4,
    0,
    100
  );

  // Directional dominance: -100 away dominant, +100 home dominant.
  const shotSplit = splitTeamTotal(shots, possHome);
  const sotSplit = splitTeamTotal(sot, possHome);
  const cornerSplit = splitTeamTotal(corners, possHome);
  const dominanceRaw =
    (possHome == null ? 0 : (possHome - 50) * 1.0) +
    ((shotSplit.home ?? 0) - (shotSplit.away ?? 0)) * 2.2 +
    ((sotSplit.home ?? 0) - (sotSplit.away ?? 0)) * 5.0 +
    ((cornerSplit.home ?? 0) - (cornerSplit.away ?? 0)) * 1.8 +
    scoreDiff * 7;
  const dominanceScore = clamp(dominanceRaw, -100, 100);

  // Momentum proxy: since we do not have event timeline yet, use current pressure + dominance.
  const momentumScore = clamp((pressureScore - 50) * 0.65 + dominanceScore * 0.35, -100, 100);

  const xgProxy = estimateXGProxy(stats);
  const reliability = computeDataReliability(stats, minute);

  // Confidence ceiling based on data availability.
  const confidenceCeiling = reliability.score < 40 ? 68 : reliability.score < 60 ? 78 : reliability.score < 80 ? 86 : 92;

  // Transition readiness: does this match contain enough action to be watched by the frontend?
  const transitionReadiness = clamp(
    pressureScore * 0.42 + tempoScore * 0.34 + Math.min(100, xgProxy * 22) * 0.24,
    0,
    confidenceCeiling
  );

  const qualityBucket = reliability.score >= 80 ? 'strong' : reliability.score >= 60 ? 'usable' : reliability.score >= 40 ? 'thin' : 'weak';

  return {
    version: '10.96-real-signal-generation',
    isRealStatsDerived: !!match?.hasStats,
    dataReliabilityScore: round(reliability.score, 1),
    dataReliabilityBucket: qualityBucket,
    missingInputs: reliability.reasons,
    pressureScore: round(pressureScore, 1),
    tempoScore: round(tempoScore, 1),
    dominanceScore: round(dominanceScore, 1),
    momentumScore: round(momentumScore, 1),
    xgProxy: round(xgProxy, 3),
    shotsPer90: round(shotsPer90, 2),
    shotsOnTargetPer90: round(sotPer90, 2),
    cornersPer90: round(cornersPer90, 2),
    confidenceCeiling,
    transitionReadiness: round(transitionReadiness, 1),
    modelNotes: match?.hasStats ? ['real_stats_active'] : ['no_real_stats'],
  };
}

function signal(id, market, label, confidence, reasons, extra = {}) {
  return {
    id,
    market,
    label,
    confidence: round(clamp(confidence, 0, 100), 1),
    action: extra.action || 'WATCH',
    severity: extra.severity || (confidence >= 82 ? 'high' : confidence >= 68 ? 'medium' : 'low'),
    reasons,
    ...extra,
  };
}

function generateRealSignals(match) {
  const d = match.derived || computeRealStatsSignals(match);
  const stats = match.stats || {};
  const minute = clamp(num(match.minute, 0), 0, 130);
  const homeGoals = num(match.match_hometeam_score, 0);
  const awayGoals = num(match.match_awayteam_score, 0);
  const totalGoals = homeGoals + awayGoals;
  const scoreDiff = Math.abs(homeGoals - awayGoals);
  const signals = [];

  const pressure = num(d.pressureScore, 0);
  const tempo = num(d.tempoScore, 0);
  const readiness = num(d.transitionReadiness, 0);
  const xgProxy = num(d.xgProxy, 0);
  const sotPer90 = num(d.shotsOnTargetPer90, 0);
  const cornersPer90 = num(d.cornersPer90, 0);
  const reliability = num(d.dataReliabilityScore, 0);

  const hasGoodData = match.hasStats && reliability >= 70;
  if (!hasGoodData) {
    return {
      signals: [],
      topSignal: null,
      signalCount: 0,
      actionabilityScore: 0,
      signalMode: 'NO_REAL_STATS_SIGNAL',
      signalBlockReasons: d.missingInputs || [],
    };
  }

  // Goal-pressure signal: high real pressure + tempo; strongest between 25' and 85'.
  if (minute >= 20 && minute <= 88 && pressure >= 72 && tempo >= 68 && xgProxy >= 1.05) {
    const conf = readiness * 0.48 + pressure * 0.27 + tempo * 0.15 + Math.min(100, xgProxy * 26) * 0.10;
    signals.push(signal('GOAL_PRESSURE_SIGNAL', 'goals', 'Goal pressure building', conf, [
      `pressure=${round(pressure,1)}`,
      `tempo=${round(tempo,1)}`,
      `xgProxy=${round(xgProxy,2)}`,
      `SOT/90=${round(sotPer90,2)}`,
    ], { scenario: 'goal_pressure', recommendedPanel: conf >= 78 ? 'ACTIONABLE_WATCH' : 'WATCH' }));
  }

  // Late goal watch: late minutes + strong pressure, useful for over/next goal monitoring.
  if (minute >= 60 && minute <= 88 && pressure >= 70 && (tempo >= 65 || sotPer90 >= 4.2)) {
    const conf = pressure * 0.42 + tempo * 0.24 + sotPer90 * 3.2 + Math.min(12, cornersPer90);
    signals.push(signal('LATE_GOAL_ALERT', 'goals', 'Late goal alert', conf, [
      `minute=${minute}`,
      `pressure=${round(pressure,1)}`,
      `SOT/90=${round(sotPer90,2)}`,
      `corners/90=${round(cornersPer90,2)}`,
    ], { scenario: 'late_goal', recommendedPanel: 'WATCH' }));
  }

  // Over 1.5 / Over 2.5 style watch signals. These remain signal-only; odds edge is not computed here.
  if (minute >= 35 && minute <= 80 && totalGoals < 2 && readiness >= 68 && xgProxy >= 1.15) {
    const conf = readiness * 0.52 + pressure * 0.22 + tempo * 0.16 + Math.min(100, xgProxy * 25) * 0.10;
    signals.push(signal('OVER_15_WATCH', 'goals', 'Over 1.5 watch', conf, [
      `goals=${totalGoals}`,
      `readiness=${round(readiness,1)}`,
      `xgProxy=${round(xgProxy,2)}`,
    ], { line: 'over_15', scenario: 'over15_watch', recommendedPanel: 'WATCH' }));
  }

  if (minute >= 55 && minute <= 84 && totalGoals < 3 && readiness >= 75 && xgProxy >= 1.65) {
    const conf = readiness * 0.50 + pressure * 0.24 + tempo * 0.16 + Math.min(100, xgProxy * 22) * 0.10;
    signals.push(signal('OVER_25_WATCH', 'goals', 'Over 2.5 watch', conf, [
      `goals=${totalGoals}`,
      `readiness=${round(readiness,1)}`,
      `xgProxy=${round(xgProxy,2)}`,
    ], { line: 'over_25', scenario: 'over25_watch', recommendedPanel: 'WATCH' }));
  }

  // Result pressure is intentionally conservative; only close-score live matches.
  if (minute >= 55 && scoreDiff <= 1 && Math.abs(num(d.dominanceScore, 0)) >= 28 && pressure >= 65) {
    const side = num(d.dominanceScore, 0) >= 0 ? 'home' : 'away';
    const conf = clamp(Math.abs(num(d.dominanceScore, 0)) * 0.65 + pressure * 0.25 + readiness * 0.10, 0, 86);
    signals.push(signal('RESULT_PRESSURE_WATCH', 'result', 'Result pressure watch', conf, [
      `dominance=${round(d.dominanceScore,1)}`,
      `scoreDiff=${scoreDiff}`,
      `pressure=${round(pressure,1)}`,
    ], { side, scenario: 'result_pressure', recommendedPanel: 'WATCH_ONLY' }));
  }

  // BTTS watch: both teams have scored? Then not useful. Otherwise, high tempo + close score.
  if (minute >= 35 && minute <= 80 && (homeGoals === 0 || awayGoals === 0) && scoreDiff <= 1 && tempo >= 72 && pressure >= 70) {
    const conf = tempo * 0.35 + pressure * 0.30 + readiness * 0.20 + Math.min(100, xgProxy * 22) * 0.15;
    signals.push(signal('BTTS_WATCH', 'goals', 'BTTS watch', conf, [
      `score=${homeGoals}-${awayGoals}`,
      `tempo=${round(tempo,1)}`,
      `pressure=${round(pressure,1)}`,
    ], { line: 'btts_yes', scenario: 'btts_watch', recommendedPanel: 'WATCH' }));
  }

  // Sort by confidence and keep compact output.
  signals.sort((a, b) => b.confidence - a.confidence);
  const top = signals[0] || null;
  const actionabilityScore = top ? clamp(top.confidence * 0.72 + readiness * 0.18 + reliability * 0.10, 0, 100) : 0;

  return {
    signals: signals.slice(0, 5),
    topSignal: top,
    signalCount: signals.length,
    actionabilityScore: round(actionabilityScore, 1),
    signalMode: signals.length ? 'REAL_STATS_SIGNAL' : 'REAL_STATS_NO_TRIGGER',
    signalBlockReasons: signals.length ? [] : ['thresholds_not_met'],
  };
}

module.exports = { computeRealStatsSignals, generateRealSignals };
