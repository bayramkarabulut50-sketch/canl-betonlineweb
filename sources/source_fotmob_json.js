/**
 * source_fotmob_json.js v11.05
 *
 * No-key public JSON probe for FotMob-style match JSON.
 * No HTML parsing, no browser automation, no proxy, no anti-bot bypass.
 *
 * Important: if provider returns 404/403, adapter fails gracefully.
 */
'use strict';

const { createHttpClient } = require('../http-client');
const { safeNum, safeStr, normalizeMatches } = require('../normalizer');

const provider = 'fotmob_json';

const FAIL = {
  HTTP_403:'HTTP_403', HTTP_404:'HTTP_404', HTTP_429:'HTTP_429',
  HTTP_5XX:'HTTP_5XX', NON_JSON:'NON_JSON_RESPONSE', JSON_PARSE:'JSON_PARSE_FAILED',
  EMPTY:'EMPTY_RESPONSE', NO_EVENTS:'NO_EVENTS_FOUND', OK:'OK_PARSED',
};

const client = createHttpClient({
  referer:   'https://www.fotmob.com/',
  origin:    'https://www.fotmob.com',
  minPaceMs: 900,
  timeoutMs: 9000,
  maxRetries: 1,
});

function yyyymmdd(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toISOString().slice(0,10).replace(/-/g,'');
}

function endpointList() {
  const dates = [-1, 0, 1].map(yyyymmdd);
  const eps = [];
  for (const date of dates) {
    eps.push(`https://www.fotmob.com/api/matches?date=${date}`);
    eps.push(`https://www.fotmob.com/api/matches?date=${date}&timezone=UTC`);
    eps.push(`https://www.fotmob.com/api/matches?date=${date}&ccode3=USA`);
    eps.push(`https://www.fotmob.com/matches?date=${date}`);
    eps.push(`https://www.fotmob.com/?date=${date}`);
  }
  return eps;
}

function classifyStatus(s) {
  if (s===403) return FAIL.HTTP_403;
  if (s===404) return FAIL.HTTP_404;
  if (s===429) return FAIL.HTTP_429;
  if (s>=500)  return FAIL.HTTP_5XX;
  return null;
}


