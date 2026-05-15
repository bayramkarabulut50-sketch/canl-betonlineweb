/**
 * server.js — CanliBet Scraper Service v10.87-json-source-audit
 *
 * This version tests public JSON endpoints only.
 * No HTML scraping. No browser automation. No anti-bot bypass. No proxy.
 * Each source is a public JSON endpoint probe.
 */
'use strict';

const express = require('express');
const cors    = require('cors');
const { mergeAdapterResults } = require('./normalizer');

// ── Env ───────────────────────────────────────────────────────────────────────
const PORT              = process.env.PORT             || 3847;
const CACHE_TTL_MS      = parseInt(process.env.CACHE_TTL_MS || '30000', 10);
const LOG_REQUESTS      = process.env.LOG_REQUESTS !== 'false';
const ENABLE_MOCK       = process.env.ENABLE_MOCK_SOURCE           !== 'false';
const ENABLE_SOFASCORE  = process.env.ENABLE_SOFASCORE_SOURCE      === 'true';  // default off (403 on Render)
const ENABLE_ESPN       = process.env.ENABLE_ESPN_JSON_SOURCE      !== 'false'; // default on
const ENABLE_FOTMOB     = process.env.ENABLE_FOTMOB_JSON_SOURCE    !== 'false'; // default on
const ENABLE_AISCORE    = process.env.ENABLE_AISCORE_JSON_SOURCE   !== 'false'; // default on

