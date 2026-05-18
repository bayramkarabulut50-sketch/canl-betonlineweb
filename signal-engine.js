/**
 * signal-engine.js — v10.95 Real Stats Signal Engine Activation
 *
 * Turns canonical live stats into stable, bounded model inputs.
 * No betting decision is made here. This only enriches matches with
 * pressure/tempo/momentum/xG proxy/data quality signals for the frontend engine.
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
    version: '10.95-real-stats-signal-engine',
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

module.exports = { computeRealStatsSignals };
