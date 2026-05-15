/**
 * source_espn_json.js v10.87
 *
 * Tests ESPN's public undocumented JSON endpoints.
 * ESPN serves JSON for their own web/app clients — no auth required.
 * No HTML scraping. No browser automation. No anti-bot bypass.
 *
 * Endpoints probed:
 *   https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard
 *
 * robots.txt: ESPN's robots.txt does not disallow /apis/ for general bots.
 */
'use strict';

const { createHttpClient } = require('../http-client');
const { safeNum, safeStr, normalizeMatches } = require('../normalizer');

const ENDPOINTS = [
  'https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard',
  'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard', // Premier League
  'https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1/scoreboard', // MLS
];

const client = createHttpClient({
  referer:   'https://www.espn.com/soccer/',
  origin:    'https://www.espn.com',
  minPaceMs: 500,
  timeoutMs: 8000,
  maxRetries: 1,
});

// Fail reason constants
const FAIL = {
  HTTP_403:         'HTTP_403',
  HTTP_404:         'HTTP_404',
  HTTP_429:         'HTTP_429',
  HTTP_5XX:         'HTTP_5XX',
  NON_JSON:         'NON_JSON_RESPONSE',
  JSON_PARSE:       'JSON_PARSE_FAILED',
  EMPTY:            'EMPTY_RESPONSE',
  NO_EVENTS:        'NO_EVENTS_FOUND',
  PARSE_FAILED:     'PARSE_FAILED',
  OK:               'OK_PARSED',
};

function classifyStatus(status) {
  if (status === 403) return FAIL.HTTP_403;
  if (status === 404) return FAIL.HTTP_404;
  if (status === 429) return FAIL.HTTP_429;
  if (status >= 500)  return FAIL.HTTP_5XX;
  return null;
}

// ESPN live status: in ('STATUS_IN_PROGRESS','STATUS_HALFTIME','STATUS_END_PERIOD')
const ESPN_LIVE = ['STATUS_IN_PROGRESS','STATUS_HALFTIME','STATUS_END_PERIOD','STATUS_EXTRA_TIME','STATUS_PENALTY'];

function normEspnEvent(ev) {
  const comp    = (ev.competitions || [])[0] || {};
  const status  = (comp.status && comp.status.type) || {};
  const stateName = status.name || '';
  if (!ESPN_LIVE.includes(stateName)) return null;

  const competitors = comp.competitors || [];
  const home = competitors.find(c => c.homeAway === 'home') || competitors[0] || {};
  const away = competitors.find(c => c.homeAway === 'away') || competitors[1] || {};

  return {
    match_id:             safeStr(ev.id),
    match_hometeam_name:  safeStr((home.team||{}).displayName||(home.team||{}).name),
    match_awayteam_name:  safeStr((away.team||{}).displayName||(away.team||{}).name),
    match_hometeam_score: safeNum(home.score, 0),
    match_awayteam_score: safeNum(away.score, 0),
    match_live:           '1',
    match_status:         stateName === 'STATUS_HALFTIME' ? 'HT' : stateName === 'STATUS_EXTRA_TIME' ? 'ET' : '1H',
    minute:               safeNum(status.displayClock ? parseInt(status.displayClock) : null),
    league_name:          safeStr(ev.season && ev.season.displayName || (ev.league && ev.league.name) || ''),
    source:               'espn',
    hasOdds:              false,
    odds:                 {},
  };
}

async function probe(endpoint) {
  const t0  = Date.now();
  const res = await client.get(endpoint);
  const durationMs = Date.now() - t0;

  const base = {
    provider:       'espn_json',
    source:         'espn',
    endpoint,
    status:         res.status,
    contentType:    res.contentType || '',
    responseLength: res.text ? res.text.length : 0,
    jsonParseOk:    false,
    topLevelKeys:   [],
    parsedMatches:  0,
    matches:        [],
    failReason:     null,
    durationMs,
    sampleRawPreview: res.text ? res.text.slice(0, 300) : '',
  };

  if (!res.ok) {
    base.failReason = classifyStatus(res.status) || FAIL.HTTP_5XX;
    return base;
  }
  if (!res.contentType.includes('json')) {
    base.failReason = FAIL.NON_JSON;
    return base;
  }

  let data;
  try { data = JSON.parse(res.text); base.jsonParseOk = true; }
  catch (e) { base.failReason = FAIL.JSON_PARSE; return base; }

  base.topLevelKeys = Object.keys(data || {}).slice(0, 12);

  const events = data.events || data.scoreboard || [];
  if (!Array.isArray(events) || events.length === 0) {
    base.failReason = FAIL.NO_EVENTS;
    return base;
  }

  const raw  = events.map(normEspnEvent).filter(Boolean);
  const norm = normalizeMatches(raw, 'espn');
  base.parsedMatches    = norm.length;
  base.matches          = norm;
  base.failReason       = norm.length > 0 ? FAIL.OK : FAIL.NO_EVENTS;
  base.sampleMatches    = norm.slice(0, 2);

  return base;
}

async function fetch(_browser, _options) {
  const fetchedAt = Date.now();
  let best = null;

  for (const endpoint of ENDPOINTS) {
    const result = await probe(endpoint);
    console.log(`[espn] ${endpoint} → status=${result.status} matches=${result.parsedMatches} reason=${result.failReason}`);
    if (result.parsedMatches > 0) { best = result; break; }
    if (!best || result.status === 200) best = result;
  }

  if (best && best.parsedMatches > 0) {
    return { provider:'espn_json', success:true, matches:best.matches, error:null, fetchedAt, _auditResult:best };
  }
  return { provider:'espn_json', success:false, matches:[], error:best ? best.failReason : 'all_endpoints_failed', fetchedAt, _auditResult:best };
}

module.exports = { fetch, probe, provider:'espn_json', needsPlaywright:false, ENDPOINTS };
