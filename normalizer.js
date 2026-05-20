/**
 * normalizer.js — CanliBet Scraper Service v11.19
 *
 * Converts any source adapter output → canonical match format.
 * v11.19: Comprehensive live status set, impossible count guard,
 * strict minute parsing, provider confidence scoring.
 */
'use strict';

const { computeRealStatsSignals, generateRealSignals } = require('./signal-engine');

// ── Helpers ───────────────────────────────────────────────────────────────────

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

/**
 * Strict minute parsing — rejects NaN, booleans, timestamps, arrays, flags.
 * Returns integer 0-130 or null.
 */
function normMinute(raw) {
  if (raw == null || raw === '' || typeof raw === 'boolean') return null;
  if (Array.isArray(raw)) return null;
  const s = String(raw).replace(/['+\s].*/g, '').trim();  // strip +extras like '45+2'→'45'
  // Reject obvious timestamps (7+ digit numbers)
  if (/^\d{7,}$/.test(s)) return null;
  const n = parseInt(s, 10);
  if (isNaN(n) || n < 0 || n > 150) return null;
  return Math.min(n, 130);
}

function normOdds(v) {
  if (v == null || v === '-' || v === '') return null;
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

// ── Live status classification ────────────────────────────────────────────────

/**
 * Comprehensive live status set covering ESPN, Flashscore, FotMob, TheSportsDB,
 * OpenLigaDB and custom adapter values.
 * v11.19: expanded to cover STATUS_* ESPN variants, state:'in', period-based.
 */
const LIVE_STATUS_SET = new Set([
  // Generic
  'live', 'in play', 'in_play', 'inplay',
  // Period labels
  '1h', '2h', 'ht', 'halftime', 'half time', 'half_time', 'halfime',
  'et', 'extra time', 'extra_time', 'aet',
  'pen', 'penalty', 'penalties', 'penalty shootout',
  // ESPN STATUS_* values (uppercase and lowercase)
  'status_in_progress', 'status_halftime', 'status_half_time',
  'status_first_half', 'status_second_half',
  'status_end_period', 'status_extra_time', 'status_extra_time_half_time',
  'status_first_extra', 'status_second_extra',
  'status_overtime', 'status_penalty', 'status_penalties',
  'status_awaiting_penalties', 'status_penalty_shootout',
  'status_delayed', 'status_suspended', 'status_interrupted',
  // ESPN compact state values
  'in', 'in_progress',
  // Flashscore / other
  'delayed', 'suspended', 'interrupted',
]);

const FINAL_STATUS_SET = new Set([
  'ft', 'full_time', 'full time', 'finished', 'final', 'ended', 'completed',
  'status_full_time', 'status_final', 'status_final_pen', 'status_final_aet',
  'status_postponed', 'status_canceled', 'status_cancelled', 'status_abandoned',
  'postponed', 'canceled', 'cancelled', 'abandoned', 'walkover',
  'after pen', 'after extra time', 'aet', 'ap',
  'post',
]);

const SCHEDULED_STATUS_SET = new Set([
  'scheduled', 'pre', 'pregame', 'ns', 'not started', 'not_started', 'tbd',
  'status_scheduled', 'status_pregame',
]);

/**
 * Classify a raw status string into 'live' | 'final' | 'scheduled' | 'unknown'.
 * Handles ESPN STATUS_* values, Flashscore compact codes, and numeric minute strings.
 */
function classifyStatus(rawStatus) {
  if (!rawStatus && rawStatus !== 0) return 'unknown';
  const s = String(rawStatus).toLowerCase().trim();
  if (!s) return 'unknown';

  if (LIVE_STATUS_SET.has(s)) return 'live';
  if (FINAL_STATUS_SET.has(s)) return 'final';
  if (SCHEDULED_STATUS_SET.has(s)) return 'scheduled';

  // Numeric minute string (including '45+2' format) → live
  const n = parseInt(s.replace(/['+\s].*/g, ''), 10);
  if (!isNaN(n) && n > 0 && n <= 130) return 'live';

  // Regex patterns for edge cases
  if (/\b(in[_\s-]?progress|first[_\s-]?half|second[_\s-]?half|half[_\s-]?time|halftime|end[_\s-]?period|extra[_\s-]?time|penalt)\b/.test(s)) return 'live';
  if (/\b(full[_\s-]?time|final|finished|postponed|cancel|abandon)\b/.test(s)) return 'final';
  if (/\b(scheduled|pregame)\b/.test(s)) return 'scheduled';

  return 'unknown';
}

/**
 * Determine if a raw match object should be considered live.
 * Priority order:
 * 1. Explicit match_live='1' from adapter → live (adapter already decided)
 * 2. Explicit completed=true → final (ESPN)
 * 3. Status classification
 * 4. Minute-based fallback (only if not scheduled/final)
 */
function isLiveMatch(raw) {
  // ── Step 1: Hard final signals override EVERYTHING ────────────────────
  // completed=true (ESPN) is a hard reject regardless of match_live flag
  if (raw.completed === true) return false;
  const statusType = raw.statusType || raw.status_type || {};
  if (statusType.completed === true) return false;

  // ── Step 2: Status string classification (highest priority after completed) ──
  // This overrides match_live flag — adapters sometimes set match_live='1'
  // on FINISHED or SCHEDULED matches incorrectly.
  const statusRaw = raw.match_status ?? raw.status ?? raw.state ?? raw.match_state ?? '';
  const statusClass = classifyStatus(statusRaw);

  if (statusClass === 'final') return false;       // FINISHED/FT/FULL_TIME → never live
  if (statusClass === 'scheduled') return false;   // SCHEDULED/PRE → never live
  if (statusClass === 'live') return true;          // explicit live status → live

  // ── Step 3: status is 'unknown' — now trust match_live flag ──────────
  if (raw.match_live === '1' || raw.match_live === true) return true;

  // State field (ESPN state:'in')
  if (raw.state && String(raw.state).toLowerCase() === 'in') return true;

  // ── Step 4: Minute-based fallback (only for unknown status) ──────────
  const min = normMinute(raw.minute ?? raw.elapsed ?? raw.match_elapsed ?? raw.min);
  if (min != null && min > 0 && min < 130) return true;

  return false;
}

// ── Impossible count guard ────────────────────────────────────────────────────

/**
 * Validates a batch of matches from a single provider.
 * Returns { ok, reason } — if !ok, provider should be quarantined.
 */
function validateProviderBatch(matches, providerName) {
  if (!Array.isArray(matches)) return { ok: true };
  const count = matches.length;
  if (count > 200) {
    return { ok: false, reason: `impossible_count:${count}>200`, quarantine: true };
  }
  if (count > 50) {
    const liveCount = matches.filter(m => m.match_live === '1').length;
    const scheduledRatio = (count - liveCount) / count;
    if (scheduledRatio > 0.80) {
      return {
        ok: false,
        reason: `high_scheduled_ratio:${Math.round(scheduledRatio * 100)}%_of_${count}`,
        quarantine: true,
      };
    }
  }
  return { ok: true };
}

// ── Canonical factory ─────────────────────────────────────────────────────────

function makeCanonical(raw, source) {
  const hg = safeScore(raw.match_hometeam_score ?? raw.home_score ?? raw.hg ?? raw.scoreHome);
  const ag = safeScore(raw.match_awayteam_score ?? raw.away_score ?? raw.ag ?? raw.scoreAway);

  const statusRaw = safeStr(raw.match_status ?? raw.status ?? raw.state ?? '');
  const live = isLiveMatch(raw);

  // Strict minute parsing
  const minute = normMinute(raw.minute ?? raw.elapsed ?? raw.match_elapsed ?? raw.min);

  // Validate: if live=true but minute is null AND status is empty → suspicious
  // We allow this (Flashscore may not always have minute)

  const rawStats = raw.stats || raw.statistics || {};
  const stats = {
    attacks:           safeNum(rawStats.attacks),
    dangerous_attacks: safeNum(rawStats.dangerous_attacks ?? rawStats.dangerousAttacks),
    shots_total:       safeNum(rawStats.shots_total ?? rawStats.shotsTotal),
    shots_on_target:   safeNum(rawStats.shots_on_target ?? rawStats.shotsOnTarget),
    corners:           safeNum(rawStats.corners ?? rawStats.won_corners ?? rawStats.corner_kicks ?? rawStats.cornerKicks),
    possession_home:   safeNum(rawStats.possession_home ?? rawStats.possessionHome ?? rawStats.home_possession),
    possession_away:   safeNum(rawStats.possession_away ?? rawStats.possessionAway ?? rawStats.away_possession),
    yellow_cards:      safeNum(rawStats.yellow_cards ?? rawStats.yellowCards),
    red_cards:         safeNum(rawStats.red_cards ?? rawStats.redCards),
  };

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

  const canonical = {
    match_id:             safeStr(raw.match_id ?? raw.fixture_id ?? raw.id ?? ''),
    match_hometeam_name:  normTeamName(raw.match_hometeam_name ?? raw.home ?? raw.homeTeam ?? ''),
    match_awayteam_name:  normTeamName(raw.match_awayteam_name ?? raw.away ?? raw.awayTeam ?? ''),
    match_hometeam_score: hg,
    match_awayteam_score: ag,
    match_live:           live ? '1' : '0',
    match_status:         statusRaw,
    minute,
    league_name:          safeStr(raw.league_name ?? raw.competition ?? raw.league ?? ''),
    source:               safeStr(source ?? raw.source ?? 'unknown'),
    fetchedAt:            raw.fetchedAt ?? Date.now(),
    hasOdds,
    hasStats,
    stats,
    odds,
    // Carry through debug fields from adapter
    _statusClass:         classifyStatus(statusRaw),
    _liveReason:          live
      ? (raw.match_live === '1' ? 'adapter_set' : 'status_class:' + classifyStatus(statusRaw))
      : 'not_live',
  };

  canonical.derived = computeRealStatsSignals(canonical);
  const signalPack = generateRealSignals(canonical);
  canonical.signals = signalPack.signals;
  canonical.topSignal = signalPack.topSignal;
  canonical.signalCount = signalPack.signalCount;
  canonical.actionabilityScore = signalPack.actionabilityScore;
  canonical.signalMode = signalPack.signalMode;
  canonical.signalBlockReasons = signalPack.signalBlockReasons;
  canonical.dataReliabilityScore = canonical.derived.dataReliabilityScore;
  canonical.pressureScore = canonical.derived.pressureScore;
  canonical.tempoScore = canonical.derived.tempoScore;
  canonical.momentumScore = canonical.derived.momentumScore;
  canonical.xgProxy = canonical.derived.xgProxy;
  canonical.transitionReadiness = canonical.derived.transitionReadiness;

  return canonical;
}

/**
 * Normalize an array of raw matches from one adapter.
 * Applies strict live filter, dedup, and impossible count guard.
 */
function normalizeMatches(rawMatches, source, { liveOnly = true } = {}) {
  if (!Array.isArray(rawMatches)) return [];
  const seen = new Set();
  const out = [];

  for (const raw of rawMatches) {
    if (!raw) continue;
    const m = makeCanonical(raw, source);

    // Dedup by match_id
    if (m.match_id) {
      if (seen.has(m.match_id)) continue;
      seen.add(m.match_id);
    }

    if (liveOnly && m.match_live !== '1') continue;
    if (!m.match_hometeam_name && !m.match_awayteam_name) continue;

    out.push(m);
  }

  // Impossible count guard per-source
  const guard = validateProviderBatch(out, source);
  if (!guard.ok) {
    console.warn(`[normalizer] QUARANTINE source=${source} reason=${guard.reason} count=${out.length}`);
    return []; // quarantine — return nothing
  }

  return out;
}

/**
 * Merge results from multiple adapters.
 * First adapter with a given match_id wins; later adapters fill missing fields.
 * v11.19: adds provider confidence scoring for dedup tie-breaking.
 */
function mergeAdapterResults(adapterResults) {
  const PROVIDER_PRIORITY = {
    espn_json: 90,
    flashscore_feed: 80,
    fotmob_json: 70,
    thesportsdb_json: 60,
    openligadb_json: 50,
    aiscore_json: 40,
    mock: 0,
  };

  const byId = new Map();
  const noId = [];

  for (const ar of (adapterResults || [])) {
    if (!ar || !ar.success || !Array.isArray(ar.matches)) continue;
    const priority = PROVIDER_PRIORITY[ar.provider] ?? 50;

    for (const m of ar.matches) {
      if (!m) continue;
      if (m.match_id && byId.has(m.match_id)) {
        const existing = byId.get(m.match_id);
        const existingPriority = PROVIDER_PRIORITY[existing.source] ?? 50;
        // Fill missing fields from any provider
        if (!existing.hasOdds && m.hasOdds) { Object.assign(existing.odds, m.odds); existing.hasOdds = true; }
        if (!existing.hasStats && m.hasStats) { Object.assign(existing.stats, m.stats); existing.hasStats = true; }
        if (existing.minute == null && m.minute != null) existing.minute = m.minute;
        // Prefer higher-priority provider's live status
        if (priority > existingPriority && m.match_live === '1') existing.match_live = '1';
      } else if (m.match_id) {
        byId.set(m.match_id, Object.assign({}, m, { _mergeProvider: ar.provider }));
      } else {
        noId.push(m);
      }
    }
  }

  return [...byId.values(), ...noId];
}

module.exports = {
  normalizeMatches,
  mergeAdapterResults,
  makeCanonical,
  normOdds,
  safeNum,
  safeStr,
  normMinute,
  classifyStatus,
  isLiveMatch,
  validateProviderBatch,
};
