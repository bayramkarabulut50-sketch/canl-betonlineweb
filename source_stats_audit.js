/**
 * source_stats_audit.js — CanliBet v10.94 stats-source-audit
 *
 * Public JSON endpoint probes only.
 * No HTML scraping. No browser automation. No proxy. No CAPTCHA/fingerprint bypass.
 *
 * Goal: discover whether Render can access match-level statistics JSON from
 * secondary sources that can enrich ESPN live matches.
 */
'use strict';

const { createHttpClient } = require('../http-client');
const { safeStr, safeNum } = require('../normalizer');

const TARGET_KEYS = [
  'shots','shot','totalShots','total_shots','shotsTotal','shots_total',
  'shotsOnTarget','shots_on_target','onTarget','on_target','sot',
  'cornerKicks','corner_kicks','corners','corner',
  'possession','possessionPct','possession_pct','possessionPercentage','ballPossession','ball_possession',
  'dangerousAttacks','dangerous_attacks','attacks','attack',
  'yellowCards','yellow_cards','redCards','red_cards'
];

const TARGET_NORMALIZED = new Set(TARGET_KEYS.map(normalizeKey));

const clients = {
  fotmob: createHttpClient({
    referer:'https://www.fotmob.com/', origin:'https://www.fotmob.com',
    minPaceMs:650, timeoutMs:9000, maxRetries:1,
  }),
  scores365: createHttpClient({
    referer:'https://www.365scores.com/', origin:'https://www.365scores.com',
    minPaceMs:650, timeoutMs:9000, maxRetries:1,
  }),
  espn: createHttpClient({
    referer:'https://www.espn.com/soccer/', origin:'https://www.espn.com',
    minPaceMs:450, timeoutMs:9000, maxRetries:1,
  }),
  generic: createHttpClient({ minPaceMs:800, timeoutMs:9000, maxRetries:1 }),
};