function log(msg, data) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}${data != null ? ' ' + JSON.stringify(data) : ''}`);
}

// ── Lazy Playwright (only if enabled adapter needs it) ────────────────────────
let _browser = null, _pwAvailable = null;
async function lazyGetBrowser() {
  if (_browser) { try { await _browser.version(); return _browser; } catch(e) { _browser=null; } }
  if (_pwAvailable===false) throw new Error('Playwright not available');
  try {
    const { chromium } = require('playwright');
    _browser = await chromium.launch({ headless:true, args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'] });
    _pwAvailable = true; return _browser;
  } catch(err) { _pwAvailable=false; throw new Error('Chromium launch failed: '+err.message); }
}
global._scraperLazyGetBrowser = lazyGetBrowser;

// ── Load adapters ─────────────────────────────────────────────────────────────
const LIVE_ADAPTERS  = [];  // used by /live
const AUDIT_ADAPTERS = [];  // used by /audit (all JSON probes)

const espnMod     = require('./sources/source_espn_json');
const fotmobMod   = require('./sources/source_fotmob_json');
const aiscoreMod  = require('./sources/source_aiscore_json');
const mockMod     = require('./sources/source_mock');

// Audit always includes all JSON probes
AUDIT_ADAPTERS.push(espnMod, fotmobMod, aiscoreMod);
if (ENABLE_SOFASCORE) AUDIT_ADAPTERS.push(require('./sources/source_sofascore'));

// Live adapters — enabled sources first, mock last
if (ENABLE_ESPN)    { LIVE_ADAPTERS.push(espnMod);    log('Adapter: espn_json (HTTP-only)'); }
if (ENABLE_FOTMOB)  { LIVE_ADAPTERS.push(fotmobMod);  log('Adapter: fotmob_json (HTTP-only)'); }
if (ENABLE_AISCORE) { LIVE_ADAPTERS.push(aiscoreMod); log('Adapter: aiscore_json (HTTP-only)'); }
if (ENABLE_SOFASCORE){ LIVE_ADAPTERS.push(require('./sources/source_sofascore')); log('Adapter: sofascore (HTTP-only)'); }
if (ENABLE_MOCK)    { LIVE_ADAPTERS.push(mockMod);    log('Adapter: mock (fallback)'); }

const anyPlaywright = ENABLE_SOFASCORE && false; // sofascore v10.87 is HTTP-only too
if (!anyPlaywright) log('Chromium disabled / skipped — no Playwright adapter active');

// ── Cache ─────────────────────────────────────────────────────────────────────
let _snapshot = null;
let _lastAuditResult = null;
const _sourceSuccessCounts = {};
const _sourceFailReasons   = {};

function isCacheValid() { return _snapshot && Date.now() < _snapshot.expiresAt; }

// ── Fetch cycle ───────────────────────────────────────────────────────────────
async function runFetchCycle() {
  const t0 = Date.now();
  const results = [], tried = [], counts = {};

  for (const adapter of LIVE_ADAPTERS) {
    const name = adapter.provider;
    const t1 = Date.now();
    let r;
    try { r = await adapter.fetch(null, { cache:_snapshot }); }
    catch(err) { r = { provider:name, success:false, matches:[], error:err.message, fetchedAt:Date.now() }; }
    const ms = Date.now()-t1;
    log(`[${name}] done`, { ok:r.success, n:r.matches?.length??0, ms, err:r.error??null });
    results.push(r); tried.push(name); counts[name]=r.success?(r.matches?.length??0):0;

    // Track success/fail globally
    _sourceSuccessCounts[name] = (_sourceSuccessCounts[name]||0) + (r.success ? 1 : 0);
    if (!r.success) _sourceFailReasons[name] = r.error || 'unknown';

    // Stop at first success with real matches (mock = last resort)
    if (r.success && r.matches?.length > 0 && name !== 'mock') break;
  }

  // If no real source succeeded, let mock fill
  const merged = mergeAdapterResults(results);
  const live   = merged.filter(m => m.match_live === '1');
  const meta   = {
    fetchedAt:t0, durationMs:Date.now()-t0, sourcesTried:tried,
    sourceSuccessCounts:counts, liveMatches:live.length,
    oddsMatchedCount:live.filter(m=>m.hasOdds).length,
    statsCoverage:live.filter(m=>m.hasStats).length,
    cacheHit:false, lastFetchAt:new Date(t0).toISOString(),
    lastLiveSource: results.find(r=>r.success&&r.matches?.length>0)?.provider || null,
  };

  _snapshot = { matches:live, allMatches:merged, meta, fetchedAt:t0, expiresAt:t0+CACHE_TTL_MS };
  log('Cycle done', { live:live.length, source:meta.lastLiveSource, ms:meta.durationMs });
  return _snapshot;
}

async function getSnapshot(force=false) {
  if (!force && isCacheValid()) return { ..._snapshot, meta:{..._snapshot.meta, cacheHit:true} };
  return runFetchCycle();
}

// ── /audit runner ─────────────────────────────────────────────────────────────
async function runAudit() {
  const testedAt  = new Date().toISOString();
  const sources   = [];

  for (const adapter of AUDIT_ADAPTERS) {
    log(`[audit] probing ${adapter.provider}...`);
    const endpoints = adapter.ENDPOINTS || [];
    if (endpoints.length > 0) {
      // Probe primary endpoint
      for (const ep of endpoints.slice(0,2)) {
        try {
          const r = await adapter.probe(ep);
          sources.push(r);
          log(`[audit] ${adapter.provider} ep=${ep} → status=${r.status} matches=${r.parsedMatches} reason=${r.failReason}`);
          if (r.parsedMatches > 0) break; // got data — no need to probe more endpoints
        } catch(e) {
          sources.push({ provider:adapter.provider, source:adapter.provider, endpoint:ep, failReason:'PROBE_EXCEPTION', error:e.message, parsedMatches:0, matches:[] });
        }
      }
    } else {
      // adapter has no ENDPOINTS array — do a full fetch and wrap
      try {
        const r = await adapter.fetch(null, {});
        sources.push({
          provider:adapter.provider, source:adapter.provider,
          endpoint:'(see adapter)', status:null,
          contentType:'', responseLength:0, jsonParseOk:r.matches?.length>0,
          topLevelKeys:[], parsedMatches:r.matches?.length||0,
          matches:r.matches||[], failReason:r.error||'OK_PARSED', sampleMatches:[],
        });
      } catch(e) {
        sources.push({ provider:adapter.provider, failReason:'PROBE_EXCEPTION', error:e.message, parsedMatches:0 });
      }
    }
  }

  const bestCandidates = sources
    .filter(s => s.parsedMatches > 0)
    .sort((a,b) => b.parsedMatches - a.parsedMatches)
    .slice(0,3)
    .map(s => s.source || s.provider);

  _lastAuditResult = { testedAt, sources, bestCandidates };
  return _lastAuditResult;
}

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin:'*' }));
app.use(express.json());
if (LOG_REQUESTS) app.use((req,_,next)=>{ log(`${req.method} ${req.path}`); next(); });

app.get('/health', (_,res) => res.json({
  status:'ok', version:'10.89-espn-stats-discovery', uptime:Math.round(process.uptime()),
  cacheValid:isCacheValid(), cacheAge:_snapshot?Math.round((Date.now()-_snapshot.fetchedAt)/1000)+'s':null,
  enabledSources: {
    espn_json:    ENABLE_ESPN,
    fotmob_json:  ENABLE_FOTMOB,
    aiscore_json: ENABLE_AISCORE,
    sofascore:    ENABLE_SOFASCORE,
    mock:         ENABLE_MOCK,
  },
  lastLiveSource:  _snapshot?.meta?.lastLiveSource || null,
  lastAuditSummary:_lastAuditResult ? {
    testedAt:       _lastAuditResult.testedAt,
    bestCandidates: _lastAuditResult.bestCandidates,
    sourcesCount:   _lastAuditResult.sources.length,
  } : null,
  sourceSuccessCounts: _sourceSuccessCounts,
  sourceFailReasons:   _sourceFailReasons,
  env:{ PORT, CACHE_TTL_MS },
}));

app.get('/live', async (req,res) => {
  try {
    const s = await getSnapshot(req.query.refresh==='1');
    res.json({ success:true, provider:'scraper', matches:s.matches, debug:{
      selectedProvider:s.meta.lastLiveSource||'unknown',
      sourcesTried:s.meta.sourcesTried, sourceSuccessCounts:s.meta.sourceSuccessCounts,
      liveMatches:s.meta.liveMatches, oddsMatchedCount:s.meta.oddsMatchedCount,
      cacheHit:s.meta.cacheHit, lastFetchAt:s.meta.lastFetchAt, durationMs:s.meta.durationMs,
    }});
  } catch(err) {
    log('[ERROR] /live', { error:err.message });
    res.status(200).json({ success:false, provider:'scraper', matches:[], error:err.message, debug:{} });
  }
});

app.get('/audit', async (req,res) => {
  try {
    log('[audit] Starting JSON source audit...');
    const result = await runAudit();
    res.json({ success:true, renderHost:true, ...result });
  } catch(err) {
    log('[ERROR] /audit', { error:err.message });
    res.status(200).json({ success:false, error:err.message, sources:[], bestCandidates:[] });
  }
});

app.get('/odds', async (_,res) => {
  try {
    const s = await getSnapshot();
    const odds = s.matches.map(m=>({ match_id:m.match_id, match_hometeam_name:m.match_hometeam_name, match_awayteam_name:m.match_awayteam_name, odds:m.odds, hasOdds:m.hasOdds, source:m.source }));
    res.json({ success:true, count:odds.length, fetchedAt:s.fetchedAt, odds });
  } catch(err) { res.status(200).json({ success:false, count:0, odds:[], error:err.message }); }
});

app.get('/snapshot', async (_,res) => {
  try { const s=await getSnapshot(); res.json({ success:true, ...s }); }
  catch(err) { res.status(200).json({ success:false, matches:[], meta:{}, error:err.message }); }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  log(`CanliBet scraper service v10.87-json-source-audit listening on :${PORT}`);
  try { await runFetchCycle(); log('Initial fetch complete'); }
  catch(err) { log('[ERROR] Initial fetch (non-fatal)', { error:err.message }); }

  const interval = Math.max(Math.round(CACHE_TTL_MS/2), 15000);
  setInterval(async () => {
    if (!isCacheValid()) {
      try { await runFetchCycle(); }
      catch(e) { log('[ERROR] Background refresh', { error:e.message }); }
    }
  }, interval);
});

process.on('SIGTERM', async () => {
  if (_browser) await _browser.close().catch(()=>{});
  process.exit(0);
});
