/**
 * source_thesportsdb_json.js v11.02
 *
 * Public JSON endpoint probe. No API key supplied by user, no HTML scraping,
 * no browser automation, no proxy/captcha bypass.
 *
 * Primary live endpoint:
 *   https://www.thesportsdb.com/api/v1/json/3/livescore.php?s=Soccer
 *
 * Notes:
 * - TheSportsDB public test key "3" is a publicly documented demo endpoint.
 * - If provider returns empty/limited data, adapter gracefully fails.
 */
'use strict';

const { createHttpClient } = require('../http-client');
const { safeNum, safeStr, normalizeMatches } = require('../normalizer');

const provider = 'thesportsdb_json';

const ENDPOINTS = [
  'https://www.thesportsdb.com/api/v1/json/3/livescore.php?s=Soccer',
  'https://www.thesportsdb.com/api/v2/json/livescore/soccer',
];

const client = createHttpClient({
  referer:'https://www.thesportsdb.com/',
  origin:'https://www.thesportsdb.com',
  minPaceMs:700,
  timeoutMs:9000,
  maxRetries:1,
});

const FAIL = {
  OK:'OK_PARSED',
  NO_EVENTS:'NO_EVENTS_FOUND',
  NON_JSON:'NON_JSON_RESPONSE',
  JSON_PARSE:'JSON_PARSE_FAILED',
  HTTP_403:'HTTP_403',
  HTTP_404:'HTTP_404',
  HTTP_429:'HTTP_429',
  HTTP_5XX:'HTTP_5XX',
};

function classifyStatus(s) {
  if (s === 403) return FAIL.HTTP_403;
  if (s === 404) return FAIL.HTTP_404;
  if (s === 429) return FAIL.HTTP_429;
  if (s >= 500) return FAIL.HTTP_5XX;
  return null;
}

function arrify(v) {
  if (Array.isArray(v)) return v;
  if (!v || typeof v !== 'object') return [];
  for (const k of ['events','event','livescore','livescores','matches','results']) {
    if (Array.isArray(v[k])) return v[k];
  }
  return [];
}

function liveLike(e) {
  const status = String(e.strStatus || e.status || e.strProgress || e.strEventStatus || '').toLowerCase();
  const progress = String(e.strProgress || e.intProgress || e.minute || e.intMinute || '').toLowerCase();
  if (status.includes('live') || status.includes('in play') || status.includes('in_play')) return true;
  if (progress.includes("'") || progress.includes('ht')) return true;
  const min = parseInt(progress, 10);
  return !isNaN(min) && min > 0 && min < 140;
}

function normEvent(e) {
  if (!e || !liveLike(e)) return null;
  const progress = e.strProgress || e.intProgress || e.minute || e.intMinute || e.strStatus || 'LIVE';
  const minute = parseInt(String(progress).replace(/[^\d]/g, ''), 10);
  return {
    match_id: safeStr(e.idEvent || e.id || e.eventId || e.idLiveScore),
    match_hometeam_name: safeStr(e.strHomeTeam || e.homeTeam || e.home || e.strTeam1),
    match_awayteam_name: safeStr(e.strAwayTeam || e.awayTeam || e.away || e.strTeam2),
    match_hometeam_score: safeNum(e.intHomeScore ?? e.homeScore ?? e.intScoreHome ?? e.scoreHome, 0),
    match_awayteam_score: safeNum(e.intAwayScore ?? e.awayScore ?? e.intScoreAway ?? e.scoreAway, 0),
    match_live:'1',
    match_status: String(progress || 'LIVE'),
    minute: isNaN(minute) ? null : minute,
    league_name: safeStr(e.strLeague || e.league || e.strCompetition),
    source:'thesportsdb',
    hasOdds:false,
    hasStats:false,
    stats:{},
    odds:{},
  };
}

async function probe(endpoint) {
  const t0 = Date.now();
  const res = await client.get(endpoint);
  const base = {
    provider, source:'thesportsdb', endpoint,
    status:res.status, contentType:res.contentType || '',
    responseLength:res.text ? res.text.length : 0,
    jsonParseOk:false, topLevelKeys:[],
    rawEventCount:0, parsedMatches:0, acceptedEventCount:0,
    matches:[], failReason:null,
    durationMs:Date.now()-t0,
    sampleRawPreview:res.text ? res.text.slice(0,500) : '',
    sampleStatusTypes:[],
    rejectedReasons:[],
  };

  if (!res.ok) { base.failReason = classifyStatus(res.status) || FAIL.HTTP_5XX; return base; }
  if (!String(res.contentType || '').includes('json')) { base.failReason = FAIL.NON_JSON; return base; }

  let data;
  try { data = JSON.parse(res.text); base.jsonParseOk = true; }
  catch(e) { base.failReason = FAIL.JSON_PARSE; return base; }

  base.topLevelKeys = Object.keys(data || {}).slice(0,12);
  const raw = arrify(data);
  base.rawEventCount = raw.length;
  const mapped = raw.map(normEvent).filter(Boolean);
  base.acceptedEventCount = mapped.length;
  const norm = normalizeMatches(mapped, 'thesportsdb');
  base.matches = norm;
  base.parsedMatches = norm.length;
  base.sampleMatches = norm.slice(0,2);
  base.failReason = norm.length ? FAIL.OK : FAIL.NO_EVENTS;
  return base;
}

async function fetch(_browser, _options) {
  const fetchedAt = Date.now();
  let best = null;
  for (const ep of ENDPOINTS) {
    const r = await probe(ep);
    console.log(`[thesportsdb] ${ep} → status=${r.status} raw=${r.rawEventCount} matches=${r.parsedMatches} reason=${r.failReason}`);
    if (r.parsedMatches > 0) return { provider, success:true, matches:r.matches, error:null, fetchedAt, _auditResult:r };
    if (!best || r.status === 200) best = r;
  }
  return { provider, success:false, matches:[], error:best ? best.failReason : 'all_failed', fetchedAt, _auditResult:best };
}

module.exports = { provider, needsPlaywright:false, ENDPOINTS, fetch, probe };