function normalizeKey(k) {
  return safeStr(k)
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

function todayYYYYMMDD(offsetDays=0) {
  const d = new Date(Date.now() + offsetDays*86400000);
  return d.toISOString().slice(0,10).replace(/-/g,'');
}
function todayISO(offsetDays=0) {
  const d = new Date(Date.now() + offsetDays*86400000);
  return d.toISOString().slice(0,10);
}

function classifyFail(res) {
  if (!res) return 'NO_RESPONSE';
  if (res.status === 403) return 'HTTP_403';
  if (res.status === 404) return 'HTTP_404';
  if (res.status === 429) return 'HTTP_429';
  if (res.status >= 500) return 'HTTP_5XX';
  if (res.error) return res.error === 'timeout' ? 'TIMEOUT' : 'NETWORK_ERROR';
  return 'HTTP_'+res.status;
}

async function getJSON(client, endpoint) {
  const t0 = Date.now();
  const res = await client.get(endpoint);
  const base = {
    endpoint,
    status:res.status ?? null,
    ok:!!res.ok,
    contentType:res.contentType || '',
    responseLength:res.text ? res.text.length : 0,
    jsonParseOk:false,
    topLevelKeys:[],
    durationMs:Date.now()-t0,
    sampleRawPreview:res.text ? res.text.slice(0,350) : '',
    data:null,
    failReason:null,
  };

  if (!res.ok) { base.failReason = classifyFail(res); return base; }
  if (!String(res.contentType||'').includes('json') && !String(res.contentType||'').includes('javascript')) {
    base.failReason = 'NON_JSON_RESPONSE'; return base;
  }
  try {
    base.data = JSON.parse(res.text);
    base.jsonParseOk = true;
    base.topLevelKeys = Object.keys(base.data || {}).slice(0,20);
  } catch(e) {
    base.failReason = 'JSON_PARSE_FAILED';
  }
  return base;
}

function isNumericLike(v) {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') return /\d/.test(v) && v.length < 40;
  return false;
}

function deepScanStatKeys(obj, opts={}) {
  const maxDepth = opts.maxDepth || 9;
  const maxHits = opts.maxHits || 80;
  const hits = [];
  const seen = new WeakSet();

  function walk(node, path, depth) {
    if (hits.length >= maxHits || depth > maxDepth || node == null) return;
    if (typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (let i=0; i<Math.min(node.length, 80); i++) walk(node[i], `${path}[${i}]`, depth+1);
      return;
    }

    for (const [key, value] of Object.entries(node)) {
      const nk = normalizeKey(key);
      const nextPath = path ? `${path}.${key}` : key;
      const directKeyHit = TARGET_NORMALIZED.has(nk) || [...TARGET_NORMALIZED].some(t => nk.includes(t) || t.includes(nk));

      if (directKeyHit) {
        const displayValue = typeof value === 'object' ? JSON.stringify(value).slice(0,120) : String(value).slice(0,120);
        hits.push({ key, normalizedKey:nk, path:nextPath, valueType:Array.isArray(value)?'array':typeof value, sampleValue:displayValue });
      }

      // ESPN/FotMob often stores statistics as {name:'Shots on target', value:'4'}
      if ((nk === 'name' || nk === 'label' || nk === 'title' || nk === 'display_name') && typeof value === 'string') {
        const nameNorm = normalizeKey(value);
        if ([...TARGET_NORMALIZED].some(t => nameNorm.includes(t) || t.includes(nameNorm))) {
          const parent = node;
          const statVal = parent.value ?? parent.displayValue ?? parent.stat ?? parent.total ?? parent.home ?? parent.away ?? parent.homeValue ?? parent.awayValue ?? null;
          hits.push({
            key:String(value), normalizedKey:nameNorm, path:nextPath.replace(/\.(name|label|title|displayName)$/,''),
            valueType:typeof statVal, sampleValue:statVal == null ? JSON.stringify(parent).slice(0,160) : String(statVal).slice(0,120)
          });
        }
      }

      if (value && typeof value === 'object') walk(value, nextPath, depth+1);
    }
  }
  walk(obj, '', 0);
  return hits;
}

function canonicalStatsFromHits(hits) {
  // This intentionally stays conservative; /stats-audit is discovery-first.
  const found = new Set(hits.map(h=>h.normalizedKey));
  return {
    attacks: found.has('attacks') || found.has('attack') ? null : null,
    dangerous_attacks: found.has('dangerous_attacks') ? null : null,
    shots_total: [...found].some(k => ['shots','total_shots','shots_total','shots_total'].includes(k) || k.includes('total_shot')) ? null : null,
    shots_on_target: [...found].some(k => k.includes('shots_on_target') || k.includes('on_target') || k === 'sot') ? null : null,
    corners: [...found].some(k => k.includes('corner')) ? null : null,
    possession_home: [...found].some(k => k.includes('possession')) ? null : null,
    possession_away: [...found].some(k => k.includes('possession')) ? null : null,
    yellow_cards: [...found].some(k => k.includes('yellow')) ? null : null,
    red_cards: [...found].some(k => k.includes('red')) ? null : null,
  };
}

function makeProbeResult(provider, endpoint, jsonResult, extra={}) {
  const hits = jsonResult.jsonParseOk ? deepScanStatKeys(jsonResult.data) : [];
  const foundStatKeys = [...new Set(hits.map(h=>h.normalizedKey))].slice(0,60);
  const hasMatchStats = hits.length > 0 && hits.some(h => {
    const p = h.path.toLowerCase();
    return p.includes('stat') || p.includes('match') || p.includes('content') || p.includes('game') || p.includes('team');
  });
  return {
    provider,
    endpoint,
    status:jsonResult.status,
    contentType:jsonResult.contentType,
    responseLength:jsonResult.responseLength,
    jsonParseOk:jsonResult.jsonParseOk,
    topLevelKeys:jsonResult.topLevelKeys,
    hasMatchStats,
    foundStatKeys,
    sampleStats:hits.slice(0,12),
    canonicalStatsPreview:canonicalStatsFromHits(hits),
    failReason: jsonResult.failReason || (hasMatchStats ? 'OK_STATS_KEYS_FOUND' : 'NO_MATCH_STATS_KEYS_FOUND'),
    durationMs:jsonResult.durationMs,
    sampleRawPreview:jsonResult.sampleRawPreview,
    ...extra,
  };
}

function extractFotmobCandidateId(data) {
  const matches = [];
  if (Array.isArray(data?.leagues)) for (const lg of data.leagues) for (const m of (lg.matches||[])) matches.push(m);
  if (Array.isArray(data?.matches)) matches.push(...data.matches);
  const live = matches.find(m => m?.status?.started && !m?.status?.finished) || matches.find(m => m?.status?.liveTime) || matches[0];
  return live?.id || live?.matchId || null;
}

async function probeFotmobStats() {
  const date = todayYYYYMMDD();
  const matchesUrl = `https://www.fotmob.com/api/matches?date=${date}`;
  const first = await getJSON(clients.fotmob, matchesUrl);
  if (!first.jsonParseOk) return makeProbeResult('fotmob_stats', matchesUrl, first, { phase:'match_list' });

  const matchId = extractFotmobCandidateId(first.data);
  if (!matchId) return makeProbeResult('fotmob_stats', matchesUrl, first, { phase:'match_list', failReason:'NO_MATCH_ID_FOUND' });

  const detailCandidates = [
    `https://www.fotmob.com/api/matchDetails?matchId=${matchId}`,
    `https://www.fotmob.com/api/matchDetails?matchId=${matchId}&ccode3=USA&timezone=UTC`,
  ];
  const tried = [];
  for (const url of detailCandidates) {
    const r = await getJSON(clients.fotmob, url);
    tried.push({ endpoint:url, status:r.status, jsonParseOk:r.jsonParseOk, topLevelKeys:r.topLevelKeys, failReason:r.failReason });
    const out = makeProbeResult('fotmob_stats', url, r, { phase:'match_details', matchId, triedEndpoints:tried });
    if (out.hasMatchStats || r.status === 200) return out;
  }
  const last = tried[tried.length-1] || {};
  return { provider:'fotmob_stats', endpoint:detailCandidates[0], status:last.status||null, contentType:'', responseLength:0, jsonParseOk:false, topLevelKeys:[], hasMatchStats:false, foundStatKeys:[], sampleStats:[], failReason:last.failReason||'DETAIL_ENDPOINTS_FAILED', durationMs:0, triedEndpoints:tried };
}

function extract365GameId(data) {
  const candidates = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const x of node.slice(0,100)) walk(x); return; }
    if ((node.id || node.gameId) && (node.homeCompetitor || node.awayCompetitor || node.competitions || node.statusText || node.gameTime)) candidates.push(node);
    for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v);
  };
  walk(data);
  const g = candidates.find(x => String(x.statusText||x.statusName||'').toLowerCase().includes('live')) || candidates[0];
  return g?.id || g?.gameId || null;
}

