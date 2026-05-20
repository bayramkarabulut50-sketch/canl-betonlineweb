/**
 * source_flashscore.js — CanliBet Scraper Service v11.17
 *
 * Public HTTP scraper for Flashscore/Livesport x-feed.
 * No API key. No browser automation. No proxy/IP rotation. No CAPTCHA bypass.
 * Uses the same lightweight feed that the public live-score pages load.
 *
 * Notes:
 * - x-feed is a compact text protocol, not JSON.
 * - We only take records that look live/in-play. This prevents finished/scheduled
 *   mobile rows from polluting live counts.
 */
'use strict';

const { createHttpClient } = require('../http-client');
const { safeNum, safeStr, normalizeMatches } = require('../normalizer');

const provider = 'flashscore_feed';

const FAIL = {
  HTTP_403:'HTTP_403', HTTP_404:'HTTP_404', HTTP_429:'HTTP_429', HTTP_5XX:'HTTP_5XX',
  EMPTY:'EMPTY_RESPONSE', NO_EVENTS:'NO_EVENTS_FOUND', OK:'OK_PARSED', NON_TEXT:'NON_TEXT_RESPONSE'
};

const XFSIGN = 'SW9D1eZo';

const client = createHttpClient({
  referer: 'https://www.livesport.com/en/soccer/',
  origin:  'https://www.livesport.com',
  minPaceMs: 350,
  timeoutMs: 9000,
  maxRetries: 1,
});

const ENDPOINTS = [
  // Most common global Flashscore/Livesport football feeds. Keep several mirrors;
  // some Render DNS regions resolve one mirror but not another.
  'https://local-global.flashscore.ninja/46/x/feed/f_1_-1_3_en_1',
  'https://local-global.flashscore.ninja/46/x/feed/f_1_0_3_en_1',
  'https://local-global.flashscore.ninja/46/x/feed/f_1_1_3_en_1',
  'https://d.flashscore.com/x/feed/f_1_-1_3_en_1',
  'https://d.flashscore.com/x/feed/f_1_0_3_en_1',
  'https://d.flashscore.com/x/feed/f_1_1_3_en_1',
  'https://local-en.flashscore.ninja/46/x/feed/f_1_-1_3_en_1',
  'https://local-en.flashscore.ninja/46/x/feed/f_1_0_3_en_1',
];

function classifyStatus(s) {
  if (s === 403) return FAIL.HTTP_403;
  if (s === 404) return FAIL.HTTP_404;
  if (s === 429) return FAIL.HTTP_429;
  if (s >= 500 || s == null) return FAIL.HTTP_5XX;
  return null;
}

function decodeVal(v) {
  return safeStr(v).replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).trim();
}

function splitFeedRecords(text) {
  if (!text) return [];
  // Feed records are usually separated by "~". Some payloads start with "¬~".
  return String(text).split('~').map(s => s.trim()).filter(Boolean);
}

function parseRecord(rec) {
  const obj = {};
  for (const part of rec.split('¬')) {
    if (!part || !part.includes('÷')) continue;
    const i = part.indexOf('÷');
    const k = part.slice(0, i);
    const v = decodeVal(part.slice(i + 1));
    obj[k] = v;
  }
  return obj;
}

function parseMinuteFromRecord(o) {
  const candidates = [o.AM, o.AO, o.BX, o.BC, o.AV, o.BE, o.AC, o.AB, o.AD];
  for (const c of candidates) {
    if (c == null) continue;
    const s = String(c);
    // Prefer explicit minutes like 39, 45+2, 90+3.
    const m = s.match(/(\d{1,3})(?:\+\d{1,2})?/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (!isNaN(n) && n > 0 && n <= 130) return n;
    }
  }
  return null;
}

function statusText(o) {
  return [o.AB, o.AC, o.AM, o.AO, o.BX, o.BC, o.AW, o.AS, o.AZ, o.CM, o.CN]
    .filter(v => v != null && v !== '')
    .map(String)
    .join(' ')
    .toLowerCase();
}

function isLiveRecord(o) {
  // Flashscore feed variants use different short fields. These heuristics are
  // intentionally inclusive for in-play records but reject obvious finished rows.
  const st = statusText(o);
  const minute = parseMinuteFromRecord(o);
  const hasScore = o.AG != null || o.AH != null || o.BA != null || o.BB != null;

  if (/\b(ft|finished|after pen|aet|walkover|postponed|cancelled|canceled|abandoned)\b/.test(st)) return false;
  if (/\b(ht|half|1st|2nd|live|in ?play|delayed|suspended)\b/.test(st)) return true;
  if (minute != null && minute > 0 && minute <= 130) return true;

  // Feed f_1_-1_3 often contains live only; AB=1/AC=1 are common in-play flags.
  if (hasScore && (o.AB === '1' || o.AC === '1' || o.AS === '1' || o.AZ === '1')) return true;
  return false;
}

