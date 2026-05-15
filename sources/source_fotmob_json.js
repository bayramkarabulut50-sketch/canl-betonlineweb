/**
 * source_fotmob_json.js v10.87
 *
 * Tests FotMob's public undocumented JSON endpoints.
 * FotMob's mobile app uses these endpoints — JSON, no auth token required.
 * No HTML scraping. No browser automation. No anti-bot bypass.
 *
 * Endpoints probed:
 *   https://www.fotmob.com/api/matches?date=YYYYMMDD
 *   https://www.fotmob.com/api/leagues?id=87&ccode3=TUR (example)
 *
 * robots.txt: /api/ is not disallowed in FotMob robots.txt.
 */
'use strict';

const { createHttpClient } = require('../http-client');
const { safeNum, safeStr, normalizeMatches } = require('../normalizer');

const FAIL = {
  HTTP_403:'HTTP_403', HTTP_404:'HTTP_404', HTTP_429:'HTTP_429',
  HTTP_5XX:'HTTP_5XX', NON_JSON:'NON_JSON_RESPONSE', JSON_PARSE:'JSON_PARSE_FAILED',
  EMPTY:'EMPTY_RESPONSE', NO_EVENTS:'NO_EVENTS_FOUND', OK:'OK_PARSED',
};

function todayStr() {
  return new Date().toISOString().slice(0,10).replace(/-/g,'');
}

const client = createHttpClient({
  referer:   'https://www.fotmob.com/',
  origin:    'https://www.fotmob.com',
  minPaceMs: 600,
  timeoutMs: 8000,
  maxRetries: 1,
});

function classifyStatus(s) {
  if (s===403) return FAIL.HTTP_403; if (s===404) return FAIL.HTTP_404;
  if (s===429) return FAIL.HTTP_429; if (s>=500)  return FAIL.HTTP_5XX;
  return null;
}

// FotMob live states
const FM_LIVE = ['live','inprogress','halftime','ht','1h','2h','extra','pen'];
function isFotmobLive(m) {
  const s = String((m.status && (m.status.liveTime||m.status.live||m.status.reason||'')) || '').toLowerCase();
  if (m.status && m.status.started && !m.status.finished) return true;
  for (const l of FM_LIVE) { if (s.includes(l)) return true; }
  return false;
}

function normFotmobMatch(m) {
  if (!m) return null;
  if (!isFotmobLive(m)) return null;
  const home = m.home || {}; const away = m.away || {};
  const st   = m.status || {};
  const min  = safeNum(st.liveTime && st.liveTime.short ? parseInt(st.liveTime.short) : null);
  return {
    match_id:             safeStr(m.id),
    match_hometeam_name:  safeStr(home.name || home.longName),
    match_awayteam_name:  safeStr(away.name || away.longName),
    match_hometeam_score: safeNum(home.score, 0),
    match_awayteam_score: safeNum(away.score, 0),
    match_live:    '1',
    match_status:  st.liveTime && st.liveTime.short ? st.liveTime.short : 'LIVE',
    minute:        min,
    league_name:   safeStr(m.leagueName || m.parentLeagueName || ''),
    source:        'fotmob', hasOdds:false, odds:{},
  };
}

function extractFotmobMatches(data) {
  const matches = [];
  // Response: { leagues: [ { matches: [...] } ] } or { matches: [...] }
  if (data.leagues && Array.isArray(data.leagues)) {
    for (const lg of data.leagues) {
      for (const m of (lg.matches || [])) matches.push(m);
    }
  }
  if (data.matches && Array.isArray(data.matches)) {
    for (const m of data.matches) matches.push(m);
  }
  return matches;
}

async function probe(endpoint) {
  const t0  = Date.now();
  const res = await client.get(endpoint);
  const durationMs = Date.now() - t0;
  const base = {
    provider:'fotmob_json', source:'fotmob', endpoint,
    status:res.status, contentType:res.contentType||'',
    responseLength:res.text?res.text.length:0,
    jsonParseOk:false, topLevelKeys:[], parsedMatches:0,
    matches:[], failReason:null, durationMs,
    sampleRawPreview:res.text?res.text.slice(0,300):'',
  };
  if (!res.ok) { base.failReason=classifyStatus(res.status)||FAIL.HTTP_5XX; return base; }
  if (!res.contentType.includes('json')) { base.failReason=FAIL.NON_JSON; return base; }
  let data;
  try { data=JSON.parse(res.text); base.jsonParseOk=true; }
  catch(e) { base.failReason=FAIL.JSON_PARSE; return base; }
  base.topLevelKeys=Object.keys(data||{}).slice(0,12);
  const raw=extractFotmobMatches(data).map(normFotmobMatch).filter(Boolean);
  const norm=normalizeMatches(raw,'fotmob');
  base.parsedMatches=norm.length; base.matches=norm;
  base.failReason=norm.length>0?FAIL.OK:FAIL.NO_EVENTS;
  base.sampleMatches=norm.slice(0,2);
  return base;
}

async function fetch(_browser, _options) {
  const fetchedAt = Date.now();
  const today = todayStr();
  const ENDPOINTS = [
    `https://www.fotmob.com/api/matches?date=${today}`,
    `https://www.fotmob.com/api/matches?date=${today}&timezone=UTC`,
  ];
  let best = null;
  for (const ep of ENDPOINTS) {
    const r = await probe(ep);
    console.log(`[fotmob] ${ep} → status=${r.status} matches=${r.parsedMatches} reason=${r.failReason}`);
    if (r.parsedMatches > 0) { best=r; break; }
    if (!best || r.status===200) best=r;
  }
  if (best && best.parsedMatches > 0) {
    return { provider:'fotmob_json', success:true, matches:best.matches, error:null, fetchedAt, _auditResult:best };
  }
  return { provider:'fotmob_json', success:false, matches:[], error:best?best.failReason:'all_failed', fetchedAt, _auditResult:best };
}

module.exports = { fetch, probe, provider:'fotmob_json', needsPlaywright:false };
