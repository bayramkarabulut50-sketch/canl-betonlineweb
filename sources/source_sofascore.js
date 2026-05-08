/**
 * source_sofascore.js v10.84 — HTTP-only, no Playwright, no recursion.
 *
 * FIX v10.84: fetchJSON rewritten as iterative loop (no self-call → no stack overflow).
 * Uses globalThis.fetch explicitly to avoid any module-level override.
 */
'use strict';

const { normalizeMatches, safeNum, safeStr } = require('../normalizer');

// ── Constants ─────────────────────────────────────────────────────────────────
const BASE_URL       = 'https://api.sofascore.com/api/v1';
const LIVE_URL       = BASE_URL + '/sport/football/events/live';
const STATS_LIMIT    = 5;
const TIMEOUT_MS     = 10000;
const MAX_RETRIES    = 1;
const RETRY_DELAY_MS = 800;

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer':         'https://www.sofascore.com/',
  'Origin':          'https://www.sofascore.com',
};

// ── HTTP helper — iterative retry, NO recursion ───────────────────────────────
async function fetchJSON(url) {
  let lastErr = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise(function(r) { setTimeout(r, RETRY_DELAY_MS); });
    }

    const controller = new AbortController();
    const timer = setTimeout(function() { controller.abort(); }, TIMEOUT_MS);

    let resp;
    try {
      // Use globalThis.fetch explicitly — avoids any local variable shadowing
      resp = await globalThis.fetch(url, {
        method:  'GET',
        headers: HEADERS,
        signal:  controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      lastErr = err.name === 'AbortError' ? new Error('timeout') : err;
      continue; // try next attempt
    }
    clearTimeout(timer);

    if (!resp.ok) {
      lastErr = new Error('HTTP ' + resp.status);
      if (resp.status === 403 || resp.status === 404 || resp.status === 451) {
        // Don't retry on these — permanent block/not-found
        break;
      }
      continue;
    }

    let text;
    try { text = await resp.text(); } catch (err) { lastErr = err; continue; }

    let data;
    try { data = JSON.parse(text); } catch (err) {
      lastErr = new Error('JSON parse error: ' + err.message);
      break; // malformed response — no point retrying
    }

    // Success
    return { ok: true, status: resp.status, data };
  }

  // All attempts failed
  return { ok: false, status: null, error: lastErr ? lastErr.message : 'unknown', data: null };
}

// ── Live status ───────────────────────────────────────────────────────────────
const LIVE_CODES = ['inprogress', 'halftime', 'extra_time', 'penalties', '1st', '2nd'];

function isLiveStatus(status) {
  if (!status) return false;
  var code = String(status.code || status.type || status.description || '')
    .toLowerCase().replace(/[^a-z0-9_]/g, '');
  for (var i = 0; i < LIVE_CODES.length; i++) {
    if (code === LIVE_CODES[i]) return true;
  }
  return code.indexOf('progress') !== -1 || code.indexOf('half') !== -1;
}

function normStatus(status) {
  if (!status) return '';
  var code = String(status.code || status.type || '').toLowerCase();
  if (code.indexOf('1st') !== -1 || code === 'inprogress') return '1H';
  if (code.indexOf('half') !== -1) return 'HT';
  if (code.indexOf('2nd') !== -1) return '2H';
  if (code.indexOf('extra') !== -1) return 'ET';
  if (code.indexOf('pen') !== -1) return 'PEN';
  return String(status.description || code).toUpperCase().slice(0, 8);
}

// ── Event normalizer ──────────────────────────────────────────────────────────
function normEvent(ev) {
  if (!ev || !ev.id) return null;
  var status = ev.status || {};
  if (!isLiveStatus(status)) return null;

  var ht     = ev.homeTeam  || {};
  var at     = ev.awayTeam  || {};
  var hScore = ev.homeScore || {};
  var aScore = ev.awayScore || {};
  var time   = ev.time      || {};

  return {
    match_id:             String(ev.id),
    match_hometeam_name:  safeStr(ht.name || ht.shortName),
    match_awayteam_name:  safeStr(at.name || at.shortName),
    match_hometeam_score: safeNum(hScore.current != null ? hScore.current : hScore.normaltime, 0),
    match_awayteam_score: safeNum(aScore.current != null ? aScore.current : aScore.normaltime, 0),
    match_live:    '1',
    match_status:  normStatus(status),
    minute:        safeNum(time.played != null ? time.played : time.min),
    league_name:   safeStr(ev.tournament ? (ev.tournament.name || '') : ''),
    source:        'sofascore',
    hasOdds:       false,
    odds:          {},
  };
}

