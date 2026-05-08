/**
 * source_sofascore.js v10.85 — detailed debug + schema auto-detect
 *
 * Changes from v10.84:
 * - Full response debug logging (status, content-type, payload length, events count)
 * - Auto-detect events array from multiple schema variants
 * - Log raw response preview when events=0 or matches=0
 * - Per-event status logging to identify filter issues
 * - Stats per-event success/fail/timeout logged
 * - Clear final summary: normalizedMatches=N
 */
'use strict';

const { normalizeMatches, safeNum, safeStr } = require('../normalizer');

// ── Constants ─────────────────────────────────────────────────────────────────
const BASE_URL       = 'https://api.sofascore.com/api/v1';
const LIVE_URL       = BASE_URL + '/sport/football/events/live';
const STATS_LIMIT    = 5;
const TIMEOUT_MS     = 10000;
const MAX_RETRIES    = 1;
const RETRY_DELAY_MS = 1000;

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer':         'https://www.sofascore.com/',
  'Origin':          'https://www.sofascore.com',
};

// ── Iterative fetch (no recursion) ────────────────────────────────────────────
async function fetchRaw(url) {
  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, RETRY_DELAY_MS));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const resp = await globalThis.fetch(url, { method:'GET', headers:HEADERS, signal:controller.signal });
      clearTimeout(timer);

      const contentType = resp.headers.get('content-type') || '';
      const text = await resp.text();

      if (!resp.ok) {
        lastErr = { status:resp.status, contentType, text:text.slice(0,200) };
        if ([403,404,410,451].includes(resp.status)) break; // permanent
        continue;
      }
      return { ok:true, status:resp.status, contentType, text };
    } catch (err) {
      clearTimeout(timer);
      lastErr = { status:null, error: err.name === 'AbortError' ? 'timeout' : err.message };
      if (err.name === 'AbortError') break; // timeout — no retry benefit
    }
  }
  return { ok:false, ...(lastErr || { error:'unknown' }) };
}

// ── Auto-detect events array from various schema shapes ───────────────────────
function extractEvents(data) {
  if (!data || typeof data !== 'object') return [];

  // Try common paths in order
  const candidates = [
    data.events,           // primary: { events: [...] }
    data.data,             // alternate: { data: [...] }
    data.data && data.data.events, // nested: { data: { events: [...] } }
    data.results,          // some APIs: { results: [...] }
    data.matches,          // fallback: { matches: [...] }
  ];

  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0) return c;
  }

  // If data itself is an array
  if (Array.isArray(data)) return data;

  return [];
}

// ── Live status detection — broad to catch schema variations ─────────────────
function isLiveStatus(status) {
  if (!status) return false;

  // Try every field that might indicate status
  const fields = [
    status.code, status.type, status.description,
    status.name, status.value, status.state,
  ].filter(Boolean).map(v => String(v).toLowerCase().replace(/[^a-z0-9]/g, ''));

  const LIVE_PATTERNS = ['inprogress','halftime','halft','extra','penalty','1st','2nd','live','playing','started','ongoing'];
  const DEAD_PATTERNS = ['finished','fulltime','ended','postponed','canceled','notstarted','scheduled','upcoming','ns','ft'];

  for (const f of fields) {
    for (const dead of DEAD_PATTERNS) { if (f === dead || f.startsWith(dead)) return false; }
  }
  for (const f of fields) {
    for (const live of LIVE_PATTERNS) { if (f === live || f.includes(live)) return true; }
  }

  // Numeric code: SofaScore uses 6=inprogress, 7=halftime etc. (undocumented)
  const numCode = Number(status.code);
  if (!isNaN(numCode) && numCode >= 6 && numCode <= 12) return true;

  return false;
}

function normStatus(status) {
  if (!status) return '';
  const code = String(status.code || status.type || '').toLowerCase();
  if (code === '6' || code.includes('1st') || code === 'inprogress') return '1H';
  if (code === '7' || code.includes('half')) return 'HT';
  if (code === '8' || code.includes('2nd')) return '2H';
  if (code === '9' || code.includes('extra')) return 'ET';
  if (code === '10' || code.includes('pen')) return 'PEN';
  const desc = String(status.description || '');
  if (desc) return desc.toUpperCase().slice(0, 8);
  return code.toUpperCase().slice(0, 8);
}

// ── Event normalizer ──────────────────────────────────────────────────────────
function normEvent(ev) {
  if (!ev || !ev.id) return null;

  const status = ev.status || {};
  if (!isLiveStatus(status)) return null;

  const ht     = ev.homeTeam  || ev.home_team  || {};
  const at     = ev.awayTeam  || ev.away_team  || {};
  const hScore = ev.homeScore || ev.home_score || {};
  const aScore = ev.awayScore || ev.away_score || {};
  const time   = ev.time || ev.match_time || {};

  const hg = safeNum(hScore.current != null ? hScore.current : hScore.normaltime, 0);
  const ag = safeNum(aScore.current != null ? aScore.current : aScore.normaltime, 0);
  const min = safeNum(time.played != null ? time.played : (time.min != null ? time.min : ev.minute));

  const tournament = ev.tournament || ev.league || ev.competition || {};

  return {
    match_id:             String(ev.id),
    match_hometeam_name:  safeStr(ht.name || ht.shortName || ht.short_name),
    match_awayteam_name:  safeStr(at.name || at.shortName || at.short_name),
    match_hometeam_score: hg,
    match_awayteam_score: ag,
    match_live:           '1',
    match_status:         normStatus(status),
    minute:               min,
    league_name:          safeStr(tournament.name || tournament.uniqueName || ''),
    source:               'sofascore',
    hasOdds:              false,
    odds:                 {},
  };
}

