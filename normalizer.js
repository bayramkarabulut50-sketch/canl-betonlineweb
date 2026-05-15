/**
 * normalizer.js — CanliBet Scraper Service
 * Converts any source adapter output → canonical match format.
 *
 * Canonical match format (v10.79):
 * {
 *   match_id, match_hometeam_name, match_awayteam_name,
 *   match_hometeam_score, match_awayteam_score,
 *   match_live, match_status, minute, league_name,
 *   source, fetchedAt,
 *   stats: { attacks, dangerous_attacks, shots_total, shots_on_target,
 *            corners, possession_home, possession_away },
 *   odds:  { home, draw, away, over_05, over_15, over_25, btts_yes }
 * }
 */

'use strict';

// ── Helpers ──────────────────────────────────────────────────────────────────

function safeNum(v, fallback = null) {
  if (v == null || v === '' || v === '-') return fallback;
  const n = Number(v);
  return isNaN(n) ? fallback : n;
}

function safeStr(v, fallback = '') {
  return (v != null && String(v).trim()) || fallback;
}

function safeScore(v, fallback = 0) {
  if (v == null) return fallback;
  const n = parseInt(String(v), 10);
  return isNaN(n) ? fallback : n;
}

function normTeamName(name) {
  if (!name) return '';
  return String(name).trim().replace(/\s+/g, ' ');
}

