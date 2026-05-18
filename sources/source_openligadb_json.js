/**
 * source_openligadb_json.js v11.02
 *
 * Public JSON endpoint probe for OpenLigaDB. No auth, no HTML scraping.
 * Coverage is limited; useful as an additional no-cost source.
 */
'use strict';

const { createHttpClient } = require('../http-client');
const { safeNum, safeStr, normalizeMatches } = require('../normalizer');

const provider = 'openligadb_json';
const ENDPOINTS = [
  'https://api.openligadb.de/getmatchdata/bl1',
  'https://api.openligadb.de/getmatchdata/bl2',
  'https://api.openligadb.de/getmatchdata/dfb',
];

const client = createHttpClient({
  referer:'https://www.openligadb.de/',
  origin:'https://www.openligadb.de',
  minPaceMs:500,
  timeoutMs:9000,
  maxRetries:1,
});

const FAIL = { OK:'OK_PARSED', NO_EVENTS:'NO_EVENTS_FOUND', NON_JSON:'NON_JSON_RESPONSE', JSON_PARSE:'JSON_PARSE_FAILED', HTTP_403:'HTTP_403', HTTP_404:'HTTP_404', HTTP_429:'HTTP_429', HTTP_5XX:'HTTP_5XX' };

function classifyStatus(s) {
  if (s === 403) return FAIL.HTTP_403;
  if (s === 404) return FAIL.HTTP_404;
  if (s === 429) return FAIL.HTTP_429;
  if (s >= 500) return FAIL.HTTP_5XX;
  return null;
}

function scoreFromGoals(m, teamId) {
  const goals = Array.isArray(m.Goals) ? m.Goals : [];
  let n = 0;
  for (const g of goals) if (String(g.ScoreTeam1 ?? '') && g.ScoreTeam1 != null) {}
  // OpenLigaDB has final scores in MatchResults; during live may have Goals array.
  const last = goals[goals.length - 1];
  if (last) {
    if (teamId === 1) return safeNum(last.ScoreTeam1, 0);
    if (teamId === 2) return safeNum(last.ScoreTeam2, 0);
  }
  const results = Array.isArray(m.MatchResults) ? m.MatchResults : [];
  const current = results.find(r => r.ResultName === 'Endergebnis') || results[results.length-1];
  if (current) return teamId === 1 ? safeNum(current.PointsTeam1, 0) : safeNum(current.PointsTeam2, 0);
  return 0;
}

function isLive(m) {
  if (!m) return false;
  if (m.MatchIsFinished === true) return false;
  const now = Date.now();
  const t = Date.parse(m.MatchDateTimeUTC || m.MatchDateTime);
  if (isNaN(t)) return false;
  return now >= t && now <= t + 2.2 * 60 * 60 * 1000;
}

function normMatch(m) {
  if (!isLive(m)) return null;
  const t = Date.parse(m.MatchDateTimeUTC || m.MatchDateTime);
  const minute = isNaN(t) ? null : Math.max(1, Math.min(120, Math.floor((Date.now() - t) / 60000)));
  return {
    match_id: safeStr(m.MatchID),
    match_hometeam_name: safeStr(m.Team1 && (m.Team1.TeamName || m.Team1.ShortName)),
    match_awayteam_name: safeStr(m.Team2 && (m.Team2.TeamName || m.Team2.ShortName)),
    match_hometeam_score: scoreFromGoals(m, 1),
    match_awayteam_score: scoreFromGoals(m, 2),
    match_live:'1',
    match_status: minute ? String(minute) : 'LIVE',
    minute,
    league_name: safeStr(m.LeagueName || m.Group && m.Group.GroupName),
    source:'openligadb',
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
    provider, source:'openligadb', endpoint,
    status:res.status, contentType:res.contentType || '',
    responseLength:res.text ? res.text.length : 0,
    jsonParseOk:false, topLevelKeys:[],
    rawEventCount:0, parsedMatches:0, acceptedEventCount:0,
    matches:[], failReason:null,
    durationMs:Date.now()-t0,
    sampleRawPreview:res.text ? res.text.slice(0,500) : '',
  };
  if (!res.ok) { base.failReason = classifyStatus(res.status) || FAIL.HTTP_5XX; return base; }
  if (!String(res.contentType || '').includes('json')) { base.failReason = FAIL.NON_JSON; return base; }
  let data;
  try { data = JSON.parse(res.text); base.jsonParseOk = true; }
  catch(e) { base.failReason = FAIL.JSON_PARSE; return base; }

  const raw = Array.isArray(data) ? data : [];
  base.rawEventCount = raw.length;
  const mapped = raw.map(normMatch).filter(Boolean);
  base.acceptedEventCount = mapped.length;
  const norm = normalizeMatches(mapped, 'openligadb');
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
    console.log(`[openligadb] ${ep} → status=${r.status} raw=${r.rawEventCount} matches=${r.parsedMatches} reason=${r.failReason}`);
    if (r.parsedMatches > 0) return { provider, success:true, matches:r.matches, error:null, fetchedAt, _auditResult:r };
    if (!best || r.status === 200) best = r;
  }
  return { provider, success:false, matches:[], error:best ? best.failReason : 'all_failed', fetchedAt, _auditResult:best };
}

module.exports = { provider, needsPlaywright:false, ENDPOINTS, fetch, probe };