function normFlashRecord(o, leagueName) {
  // Known compact fields: AA=id, AF=home, AE=away in many feed versions.
  // Some mirrors flip AE/AF; use WN/WM short-code hints only as fallback.
  const id = safeStr(o.AA || o.ID || o.eventId);
  const home = safeStr(o.AF || o.WN || o.home || o.homeName);
  const away = safeStr(o.AE || o.WM || o.away || o.awayName);
  if (!id || (!home && !away)) return null;
  if (!isLiveRecord(o)) return null;

  const minute = parseMinuteFromRecord(o);
  const hg = safeNum(o.AG ?? o.BA ?? o.homeScore, 0);
  const ag = safeNum(o.AH ?? o.BB ?? o.awayScore, 0);
  const rawStatus = statusText(o).includes('ht') ? 'HT' : (minute ? String(minute) : 'LIVE');

  return {
    match_id: id,
    match_hometeam_name: home,
    match_awayteam_name: away,
    match_hometeam_score: hg,
    match_awayteam_score: ag,
    match_live: '1',
    match_status: rawStatus,
    minute,
    league_name: safeStr(leagueName || o.ZA || o.ZE || o.ZEE || 'Flashscore Soccer'),
    source: 'flashscore',
    hasOdds: false,
    hasStats: false,
    stats: {},
    odds: {},
    liveQualityTier: 'BASIC_LIVE_ONLY',
    liveMode: 'WATCH_ONLY',
    coverageNotes: ['flashscore_xfeed_basic_live_no_stats_no_odds'],
  };
}

function parseFeed(text) {
  const records = splitFeedRecords(text);
  const out = [];
  let currentLeague = '';
  let rawEventCount = 0;
  let liveRejected = 0;

  for (const rec of records) {
    const o = parseRecord(rec);
    if (!Object.keys(o).length) continue;

    if (o.ZA || o.ZE || o.ZEE) {
      currentLeague = safeStr(o.ZA || o.ZE || o.ZEE || currentLeague);
    }

    if (!o.AA) continue;
    rawEventCount++;
    const m = normFlashRecord(o, currentLeague);
    if (m) out.push(m); else liveRejected++;
  }

  return { rawEventCount, liveRejected, matches: normalizeMatches(out, 'flashscore') };
}

async function probe(endpoint) {
  const t0 = Date.now();
  const headers = { 'x-fsign': XFSIGN, 'Accept': '*/*', 'Referer': 'https://www.livesport.com/en/soccer/' };
  const res = await client.get(endpoint, headers);
  const base = {
    provider, source:'flashscore', endpoint,
    status:res.status, contentType:res.contentType || '', responseLength:res.text ? res.text.length : 0,
    jsonParseOk:false, topLevelKeys:[], rawEventCount:0, parsedMatches:0, acceptedEventCount:0,
    matches:[], sampleMatches:[], failReason:null, durationMs:Date.now()-t0,
    sampleRawPreview:res.text ? res.text.slice(0,500) : '',
  };

  if (!res.ok) { base.failReason = classifyStatus(res.status) || FAIL.HTTP_5XX; return base; }
  if (!res.text || res.text.length < 10) { base.failReason = FAIL.EMPTY; return base; }

  const parsed = parseFeed(res.text);
  base.rawEventCount = parsed.rawEventCount;
  base.acceptedEventCount = parsed.matches.length;
  base.parsedMatches = parsed.matches.length;
  base.matches = parsed.matches;
  base.sampleMatches = parsed.matches.slice(0,3);
  base.failReason = parsed.matches.length ? FAIL.OK : FAIL.NO_EVENTS;
  base.feedDebug = { liveRejected: parsed.liveRejected, recordCount: splitFeedRecords(res.text).length };
  return base;
}

async function fetch(_browser, _options = {}) {
  const fetchedAt = Date.now();
  const audits = [];
  let best = null;
  for (const ep of ENDPOINTS) {
    const r = await probe(ep);
    audits.push(r);
    console.log(`[flashscore] ${ep} → status=${r.status} raw=${r.rawEventCount} matches=${r.parsedMatches} reason=${r.failReason}`);
    if (r.parsedMatches > 0) {
      // Continue one more mirror only if first hit is tiny? Keep fast: return first useful feed.
      return { provider, success:true, matches:r.matches, error:null, fetchedAt, _auditResult:r, _globalAudit:{ endpointsTried:audits.length, topEndpoints:audits.filter(a=>a.parsedMatches>0).slice(0,5), sampledFailures:audits.filter(a=>!a.parsedMatches).slice(0,8) } };
    }
    if (!best || (r.status === 200 && best.status !== 200)) best = r;
  }
  return { provider, success:false, matches:[], error:best ? best.failReason : 'all_failed', fetchedAt, _auditResult:best, _globalAudit:{ endpointsTried:audits.length, topEndpoints:audits.filter(a=>a.parsedMatches>0).slice(0,5), sampledFailures:audits.slice(0,8) } };
}

module.exports = { fetch, probe, provider, needsPlaywright:false, ENDPOINTS, enabled:true };
