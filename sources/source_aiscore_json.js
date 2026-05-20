/**
 * source_aiscore_json.js v10.87
 *
 * Tests AiScore public JSON endpoints.
 * AiScore (aiscore.com) serves JSON for their app clients.
 * No HTML scraping. No browser automation. No anti-bot bypass.
 *
 * Endpoints probed:
 *   https://api.aiscore.com/api/sport-competition-events?sportId=1&type=Live
 *   https://api.aiscore.com/sport/football/live
 */
'use strict';

const { createHttpClient } = require('../http-client');
const { safeNum, safeStr, normalizeMatches } = require('../normalizer');

const FAIL = {
  HTTP_403:'HTTP_403', HTTP_404:'HTTP_404', HTTP_429:'HTTP_429',
  HTTP_5XX:'HTTP_5XX', NON_JSON:'NON_JSON_RESPONSE', JSON_PARSE:'JSON_PARSE_FAILED',
  EMPTY:'EMPTY_RESPONSE', NO_EVENTS:'NO_EVENTS_FOUND', OK:'OK_PARSED',
};

const ENDPOINTS = [
  'https://api.aiscore.com/api/sport-competition-events?sportId=1&type=Live',
  'https://api.aiscore.com/sport/football/live',
  'https://www.aiscore.com/api/livescore?sport=football',
];

const client = createHttpClient({
  referer:   'https://www.aiscore.com/',
  origin:    'https://www.aiscore.com',
  minPaceMs: 600,
  timeoutMs: 8000,
  maxRetries: 1,
});

function classifyStatus(s) {
  if (s===403) return FAIL.HTTP_403; if (s===404) return FAIL.HTTP_404;
  if (s===429) return FAIL.HTTP_429; if (s>=500)  return FAIL.HTTP_5XX;
  return null;
}

function extractAiScoreMatches(data) {
  // Try multiple shapes
  if (Array.isArray(data)) return data;
  if (data.data && Array.isArray(data.data)) return data.data;
  if (data.events && Array.isArray(data.events)) return data.events;
  if (data.matches && Array.isArray(data.matches)) return data.matches;
  if (data.result && Array.isArray(data.result)) return data.result;
  return [];
}

function normAiScoreMatch(m) {
  if (!m) return null;
  const status = String(m.status||m.matchStatus||m.state||'').toLowerCase();
  const LIVE_STATUSES=['live','inplay','in play','1h','2h','ht','halftime'];
  const isLive=LIVE_STATUSES.some(l=>status.includes(l)) || m.isLive===true || m.live===true;
  if (!isLive) return null;
  return {
    match_id:             safeStr(m.id||m.matchId||m.eventId||''),
    match_hometeam_name:  safeStr(m.homeName||m.homeTeam||m.home||(m.homeTeam&&m.homeTeam.name)||''),
    match_awayteam_name:  safeStr(m.awayName||m.awayTeam||m.away||(m.awayTeam&&m.awayTeam.name)||''),
    match_hometeam_score: safeNum(m.homeScore||m.homeGoals||0,0),
    match_awayteam_score: safeNum(m.awayScore||m.awayGoals||0,0),
    match_live:'1', match_status:status.toUpperCase().slice(0,8),
    minute: safeNum(m.minute||m.matchMinute||m.time||null),
    league_name: safeStr(m.leagueName||m.competition||m.league||''),
    source:'aiscore', hasOdds:false, odds:{},
  };
}

async function probe(endpoint) {
  const t0=Date.now(); const res=await client.get(endpoint); const durationMs=Date.now()-t0;
  const base={
    provider:'aiscore_json',source:'aiscore',endpoint,status:res.status,
    contentType:res.contentType||'',responseLength:res.text?res.text.length:0,
    jsonParseOk:false,topLevelKeys:[],parsedMatches:0,matches:[],
    failReason:null,durationMs,sampleRawPreview:res.text?res.text.slice(0,300):'',
  };
  if (!res.ok) { base.failReason=classifyStatus(res.status)||FAIL.HTTP_5XX; return base; }
  if (!res.contentType.includes('json')) { base.failReason=FAIL.NON_JSON; return base; }
  let data;
  try { data=JSON.parse(res.text); base.jsonParseOk=true; }
  catch(e) { base.failReason=FAIL.JSON_PARSE; return base; }
  base.topLevelKeys=Object.keys(data||{}).slice(0,12);
  const raw=extractAiScoreMatches(data).map(normAiScoreMatch).filter(Boolean);
  const norm=normalizeMatches(raw,'aiscore');
  base.parsedMatches=norm.length; base.matches=norm;
  base.failReason=norm.length>0?FAIL.OK:FAIL.NO_EVENTS;
  base.sampleMatches=norm.slice(0,2);
  return base;
}

async function fetch(_browser, _options) {
  const fetchedAt=Date.now(); let best=null;
  for (const ep of ENDPOINTS) {
    const r=await probe(ep);
    console.log(`[aiscore] ${ep} → status=${r.status} matches=${r.parsedMatches} reason=${r.failReason}`);
    if (r.parsedMatches>0) { best=r; break; }
    if (!best||r.status===200) best=r;
  }
  if (best&&best.parsedMatches>0) {
    return { provider:'aiscore_json',success:true,matches:best.matches,error:null,fetchedAt,_auditResult:best };
  }
  return { provider:'aiscore_json',success:false,matches:[],error:best?best.failReason:'all_failed',fetchedAt,_auditResult:best };
}

module.exports = { fetch, probe, provider:'aiscore_json', needsPlaywright:false, ENDPOINTS };
