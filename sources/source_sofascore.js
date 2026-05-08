/**
 * source_sofascore.js v10.86-safe-http
 *
 * Uses centralized http-client.js with production-grade HTTP hygiene:
 * - Stable Chrome UA, standard browser headers
 * - Request pacing (min 1200ms between calls)
 * - 403 → single cautious retry; 429/503 → exponential backoff
 * - Graceful fail if 403 persists → mock fallback continues
 *
 * No stealth, no fingerprint spoofing, no CAPTCHA solving.
 */
'use strict';

const { createHttpClient } = require('../http-client');
const { normalizeMatches, safeNum, safeStr } = require('../normalizer');

const BASE_URL   = 'https://api.sofascore.com/api/v1';
const LIVE_URL   = BASE_URL + '/sport/football/events/live';
const STATS_LIMIT = 5;

// Single shared client for all SofaScore requests
const client = createHttpClient({
  referer:    'https://www.sofascore.com/',
  origin:     'https://www.sofascore.com',
  minPaceMs:  1200,
  timeoutMs:  8000,
  maxRetries: 1,
});

// ── Schema auto-detect ────────────────────────────────────────────────────────
function extractEvents(data) {
  if (!data || typeof data !== 'object') return [];
  const candidates = [
    data.events,
    data.data,
    data.data && data.data.events,
    data.results,
    data.matches,
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0) return c;
  }
  return Array.isArray(data) ? data : [];
}

// ── Live status detection — broad ─────────────────────────────────────────────
const DEAD = ['finished','fulltime','ended','postponed','canceled','notstarted','scheduled','ft','ns'];
const LIVE = ['inprogress','halftime','extra','penalty','1st','2nd','live','playing','started'];

function isLiveStatus(status) {
  if (!status) return false;
  const fields = [status.code, status.type, status.description, status.name]
    .filter(Boolean).map(v => String(v).toLowerCase().replace(/[^a-z0-9]/g, ''));
  for (const f of fields) {
    for (const d of DEAD) { if (f === d || f.startsWith(d)) return false; }
  }
  for (const f of fields) {
    for (const l of LIVE) { if (f === l || f.includes(l)) return true; }
  }
  // SofaScore numeric codes: 6=1H, 7=HT, 8=2H, 9=ET, 10=PEN
  const n = Number(status.code);
  if (!isNaN(n) && n >= 6 && n <= 12) return true;
  return false;
}

function normStatus(status) {
  if (!status) return '';
  const code = String(status.code || '').toLowerCase();
  if (code === '6' || code === 'inprogress') return '1H';
  if (code === '7' || code.includes('half'))  return 'HT';
  if (code === '8')                            return '2H';
  if (code === '9' || code.includes('extra'))  return 'ET';
  if (code === '10')                           return 'PEN';
  return String(status.description || code).toUpperCase().slice(0, 8);
}

// ── Event normalizer ──────────────────────────────────────────────────────────
function normEvent(ev) {
  if (!ev || !ev.id) return null;
  if (!isLiveStatus(ev.status || {})) return null;
  const ht = ev.homeTeam || {}; const at = ev.awayTeam || {};
  const hs = ev.homeScore || {}; const as_ = ev.awayScore || {};
  const tm = ev.time || {};
  return {
    match_id:             String(ev.id),
    match_hometeam_name:  safeStr(ht.name || ht.shortName),
    match_awayteam_name:  safeStr(at.name || at.shortName),
    match_hometeam_score: safeNum(hs.current != null ? hs.current : hs.normaltime, 0),
    match_awayteam_score: safeNum(as_.current != null ? as_.current : as_.normaltime, 0),
    match_live:    '1',
    match_status:  normStatus(ev.status),
    minute:        safeNum(tm.played != null ? tm.played : tm.min),
    league_name:   safeStr((ev.tournament || {}).name),
    source:        'sofascore',
    hasOdds:       false, odds: {},
  };
}

