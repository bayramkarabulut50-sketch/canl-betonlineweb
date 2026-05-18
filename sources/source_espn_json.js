/**
 * source_espn_json.js v11.01-live-status-final
 *
 * ESPN public JSON — live match extraction + stats endpoint discovery.
 * Secondary endpoints probed per event: summary, statistics, situation.
 * No HTML scraping. No browser automation. No anti-bot bypass.
 */
'use strict';

const { createHttpClient } = require('../http-client');
const { safeNum, safeStr, normalizeMatches } = require('../normalizer');

const LEAGUE_SLUGS = [
  // Broad ESPN public soccer JSON coverage.
  // Some slugs may return 404 depending on region/season; probe skips gracefully.
  'all',

  // Europe top leagues
  'eng.1', 'eng.2', 'eng.3',
  'esp.1', 'esp.2',
  'ger.1', 'ger.2',
  'ita.1', 'ita.2',
  'fra.1', 'fra.2',
  'ned.1', 'por.1', 'bel.1', 'sco.1', 'tur.1',

  // International / UEFA
  'uefa.champions',
  'uefa.europa',
  'uefa.europa.conf',
  'uefa.nations',
  'fifa.world',
  'fifa.friendly',

  // Americas
  'usa.1', 'usa.nwsl',
  'mex.1',
  'bra.1',
  'arg.1',
  'conmebol.libertadores',
  'conmebol.sudamericana',

  // Asia / other commonly available ESPN slugs
  'ind.1', 'aus.1', 'jpn.1', 'kor.1',
  'ksa.1',
];
const BASE      = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const SITE_BASE = 'https://site.web.api.espn.com/apis/site/v2/sports/soccer';
const WEB_BASE  = 'https://site.web.api.espn.com/apis/v2/sports/soccer';
const FORCE_ESPN_DETAILS = process.env.FORCE_ESPN_DETAILS !== 'false';
const ALL_ENDPOINTS    = LEAGUE_SLUGS.map(s => `${BASE}/${s}/scoreboard`);
// v10.99: scan all configured slugs in /live, not only first 5. This fixes false 0-live when active games are outside top-5 slugs.
const PRIMARY_ENDPOINTS = LEAGUE_SLUGS.map(s => `${BASE}/${s}/scoreboard`);

// Per-event detail endpoint patterns
const DETAIL_PATHS = ['summary'];
function summaryUrlCandidates(slug, eventId) {
  const cleanSlug = slug || 'all';
  const slugs = [...new Set([cleanSlug, 'all', 'usa.1', 'eng.1'].filter(Boolean))];
  const urls = [];
  for (const s of slugs) {
    urls.push(`${BASE}/${s}/summary?event=${eventId}`);
    urls.push(`${SITE_BASE}/${s}/summary?event=${eventId}&lang=en&region=us`);
    urls.push(`${WEB_BASE}/${s}/summary?event=${eventId}&lang=en&region=us`);
  }
  return [...new Set(urls)];
}

const FAIL = {
  HTTP_403:'HTTP_403', HTTP_404:'HTTP_404', HTTP_429:'HTTP_429',
  HTTP_5XX:'HTTP_5XX', NON_JSON:'NON_JSON_RESPONSE', JSON_PARSE:'JSON_PARSE_FAILED',
  NO_EVENTS:'NO_EVENTS_FOUND', OK:'OK_PARSED', EMPTY:'EMPTY_RESPONSE',
};

function classifyStatus(s) {
  if (s===403) return FAIL.HTTP_403; if (s===404) return FAIL.HTTP_404;
  if (s===429) return FAIL.HTTP_429; if (s>=500) return FAIL.HTTP_5XX;
  return null;
}

const client = createHttpClient({
  referer:   'https://www.espn.com/soccer/',
  origin:    'https://www.espn.com',
  minPaceMs: 400,
  timeoutMs: 9000,
  maxRetries: 1,
});

const ESPN_LIVE = new Set([
  // ESPN soccer status.type.name values
  'STATUS_IN_PROGRESS',
  'STATUS_HALFTIME',
  'STATUS_HALF_TIME',
  'STATUS_END_PERIOD',
  'STATUS_FIRST_HALF',
  'STATUS_SECOND_HALF',
  'STATUS_EXTRA_TIME',
  'STATUS_EXTRA_TIME_HALF_TIME',
  'STATUS_FIRST_EXTRA',
  'STATUS_SECOND_EXTRA',
  'STATUS_OVERTIME',
  'STATUS_PENALTY',
  'STATUS_AWAITING_PENALTIES',
  'STATUS_PENALTY_SHOOTOUT',

  // ESPN sometimes exposes state/detail style values instead of name
  'IN',
  'LIVE',
  'HALFTIME',
  'HALF_TIME',
  '1H',
  '2H',
  'HT',
  'ET',
  'PEN'
]);

