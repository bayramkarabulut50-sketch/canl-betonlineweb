/**
 * source_flashscore.js — CanliBet Scraper Service v11.22
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
  // IMPORTANT: AB/AC/AD are often flags/status markers in x-feed, not minutes.
  // Reading them as minutes caused the 666-live bug (many scheduled rows became minute=1).
  const candidates = [o.AM, o.AO, o.BX, o.BC, o.AV, o.BE];
  for (const c of candidates) {
    if (c == null) continue;
    const s = String(c).trim();
    // Accept only explicit clock-like values: 1..130, 45+2, 90+3, or 12'.
    const m = s.match(/^(\d{1,3})(?:\+\d{1,2})?'?$/);
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
  const st = statusText(o);
  const minute = parseMinuteFromRecord(o);

  if (/\b(ft|finished|after pen|aet|walkover|postponed|cancelled|canceled|abandoned|scheduled|not started)\b/.test(st)) return false;
  if (/\b(ht|half\s*time|1st half|2nd half|live|in ?play|delayed|suspended)\b/.test(st)) return true;
  if (minute != null && minute > 0 && minute <= 130) return true;

  // Never use AB/AC/AD/AS/AZ flags or score alone as live proof.
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
  const rawStatusText = statusText(o);
  const rawStatus = rawStatusText.includes('ht') ? 'HT' : (minute ? String(minute) : (rawStatusText.includes('live') ? 'LIVE' : 'UNKNOWN'));

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
  // v11.18: try ALL mirrors in parallel — collect all results, merge best
  const fetchedAt = Date.now();
  const probeAll  = ENDPOINTS.map(ep => probe(ep).catch(e => ({
    provider, source:'flashscore', endpoint:ep, status:null, parsedMatches:0, matches:[],
    failReason:'ENDPOINT_EXCEPTION', error:e.message, rawEventCount:0
  })));
  const audits = await Promise.all(probeAll);

  for (const r of audits) {
    console.log(`[flashscore] ${r.endpoint} → status=${r.status} raw=${r.rawEventCount} matches=${r.parsedMatches} reason=${r.failReason}`);
  }

  // Merge all successful results — dedupe by match_id
  const allMatches = [];
  const seen = new Set();
  for (const r of audits) {
    for (const m of (r.matches || [])) {
      const key = m.match_id || (m.match_hometeam_name+'___'+m.match_awayteam_name);
      if (!seen.has(key)) { seen.add(key); allMatches.push(m); }
    }
  }

  const workingAudits = audits.filter(a=>a.parsedMatches>0);
  const failedAudits  = audits.filter(a=>!a.parsedMatches);
  const best = workingAudits[0] || audits.find(a=>a.status===200) || audits[0];
  const globalAudit = { endpointsTried:ENDPOINTS.length, topEndpoints:workingAudits.slice(0,5), sampledFailures:failedAudits.slice(0,8) };

  if (allMatches.length > 0) {
    return { provider, success:true, matches:allMatches, error:null, fetchedAt, _auditResult:best, _globalAudit:globalAudit };
  }
  return { provider, success:false, matches:[], error:best ? best.failReason : 'all_endpoints_blocked', fetchedAt, _auditResult:best, _globalAudit:globalAudit };
}

module.exports = { fetch, probe, provider, needsPlaywright:false, ENDPOINTS, enabled:true };
