/**
 * signal-engine.js — v10.97 Coverage-Balanced Signal Generation
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



function computeGameFlowIntelligence({minute, shots, sot, corners, pressureScore, tempoScore, dominanceScore, xgProxy, totalGoals, scoreDiff, cards}) {
  // Current-stat based intelligence layer. We do not fake event timelines; instead we
  // infer pressure waves from live volume density, match phase, and close-score context.
  const m = clamp(minute, 1, 120);
  const shotDensity = per90(shots, m);
  const sotDensity = per90(sot, m);
  const cornerDensity = per90(corners, m);
  const closeGameBoost = scoreDiff <= 1 ? 10 : scoreDiff === 2 ? 3 : -8;
  const earlyPenalty = m < 12 ? -16 : m < 20 ? -6 : 0;

  const attackClusterScore = clamp(
    sotDensity * 8.5 + cornerDensity * 4.4 + shotDensity * 2.8 + pressureScore * 0.18 + closeGameBoost + earlyPenalty,
    0,
    100
  );

  const pressureWaveScore = clamp(
    pressureScore * 0.42 + tempoScore * 0.28 + attackClusterScore * 0.22 + Math.min(18, xgProxy * 5.5) + closeGameBoost,
    0,
    100
  );

  // Since a true timeline is not always available, momentum acceleration is a bounded
  // proxy for "current phase heating up" from event density + match phase.
  const phaseBoost = (m >= 38 && m <= 45) ? 8 : (m >= 50 && m <= 70) ? 14 : (m >= 71 && m <= 86) ? 10 : 0;
  const momentumAcceleration = clamp(
    (pressureScore - 48) * 0.55 + (tempoScore - 45) * 0.35 + sotDensity * 2.3 + cornerDensity * 1.4 + phaseBoost - cards * 0.8,
    0,
    100
  );

  const secondHalfUnlockScore = (m >= 45 && m <= 72)
    ? clamp(pressureScore * 0.35 + tempoScore * 0.25 + attackClusterScore * 0.22 + Math.min(20, xgProxy * 6) + closeGameBoost, 0, 100)
    : 0;

  const lateDesperationScore = (m >= 70 && m <= 90)
    ? clamp(pressureScore * 0.40 + tempoScore * 0.22 + attackClusterScore * 0.24 + (totalGoals <= 2 ? 8 : 0) + closeGameBoost, 0, 100)
    : 0;

  const intelligenceScore = clamp(
    pressureWaveScore * 0.32 + attackClusterScore * 0.24 + momentumAcceleration * 0.22 + Math.max(secondHalfUnlockScore, lateDesperationScore) * 0.22,
    0,
    100
  );

  let gameFlowLabel = 'neutral';
  if (lateDesperationScore >= 72) gameFlowLabel = 'late_desperation';
  else if (secondHalfUnlockScore >= 72) gameFlowLabel = 'second_half_unlock';
  else if (attackClusterScore >= 72) gameFlowLabel = 'attack_cluster';
  else if (pressureWaveScore >= 68) gameFlowLabel = 'pressure_wave';
  else if (momentumAcceleration >= 65) gameFlowLabel = 'momentum_acceleration';

  return {
    attackClusterScore: round(attackClusterScore, 1),
    pressureWaveScore: round(pressureWaveScore, 1),
    momentumAcceleration: round(momentumAcceleration, 1),
    secondHalfUnlockScore: round(secondHalfUnlockScore, 1),
    lateDesperationScore: round(lateDesperationScore, 1),
    intelligenceScore: round(intelligenceScore, 1),
    gameFlowLabel
  };
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
  const flow = computeGameFlowIntelligence({
    minute, shots, sot, corners, pressureScore, tempoScore, dominanceScore,
    xgProxy, totalGoals: homeScore + awayScore, scoreDiff: Math.abs(scoreDiff), cards
  });

  // Confidence ceiling based on data availability.
  const confidenceCeiling = reliability.score < 40 ? 68 : reliability.score < 60 ? 78 : reliability.score < 80 ? 86 : 92;

  // Transition readiness: does this match contain enough action to be watched by the frontend?
  const transitionReadiness = clamp(
    pressureScore * 0.32 + tempoScore * 0.24 + Math.min(100, xgProxy * 22) * 0.18 + Number(flow.intelligenceScore || 0) * 0.26,
    0,
    confidenceCeiling
  );

  const qualityBucket = reliability.score >= 80 ? 'strong' : reliability.score >= 60 ? 'usable' : reliability.score >= 40 ? 'thin' : 'weak';

  return {
    version: '11.30-intelligence-rebuild',
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
    pressureWaveScore: flow.pressureWaveScore,
    attackClusterScore: flow.attackClusterScore,
    momentumAcceleration: flow.momentumAcceleration,
    secondHalfUnlockScore: flow.secondHalfUnlockScore,
    lateDesperationScore: flow.lateDesperationScore,
    intelligenceScore: flow.intelligenceScore,
    gameFlowLabel: flow.gameFlowLabel,
    modelNotes: match?.hasStats ? ['real_stats_active', flow.gameFlowLabel].filter(Boolean) : ['no_real_stats'],
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


function addMonitorSignalIfUseful(signals, match, d, ctx) {
  const minute = ctx.minute;
  const pressure = ctx.pressure;
  const tempo = ctx.tempo;
  const readiness = ctx.readiness;
  const xgProxy = ctx.xgProxy;
  const sotPer90 = ctx.sotPer90;
  const cornersPer90 = ctx.cornersPer90;
  const intelligence = ctx.intelligence;
  const pressureWave = ctx.pressureWave;
  const attackCluster = ctx.attackCluster;
  const momentumAcceleration = ctx.momentumAcceleration;
  const reliability = ctx.reliability;
  const shots = ctx.shots;
  const sot = ctx.sot;
  const corners = ctx.corners;

  // Only real stats can become a signal-like monitor. Flashscore/basic low-data
  // stays visible only; we do not fabricate betting signals from score/minute alone.
  if (!match || !match.hasStats || reliability < 70) return;
  if (minute < 8 || minute > 88) return;

  const hasEventVolume = (shots + sot + corners) >= 3 || sot >= 1 || corners >= 2;
  if (!hasEventVolume) return;

  // Near-trigger stats: good enough to surface as monitor, not as actionable.
  const nearTrigger = readiness >= 38 || pressure >= 54 || tempo >= 54 || xgProxy >= 0.45 || sotPer90 >= 1.75 || intelligence >= 52 || pressureWave >= 55 || attackCluster >= 55;
  if (!nearTrigger) return;

  const conf = clamp(
    38 + readiness * 0.22 + pressure * 0.15 + tempo * 0.10 + Math.min(16, xgProxy * 5) + Math.min(10, sotPer90 * 1.2) + Math.min(6, cornersPer90 * 0.6),
    48,
    74
  );
  signals.push(signal('ANALYZABLE_MONITOR', 'monitor', 'Analiz izleme adayı', conf, [
    `readiness=${round(readiness,1)}`,
    `pressure=${round(pressure,1)}`,
    `tempo=${round(tempo,1)}`,
    `xgProxy=${round(xgProxy,2)}`,
    `intel=${round(intelligence,1)}`,
  ], {
    scenario: 'real_stats_monitor',
    recommendedPanel: 'MONITOR',
    action: 'MONITOR',
    signalTier: 'monitor_signal',
    qualityNote: 'real_stats_near_trigger_not_actionable'
  }));
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
  const intelligence = num(d.intelligenceScore, 0);
  const pressureWave = num(d.pressureWaveScore, 0);
  const attackCluster = num(d.attackClusterScore, 0);
  const momentumAcceleration = num(d.momentumAcceleration, 0);
  const secondHalfUnlock = num(d.secondHalfUnlockScore, 0);
  const lateDesperation = num(d.lateDesperationScore, 0);
  const reliability = num(d.dataReliabilityScore, 0);
  const shots = Math.max(0, num(stats.shots_total, 0));
  const sotRaw = Math.max(0, num(stats.shots_on_target, 0));
  const cornersRaw = Math.max(0, num(stats.corners, 0));

  const hasGoodData = match.hasStats && reliability >= 55;
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
  if (minute >= 12 && minute <= 88 && ((pressure >= 62 && tempo >= 52 && xgProxy >= 0.55) || intelligence >= 68 || attackCluster >= 72 || pressureWave >= 72)) {
    const conf = readiness * 0.34 + pressure * 0.22 + tempo * 0.12 + Math.min(100, xgProxy * 26) * 0.10 + intelligence * 0.22;
    signals.push(signal('GOAL_PRESSURE_SIGNAL', 'goals', 'Goal pressure building', conf, [
      `pressure=${round(pressure,1)}`,
      `tempo=${round(tempo,1)}`,
      `xgProxy=${round(xgProxy,2)}`,
      `SOT/90=${round(sotPer90,2)}`,
      `intel=${round(intelligence,1)}`,
    ], { scenario: 'goal_pressure', recommendedPanel: conf >= 78 ? 'ACTIONABLE_WATCH' : 'WATCH' }));
  }

  // Late goal watch: late minutes + strong pressure, useful for over/next goal monitoring.
  if (minute >= 50 && minute <= 90 && ((pressure >= 58 && (tempo >= 48 || sotPer90 >= 2.2)) || lateDesperation >= 62 || intelligence >= 66)) {
    const conf = pressure * 0.32 + tempo * 0.18 + sotPer90 * 2.8 + Math.min(12, cornersPer90) + lateDesperation * 0.22 + intelligence * 0.12;
    signals.push(signal('LATE_GOAL_ALERT', 'goals', 'Late goal alert', conf, [
      `minute=${minute}`,
      `pressure=${round(pressure,1)}`,
      `SOT/90=${round(sotPer90,2)}`,
      `corners/90=${round(cornersPer90,2)}`,
    ], { scenario: 'late_goal', recommendedPanel: 'WATCH' }));
  }


  // Intelligence layer: these are not fake betting picks; they surface real game-flow patterns
  // from stats-backed matches so the product does not go blind when classical thresholds miss.
  if (minute >= 18 && minute <= 82 && attackCluster >= 70 && pressure >= 55) {
    const conf = clamp(attackCluster * 0.40 + pressureWave * 0.25 + readiness * 0.20 + intelligence * 0.15, 0, 90);
    signals.push(signal('ATTACK_CLUSTER_WATCH', 'goals', 'Attack cluster forming', conf, [
      `cluster=${round(attackCluster,1)}`,
      `pressureWave=${round(pressureWave,1)}`,
      `SOT/90=${round(sotPer90,2)}`,
    ], { scenario: 'attack_cluster', recommendedPanel: conf >= 78 ? 'ACTIONABLE_WATCH' : 'WATCH', signalTier: conf >= 78 ? 'strong_signal' : 'monitor_signal' }));
  }

  if (minute >= 45 && minute <= 72 && secondHalfUnlock >= 66 && scoreDiff <= 1) {
    const conf = clamp(secondHalfUnlock * 0.42 + pressure * 0.18 + tempo * 0.16 + readiness * 0.14 + intelligence * 0.10, 0, 91);
    signals.push(signal('SECOND_HALF_UNLOCK', 'goals', 'Second-half unlock pressure', conf, [
      `unlock=${round(secondHalfUnlock,1)}`,
      `score=${homeGoals}-${awayGoals}`,
      `intel=${round(intelligence,1)}`,
    ], { scenario: 'second_half_unlock', recommendedPanel: conf >= 76 ? 'ACTIONABLE_WATCH' : 'WATCH', signalTier: conf >= 76 ? 'strong_signal' : 'monitor_signal' }));
  }

  if (minute >= 70 && minute <= 90 && lateDesperation >= 68) {
    const conf = clamp(lateDesperation * 0.44 + pressure * 0.18 + attackCluster * 0.18 + readiness * 0.12 + intelligence * 0.08, 0, 92);
    signals.push(signal('LATE_DESPERATION_WAVE', 'goals', 'Late desperation wave', conf, [
      `late=${round(lateDesperation,1)}`,
      `pressure=${round(pressure,1)}`,
      `cluster=${round(attackCluster,1)}`,
    ], { scenario: 'late_desperation_wave', recommendedPanel: 'WATCH', signalTier: conf >= 80 ? 'strong_signal' : 'monitor_signal' }));
  }

  // Over 1.5 / Over 2.5 style watch signals. These remain signal-only; odds edge is not computed here.
  if (minute >= 25 && minute <= 82 && totalGoals < 2 && ((readiness >= 50 && xgProxy >= 0.58) || intelligence >= 68 || pressureWave >= 70)) {
    const conf = readiness * 0.52 + pressure * 0.22 + tempo * 0.16 + Math.min(100, xgProxy * 25) * 0.10;
    signals.push(signal('OVER_15_WATCH', 'goals', 'Over 1.5 watch', conf, [
      `goals=${totalGoals}`,
      `readiness=${round(readiness,1)}`,
      `xgProxy=${round(xgProxy,2)}`,
    ], { line: 'over_15', scenario: 'over15_watch', recommendedPanel: 'WATCH' }));
  }

  if (minute >= 48 && minute <= 84 && totalGoals < 3 && ((readiness >= 58 && xgProxy >= 0.9) || lateDesperation >= 72 || intelligence >= 74)) {
    const conf = readiness * 0.50 + pressure * 0.24 + tempo * 0.16 + Math.min(100, xgProxy * 22) * 0.10;
    signals.push(signal('OVER_25_WATCH', 'goals', 'Over 2.5 watch', conf, [
      `goals=${totalGoals}`,
      `readiness=${round(readiness,1)}`,
      `xgProxy=${round(xgProxy,2)}`,
    ], { line: 'over_25', scenario: 'over25_watch', recommendedPanel: 'WATCH' }));
  }

  // Result pressure is intentionally conservative; only close-score live matches.
  if (minute >= 52 && scoreDiff <= 1 && Math.abs(num(d.dominanceScore, 0)) >= 22 && (pressure >= 62 || intelligence >= 70)) {
    const side = num(d.dominanceScore, 0) >= 0 ? 'home' : 'away';
    const conf = clamp(Math.abs(num(d.dominanceScore, 0)) * 0.65 + pressure * 0.25 + readiness * 0.10, 0, 86);
    signals.push(signal('RESULT_PRESSURE_WATCH', 'result', 'Result pressure watch', conf, [
      `dominance=${round(d.dominanceScore,1)}`,
      `scoreDiff=${scoreDiff}`,
      `pressure=${round(pressure,1)}`,
    ], { side, scenario: 'result_pressure', recommendedPanel: 'WATCH_ONLY' }));
  }

  // BTTS watch: both teams have scored? Then not useful. Otherwise, high tempo + close score.
  if (minute >= 30 && minute <= 82 && (homeGoals === 0 || awayGoals === 0) && scoreDiff <= 1 && ((tempo >= 62 && pressure >= 58) || intelligence >= 68)) {
    const conf = tempo * 0.35 + pressure * 0.30 + readiness * 0.20 + Math.min(100, xgProxy * 22) * 0.15;
    signals.push(signal('BTTS_WATCH', 'goals', 'BTTS watch', conf, [
      `score=${homeGoals}-${awayGoals}`,
      `tempo=${round(tempo,1)}`,
      `pressure=${round(pressure,1)}`,
    ], { line: 'btts_yes', scenario: 'btts_watch', recommendedPanel: 'WATCH' }));
  }

  // If no hard signal fired but the match has real, high-quality stats, surface it as MONITOR.
  // This fixes the previous dead-zone where 40+ live matches could show 0 signal-like candidates.
  if (!signals.length) {
    addMonitorSignalIfUseful(signals, match, d, {
      minute, pressure, tempo, readiness, xgProxy, sotPer90, cornersPer90,
      intelligence, pressureWave, attackCluster, momentumAcceleration, reliability,
      shots, sot: sotRaw, corners: cornersRaw
    });
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
    signalMode: signals.length ? (signals[0] && signals[0].id === 'ANALYZABLE_MONITOR' ? 'REAL_STATS_MONITOR' : 'REAL_STATS_SIGNAL') : 'REAL_STATS_NO_TRIGGER',
    signalBlockReasons: signals.length ? [] : ['thresholds_not_met'],
  };
}

module.exports = { computeRealStatsSignals, generateRealSignals };