function tryParseFotmobHtml(text) {
  if (!text || typeof text !== 'string') return null;
  // Classic Next.js payload
  const m = text.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (m) {
    try { return JSON.parse(m[1]); } catch(e) {}
  }
  // App router payload sometimes stores escaped JSON chunks. Extract candidate objects
  // containing "matches" or "leagues" and parse the largest one.
  const candidates = [];
  const re = /\{[^<>]{100,}?(?:matches|leagues)[^<>]{100,}?\}/g;
  let x;
  while ((x = re.exec(text)) && candidates.length < 20) candidates.push(x[0]);
  candidates.sort((a,b)=>b.length-a.length);
  for (const c of candidates) {
    try { return JSON.parse(c.replace(/\\"/g, '"')); } catch(e) {}
  }
  return null;
}

function extractMatches(data) {
  const matches = [];
  if (!data || typeof data !== 'object') return matches;

  if (Array.isArray(data.matches)) matches.push(...data.matches);

  if (Array.isArray(data.leagues)) {
    for (const lg of data.leagues) {
      const lgName = lg.name || lg.localizedName || lg.primaryId || '';
      for (const m of (lg.matches || [])) {
        if (m && typeof m === 'object' && !m.leagueName) m.leagueName = lgName;
        matches.push(m);
      }
    }
  }

  if (data.data && Array.isArray(data.data.matches)) matches.push(...data.data.matches);
  if (data.data && Array.isArray(data.data.leagues)) {
    for (const lg of data.data.leagues) for (const m of (lg.matches || [])) matches.push(m);
  }

  return matches;
}

function parseMinute(status) {
  const raw = status && status.liveTime && (status.liveTime.short || status.liveTime.long) || status && (status.utcTime || status.reason) || '';
  const n = parseInt(String(raw).replace(/[^\d]/g,''), 10);
  return isNaN(n) ? null : n;
}

function isLive(m) {
  const st = m.status || {};
  const raw = [
    st.liveTime && st.liveTime.short,
    st.liveTime && st.liveTime.long,
    st.reason,
    st.status,
    m.statusId,
    m.status,
  ].filter(Boolean).join(' ').toLowerCase();

  if (st.started === true && st.finished !== true && st.cancelled !== true) return true;
  if (raw.includes('ht') || raw.includes('half') || raw.includes('live') || raw.includes('1h') || raw.includes('2h')) return true;
  const min = parseMinute(st);
  return min != null && min > 0 && min < 140 && st.finished !== true;
}

function normMatch(m) {
  if (!m || !isLive(m)) return null;
  const home = m.home || m.homeTeam || {};
  const away = m.away || m.awayTeam || {};
  const st = m.status || {};
  const minute = parseMinute(st);
  return {
    match_id: safeStr(m.id || m.matchId || m.eventId),
    match_hometeam_name: safeStr(home.name || home.longName || home.shortName),
    match_awayteam_name: safeStr(away.name || away.longName || away.shortName),
    match_hometeam_score: safeNum(home.score ?? m.homeScore, 0),
    match_awayteam_score: safeNum(away.score ?? m.awayScore, 0),
    match_live:'1',
    match_status: st.liveTime && st.liveTime.short ? st.liveTime.short : (minute ? String(minute) : 'LIVE'),
    minute,
    league_name: safeStr(m.leagueName || m.parentLeagueName || ''),
    source:'fotmob',
    hasOdds:false,
    hasStats:false,
    stats:{},
    odds:{},
    liveQualityTier:'BASIC_LIVE_ONLY',
    liveMode:'WATCH_ONLY',
    coverageNotes:['fotmob_basic_live_no_stats_no_odds'],
  };
}

async function probe(endpoint) {
  const t0 = Date.now();
  const res = await client.get(endpoint);
  const base = {
    provider, source:'fotmob', endpoint,
    status:res.status, contentType:res.contentType||'',
    responseLength:res.text?res.text.length:0,
    jsonParseOk:false, topLevelKeys:[],
    rawEventCount:0, parsedMatches:0, acceptedEventCount:0,
    matches:[], sampleMatches:[],
    failReason:null,
    durationMs:Date.now()-t0,
    sampleRawPreview:res.text?res.text.slice(0,400):'',
  };

  if (!res.ok) { base.failReason = classifyStatus(res.status) || FAIL.HTTP_5XX; return base; }

  let data;
  if (String(res.contentType || '').includes('json')) {
    try { data = JSON.parse(res.text); base.jsonParseOk = true; }
    catch(e) { base.failReason = FAIL.JSON_PARSE; return base; }
  } else if (String(res.contentType || '').includes('html')) {
    data = tryParseFotmobHtml(res.text);
    if (data) base.jsonParseOk = true;
    else { base.failReason = FAIL.NON_JSON; return base; }
  } else {
    base.failReason = FAIL.NON_JSON; return base;
  }

  base.topLevelKeys = Object.keys(data || {}).slice(0,12);
  const raw = extractMatches(data);
  base.rawEventCount = raw.length;
  const mapped = raw.map(normMatch).filter(Boolean);
  base.acceptedEventCount = mapped.length;
  const norm = normalizeMatches(mapped, 'fotmob');
  base.matches = norm;
  base.parsedMatches = norm.length;
  base.sampleMatches = norm.slice(0,2);
  base.failReason = norm.length ? FAIL.OK : FAIL.NO_EVENTS;
  return base;
}

async function fetch(_browser, _options) {
  // v11.18: parallel date probes
  const fetchedAt = Date.now();
  const eps = endpointList();
  const probeAll = eps.map(ep => probe(ep).catch(e => ({
    provider, source:'fotmob', endpoint:ep, status:null, parsedMatches:0, matches:[],
    failReason:'ENDPOINT_EXCEPTION', error:e.message, rawEventCount:0
  })));
  const results = await Promise.all(probeAll);

  for (const r of results) {
    console.log(`[fotmob] ${r.endpoint} → status=${r.status} raw=${r.rawEventCount} matches=${r.parsedMatches} reason=${r.failReason}`);
  }

  // Count blocked vs no-data
  const blocked = results.filter(r=>r.status===403||r.failReason===FAIL.HTTP_403).length;
  if (blocked === results.length) {
    const best = results[0];
    return { provider, success:false, matches:[], error:'HTTP_403_ALL_BLOCKED', fetchedAt, _auditResult:best };
  }

  // Merge all successful
  const allMatches = []; const seen = new Set();
  for (const r of results) {
    for (const m of (r.matches||[])) {
      const key = m.match_id||(m.match_hometeam_name+'___'+m.match_awayteam_name);
      if (!seen.has(key)){ seen.add(key); allMatches.push(m); }
    }
  }

  const best = results.find(r=>r.parsedMatches>0) || results.find(r=>r.status===200) || results[0];
  if (allMatches.length > 0) return { provider, success:true, matches:allMatches, error:null, fetchedAt, _auditResult:best };
  return { provider, success:false, matches:[], error:best ? best.failReason : 'no_live_events', fetchedAt, _auditResult:best };
}

module.exports = { provider, needsPlaywright:false, ENDPOINTS:endpointList(), fetch, probe };