const ESPN_SCHEDULED = new Set([
  'STATUS_SCHEDULED',
  'STATUS_PREGAME',
  'PRE',
  'SCHEDULED'
]);

const ESPN_FINAL = new Set([
  'STATUS_FULL_TIME',
  'STATUS_FINAL',
  'STATUS_FINAL_PEN',
  'STATUS_FINAL_AET',
  'FULL_TIME',
  'FINAL',
  'POST'
]);

function normalizeEspnStatus(statusType = {}) {
  const parts = [
    statusType.name,
    statusType.state,
    statusType.detail,
    statusType.shortDetail,
    statusType.description
  ].filter(Boolean).map(x => String(x).trim().toUpperCase());
  return parts;
}

function isEspnLiveStatus(statusType = {}) {
  const parts = normalizeEspnStatus(statusType);
  if (parts.some(p => ESPN_LIVE.has(p))) return true;
  // Some payloads have state:"in" but name/detail empty.
  if (parts.includes('IN')) return true;
  return false;
}

function isEspnScheduledStatus(statusType = {}) {
  const parts = normalizeEspnStatus(statusType);
  return parts.some(p => ESPN_SCHEDULED.has(p));
}

function isEspnFinalStatus(statusType = {}) {
  const parts = normalizeEspnStatus(statusType);
  if (statusType.completed === true) return true;
  return parts.some(p => ESPN_FINAL.has(p));
}

// ── Event normalizer (scoreboard payload) ─────────────────────────────────────
function normEspnEvent(ev, acceptScheduled = false) {
  if (!ev) return null;
  const comp     = (ev.competitions || [])[0] || {};
  const statusType = (comp.status && comp.status.type) || (ev.status && ev.status.type) || {};
  const statusParts = normalizeEspnStatus(statusType);
  const typeName   = statusParts[0] || '';
  const isLive      = isEspnLiveStatus(statusType);
  const isScheduled = isEspnScheduledStatus(statusType);
  const isFinal     = isEspnFinalStatus(statusType);
  const eventId     = safeStr(ev.id || (ev.competitions&&ev.competitions[0]&&ev.competitions[0].id) || '');

  // Per-event filter log — always emitted so Render shows exactly what's happening
  console.log(`[espn-filter] id=${eventId} status="${typeName}" parts=${JSON.stringify(statusParts)} completed=${!!statusType.completed} isLive=${isLive} isScheduled=${isScheduled} isFinal=${isFinal} accepted=${isLive}`);

  if (!typeName) {
    console.log(`[espn-filter] REJECT_NO_STATUS id=${eventId}`);
    return null;
  }
  if (!isLive && !(acceptScheduled && isScheduled)) {
    console.log(`[espn-filter] REJECT_NOT_LIVE id=${eventId} status="${typeName}"`);
    return null;
  }

  const competitors = comp.competitors || ev.competitors || [];
  const home = competitors.find(c => c.homeAway==='home') || competitors[0] || {};
  const away = competitors.find(c => c.homeAway==='away') || competitors[1] || {};
  const clock  = statusType.displayClock || (comp.status && comp.status.displayClock) || '';
  const minute = clock ? safeNum(parseInt(clock)) : safeNum(statusType.period);
  const ms = (
    (typeName==='STATUS_HALFTIME'||typeName==='STATUS_HALF_TIME') ? 'HT' :
    (typeName==='STATUS_FIRST_HALF'||typeName==='STATUS_IN_PROGRESS') ? '1H' :
    (typeName==='STATUS_SECOND_HALF') ? '2H' :
    (typeName==='STATUS_EXTRA_TIME'||typeName==='STATUS_FIRST_EXTRA'||typeName==='STATUS_SECOND_EXTRA'||typeName==='STATUS_EXTRA_TIME_HALF_TIME') ? 'ET' :
    (typeName==='STATUS_PENALTY'||typeName==='STATUS_PENALTY_SHOOTOUT'||typeName==='STATUS_AWAITING_PENALTIES') ? 'PEN' :
    typeName==='STATUS_OVERTIME' ? 'OT' :
    isScheduled ? 'SCH' : 'LIVE'
  );
  const leagueName = safeStr((ev.season&&ev.season.displayName)||(ev.league&&ev.league.name)||'');

  // Odds from scoreboard level (sometimes present)
  let odds = {};
  const compOdds = comp.odds || ev.odds || [];
  if (Array.isArray(compOdds) && compOdds.length > 0) {
    const o = compOdds[0] || {};
    odds = {
      home: safeNum(o.homeTeamOdds && (o.homeTeamOdds.moneyLine || o.homeTeamOdds.value)),
      away: safeNum(o.awayTeamOdds && (o.awayTeamOdds.moneyLine || o.awayTeamOdds.value)),
      draw: safeNum(o.drawOdds && (o.drawOdds.moneyLine || o.drawOdds.value)),
    };
  }

  const match_id = safeStr(ev.id || comp.id || '');
  // Log if match_id empty — would break detail fetch
  if (!match_id) console.log('[espn-details] WARNING: event has no id', JSON.stringify(ev).slice(0,100));

  return {
    match_id,
    match_hometeam_name:  safeStr((home.team||{}).displayName||(home.team||{}).name||(home.team||{}).abbreviation),
    match_awayteam_name:  safeStr((away.team||{}).displayName||(away.team||{}).name||(away.team||{}).abbreviation),
    match_hometeam_score: safeNum(home.score, 0),
    match_awayteam_score: safeNum(away.score, 0),
    match_live:           isLive ? '1' : '0',
    match_status:         ms,
    minute,
    league_name:          leagueName,
    _leagueSlug:          ev._leagueSlug || '',   // passed from probe() loop
    source:               'espn',
    _espnStatusType:      typeName,
    _isScheduled:         isScheduled,
    hasOdds:              Object.values(odds).some(v => v !== null),
    odds,
    hasStats:             false,
    stats:                {},
  };
}