async function probe365ScoresStats() {
  const listUrls = [
    'https://webws.365scores.com/web/games/current/?appTypeId=5&langId=1&timezoneName=UTC&sports=1&onlyLiveGames=true',
    'https://webws.365scores.com/web/games/current/?appTypeId=5&langId=1&timezoneName=UTC&sports=1',
  ];
  const tried = [];
  for (const listUrl of listUrls) {
    const list = await getJSON(clients.scores365, listUrl);
    tried.push({ endpoint:listUrl, status:list.status, jsonParseOk:list.jsonParseOk, topLevelKeys:list.topLevelKeys, failReason:list.failReason });
    if (!list.jsonParseOk) continue;
    const gameId = extract365GameId(list.data);
    if (!gameId) {
      const out = makeProbeResult('365scores_stats', listUrl, list, { phase:'game_list', triedEndpoints:tried, failReason:'NO_GAME_ID_FOUND' });
      if (out.hasMatchStats) return out;
      continue;
    }
    const detailUrls = [
      `https://webws.365scores.com/web/game/?appTypeId=5&langId=1&timezoneName=UTC&gameId=${gameId}`,
      `https://webws.365scores.com/web/game/stats/?appTypeId=5&langId=1&gameId=${gameId}`,
    ];
    for (const url of detailUrls) {
      const r = await getJSON(clients.scores365, url);
      tried.push({ endpoint:url, status:r.status, jsonParseOk:r.jsonParseOk, topLevelKeys:r.topLevelKeys, failReason:r.failReason });
      const out = makeProbeResult('365scores_stats', url, r, { phase:'game_details', gameId, triedEndpoints:tried });
      if (out.hasMatchStats || r.status === 200) return out;
    }
  }
  return { provider:'365scores_stats', endpoint:listUrls[0], status:tried[0]?.status||null, contentType:'', responseLength:0, jsonParseOk:false, topLevelKeys:[], hasMatchStats:false, foundStatKeys:[], sampleStats:[], failReason:'ALL_ENDPOINTS_FAILED', durationMs:0, triedEndpoints:tried };
}

