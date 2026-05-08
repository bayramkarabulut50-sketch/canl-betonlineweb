/**
 * source_sofascore.js v10.83 — HTTP-only, no Playwright.
 *
 * Uses SofaScore's public JSON endpoints (same ones their own web app uses).
 * These are publicly accessible, not behind auth.
 * Rate limit: max 1 call per CACHE_TTL seconds (handled by server.js cache cycle).
 * No CAPTCHA bypass, no browser automation, no fingerprint evasion.
 *
 * Endpoints used:
 *   GET /api/v1/sport/football/events/live
 *     → returns live football events with scores, time, team names
 *
 *   GET /api/v1/event/{id}/statistics
 *     → per-match stats (shots, possession, corners, etc.)
 *     → only fetched for first N matches to avoid hammering
 */

'use strict';

const { normalizeMatches, safeNum, safeStr } = require('../normalizer');

// ── Config ────────────────────────────────────────────────────────────────────
const BASE_URL      = 'https://api.sofascore.com/api/v1';
const LIVE_URL      = `${BASE_URL}/sport/football/events/live`;
const STATS_LIMIT   = 5;    // max per-match stats requests per cycle
const REQUEST_TIMEOUT_MS = 10000;
const MAX_RETRIES   = 1;

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer':         'https://www.sofascore.com/',
  'Origin':          'https://www.sofascore.com',
};

// ── HTTP helper ───────────────────────────────────────────────────────────────
async function fetchJSON(url, retries = MAX_RETRIES) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { headers: HEADERS, signal: controller.signal });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } catch (err) {
    clearTimeout(timer);
    if (retries > 0 && err.name !== 'AbortError') {
      await new Promise(r => setTimeout(r, 800));
      return fetchJSON(url, retries - 1);
    }
    throw err;
  }
}

// ── Live status detection ─────────────────────────────────────────────────────
const LIVE_CODES = new Set(['inprogress', 'halftime', 'extra_time', 'penalties', '1st', '2nd']);

