/**
 * source_espn_json.js v10.88-espn-live-fix
 *
 * ESPN public JSON endpoint - live match extraction fix.
 * - Probes multiple league scoreboard endpoints
 * - Broad status acceptance (any live + scheduled for debug)
 * - Full schema debug in audit mode
 * - No HTML scraping, no anti-bot bypass.
 */
'use strict';

const { createHttpClient } = require('../http-client');
const { safeNum, safeStr, normalizeMatches } = require('../normalizer');

// All league slugs to try
const LEAGUE_SLUGS = [
  'all',
  'eng.1',       // Premier League
  'esp.1',       // La Liga
  'ger.1',       // Bundesliga
  'ita.1',       // Serie A
  'fra.1',       // Ligue 1
  'tur.1',       // Süper Lig
  'uefa.champions', // Champions League
  'uefa.europa',
  'usa.1',       // MLS
];

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
function epUrl(slug) { return `${BASE}/${slug}/scoreboard`; }

// Primary endpoints (tried first in /live)
const PRIMARY_ENDPOINTS = LEAGUE_SLUGS.slice(0, 5).map(epUrl);

// All endpoints (tried in /audit)
const ALL_ENDPOINTS = LEAGUE_SLUGS.map(epUrl);

const FAIL = {
  HTTP_403:'HTTP_403', HTTP_404:'HTTP_404', HTTP_429:'HTTP_429',
  HTTP_5XX:'HTTP_5XX', NON_JSON:'NON_JSON_RESPONSE', JSON_PARSE:'JSON_PARSE_FAILED',
  NO_EVENTS:'NO_EVENTS_FOUND', OK:'OK_PARSED', EMPTY:'EMPTY_RESPONSE',
};

function classifyStatus(s) {
  if (s===403) return FAIL.HTTP_403; if (s===404) return FAIL.HTTP_404;
  if (s===429) return FAIL.HTTP_429; if (s>=500)  return FAIL.HTTP_5XX;
  return null;
}

const client = createHttpClient({
  referer:   'https://www.espn.com/soccer/',
  origin:    'https://www.espn.com',
  minPaceMs: 400,
  timeoutMs: 9000,
  maxRetries: 1,
});

// ── Status detection ──────────────────────────────────────────────────────────
// Live states ESPN uses
const ESPN_LIVE = new Set([
  'STATUS_IN_PROGRESS',
  'STATUS_HALFTIME',
  'STATUS_END_PERIOD',
  'STATUS_EXTRA_TIME',
  'STATUS_PENALTY',
  'STATUS_OVERTIME',
]);

// Scheduled / pre-match (accepted in debug, rejected in live)
const ESPN_SCHEDULED = new Set([
  'STATUS_SCHEDULED',
  'STATUS_PREGAME',
]);

function isLiveStatus(typeName) {
  return ESPN_LIVE.has(typeName);
}

