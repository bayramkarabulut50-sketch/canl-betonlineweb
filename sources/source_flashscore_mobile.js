/**
 * source_flashscore_mobile.js — CanliBet Scraper Service v11.27
 *
 * Public HTTP HTML scraper for m.Flashscore live football page.
 * No API key. No browser automation. No proxy/IP rotation.
 * Purpose: high-coverage live discovery source to complement ESPN quality/stats.
 */
'use strict';

const { createHttpClient } = require('../http-client');
const { safeNum, safeStr, normalizeMatches } = require('../normalizer');

const provider = 'flashscore_mobile';

const client = createHttpClient({
  referer: 'https://m.flashscore.com.tr/',
  origin:  'https://m.flashscore.com.tr',
  minPaceMs: 400,
  timeoutMs: 9000,
  maxRetries: 1,
});

const ENDPOINTS = [
  'https://m.flashscore.com.tr/?s=2', // Turkish mobile live football
  'https://m.flashscore.com/?s=2',    // global/en fallback
];

function htmlDecode(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function stripHtml(html) {
  return htmlDecode(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p>|<\/div>|<\/li>|<\/tr>|<\/h\d>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\t\r]+/g, ' ')
  );
}

function cleanLine(line) {
  return String(line || '')
    .replace(/\s+/g, ' ')
    .replace(/Image/g, '')
    .replace(/Puan durumu/g, '')
    .trim();
}