function normMinute(raw) {
  // Accept "45+2", "67'", 67, null
  if (raw == null) return null;
  const s = String(raw).replace(/['+]/g, '').trim();
  const n = parseInt(s, 10);
  return isNaN(n) ? null : Math.min(n, 130);
}

function normOdds(v) {
  if (v == null || v === '-' || v === '') return null;
  // Decimal: 2.50 | American: +150 → 2.50 | fractional: 3/2 → 2.50
  const s = String(v).trim();
  if (s.includes('/')) {
    const [num, den] = s.split('/').map(Number);
    if (!isNaN(num) && !isNaN(den) && den !== 0) return +(num / den + 1).toFixed(3);
    return null;
  }
  if (s.startsWith('+') || s.startsWith('-')) {
    const n = Number(s);
    if (isNaN(n)) return null;
    return n >= 0 ? +(n / 100 + 1).toFixed(3) : +(100 / Math.abs(n) + 1).toFixed(3);
  }
  const n = Number(s);
  return (isNaN(n) || n < 1.01) ? null : +n.toFixed(3);
}

const LIVE_STATUSES = new Set([
  'live', 'in play', 'in_play', 'inplay', '1h', '2h', 'ht', 'halftime',
  'half time', 'et', 'extra time', 'extra_time', 'pen', 'penalty'
]);

function isLiveStatus(status) {
  if (!status) return false;
  return LIVE_STATUSES.has(String(status).toLowerCase().trim());
}

// ── Canonical factory ─────────────────────────────────────────────────────────

function makeCanonical(raw, source) {
  const hg = safeScore(raw.match_hometeam_score ?? raw.home_score ?? raw.hg ?? raw.scoreHome);
  const ag = safeScore(raw.match_awayteam_score ?? raw.away_score ?? raw.ag ?? raw.scoreAway);
  const status = safeStr(raw.match_status ?? raw.status ?? raw.state ?? '');
  const live   = raw.match_live === '1' || raw.match_live === true || isLiveStatus(status);

  // stats object — all fields optional.
  // Adapter may pre-fill canonical stats (e.g. ESPN). Use them; fill gaps from rawStats aliases.
  const rawStats = raw.stats || raw.statistics || {};
  const stats = {
    attacks:           safeNum(rawStats.attacks),
    dangerous_attacks: safeNum(rawStats.dangerous_attacks ?? rawStats.dangerousAttacks),
    shots_total:       safeNum(rawStats.shots_total ?? rawStats.shotsTotal),
    shots_on_target:   safeNum(rawStats.shots_on_target ?? rawStats.shotsOnTarget),
    corners:           safeNum(rawStats.corners),
    possession_home:   safeNum(rawStats.possession_home ?? rawStats.possessionHome),
    possession_away:   safeNum(rawStats.possession_away ?? rawStats.possessionAway),
    yellow_cards:      safeNum(rawStats.yellow_cards ?? rawStats.yellowCards),
    red_cards:         safeNum(rawStats.red_cards   ?? rawStats.redCards),
  };

  // odds object — all fields optional
  const rawOdds = raw.odds || raw.markets || {};
  const odds = {
    home:    normOdds(rawOdds.home ?? rawOdds.win_home ?? rawOdds['1']),
    draw:    normOdds(rawOdds.draw ?? rawOdds.win_draw ?? rawOdds['X']),
    away:    normOdds(rawOdds.away ?? rawOdds.win_away ?? rawOdds['2']),
    over_05: normOdds(rawOdds.over_05 ?? rawOdds.over_0_5 ?? rawOdds['over0.5']),
    over_15: normOdds(rawOdds.over_15 ?? rawOdds.over_1_5 ?? rawOdds['over1.5']),
    over_25: normOdds(rawOdds.over_25 ?? rawOdds.over_2_5 ?? rawOdds['over2.5']),
    btts_yes:normOdds(rawOdds.btts_yes ?? rawOdds.btts ?? rawOdds['gg']),
  };

  const hasOdds = Object.values(odds).some(v => v !== null);
  const hasStats = Object.values(stats).some(v => v !== null);

  return {
    match_id:             safeStr(raw.match_id ?? raw.fixture_id ?? raw.id ?? ''),
    match_hometeam_name:  normTeamName(raw.match_hometeam_name ?? raw.home ?? raw.homeTeam ?? ''),
    match_awayteam_name:  normTeamName(raw.match_awayteam_name ?? raw.away ?? raw.awayTeam ?? ''),
    match_hometeam_score: hg,
    match_awayteam_score: ag,
    match_live:           live ? '1' : '0',
    match_status:         status,
    minute:               normMinute(raw.minute ?? raw.elapsed ?? raw.match_elapsed ?? raw.min),
    league_name:          safeStr(raw.league_name ?? raw.competition ?? raw.league ?? ''),
    source:               safeStr(source ?? raw.source ?? 'unknown'),
    fetchedAt:            raw.fetchedAt ?? Date.now(),
    hasOdds,
    hasStats,
    stats,
    odds,
  };
}

/**
 * Normalize an array of raw matches from one adapter.
 * Filters out non-live, deduplicates by match_id where possible.
 */
function normalizeMatches(rawMatches, source, { liveOnly = true } = {}) {
  if (!Array.isArray(rawMatches)) return [];
  const seen = new Set();
  const out  = [];

  for (const raw of rawMatches) {
    if (!raw) continue;
    const m = makeCanonical(raw, source);

    // Dedup by match_id
    if (m.match_id) {
      if (seen.has(m.match_id)) continue;
      seen.add(m.match_id);
    }

    if (liveOnly && m.match_live !== '1') continue;
    if (!m.match_hometeam_name && !m.match_awayteam_name) continue; // skip empty

    out.push(m);
  }
  return out;
}

/**
 * Merge results from multiple adapters.
 * First adapter with a given match_id wins; later adapters fill missing fields.
 */
function mergeAdapterResults(adapterResults) {
  // adapterResults = [{ provider, success, matches, odds, stats, error, fetchedAt }]
  const byId  = new Map();   // match_id → canonical
  const noId  = [];          // matches without id — append

  for (const ar of adapterResults) {
    if (!ar.success || !Array.isArray(ar.matches)) continue;
    for (const m of ar.matches) {
      if (!m) continue;
      if (m.match_id && byId.has(m.match_id)) {
        // Fill missing fields from later provider
        const existing = byId.get(m.match_id);
        if (!existing.hasOdds && m.hasOdds) Object.assign(existing.odds, m.odds);
        if (!existing.hasStats && m.hasStats) Object.assign(existing.stats, m.stats);
        if (existing.minute == null && m.minute != null) existing.minute = m.minute;
      } else if (m.match_id) {
        byId.set(m.match_id, m);
      } else {
        noId.push(m);
      }
    }
  }

  return [...byId.values(), ...noId];
}

module.exports = { normalizeMatches, mergeAdapterResults, makeCanonical, normOdds, safeNum, safeStr };