// ── Per-match stats ───────────────────────────────────────────────────────────
async function fetchMatchStats(eventId) {
  const res = await client.get(BASE_URL + '/event/' + eventId + '/statistics');
  if (!res.ok) { console.log(`[sofascore] stats ${eventId} failed status=${res.status||res.error}`); return null; }
  let data;
  try { data = JSON.parse(res.text); } catch (e) { return null; }

  const map = {};
  for (const g of (data.statistics || [])) {
    for (const item of (g.statisticsItems || [])) {
      const key = String(item.key || '').toLowerCase().replace(/[^a-z0-9]/g, '_');
      const hv  = safeNum(String(item.home ?? '').replace('%', ''));
      const av  = safeNum(String(item.away ?? '').replace('%', ''));
      if (hv !== null || av !== null) map[key] = { home: hv, away: av };
    }
  }
  const pick = (...ks) => { for (const k of ks) if (map[k]) return map[k]; return null; };
  const sum  = s => s ? (s.home||0)+(s.away||0) : null;
  const home = s => s ? s.home : null;
  const away = s => s ? s.away : null;

  const r = {
    attacks:           sum(pick('attacks','total_attacks')),
    dangerous_attacks: sum(pick('dangerous_attacks')),
    shots_total:       sum(pick('total_shots','shots_total')),
    shots_on_target:   sum(pick('shots_on_target')),
    corners:           sum(pick('corner_kicks','corners')),
    possession_home:   home(pick('ball_possession','possession')),
    possession_away:   away(pick('ball_possession','possession')),
  };
  const hasAny = Object.values(r).some(v => v !== null);
  console.log(`[sofascore] stats ${eventId} ${hasAny ? 'ok' : 'empty'}`);
  return hasAny ? r : null;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function fetch(_browser, _options) {
  const fetchedAt = Date.now();

  // ── Live request ──
  const res = await client.get(LIVE_URL);
  console.log(`[sofascore] live status=${res.status||'none'} ok=${res.ok} duration=${res.durationMs}ms attempts=${res.attempts}`);
  if (res.contentType) console.log(`[sofascore] content-type=${res.contentType.slice(0,50)}`);

  if (!res.ok) {
    if (res.status === 403) console.log(`[sofascore] 403 — datacenter IP likely blocked; mock fallback active`);
    else if (res.error)     console.log(`[sofascore] error=${res.error}`);
    else                    console.log(`[sofascore] body preview=${(res.text||'').slice(0,300)}`);
    return { provider:'sofascore', success:false, matches:[], error:res.error||'HTTP '+res.status, fetchedAt };
  }

  // ── Parse ──
  let data;
  try { data = JSON.parse(res.text); }
  catch (e) {
    console.log(`[sofascore] JSON parse error. preview=${res.text.slice(0,200)}`);
    return { provider:'sofascore', success:false, matches:[], error:'json_parse_error', fetchedAt };
  }
  console.log(`[sofascore] payload=${res.text.length}b keys=${Object.keys(data||{}).join(',')}`);

  // ── Extract events ──
  const events = extractEvents(data);
  console.log(`[sofascore] events=${events.length}`);
  if (events.length === 0) {
    console.log(`[sofascore] raw preview=${res.text.slice(0,500)}`);
    return { provider:'sofascore', success:false, matches:[], error:'no_events_in_response', fetchedAt };
  }

  // ── Status sample for diagnosis ──
  const statusSample = events.slice(0,8).map(ev => {
    const s = ev.status||{}; return String(s.code||s.type||s.description||'?');
  }).join(',');
  console.log(`[sofascore] status sample=${statusSample}`);

  // ── Normalize ──
  const raw = []; let filteredOut = 0;
  for (const ev of events) {
    const m = normEvent(ev);
    if (m) raw.push(m); else filteredOut++;
  }
  console.log(`[sofascore] live_after_filter=${raw.length} filtered_out=${filteredOut}`);

  if (raw.length === 0) {
    const sample = events.slice(0,3).map(ev => JSON.stringify(ev.status||{})).join(' | ');
    console.log(`[sofascore] status objects: ${sample}`);
    return { provider:'sofascore', success:false, matches:[], error:'no_live_matches', fetchedAt };
  }

  // ── Stats (serial, paced by http-client) ──
  let statsFetched = 0;
  for (let j = 0; j < Math.min(raw.length, STATS_LIMIT); j++) {
    const stats = await fetchMatchStats(raw[j].match_id);
    if (stats) { raw[j].stats = stats; raw[j].hasStats = true; statsFetched++; }
    else        { raw[j].stats = {};   raw[j].hasStats = false; }
  }
  for (let k = STATS_LIMIT; k < raw.length; k++) { raw[k].stats={}; raw[k].hasStats=false; }

  const normalized = normalizeMatches(raw, 'sofascore');
  console.log(`[sofascore] normalizedMatches=${normalized.length} stats=${statsFetched} total=${Date.now()-fetchedAt}ms`);

  if (normalized.length === 0) {
    return { provider:'sofascore', success:false, matches:[], error:'no_matches_after_normalization', fetchedAt };
  }
  return { provider:'sofascore', success:true, matches:normalized, error:null, fetchedAt,
           meta:{ liveMatches:normalized.length, statsFetched, durationMs:Date.now()-fetchedAt } };
}

module.exports = { fetch, provider:'sofascore', needsPlaywright:false };