async function probeEspnAltStats() {
  const scoreboard = `https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard`;
  const s = await getJSON(clients.espn, scoreboard);
  if (!s.jsonParseOk) return makeProbeResult('espn_alt_stats', scoreboard, s, { phase:'scoreboard' });
  const ev = (s.data.events||[]).find(e => {
    const st = e?.competitions?.[0]?.status?.type?.name || e?.status?.type?.name || '';
    return ['STATUS_FIRST_HALF','STATUS_SECOND_HALF','STATUS_HALFTIME','STATUS_HALF_TIME'].includes(st);
  }) || (s.data.events||[])[0];
  const eventId = ev?.id;
  const slug = s.data?.leagues?.[0]?.slug || 'all';
  if (!eventId) return makeProbeResult('espn_alt_stats', scoreboard, s, { phase:'scoreboard', failReason:'NO_EVENT_ID_FOUND' });
  const urls = [
    `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/summary?event=${eventId}`,
    `https://site.api.espn.com/apis/site/v2/sports/soccer/all/summary?event=${eventId}`,
    `https://sports.core.api.espn.com/v2/sports/soccer/leagues/${slug}/events/${eventId}/competitions/${eventId}/competitors?lang=en&region=us`,
  ];
  const tried = [];
  for (const url of urls) {
    const r = await getJSON(clients.espn, url);
    tried.push({ endpoint:url, status:r.status, jsonParseOk:r.jsonParseOk, topLevelKeys:r.topLevelKeys, failReason:r.failReason });
    const out = makeProbeResult('espn_alt_stats', url, r, { phase:'summary_or_core', eventId, slug, triedEndpoints:tried });
    if (out.hasMatchStats || r.status === 200) return out;
  }
  return { provider:'espn_alt_stats', endpoint:urls[0], status:tried[0]?.status||null, contentType:'', responseLength:0, jsonParseOk:false, topLevelKeys:[], hasMatchStats:false, foundStatKeys:[], sampleStats:[], failReason:'ALL_ENDPOINTS_FAILED', durationMs:0, triedEndpoints:tried };
}

async function probeAiScoreAltStats() {
  const urls = [
    'https://api.aiscore.com/api/sport-competition-events?sportId=1&type=Live',
    'https://api.aiscore.com/sport/football/live',
  ];
  const tried = [];
  for (const url of urls) {
    const r = await getJSON(clients.generic, url);
    tried.push({ endpoint:url, status:r.status, jsonParseOk:r.jsonParseOk, topLevelKeys:r.topLevelKeys, failReason:r.failReason });
    const out = makeProbeResult('aiscore_alt_stats', url, r, { triedEndpoints:tried });
    if (out.hasMatchStats || r.status === 200) return out;
  }
  return { provider:'aiscore_alt_stats', endpoint:urls[0], status:tried[0]?.status||null, contentType:'', responseLength:0, jsonParseOk:false, topLevelKeys:[], hasMatchStats:false, foundStatKeys:[], sampleStats:[], failReason:'ALL_ENDPOINTS_FAILED', durationMs:0, triedEndpoints:tried };
}

async function runStatsAudit() {
  const testedAt = new Date().toISOString();
  const probes = [
    probeFotmobStats,
    probe365ScoresStats,
    probeEspnAltStats,
    probeAiScoreAltStats,
  ];
  const sources = [];
  for (const fn of probes) {
    try { sources.push(await fn()); }
    catch(e) { sources.push({ provider:fn.name.replace(/^probe/, '').toLowerCase(), endpoint:'(exception)', status:null, contentType:'', responseLength:0, jsonParseOk:false, topLevelKeys:[], hasMatchStats:false, foundStatKeys:[], sampleStats:[], failReason:'PROBE_EXCEPTION', error:e.message, durationMs:0 }); }
  }
  const bestCandidates = sources
    .filter(s => s.hasMatchStats)
    .sort((a,b) => (b.foundStatKeys?.length||0) - (a.foundStatKeys?.length||0))
    .map(s => s.provider)
    .slice(0,5);
  const sourceFailReasons = {};
  for (const s of sources) sourceFailReasons[s.provider] = s.failReason;
  return { success:true, testedAt, sources, bestCandidates, sourceFailReasons };
}

function mergeStatsIntoMatch(match, statsResult) {
  if (!match || !statsResult || !statsResult.hasMatchStats) return match;
  // Discovery-first: we do not force values until a provider shape is confirmed.
  match._statsProbeProvider = statsResult.provider;
  match._statsProbeKeys = statsResult.foundStatKeys || [];
  return match;
}

module.exports = { runStatsAudit, mergeStatsIntoMatch, deepScanStatKeys, provider:'stats_audit' };