// ── Per-match stats ───────────────────────────────────────────────────────────
async function fetchMatchStats(eventId) {
  var result = fetchJSON(BASE_URL + '/event/' + eventId + '/statistics');
  var res = await result;
  if (!res.ok || !res.data) return null;

  var groups = res.data.statistics || [];
  var map = {};
  for (var g = 0; g < groups.length; g++) {
    var items = groups[g].statisticsItems || [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var key  = String(item.key || item.name || '').toLowerCase().replace(/[^a-z0-9]/g, '_');
      var hv   = safeNum(String(item.home || '').replace('%', ''));
      var av   = safeNum(String(item.away || '').replace('%', ''));
      if (hv !== null || av !== null) map[key] = { home: hv, away: av };
    }
  }

  function pick(keys) {
    for (var i = 0; i < keys.length; i++) { if (map[keys[i]]) return map[keys[i]]; }
    return null;
  }
  function sum(s)  { return s ? (s.home || 0) + (s.away || 0) : null; }
  function home(s) { return s ? s.home : null; }
  function away(s) { return s ? s.away : null; }

  var shots   = pick(['total_shots', 'shots_total', 'shots']);
  var on_tgt  = pick(['shots_on_target', 'on_target_shooting']);
  var corners = pick(['corner_kicks', 'corners']);
  var attacks = pick(['attacks', 'total_attacks']);
  var da      = pick(['dangerous_attacks']);
  var poss    = pick(['ball_possession', 'possession']);

  return {
    attacks:           sum(attacks),
    dangerous_attacks: sum(da),
    shots_total:       sum(shots),
    shots_on_target:   sum(on_tgt),
    corners:           sum(corners),
    possession_home:   home(poss),
    possession_away:   away(poss),
  };
}

// ── Adapter entry point ───────────────────────────────────────────────────────
async function fetch(_browser, _options) {
  var fetchedAt = Date.now();

  // ── Live events request ──
  var t0  = Date.now();
  var res = await fetchJSON(LIVE_URL);
  var requestDurationMs = Date.now() - t0;

  console.log('[sofascore] request live ok=' + res.ok + ' status=' + res.status + ' err=' + (res.error || 'none'));

  if (!res.ok) {
    return {
      provider: 'sofascore', success: false, matches: [],
      error: res.error || ('HTTP ' + res.status), fetchedAt,
    };
  }

  var events = (res.data && (res.data.events || res.data.data)) || [];
  if (!Array.isArray(events)) {
    return { provider:'sofascore', success:false, matches:[], error:'unexpected_response_shape', fetchedAt };
  }

  // Normalize — live only
  var raw = [];
  for (var i = 0; i < events.length; i++) {
    var m = normEvent(events[i]);
    if (m) raw.push(m);
  }

  // Per-match stats (iterative, no concurrent blast)
  var statsCoverage = 0;
  for (var j = 0; j < Math.min(raw.length, STATS_LIMIT); j++) {
    var stats = await fetchMatchStats(raw[j].match_id);
    if (stats && Object.values(stats).some(function(v) { return v !== null; })) {
      raw[j].stats    = stats;
      raw[j].hasStats = true;
      statsCoverage++;
    } else {
      raw[j].stats    = {};
      raw[j].hasStats = false;
    }
  }
  // Remaining matches without stats
  for (var k = STATS_LIMIT; k < raw.length; k++) {
    raw[k].stats    = {};
    raw[k].hasStats = false;
  }

  var normalized = normalizeMatches(raw, 'sofascore');

  console.log('[sofascore] Fetched live matches: ' + normalized.length + ' | stats: ' + statsCoverage + ' | ' + requestDurationMs + 'ms');

  return {
    provider:  'sofascore',
    success:   normalized.length > 0,
    matches:   normalized,
    error:     normalized.length === 0 ? 'no_live_matches' : null,
    fetchedAt,
    meta: { requestDurationMs, rawEventCount: events.length, liveMatches: normalized.length, statsCoverage },
  };
}

module.exports = { fetch, provider: 'sofascore', needsPlaywright: false };
