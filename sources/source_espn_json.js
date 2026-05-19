/**
 * source_espn_json.js v11.10-espn-date-window-coverage
 *
 * ESPN public JSON — live match extraction + stats endpoint discovery.
 * Secondary endpoints probed per event: summary, statistics, situation.
 * No HTML scraping. No browser automation. No anti-bot bypass.
 */
'use strict';

const { createHttpClient } = require('../http-client');
const { safeNum, safeStr, normalizeMatches } = require('../normalizer');

const LEAGUE_SLUGS = [
  'all',

  // England
  'eng.1','eng.2','eng.3','eng.4','eng.5',
  // Spain / Germany / Italy / France
  'esp.1','esp.2','ger.1','ger.2','ita.1','ita.2','fra.1','fra.2',
  // Europe no-key ESPN coverage
  'ned.1','por.1','bel.1','sco.1','tur.1','swe.1','nor.1','den.1','fin.1',
  'aut.1','sui.1','cze.1','gre.1',
  // UEFA / international
  'uefa.champions','uefa.europa','uefa.europa.conf','uefa.nations',
  'fifa.world','fifa.friendly','fifa.worldq','uefa.euro',
  // North America
  'usa.1','usa.nwsl','usa.usl.1','usa.open','mex.1','mex.2',
  // South America
  'bra.1','bra.2','arg.1','arg.2','col.1','chi.1','per.1','uru.1','ecu.1','par.1',
  'conmebol.libertadores','conmebol.sudamericana',
  // Asia / Oceania / Africa
  'ind.1','aus.1','jpn.1','jpn.2','kor.1','chn.1','ksa.1','qat.1',
  'idn.1','tha.1','mys.1','zaf.1','egy.1','mar.1',

  // Extra ESPN no-key soccer slugs / cup & international windows. Some may 404; audit records that safely.
  'eng.fa','eng.league_cup','eng.trophy','esp.copa_del_rey','ita.coppa_italia','ger.dfb_pokal','fra.coupe_de_france',
  'club.friendly','concacaf.champions','concacaf.gold','concacaf.nations.league',
  'fifa.u20','fifa.u17','fifa.wwc','fifa.olympics','uefa.wchampions','uefa.euroq',
  'fifa.worldq.uefa','fifa.worldq.conmebol','fifa.worldq.concacaf','fifa.worldq.afc','fifa.worldq.caf','fifa.worldq.ofc'
];
const BASE      = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const SITE_BASE = 'https://site.web.api.espn.com/apis/site/v2/sports/soccer';
const WEB_BASE  = 'https://site.web.api.espn.com/apis/v2/sports/soccer';
const FORCE_ESPN_DETAILS = process.env.FORCE_ESPN_DETAILS !== 'false';
function yyyymmddUTC(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}`;
}

function buildScoreboardEndpoints() {
  const today = yyyymmddUTC(0);
  const prev  = yyyymmddUTC(-1);
  const next  = yyyymmddUTC(1);
  const eps = [];
  for (const slug of LEAGUE_SLUGS) {
    const base = `${BASE}/${slug}/scoreboard`;
    // 1) default ESPN scoreboard (fast path)
    eps.push(base);
    // 2) explicit date path: fixes cases where default calendar omits current matchday
    eps.push(`${base}?dates=${today}&limit=200`);
    // 3) all/scoreboard around timezone boundaries only; avoids scanning every slug 3x
    if (slug === 'all') {
      eps.push(`${base}?dates=${prev}&limit=200`);
      eps.push(`${base}?dates=${next}&limit=200`);
    }
  }
  return [...new Set(eps)];
}

const ALL_ENDPOINTS = buildScoreboardEndpoints();
// v11.10: scan all slugs + explicit date variant. No browser, no proxy, no IP-sensitive source.
const PRIMARY_ENDPOINTS = ALL_ENDPOINTS;

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
  minPaceMs: 180,
  timeoutMs: 6500,
  maxRetries: 1,
});

const ESPN_LIVE = new Set([
  // Standard ESPN soccer status.type.name — accept all live variants
  'STATUS_IN_PROGRESS',
  'STATUS_HALFTIME',       // v11.06: explicit
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
  'STATUS_PENALTIES',      // v11.06: explicit alias
  'STATUS_AWAITING_PENALTIES',
  'STATUS_PENALTY_SHOOTOUT',
  // Compact/state values
  'IN', 'LIVE', 'HALFTIME', 'HALF_TIME', '1H', '2H', 'HT', 'ET', 'PEN',
]);

// Hard reject — only these explicitly disqualify a match
const ESPN_DEAD = new Set([
  'STATUS_FULL_TIME', 'STATUS_FINAL', 'STATUS_FINAL_PEN', 'STATUS_FINAL_AET',
  'STATUS_POSTPONED', 'STATUS_CANCELED', 'STATUS_ABANDONED',
  'FULL_TIME', 'FINAL', 'POST',
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

function applyLiveQualityTier(match) {
  const hasBasic = !!(match && match.match_id && match.match_hometeam_name && match.match_awayteam_name && match.match_live === '1');
  const hasStats = !!(match && match.hasStats);
  const hasOdds  = !!(match && match.hasOdds);

  if (!hasBasic) {
    match.liveQualityTier = 'REJECTED_INCOMPLETE';
    match.liveMode = 'REJECTED';
    return match;
  }

  if (hasStats && hasOdds) {
    match.liveQualityTier = 'FULL_STATS_SIGNAL';
    match.liveMode = 'FULL_SIGNAL';
  } else if (hasStats) {
    match.liveQualityTier = 'STATS_ONLY_SIGNAL';
    match.liveMode = 'STATS_SIGNAL';
  } else if (hasOdds) {
    match.liveQualityTier = 'ODDS_ONLY_WATCH';
    match.liveMode = 'WATCH_ONLY';
  } else {
    match.liveQualityTier = 'BASIC_LIVE_ONLY';
    match.liveMode = 'WATCH_ONLY';
  }

  match.coverageNotes = match.coverageNotes || [];
  if (!hasStats) match.coverageNotes.push('no_stats_available_from_source');
  if (!hasOdds)  match.coverageNotes.push('no_odds_available_from_source');
  return match;
}

function slugToLeagueName(slug) {
  const map = {
    'eng.1':'Premier League',       'eng.2':'Championship',
    'esp.1':'LaLiga',               'esp.2':'LaLiga 2',
    'ger.1':'Bundesliga',           'ger.2':'2. Bundesliga',
    'ita.1':'Serie A',              'ita.2':'Serie B',
    'fra.1':'Ligue 1',              'fra.2':'Ligue 2',
    'ned.1':'Eredivisie',           'por.1':'Primeira Liga',
    'bel.1':'First Division A',     'sco.1':'Scottish Premiership',
    'tur.1':'Süper Lig',            'swe.1':'Allsvenskan',
    'nor.1':'Eliteserien',          'den.1':'Superliga',
    'fin.1':'Veikkausliiga',        'aut.1':'Bundesliga Austria',
    'sui.1':'Super League Swiss',   'cze.1':'Czech First League',
    'gre.1':'Super League Greece',
    'uefa.champions':'Champions League','uefa.europa':'Europa League',
    'uefa.europa.conf':'Conference League','uefa.nations':'UEFA Nations League',
    'fifa.world':'FIFA World Cup',  'fifa.worldq':'World Cup Qualifying',
    'fifa.friendly':'International Friendly','uefa.euro':'UEFA Euro',
    'usa.1':'MLS',                  'usa.nwsl':'NWSL',
    'mex.1':'Liga MX',              'mex.2':'Liga de Expansión',
    'bra.1':'Brasileirão',          'bra.2':'Série B',
    'arg.1':'Argentina Primera',    'arg.2':'Primera Nacional',
    'col.1':'Categoría Primera A',  'chi.1':'Primera División Chile',
    'per.1':'Liga 1 Perú',          'uru.1':'Primera División Uruguay',
    'ecu.1':'LigaPro Ecuador',      'par.1':'División Profesional Paraguay',
    'conmebol.libertadores':'Copa Libertadores',
    'conmebol.sudamericana':'Copa Sudamericana',
    'ind.1':'Indian Super League',  'aus.1':'A-League',
    'jpn.1':'J1 League',            'jpn.2':'J2 League',
    'kor.1':'K League 1',           'chn.1':'Chinese Super League',
    'ksa.1':'Saudi Pro League',     'qat.1':'Qatar Stars League',
    'idn.1':'Liga 1 Indonesia',     'tha.1':'Thai League 1',
    'mys.1':'Malaysia Super League','zaf.1':'Premier Soccer League',
    'egy.1':'Egyptian Premier League','mar.1':'Botola Pro',
    'all':'ESPN Soccer',
  };
  return map[slug] || slug || 'ESPN Soccer';
}

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
  const leagueSlug = ev._leagueSlug || '';
  const eventLeagueName = (ev.season && ev.season.displayName) || '';
  const leagueObj = ev.league || comp.league || {};
  const leagueName =
    safeStr(eventLeagueName) ||
    safeStr(leagueObj.name) ||
    safeStr(leagueObj.displayName) ||
    safeStr(ev.leagueName) ||
    safeStr(ev.competitionName) ||
    safeStr(comp.leagueName) ||
    slugToLeagueName(leagueSlug) ||
    'ESPN Soccer';

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
    _leagueSlug:          leagueSlug,   // passed from probe() loop
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
async function fetch(_browser, _options) {
  const fetchedAt = Date.now();
  const audits = [];
  let allMatches = [];
  let workingEndpoints = 0;
  let failedEndpoints = 0;
  let detailFetchFailures = 0;
  const rejectedByStatus = {};

  for (const ep of PRIMARY_ENDPOINTS) {
    try {
      const r = await probe(ep, { fetchStats:true, acceptScheduled:false });
      audits.push({
        endpoint:r.endpoint,
        slug:r.slug,
        status:r.status,
        rawEventCount:r.rawEventCount || 0,
        parsedMatches:r.parsedMatches || 0,
        acceptedEventCount:r.acceptedEventCount || 0,
        failReason:r.failReason,
        discoveredStatusTypes:r.discoveredStatusTypes || [],
        rejectedReasons:r.rejectedReasons || []
      });

      if (r.status === 200) workingEndpoints++; else failedEndpoints++;
      for (const rr of (r.rejectedReasons || [])) rejectedByStatus[rr] = (rejectedByStatus[rr] || 0) + 1;
      for (const d of (r.espnDetailsDebug || [])) if (d && d.failReason) detailFetchFailures++;
      if (r.parsedMatches > 0) allMatches.push(...(r.matches || []));

      console.log(`[espn-global] ${r.slug || ep} → status=${r.status} raw=${r.rawEventCount||0} parsed=${r.parsedMatches||0} reason=${r.failReason}`);
    } catch (err) {
      failedEndpoints++;
      audits.push({ endpoint:ep, status:null, parsedMatches:0, failReason:'ENDPOINT_EXCEPTION', error:String(err && err.message || err) });
      console.log(`[espn-global] endpoint exception ${ep}`, err && err.message || err);
    }
  }

  const deduped = dedupeMatches(allMatches);
  const qualityTiers = deduped.reduce((acc,m)=>{ const k=m.liveQualityTier||'UNKNOWN'; acc[k]=(acc[k]||0)+1; return acc; },{});
  const globalAudit = {
    endpointsTried: PRIMARY_ENDPOINTS.length,
    workingEndpoints,
    failedEndpoints,
    liveAcceptedCount: deduped.length,
    rawEventsTotal: audits.reduce((a,x)=>a+(x.rawEventCount||0),0),
    parsedBeforeDedupe: allMatches.length,
    parsedAfterDedupe: deduped.length,
    rejectedByStatus,
    detailFetchFailures,
    qualityTiers,
    topEndpoints: audits.filter(x=>x.parsedMatches>0).sort((a,b)=>(b.parsedMatches||0)-(a.parsedMatches||0)).slice(0,10),
    sampledFailures: audits.filter(x=>!x.parsedMatches).slice(0,12)
  };

  if (deduped.length > 0) {
    return {
      provider,
      success:true,
      matches:deduped,
      error:null,
      fetchedAt,
      _globalAudit:globalAudit,
      _auditResult:{ provider, source:'espn', endpoint:'GLOBAL_AGGREGATION', status:200, parsedMatches:deduped.length, matches:deduped, failReason:'OK_PARSED', auditSummary:globalAudit }
    };
  }

  return {
    provider,
    success:false,
    matches:[],
    error:'NO_LIVE_MATCHES_FROM_ESPN_GLOBAL_SCAN',
    fetchedAt,
    _globalAudit:globalAudit,
    _auditResult:{ provider, source:'espn', endpoint:'GLOBAL_AGGREGATION', status:200, parsedMatches:0, matches:[], failReason:'NO_EVENTS_FOUND', auditSummary:globalAudit }
  };
}

// ── Probe a single scoreboard endpoint ───────────────────────────────────────

function canonicalMatchKey(m) {
  const h = String(m.match_hometeam_name || '').toLowerCase().replace(/[^a-z0-9]+/g,'');
  const a = String(m.match_awayteam_name || '').toLowerCase().replace(/[^a-z0-9]+/g,'');
  const id = String(m.match_id || '');
  return id ? `id:${id}` : `${h}__${a}`;
}

function matchQualityScore(m) {
  let s = 0;
  if (m.hasStats) s += 40;
  if (m.hasOdds) s += 25;
  if (m.minute != null) s += 10;
  if (m.signalCount > 0) s += 15;
  if (m.liveQualityTier === 'FULL_STATS_SIGNAL') s += 20;
  if (m.liveQualityTier === 'STATS_ONLY_SIGNAL') s += 10;
  return s;
}

function dedupeMatches(matches) {
  const map = new Map();
  for (const m of (matches || [])) {
    const key = canonicalMatchKey(m);
    const old = map.get(key);
    if (!old || matchQualityScore(m) > matchQualityScore(old)) map.set(key, m);
  }
  return Array.from(map.values());
}


// ── PATCH 1 v11.06: fetchEventDetails — guaranteed-safe, no crash ─────────────
// Called once per live match. Never throws. Returns {ok, stats, odds, debug}.
async function fetchEventDetails(slug, eventId) {
  const debug = {
    testedEndpoints:  [],
    successfulEndpoints: [],
    discoveredKeys:   [],
    hasStatistics:    false,
    hasOdds:          false,
    failReason:       null,
  };

  if (!eventId) {
    debug.failReason = 'DETAIL_FETCH_SKIPPED_NO_ID';
    return { ok:false, stats:null, odds:null, debug };
  }

  // Two URL patterns to try: site.api first, site.web second
  const effectiveSlug = slug || 'all';
  const urls = [
    `${BASE}/${effectiveSlug}/summary?event=${eventId}`,
    `${SITE_BASE}/${effectiveSlug}/summary?event=${eventId}`,
  ];
  // Fallback slugs if slug-specific fails
  const slugFallbacks = ['all', 'eng.1', 'usa.1'];
  const allUrls = [...urls];
  if (!slugFallbacks.includes(effectiveSlug)) {
    for (const fb of slugFallbacks) {
      allUrls.push(`${BASE}/${fb}/summary?event=${eventId}`);
    }
  }

  for (const url of allUrls) {
    debug.testedEndpoints.push(url);
    console.log(`[espn-details] fetching summary url ${url}`);
    let res;
    try {
      res = await client.get(url);
    } catch (e) {
      console.log(`[espn-details] fetch error url=${url} err=${e.message}`);
      continue;
    }

    console.log(`[espn-details] summary status=${res.status} ok=${res.ok} ct=${(res.contentType||'').slice(0,30)}`);
    if (!res.ok) {
      debug.failReason = `HTTP_${res.status}`;
      continue;
    }
    if (!res.contentType || (!res.contentType.includes('json') && !res.contentType.includes('javascript'))) {
      debug.failReason = 'DETAIL_PARSE_FAILED_NON_JSON';
      continue;
    }

    let data;
    try { data = JSON.parse(res.text); }
    catch (e) {
      debug.failReason = 'DETAIL_PARSE_FAILED_JSON';
      console.log(`[espn-details] JSON parse error url=${url}`);
      continue;
    }

    const topKeys = Object.keys(data || {}).slice(0, 20);
    debug.successfulEndpoints.push(url);
    debug.discoveredKeys = topKeys;
    console.log(`[espn-details] stats keys=${topKeys.join(',').slice(0,120)}`);

    // Extract statistics
    const extracted = extractEspnStats(data);
    if (extracted) {
      debug.hasStatistics = extracted.hasAny;
      debug.hasOdds       = extracted.oddsFound;
      if (!extracted.hasAny) debug.failReason = 'DETAIL_OK_NO_STATS';
      return {
        ok:    true,
        stats: extracted.stats,
        odds:  extracted.oddsFound ? extracted.odds : null,
        debug,
      };
    }

    // 200 but no parseable stats
    debug.failReason = 'DETAIL_OK_NO_STATS';
    return { ok:true, stats:null, odds:null, debug };
  }

  // All URLs failed
  if (!debug.failReason) debug.failReason = 'DETAIL_FETCH_FAILED';
  return { ok:false, stats:null, odds:null, debug };
}

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
      // PATCH 2: wrap in try/catch — detail failure must never abort provider
      let details = { ok:false, stats:null, odds:null, debug:{ failReason:'DETAIL_PIPELINE_NOT_EXECUTED' } };
      try {
        details = await fetchEventDetails(eventSlug, eventId);
      } catch (eDetail) {
        console.log(`[espn-details] EXCEPTION eventId=${eventId} err=${eDetail.message}`);
        base.detailFailReasons = base.detailFailReasons || [];
        base.detailFailReasons.push({ eventId, error: eDetail.message });
        m.stats = {}; m.hasStats = false;
      }
      console.log(`[espn-details] result eventId=${eventId} ok=${details.ok} hasStats=${!!details.stats} statsKeys=${details.stats?Object.keys(details.stats).filter(k=>details.stats[k]!==null).join(','):'none'}`);
      base.espnDetailsDebug.push({
        eventId, match:`${m.match_hometeam_name} vs ${m.match_awayteam_name}`,
        ...(details.debug || {}),
        _espnDetailDebug: {
          eventId, slug:eventSlug,
          triedUrls:    (details.debug||{}).testedEndpoints   || [],
          statusCodes:  [],
          jsonParseOk:  (details.debug||{}).successfulEndpoints ? [(details.debug.successfulEndpoints.length > 0)] : [],
          foundKeys:    (details.debug||{}).discoveredKeys    || [],
          hasStats:     (details.debug||{}).hasStatistics     || false,
          hasOdds:      (details.debug||{}).hasOdds           || false,
          failReason:   (details.debug||{}).failReason        || null,
        },
      });
      if (details.ok) {
        base.detailEndpointsSuccess++;
        if (details.stats) {
          m.stats    = details.stats;
          m.hasStats = Object.values(details.stats).some(v => v !== null);
          if (m.hasStats) { base.hasStatistics = true; console.log(`[espn-details] stats ok eventId=${eventId} keys=${Object.keys(details.stats).filter(k=>details.stats[k]!==null).join(',')}`); }
          else { console.log(`[espn-details] DETAIL_OK_NO_STATS eventId=${eventId}`); }
        }
        if (details.odds && details.odds && Object.values(details.odds).some(v => v !== null)) {
          m.odds    = Object.assign({}, m.odds, details.odds);
          m.hasOdds = true;
          base.hasOdds = true;
          console.log(`[espn-details] odds ok eventId=${eventId}`);
        }
      } else {
        const fr = (details.debug||{}).failReason || 'DETAIL_FETCH_FAILED';
        console.log(`[espn-details] ${fr} eventId=${eventId}`);
        base.detailFailReasons = base.detailFailReasons || [];
        base.detailFailReasons.push({ eventId, failReason: fr });
        m.stats = {}; m.hasStats = false;
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
// v11.08: TRUE global aggregation — scan ALL slugs, collect all live matches, dedupe.
// Previous impl broke early on first match found; now we aggregate across all leagues.
async function fetch(_browser, _options) {
  const fetchedAt = Date.now();
  const allMatches  = [];   // raw parsed matches (pre-dedupe)
  const audits      = [];   // per-slug audit records
  const workingEndpoints  = [];
  const failedEndpoints   = [];
  let rawEventsTotal       = 0;
  let totalDetailFailures  = 0;
  let rejectedByStatus     = {};
  let detailFetchFailures  = [];
  let bestDebug            = null;  // first 200 response for debug fallback

  function extractSlugFromEndpoint(ep) {
    try { return ep.split('/soccer/')[1].split('/')[0]; } catch(e) { return ep; }
  }

  for (const endpoint of PRIMARY_ENDPOINTS) {
    let r;
    try {
      r = await probe(endpoint, { acceptScheduled: false, debug: true, fetchStats: true });
      const slug = r.slug || extractSlugFromEndpoint(endpoint);
      console.log(`[espn-global-scan] slug=${slug} status=${r.status} raw=${r.rawEventCount||0} parsed=${r.parsedMatches||0} reason=${r.failReason}`);

      if (r.status === 200) workingEndpoints.push(slug);
      else failedEndpoints.push(slug + ':' + (r.failReason || r.status));

      rawEventsTotal += (r.rawEventCount || 0);
      totalDetailFailures += (r.detailFailReasons || []).length;
      detailFetchFailures = detailFetchFailures.concat(r.detailFailReasons || []);

      // Aggregate rejected-by-status counts
      (r.rejectedReasons || []).forEach(function(rr) {
        rejectedByStatus[rr] = (rejectedByStatus[rr] || 0) + 1;
      });

      audits.push({
        slug,
        endpoint: r.endpoint || endpoint,
        status: r.status,
        rawEventCount: r.rawEventCount || 0,
        parsedMatches: r.parsedMatches || 0,
        acceptedEventCount: r.acceptedEventCount || 0,
        hasStatistics: r.hasStatistics || false,
        hasOdds: r.hasOdds || false,
        failReason: r.failReason,
        discoveredStatusTypes: r.discoveredStatusTypes || [],
        rejectedReasons: r.rejectedReasons || [],
        detailEndpointsTried: r.detailEndpointsTried || 0,
        detailEndpointsSuccess: r.detailEndpointsSuccess || 0,
      });

      if (r.parsedMatches > 0) {
        allMatches.push(...(r.matches || []));
      }

      if (!bestDebug && r.status === 200) bestDebug = r;

    } catch (eProbe) {
      const slug = extractSlugFromEndpoint(endpoint);
      console.log(`[espn] PROBE_EXCEPTION slug=${slug} err=${eProbe.message}`);
      failedEndpoints.push(slug + ':EXCEPTION');
      audits.push({
        slug,
        endpoint,
        status: null,
        parsedMatches: 0,
        failReason: 'ENDPOINT_EXCEPTION',
        error: String(eProbe && eProbe.message || eProbe),
      });
      // Never abort — continue to next endpoint
    }
  }

  // Deduplicate by match_id (all/scoreboard often overlaps with eng.1, etc.)
  const seenIds = new Set();
  const deduped = [];
  for (const m of allMatches) {
    const key = m.match_id || (m.match_hometeam_name + '___' + m.match_awayteam_name);
    if (!seenIds.has(key)) { seenIds.add(key); deduped.push(m); }
  }

  const globalAudit = {
    endpointsTried:       PRIMARY_ENDPOINTS.length,
    workingEndpoints,
    failedEndpoints,
    rawEventsTotal,
    parsedBeforeDedupe:   allMatches.length,
    parsedAfterDedupe:    deduped.length,
    liveAcceptedCount:    deduped.length,
    topEndpoints:         audits.filter(a => a.parsedMatches > 0),
    sampledFailures:      audits.filter(a => !a.parsedMatches && a.failReason !== 'EMPTY' && a.failReason !== 'NO_LIVE_MATCHES_SCHEDULED_ONLY').slice(0, 15),
    rejectedByStatus,
    detailFetchFailures:  detailFetchFailures.slice(0, 20),
  };

  console.log(`[espn] fetch done — endpoints=${PRIMARY_ENDPOINTS.length} working=${workingEndpoints.length} liveDeduped=${deduped.length} rawTotal=${rawEventsTotal}`);

  const espnDebug = {
    mode:                  'global_aggregation',
    endpointsTried:        PRIMARY_ENDPOINTS.length,
    parsedMatches:         deduped.length,
    liveAcceptedCount:     deduped.length,
    rawEventsTotal,
    workingEndpoints,
    failedEndpoints,
    topEndpoints:          globalAudit.topEndpoints,
    rejectedByStatus,
    detailFetchFailures:   totalDetailFailures,
  };

  return {
    provider:       'espn_json',
    success:        deduped.length > 0,
    matches:        deduped,
    error:          deduped.length > 0 ? null : (workingEndpoints.length > 0 ? 'no_live_matches' : 'no_endpoints_ok'),
    fetchedAt,
    _auditResult:   bestDebug,
    _espnDebug:     espnDebug,
    sourceGlobalAudit: globalAudit,
  };
}

module.exports = { fetch, probe, provider:'espn_json', needsPlaywright:false, ENDPOINTS:ALL_ENDPOINTS, PRIMARY_ENDPOINTS };