function parseMinuteToken(tok) {
  if (!tok) return null;
  const t = String(tok).trim().toLowerCase();
  if (/devre|half/.test(t)) return 45;
  if (/uzatma|extra/.test(t)) return 105;
  const m = t.match(/^(\d{1,3})(?:\+\d{0,2})?'?$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return (!isNaN(n) && n > 0 && n <= 130) ? n : null;
}

function rawStatusFromMinute(minuteToken) {
  const t = String(minuteToken || '').trim().toLowerCase();
  if (/devre|half/.test(t)) return 'HT';
  if (/uzatma|extra/.test(t)) return 'ET';
  const min = parseMinuteToken(minuteToken);
  if (min == null) return 'UNKNOWN';
  if (min <= 45) return '1H';
  if (min <= 130) return '2H';
  return 'LIVE';
}

function isLeagueHeading(line) {
  if (!line) return false;
  if (/^(Futbol|Football)\s*»/i.test(line)) return false;
  if (/^(Bugün|Dün|Yarın|Hepsi|Canlı|Bitmiş|Oranlar|ŞIMDI|SIMDI|Başa)/i.test(line)) return false;
  // Mobile headings look like "İSVEÇ: Superettan" or "AVRUPA: ..."
  return /^[A-ZÇĞİÖŞÜÂÊÎÛÄËÏÖÜÉÈÀÙÑ0-9 .&'-]+:\s+/.test(line);
}

function parseScore(s) {
  const m = String(s || '').match(/^(\d+)\s*:\s*(\d+)/);
  if (!m) return null;
  return { home: safeNum(m[1], 0), away: safeNum(m[2], 0) };
}

function parseLiveLine(line, currentLeague, idx) {
  const ln = cleanLine(line);
  if (!ln) return null;
  if (/(^|\s)-:-($|\s)/.test(ln)) return null; // scheduled
  if (/\b(ft|finished|ertelendi|postponed|cancelled|canceled|abandoned)\b/i.test(ln)) return null;

  // Examples:
  // 24'Admira - Floridsdorfer AC 0:0
  // Devre Arası Basel - St. Gallen 0:0
  // 90+'Mjallby - Hammarby 2:1
  // Uzatma Royale Union SG - Anderlecht 3:1
  const re = /^(?:(\d{1,3}(?:\+\d{0,2})?'?)|(Devre\s+Arası|Uzatma|Half\s*Time|HT|Extra\s*Time))\s*'?\s*(.+?)\s+-\s+(.+?)\s+(\d+\s*:\s*\d+)(?:\w+)?\s*$/i;
  const m = ln.match(re);
  if (!m) return null;
  const minuteToken = m[1] || m[2];
  const minute = parseMinuteToken(minuteToken);
  if (minute == null || minute < 1 || minute > 130) return null;
  const score = parseScore(m[5]);
  if (!score) return null;
  const home = cleanLine(m[3]);
  const away = cleanLine(m[4]);
  if (!home || !away || home.length < 2 || away.length < 2) return null;

  return {
    match_id: 'fsm_' + Buffer.from([currentLeague, home, away, minuteToken, score.home, score.away].join('|')).toString('base64url').slice(0, 28),
    match_hometeam_name: home,
    match_awayteam_name: away,
    match_hometeam_score: score.home,
    match_awayteam_score: score.away,
    match_live: '1',
    match_status: rawStatusFromMinute(minuteToken),
    minute,
    league_name: safeStr(currentLeague || 'Flashscore Mobile Soccer'),
    source: 'flashscore_mobile',
    hasOdds: false,
    hasStats: false,
    stats: {},
    odds: {},
    liveQualityTier: 'MOBILE_BASIC_LIVE',
    liveMode: 'VISIBLE_LOW_DATA',
    coverageNotes: ['flashscore_mobile_live_html_no_stats_no_odds'],
    _rawMobileLine: ln,
    _mobileIndex: idx,
  };
}

function parseMobileHtml(html) {
  const text = stripHtml(html);
  const lines = text.split('\n').map(cleanLine).filter(Boolean);
  const matches = [];
  let currentLeague = '';
  let rawLiveLikeRows = 0;
  let rejectedRows = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isLeagueHeading(line)) {
      currentLeague = line.replace(/\s*Puan durumu\s*/ig, '').trim();
      continue;
    }
    if (/^(\d{1,3}(?:\+\d{0,2})?'?|Devre\s+Arası|Uzatma|Half\s*Time|HT|Extra\s*Time)/i.test(line)) {
      rawLiveLikeRows++;
      const m = parseLiveLine(line, currentLeague, i);
      if (m) matches.push(m); else rejectedRows++;
    }
  }

  return {
    lines: lines.length,
    rawEventCount: rawLiveLikeRows,
    rejectedRows,
    matches: normalizeMatches(matches, 'flashscore_mobile', { minValidationScore: 30 }),
    sampleLines: lines.slice(0, 80),
  };
}

async function probe(endpoint) {
  const t0 = Date.now();
  const res = await client.get(endpoint, {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Referer': 'https://m.flashscore.com.tr/?s=2',
  });
  const base = {
    provider, source:'flashscore_mobile', endpoint,
    status:res.status, contentType:res.contentType || '', responseLength:res.text ? res.text.length : 0,
    jsonParseOk:false, topLevelKeys:[], rawEventCount:0, parsedMatches:0, acceptedEventCount:0,
    matches:[], sampleMatches:[], failReason:null, durationMs:Date.now()-t0,
    sampleRawPreview:res.text ? res.text.slice(0,500) : '',
  };
  if (!res.ok) { base.failReason = res.status === 403 ? 'HTTP_403' : (res.status === 404 ? 'HTTP_404' : 'HTTP_'+(res.status||'ERR')); return base; }
  if (!res.text || res.text.length < 100) { base.failReason = 'EMPTY_RESPONSE'; return base; }
  const parsed = parseMobileHtml(res.text);
  base.rawEventCount = parsed.rawEventCount;
  base.parsedMatches = parsed.matches.length;
  base.acceptedEventCount = parsed.matches.length;
  base.matches = parsed.matches;
  base.sampleMatches = parsed.matches.slice(0, 5);
  base.mobileDebug = { lineCount:parsed.lines, rejectedRows:parsed.rejectedRows, sampleLines:parsed.sampleLines.slice(0, 25) };
  base.failReason = parsed.matches.length ? 'OK_PARSED' : 'NO_LIVE_EVENTS_FOUND';
  return base;
}

async function fetch(_browser, _options = {}) {
  const fetchedAt = Date.now();
  const audits = await Promise.all(ENDPOINTS.map(ep => probe(ep).catch(e => ({ provider, source:'flashscore_mobile', endpoint:ep, status:null, parsedMatches:0, rawEventCount:0, matches:[], failReason:'ENDPOINT_EXCEPTION', error:e.message }))));
  const all = [];
  const seen = new Set();
  for (const a of audits) {
    console.log(`[flashscore_mobile] ${a.endpoint} → status=${a.status} raw=${a.rawEventCount} matches=${a.parsedMatches} reason=${a.failReason}`);
    for (const m of (a.matches || [])) {
      const key = [m.match_hometeam_name, m.match_awayteam_name, m.minute, m.match_hometeam_score, m.match_awayteam_score].join('|').toLowerCase();
      if (!seen.has(key)) { seen.add(key); all.push(m); }
    }
  }
  const best = audits.find(a => a.parsedMatches > 0) || audits.find(a => a.status === 200) || audits[0];
  const globalAudit = { endpointsTried:ENDPOINTS.length, topEndpoints:audits.filter(a=>a.parsedMatches>0).slice(0,5), sampledFailures:audits.filter(a=>!a.parsedMatches).slice(0,5) };
  if (all.length) return { provider, success:true, matches:all, fetchedAt, _auditResult:best, _globalAudit:globalAudit };
  return { provider, success:false, matches:[], error:best?.failReason || 'all_mobile_endpoints_failed', fetchedAt, _auditResult:best, _globalAudit:globalAudit };
}

module.exports = { provider, fetch, probe, needsPlaywright:false, ENDPOINTS, enabled:true, _parseMobileHtml:parseMobileHtml };