// ── Schema-resilient event normalizer ─────────────────────────────────────────
function normEspnEvent(ev, acceptScheduled = false) {
  if (!ev) return null;

  // ESPN wraps match data under competitions[]
  const comp       = (ev.competitions || [])[0] || {};
  const statusType = (comp.status && comp.status.type) || (ev.status && ev.status.type) || {};
  const typeName   = statusType.name || statusType.state || '';

  const isLive      = isLiveStatus(typeName);
  const isScheduled = ESPN_SCHEDULED.has(typeName);

  if (!isLive && !(acceptScheduled && isScheduled)) return null;

  const competitors = comp.competitors || ev.competitors || [];
  const home = competitors.find(c => c.homeAway === 'home') || competitors[0] || {};
  const away = competitors.find(c => c.homeAway === 'away') || competitors[1] || {};

  // Score: can be string or number
  const hg = safeNum(home.score, 0);
  const ag = safeNum(away.score, 0);

  // Minute: from displayClock ("45:00" → 45) or currentPeriod
  const clock = statusType.displayClock || comp.status?.displayClock || '';
  const minute = clock ? safeNum(parseInt(clock)) : safeNum(statusType.period);

  const matchStatus = typeName === 'STATUS_HALFTIME' ? 'HT'
    : typeName === 'STATUS_EXTRA_TIME' ? 'ET'
    : typeName === 'STATUS_PENALTY' ? 'PEN'
    : isScheduled ? 'SCH'
    : '1H';

  // League name: season.displayName or top-level league
  const leagueName = safeStr(
    (ev.season && ev.season.displayName) ||
    (ev.league && ev.league.name) ||
    (comp.venue && comp.venue.fullName) || ''
  );

  return {
    match_id:             safeStr(ev.id || comp.id),
    match_hometeam_name:  safeStr((home.team||{}).displayName || (home.team||{}).name || (home.team||{}).abbreviation),
    match_awayteam_name:  safeStr((away.team||{}).displayName || (away.team||{}).name || (away.team||{}).abbreviation),
    match_hometeam_score: hg,
    match_awayteam_score: ag,
    match_live:           isLive ? '1' : '0',
    match_status:         matchStatus,
    minute,
    league_name:          leagueName,
    source:               'espn',
    _espnStatusType:      typeName,
    _isScheduled:         isScheduled,
    hasOdds:              false,
    odds:                 {},
  };
}

// ── Probe a single endpoint ───────────────────────────────────────────────────
async function probe(endpoint, opts = {}) {
  const { acceptScheduled = false, debug = true } = opts;
  const t0  = Date.now();
  const res = await client.get(endpoint);
  const durationMs = Date.now() - t0;

  const base = {
    provider:'espn_json', source:'espn', endpoint,
    status:  res.status,
    contentType: res.contentType || '',
    responseLength: res.text ? res.text.length : 0,
    jsonParseOk: false, topLevelKeys: [],
    rawEventCount: 0, parsedMatches: 0, acceptedEventCount: 0,
    matches: [], failReason: null, durationMs,
    sampleRawPreview: res.text ? res.text.slice(0, 300) : '',
    // Debug fields
    discoveredStatusTypes: [],
    discoveredLeagueSlugs: [],
    rejectedReasons: [],
    sampleEventIds: [],
    sampleStatusTypes: [],
  };

  if (!res.ok) {
    base.failReason = classifyStatus(res.status) || FAIL.HTTP_5XX;
    return base;
  }
  if (res.contentType && !res.contentType.includes('json') && !res.contentType.includes('javascript')) {
    base.failReason = FAIL.NON_JSON;
    return base;
  }

  let data;
  try { data = JSON.parse(res.text); base.jsonParseOk = true; }
  catch (e) { base.failReason = FAIL.JSON_PARSE; return base; }

  base.topLevelKeys = Object.keys(data || {}).slice(0, 15);

  // Events can be at data.events or data.scoreboard
  const events = data.events || data.scoreboard || data.data || [];
  if (!Array.isArray(events)) { base.failReason = FAIL.NO_EVENTS; return base; }
  base.rawEventCount = events.length;

  if (events.length === 0) { base.failReason = FAIL.EMPTY; return base; }

  // ── Debug: discover what status types / leagues are in the response ──
  if (debug) {
    const statusTypesSeen = new Set();
    const leaguesSeen = new Set();
    for (const ev of events.slice(0, 30)) {
      const comp = (ev.competitions || [])[0] || {};
      const st   = (comp.status && comp.status.type) || (ev.status && ev.status.type) || {};
      if (st.name) statusTypesSeen.add(st.name);
      const lg = (ev.season && ev.season.displayName) || (ev.league && ev.league.name);
      if (lg) leaguesSeen.add(lg);
    }
    base.discoveredStatusTypes = [...statusTypesSeen].slice(0, 10);
    base.discoveredLeagueSlugs = [...leaguesSeen].slice(0, 10);
    base.sampleEventIds        = events.slice(0, 5).map(e => e.id);
    base.sampleStatusTypes     = events.slice(0, 5).map(e => {
      const comp = (e.competitions||[])[0]||{};
      const st   = (comp.status&&comp.status.type)||(e.status&&e.status.type)||{};
      return st.name || '?';
    });

    // Log for Render
    console.log(`[espn] endpoint=${endpoint.split('/').pop()} events=${events.length} statusTypes=${base.discoveredStatusTypes.join(',')}`);
    if (events.length > 0 && base.discoveredStatusTypes.length === 0) {
      // Sample raw event structure for diagnosis
      const sample = events[0];
      console.log(`[espn] sample event keys: ${Object.keys(sample||{}).join(',')}`);
      const comp = (sample.competitions||[])[0]||{};
      console.log(`[espn] sample comp keys: ${Object.keys(comp||{}).join(',')}`);
      const st   = (comp.status||{});
      console.log(`[espn] sample status: ${JSON.stringify(st).slice(0,200)}`);
    }
  }

  // ── Normalize ──
  const rejected = [];
  const raw = [];
  for (const ev of events) {
    const m = normEspnEvent(ev, acceptScheduled);
    if (m) {
      raw.push(m);
    } else {
      const comp = (ev.competitions||[])[0]||{};
      const st   = (comp.status&&comp.status.type)||(ev.status&&ev.status.type)||{};
      rejected.push(st.name || 'unknown');
    }
  }
  base.acceptedEventCount  = raw.length;
  base.rejectedReasons     = [...new Set(rejected)].slice(0, 10);

  const liveOnly = raw.filter(m => m.match_live === '1');
  const norm     = normalizeMatches(liveOnly, 'espn');
  base.parsedMatches   = norm.length;
  base.matches         = norm;
  base.sampleMatches   = norm.slice(0, 2);

  if (norm.length > 0) {
    base.failReason = FAIL.OK;
  } else if (raw.length > 0) {
    // Got scheduled but no live — still report accepted count
    base.failReason = 'NO_LIVE_MATCHES_SCHEDULED_ONLY';
    base.acceptedScheduled = raw.filter(m => m._isScheduled).length;
  } else {
    base.failReason = FAIL.NO_EVENTS;
  }

  return base;
}