// ── Per-match stats ───────────────────────────────────────────────────────────
async function fetchMatchStats(eventId) {
  const res = await fetchRaw(BASE_URL + '/event/' + eventId + '/statistics');
  if (!res.ok) {
    console.log('[sofascore] stats eventId=' + eventId + ' failed: ' + (res.status || res.error));
    return null;
  }

  let data;
  try { data = JSON.parse(res.text); } catch (e) {
    console.log('[sofascore] stats eventId=' + eventId + ' JSON parse error');
    return null;
  }

  const groups = (data.statistics || data.stats || []);
  const map = {};
  for (const group of groups) {
    for (const item of (group.statisticsItems || group.items || [])) {
      const key = String(item.key || item.name || '').toLowerCase().replace(/[^a-z0-9]/g, '_');
      const hv  = safeNum(String(item.home ?? '').replace('%',''));
      const av  = safeNum(String(item.away ?? '').replace('%',''));
      if (hv !== null || av !== null) map[key] = { home:hv, away:av };
    }
  }

  const pick = (...keys) => { for (const k of keys) if (map[k]) return map[k]; return null; };
  const sum  = s => s ? (s.home||0)+(s.away||0) : null;
  const home = s => s ? s.home : null;
  const away = s => s ? s.away : null;

  const result = {
    attacks:           sum(pick('attacks','total_attacks')),
    dangerous_attacks: sum(pick('dangerous_attacks')),
    shots_total:       sum(pick('total_shots','shots_total','shots')),
    shots_on_target:   sum(pick('shots_on_target','on_target_shooting')),
    corners:           sum(pick('corner_kicks','corners')),
    possession_home:   home(pick('ball_possession','possession')),
    possession_away:   away(pick('ball_possession','possession')),
  };

  const hasAny = Object.values(result).some(v => v !== null);
  console.log('[sofascore] stats eventId=' + eventId + (hasAny ? ' ok' : ' empty'));
  return hasAny ? result : null;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function fetch(_browser, _options) {
  const fetchedAt = Date.now();
  const t0 = Date.now();

  // ── 1. Fetch live endpoint ──
  const res = await fetchRaw(LIVE_URL);
  const requestDurationMs = Date.now() - t0;

  console.log('[sofascore] live status=' + (res.status || 'none') + ' ok=' + res.ok);
  if (res.contentType) console.log('[sofascore] content-type=' + res.contentType);

  if (!res.ok) {
    console.log('[sofascore] live failed: ' + (res.error || 'HTTP ' + res.status));
    return { provider:'sofascore', success:false, matches:[], error:res.error || 'HTTP '+res.status, fetchedAt };
  }

  // ── 2. Parse JSON ──
  let data;
  try {
    data = JSON.parse(res.text);
  } catch (e) {
    console.log('[sofascore] JSON parse error. preview=' + res.text.slice(0,200));
    return { provider:'sofascore', success:false, matches:[], error:'json_parse_error', fetchedAt };
  }

  console.log('[sofascore] payload length=' + res.text.length + ' top-level keys=' + Object.keys(data||{}).join(','));

  // ── 3. Extract events (auto-detect schema) ──
  const events = extractEvents(data);
  console.log('[sofascore] events=' + events.length);

  if (events.length === 0) {
    console.log('[sofascore] raw preview=' + res.text.slice(0, 500));
    return { provider:'sofascore', success:false, matches:[], error:'no_events_in_response', fetchedAt };
  }

  // ── 4. Log status distribution for diagnosis ──
  const statusSample = events.slice(0, 10).map(ev => {
    const s = ev.status || {};
    return String(s.code || s.type || s.description || '?');
  });
  console.log('[sofascore] status sample=' + statusSample.join(','));

  // ── 5. Normalize — live filter ──
  const raw = [];
  let filteredOut = 0;
  for (const ev of events) {
    const m = normEvent(ev);
    if (m) raw.push(m);
    else filteredOut++;
  }
  console.log('[sofascore] live_after_filter=' + raw.length + ' filtered_out=' + filteredOut);

  if (raw.length === 0) {
    // Log a couple of raw events to diagnose status field shape
    const sample = events.slice(0,3).map(ev => JSON.stringify(ev.status || {})).join(' | ');
    console.log('[sofascore] status objects sample: ' + sample);
    return { provider:'sofascore', success:false, matches:[], error:'no_live_matches', fetchedAt };
  }

  // ── 6. Fetch stats for first N matches ──
  let statsFetched = 0;
  for (let j = 0; j < Math.min(raw.length, STATS_LIMIT); j++) {
    const stats = await fetchMatchStats(raw[j].match_id);
    if (stats) { raw[j].stats = stats; raw[j].hasStats = true; statsFetched++; }
    else        { raw[j].stats = {};    raw[j].hasStats = false; }
  }
  for (let k = STATS_LIMIT; k < raw.length; k++) {
    raw[k].stats = {}; raw[k].hasStats = false;
  }

  // ── 7. Final normalize ──
  const normalized = normalizeMatches(raw, 'sofascore');
  console.log('[sofascore] normalizedMatches=' + normalized.length + ' stats fetched=' + statsFetched + ' duration=' + requestDurationMs + 'ms');

  if (normalized.length === 0) {
    return { provider:'sofascore', success:false, matches:[], error:'no_matches_after_normalization', fetchedAt };
  }

  return {
    provider: 'sofascore',
    success:  true,
    matches:  normalized,
    error:    null,
    fetchedAt,
    meta: { requestDurationMs, rawEventCount:events.length, liveMatches:normalized.length, statsFetched },
  };
}

module.exports = { fetch, provider:'sofascore', needsPlaywright:false };