// ── Stats extraction from ESPN summary JSON ───────────────────────────────────
function parseStatVal(v) {
  if (v == null || v === '' || v === '-') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const raw = String(v).trim();
  // Handles "53%", "7", "7.0", "7-3" (uses first number)
  const m = raw.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function normalizeStatName(rawName) {
  return safeStr(rawName)
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

function pushTeamStatsIntoMap(map, teams) {
  if (!Array.isArray(teams)) return;
  for (let ti = 0; ti < Math.min(teams.length, 2); ti++) {
    const teamNode = teams[ti] || {};
    const side = (teamNode.homeAway === 'away' || teamNode.team?.homeAway === 'away' || ti === 1) ? 'away' : 'home';
    const stats = teamNode.statistics || teamNode.stats || teamNode.teamStats || [];
    if (!Array.isArray(stats)) continue;
    for (const st of stats) {
      const name = normalizeStatName(st.name || st.label || st.displayName || st.shortDisplayName || st.abbreviation);
      if (!name) continue;
      const val = parseStatVal(st.displayValue ?? st.value ?? st.displayValueShort ?? st.summary);
      if (!map[name]) map[name] = { home:null, away:null };
      map[name][side] = val;
    }
  }
}

// ── Stats extraction from ESPN summary JSON ───────────────────────────────────
function extractEspnStats(summaryData) {
  if (!summaryData) return null;

  const map = {};

  // Shape 1: summary.statistics[*].teams[*].statistics[*]
  const statGroups = summaryData.statistics || summaryData.stats || [];
  if (Array.isArray(statGroups)) {
    for (const group of statGroups) {
      pushTeamStatsIntoMap(map, group.teams || group.team || group.competitors || []);
    }
  }

  // Shape 2: summary.boxscore.teams[*].statistics[*]
  if (summaryData.boxscore) {
    pushTeamStatsIntoMap(map, summaryData.boxscore.teams || summaryData.boxscore.competitors || []);
  }

  // Shape 3: summary.header.competitions[0].competitors[*].statistics[*]
  const headerComp = summaryData.header?.competitions?.[0];
  if (headerComp) {
    pushTeamStatsIntoMap(map, headerComp.competitors || []);
  }

  // Odds from summary / pickcenter / competitions
  let oddsFound = false;
  let odds = {};
  const summaryOdds = summaryData.odds || summaryData.pickcenter || summaryData.header?.competitions?.[0]?.odds || [];
  if (Array.isArray(summaryOdds) && summaryOdds.length > 0) {
    const o = summaryOdds[0] || {};
    odds = {
      home: safeNum(o.homeTeamOdds && (o.homeTeamOdds.moneyLine || o.homeTeamOdds.value || o.homeTeamOdds.odds)),
      away: safeNum(o.awayTeamOdds && (o.awayTeamOdds.moneyLine || o.awayTeamOdds.value || o.awayTeamOdds.odds)),
      draw: safeNum(o.drawOdds && (o.drawOdds.moneyLine || o.drawOdds.value || o.drawOdds.odds)),
      over_25: safeNum(o.overUnder),
    };
    oddsFound = Object.values(odds).some(v => v !== null);
  }

  const pick = (...keys) => { for (const k of keys) if (map[k]) return map[k]; return null; };
  const sum  = s => s ? ((s.home ?? 0) + (s.away ?? 0)) : null;
  const home = s => s ? s.home : null;
  const away = s => s ? s.away : null;

  const result = {
    attacks:           sum(pick('attacks','total_attacks')),
    dangerous_attacks: sum(pick('dangerous_attacks')),
    // ESPN soccer summary commonly returns keys like:
    // won_corners, total_shots, shots_on_target, possession_pct, yellow_cards, red_cards.
    // Keep many aliases so canonical output does not silently lose useful stats.
    shots_total:       sum(pick('shots','total_shots','shot','shots_total','total_shots_on_goal','total_shots_attempted','shot_attempts')),
    shots_on_target:   sum(pick('shots_on_target','on_target','on_goal','shots_on_goal','shots_on_target_total','shots_on_target_total','shots_on_target_pct')),
    corners:           sum(pick('won_corners','corner_kicks','cornerkicks','corners','corner','corners_won','corner_kicks_won','total_corners')),
    possession_home:   home(pick('possession','ball_possession','possession_pct','possession_percentage','possession_percent')),
    possession_away:   away(pick('possession','ball_possession','possession_pct','possession_percentage','possession_percent')),
    yellow_cards:      sum(pick('yellow_cards','yellowcards','yellows')),
    red_cards:         sum(pick('red_cards','redcards','reds')),
  };

  const discoveredKeys = Object.keys(map).slice(0, 60);
  const mappedStatsKeys = Object.keys(result).filter(k => result[k] !== null);
  const hasAny = mappedStatsKeys.length > 0;

  return { stats: result, hasAny, discoveredKeys, mappedStatsKeys, oddsFound, odds };
}

// ── Fetch per-event stats from ESPN summary endpoint ──────────────────────────
async function fetchEventDetails(leagueSlug, eventId) {
  const urls = summaryUrlCandidates(leagueSlug, eventId);
  const debug = { testedEndpoints:[], successfulEndpoints:[], discoveredKeys:[], hasStatistics:false, hasOdds:false, failReason:null };

  for (const url of urls) {
    debug.testedEndpoints.push(url);
    console.log(`[espn-details] fetching summary url ${url}`);
    const res = await client.get(url);
    console.log(`[espn-details] summary status=${res.status} ok=${res.ok} ct=${(res.contentType||'').slice(0,30)}`);
    if (!res.ok || !res.contentType.includes('json')) {
      console.log(`[espn-details] DETAIL_PARSE_FAILED — bad response status=${res.status} ct=${res.contentType||''}`);
      continue;
    }

    let data;
    try { data = JSON.parse(res.text); } catch(e) { debug.failReason='DETAIL_PARSE_FAILED'; continue; }

    debug.successfulEndpoints.push(url);
    console.log(`[espn-details] stats keys=${Object.keys(data||{}).join(',').slice(0,100)}`);
    const extracted = extractEspnStats(data);
    if (extracted) {
      debug.discoveredKeys  = extracted.discoveredKeys;
      debug.mappedStatsKeys = extracted.mappedStatsKeys || [];
      debug.hasStatistics   = extracted.hasAny;
      debug.hasOdds         = extracted.oddsFound;
      return { ok:true, stats:extracted.stats, odds:extracted.odds, debug };
    }
    // Even if no stats, log what top-level keys came back
    debug.discoveredKeys = Object.keys(data||{}).slice(0,15);
    console.log(`[espn-stats] ${url.split('?')[0]} → keys=${debug.discoveredKeys.join(',')}`);
    return { ok:true, stats:null, odds:null, debug };
  }

  debug.failReason = debug.failReason || 'DETAIL_FETCH_FAILED';
  return { ok:false, stats:null, odds:null, debug };
}

// ── Probe a single scoreboard endpoint ───────────────────────────────────────
async function probe(endpoint, opts = {}) {
  const { acceptScheduled=false, debug=true, fetchStats=FORCE_ESPN_DETAILS } = opts;
  const slug = endpoint.split('/soccer/')[1]?.split('/')[0] || 'all';
  const t0   = Date.now();
  const res  = await client.get(endpoint);
  const durationMs = Date.now()-t0;

  const base = {
    provider:'espn_json', source:'espn', endpoint, slug,
    status:res.status, contentType:res.contentType||'',
    responseLength:res.text?res.text.length:0,
    jsonParseOk:false, topLevelKeys:[], rawEventCount:0,
    parsedMatches:0, acceptedEventCount:0,
    matches:[], failReason:null, durationMs,
    sampleRawPreview:res.text?res.text.slice(0,300):'',
    discoveredStatusTypes:[], discoveredLeagueSlugs:[],
    rejectedReasons:[], sampleEventIds:[], sampleStatusTypes:[],
    // Stats discovery
    detailEndpointsTried:0, detailEndpointsSuccess:0,
    hasStatistics:false, hasOdds:false,
    espnDetailsDebug:[],
  };

  if (!res.ok) { base.failReason=classifyStatus(res.status)||FAIL.HTTP_5XX; return base; }
  if (res.contentType && !res.contentType.includes('json') && !res.contentType.includes('javascript')) {
    base.failReason=FAIL.NON_JSON; return base;
  }

  let data;
  try { data=JSON.parse(res.text); base.jsonParseOk=true; }
  catch(e) { base.failReason=FAIL.JSON_PARSE; return base; }
  base.topLevelKeys=Object.keys(data||{}).slice(0,15);

  const events=data.events||data.scoreboard||data.data||[];
  if (!Array.isArray(events)) { base.failReason=FAIL.NO_EVENTS; return base; }
  base.rawEventCount=events.length;
  if (events.length===0) { base.failReason=FAIL.EMPTY; return base; }

  // Mark league slug on each event for stats fetch
  for (const ev of events) ev._leagueSlug = slug;

  if (debug) {
    const statusSet=new Set(), leagueSet=new Set();
    for (const ev of events.slice(0,20)) {
      const comp=(ev.competitions||[])[0]||{};
      const st=(comp.status&&comp.status.type)||(ev.status&&ev.status.type)||{};
      if (st.name) statusSet.add(st.name);
      const lg=(ev.season&&ev.season.displayName)||(ev.league&&ev.league.name);
      if (lg) leagueSet.add(lg);
    }
    base.discoveredStatusTypes=[...statusSet].slice(0,10);
    base.discoveredLeagueSlugs=[...leagueSet].slice(0,10);
    base.sampleEventIds=events.slice(0,5).map(e=>e.id);
    base.sampleStatusTypes=events.slice(0,5).map(e=>{
      const comp=(e.competitions||[])[0]||{};
      const st=(comp.status&&comp.status.type)||(e.status&&e.status.type)||{};
      return st.name||'?';
    });
    console.log(`[espn] ${slug}/scoreboard → status=${res.status} events=${events.length} statusTypes=${base.discoveredStatusTypes.slice(0,4).join(',')}`);
  }

  // Normalize
  const rejected=[], raw=[];
  for (const ev of events) {
    const m=normEspnEvent(ev, acceptScheduled);
    if (m) raw.push(m);
    else {
      const comp=(ev.competitions||[])[0]||{};
      const st=(comp.status&&comp.status.type)||(ev.status&&ev.status.type)||{};
      rejected.push(st.name||'unknown');
    }
  }
  base.acceptedEventCount=raw.length;
  base.rejectedReasons=[...new Set(rejected)].slice(0,10);

  const liveOnly=raw.filter(m=>m.match_live==='1');

  // ── Stats discovery for live matches ─────────────────────────────────────
  console.log(`[espn-details] pipeline check: fetchStats=${fetchStats} force=${FORCE_ESPN_DETAILS} liveCount=${liveOnly.length} slug=${slug}`);
  if (!fetchStats) {
    console.log('[espn-details] DETAIL_FETCH_SKIPPED — fetchStats=false (check probe() call opts)');
  } else if (liveOnly.length === 0) {
    console.log('[espn-details] DETAIL_FETCH_SKIPPED — no live matches to fetch details for');
  } else {
    const toFetch = liveOnly.slice(0, 3);
    for (const m of toFetch) {
      const eventId    = m.match_id;
      const eventSlug  = m._leagueSlug || slug;
      console.log(`[espn-details] entering detail pipeline eventId=${eventId} slug=${eventSlug} match="${m.match_hometeam_name} vs ${m.match_awayteam_name}"`);
      if (!eventId) {
        console.log('[espn-details] DETAIL_FETCH_SKIPPED — eventId empty');
        base.espnDetailsDebug.push({ eventId:'', failReason:'DETAIL_FETCH_SKIPPED_NO_ID' });
        continue;
      }
      base.detailEndpointsTried++;
      const details = await fetchEventDetails(eventSlug, eventId);
      console.log(`[espn-details] result eventId=${eventId} ok=${details.ok} hasStats=${!!details.stats} statsKeys=${details.stats?Object.keys(details.stats).filter(k=>details.stats[k]!==null).join(','):'none'}`);
      base.espnDetailsDebug.push({
        eventId, match:`${m.match_hometeam_name} vs ${m.match_awayteam_name}`,
        ...details.debug,
      });
      if (details.ok) {
        base.detailEndpointsSuccess++;
        if (details.stats) {
          m.stats    = details.stats;
          m.hasStats = Object.values(details.stats).some(v => v !== null);
          if (m.hasStats) { base.hasStatistics = true; console.log(`[espn-details] stats ok eventId=${eventId} keys=${Object.keys(details.stats).filter(k=>details.stats[k]!==null).join(',')}`); }
        }
        if (details.odds && Object.values(details.odds).some(v => v !== null)) {
          m.odds    = Object.assign({}, m.odds, details.odds);
          m.hasOdds = true;
          base.hasOdds = true;
          console.log(`[espn-details] odds ok eventId=${eventId}`);
        }
      } else {
        console.log(`[espn-details] DETAIL_FETCH_FAILED eventId=${eventId} reason=${JSON.stringify(details.debug)}`);
        m.stats    = {};
        m.hasStats = false;
      }
    }
    for (const m of liveOnly.slice(3)) { m.stats={}; m.hasStats=false; }
  }

  const norm=normalizeMatches(liveOnly,'espn');
  base.parsedMatches=norm.length;
  base.matches=norm;
  base.sampleMatches=norm.slice(0,2);
  if (norm.length>0) base.failReason=FAIL.OK;
  else if (raw.length>0) { base.failReason='NO_LIVE_MATCHES_SCHEDULED_ONLY'; base.acceptedScheduled=raw.filter(m=>m._isScheduled).length; }
  else base.failReason=FAIL.NO_EVENTS;

  return base;
}

// ── fetch() — used by /live ────────────────────────────────────────────────────
async function fetch(_browser, _options) {
  const fetchedAt=Date.now();
  let bestLive=null, bestDebug=null;

  for (const endpoint of PRIMARY_ENDPOINTS) {
    const r=await probe(endpoint, { acceptScheduled:false, debug:true, fetchStats:true });
    console.log(`[espn] ${r.slug}/scoreboard → live=${r.parsedMatches} stats=${r.hasStatistics} odds=${r.hasOdds}`);
    if (r.parsedMatches>0) { bestLive=r; break; }
    if (!bestDebug && r.status===200) bestDebug=r;
  }

  const winner=bestLive||bestDebug;
  const espnDebug=winner?{
    endpoint:             winner.endpoint,
    rawEventCount:        winner.rawEventCount,
    discoveredStatusTypes:winner.discoveredStatusTypes,
    rejectedReasons:      winner.rejectedReasons,
    parsedMatches:        winner.parsedMatches,
    hasStatistics:        winner.hasStatistics,
    hasOdds:              winner.hasOdds,
    detailEndpointsTried: winner.detailEndpointsTried,
    detailEndpointsSuccess:winner.detailEndpointsSuccess,
    espnDetailsDebug:     winner.espnDetailsDebug,
  }:null;

  console.log(`[espn] fetch done — live=${winner?.parsedMatches||0} hasStats=${winner?.hasStatistics} hasOdds=${winner?.hasOdds}`);

  return {
    provider:'espn_json',
    success:!!(winner&&winner.parsedMatches>0),
    matches:winner?winner.matches:[],
    error:winner?(winner.parsedMatches>0?null:winner.failReason):'no_endpoints_ok',
    fetchedAt, _auditResult:winner, _espnDebug:espnDebug,
  };
}

module.exports = { fetch, probe, provider:'espn_json', needsPlaywright:false, ENDPOINTS:ALL_ENDPOINTS, PRIMARY_ENDPOINTS };