// ── fetch() — used by /live ───────────────────────────────────────────────────
async function fetch(_browser, _options) {
  const fetchedAt = Date.now();
  let bestLive    = null;
  let bestDebug   = null;

  for (const endpoint of PRIMARY_ENDPOINTS) {
    const r = await probe(endpoint, { acceptScheduled: false, debug: true });
    console.log(`[espn] ${endpoint.split('/').slice(-2).join('/')} → status=${r.status} events=${r.rawEventCount} live=${r.parsedMatches} statusTypes=${r.discoveredStatusTypes.slice(0,3).join(',')}`);

    if (r.parsedMatches > 0) { bestLive = r; break; }
    if (!bestDebug && r.status === 200) bestDebug = r;
  }

  const winner = bestLive || bestDebug;

  return {
    provider:   'espn_json',
    success:    !!(winner && winner.parsedMatches > 0),
    matches:    winner ? winner.matches : [],
    error:      winner ? (winner.parsedMatches > 0 ? null : winner.failReason) : 'no_endpoints_ok',
    fetchedAt,
    _auditResult: winner,
    _espnDebug: winner ? {
      endpoint:             winner.endpoint,
      rawEventCount:        winner.rawEventCount,
      discoveredStatusTypes:winner.discoveredStatusTypes,
      rejectedReasons:      winner.rejectedReasons,
      parsedMatches:        winner.parsedMatches,
    } : null,
  };
}

module.exports = {
  fetch, probe,
  provider: 'espn_json',
  needsPlaywright: false,
  ENDPOINTS: ALL_ENDPOINTS,
  PRIMARY_ENDPOINTS,
};