function isLive(status) {
  if (!status) return false;
  const code = String(status.code || status.type || status.description || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
  return LIVE_CODES.has(code) || code.includes('progress') || code.includes('half');
}

function normStatus(status) {
  if (!status) return '';
  const code = String(status.code || status.type || '').toLowerCase();
  if (code.includes('1st') || code === 'inprogress') return '1H';
  if (code.includes('half')) return 'HT';
  if (code.includes('2nd')) return '2H';
  if (code.includes('extra')) return 'ET';
  if (code.includes('pen')) return 'PEN';
  return String(status.description || code).toUpperCase().slice(0, 8);
}

// ── Per-match stats fetch ─────────────────────────────────────────────────────
async function fetchMatchStats(eventId) {
  try {
    const data = await fetchJSON(`${BASE_URL}/event/${eventId}/statistics`);
    const groups = data.statistics || [];
    const stats = {};

    for (const group of groups) {
      for (const item of (group.statisticsItems || [])) {
        const key = (item.key || item.name || '').toLowerCase().replace(/[^a-z0-9]/g, '_');
        const homeVal = safeNum(item.home);
        const awayVal = safeNum(item.away);
        if (homeVal !== null || awayVal !== null) {
          stats[key] = { home: homeVal, away: awayVal };
        }
      }
    }

    // Map to canonical stat names
    const get = (keys) => {
      for (const k of keys) {
        if (stats[k]) return stats[k];
      }
      return null;
    };

    const shots_total      = get(['total_shots', 'shots_total', 'shots']);
    const shots_on_target  = get(['shots_on_target', 'on_target_shooting']);
    const corners          = get(['corner_kicks', 'corners']);
    const attacks          = get(['attacks', 'total_attacks']);
    const dangerous_attacks= get(['dangerous_attacks']);
    const possession_raw   = get(['ball_possession', 'possession']);

    const sumStat = (s) => s ? (safeNum(s.home) || 0) + (safeNum(s.away) || 0) : null;
    const homeNum = (s) => s ? safeNum(s.home) : null;
    const awayNum = (s) => s ? safeNum(s.away) : null;

    return {
      attacks:           sumStat(attacks),
      dangerous_attacks: sumStat(dangerous_attacks),
      shots_total:       sumStat(shots_total),
      shots_on_target:   sumStat(shots_on_target),
      corners:           sumStat(corners),
      possession_home:   homeNum(possession_raw),
      possession_away:   awayNum(possession_raw),
    };
  } catch (err) {
    return null;
  }
}

// ── Main normalizer ───────────────────────────────────────────────────────────
function normEvent(ev) {
  if (!ev) return null;

  const ht     = ev.homeTeam || {};
  const at     = ev.awayTeam || {};
  const hScore = ev.homeScore || {};
  const aScore = ev.awayScore || {};
  const status = ev.status   || {};
  const time   = ev.time     || {};

  if (!isLive(status)) return null;

  const hg = safeNum(hScore.current ?? hScore.normaltime, 0);
  const ag = safeNum(aScore.current ?? aScore.normaltime, 0);

  return {
    match_id:             String(ev.id || ''),
    match_hometeam_name:  safeStr(ht.name || ht.shortName),
    match_awayteam_name:  safeStr(at.name || at.shortName),
    match_hometeam_score: hg,
    match_awayteam_score: ag,
    match_live:           '1',
    match_status:         normStatus(status),
    minute:               safeNum(time.played ?? time.min),
    league_name:          safeStr(ev.tournament && (ev.tournament.name || ev.tournament.uniqueTournament?.name)),
    source:               'sofascore',
    hasOdds:              false,
    odds:                 {},
  };
}

// ── Adapter entry point ───────────────────────────────────────────────────────
async function fetch(_browser, _options) {
  const fetchedAt = Date.now();

  try {
    const t0   = Date.now();
    const data = await fetchJSON(LIVE_URL);
    const requestDurationMs = Date.now() - t0;

    const events = data.events || data.data || [];
    if (!Array.isArray(events)) {
      return { provider:'sofascore', success:false, matches:[], error:'unexpected_response_shape', fetchedAt };
    }

    // Normalize — filter to live only
    const raw = events.map(normEvent).filter(Boolean);

    // Fetch per-match stats for first N (rate-limit friendly)
    let statsCoverage = 0;
    const statsPromises = raw.slice(0, STATS_LIMIT).map(async (m) => {
      const stats = await fetchMatchStats(m.match_id);
      if (stats && Object.values(stats).some(v => v !== null)) {
        m.stats    = stats;
        m.hasStats = true;
        statsCoverage++;
      } else {
        m.stats    = {};
        m.hasStats = false;
      }
      return m;
    });

    const withStats = await Promise.all(statsPromises);
    // Matches beyond STATS_LIMIT get empty stats
    const remaining = raw.slice(STATS_LIMIT).map(m => ({ ...m, stats:{}, hasStats:false }));
    const allMatches = [...withStats, ...remaining];

    const normalized = normalizeMatches(allMatches, 'sofascore');

    console.log(`[sofascore] Fetched live matches: ${normalized.length} | stats: ${statsCoverage} | ${requestDurationMs}ms`);

    return {
      provider:  'sofascore',
      success:   normalized.length > 0,
      matches:   normalized,
      error:     normalized.length === 0 ? 'no_live_matches' : null,
      fetchedAt,
      meta: {
        requestDurationMs,
        rawEventCount: events.length,
        liveMatches:   normalized.length,
        statsCoverage,
      },
    };
  } catch (err) {
    console.error(`[sofascore] Error: ${err.message}`);
    return { provider:'sofascore', success:false, matches:[], error:err.message, fetchedAt };
  }
}

module.exports = { fetch, provider:'sofascore', needsPlaywright:false };
