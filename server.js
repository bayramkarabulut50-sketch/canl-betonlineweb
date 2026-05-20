/**
 * server.js — CanliBet Scraper Service v11.17-scraper-data-network-flashscore
 *
 * Scraper-only data network.
 * No paid/API-key provider connections. No API-Sports. No API-Football.
 * No SofaScore/IP-sensitive source. No proxy/IP rotation/browser automation.
 * Only public scraper/HTTP JSON probes are used.
 */
'use strict';

const express = require('express');
const cors    = require('cors');
const { mergeAdapterResults } = require('./normalizer');
const statsAudit = require('./sources/source_stats_audit');

// ── Env ───────────────────────────────────────────────────────────────────────
const PORT              = process.env.PORT             || 3847;
const CACHE_TTL_MS      = parseInt(process.env.CACHE_TTL_MS || '30000', 10);
const LOG_REQUESTS      = process.env.LOG_REQUESTS !== 'false';
const ENABLE_MOCK       = process.env.ENABLE_MOCK_SOURCE           !== 'false';
const ENABLE_SOFASCORE  = false; // v11.10: disabled by policy. No SofaScore/IP-sensitive source.
const ENABLE_ESPN       = process.env.ENABLE_ESPN_JSON_SOURCE      !== 'false'; // default on
const ENABLE_FOTMOB     = process.env.ENABLE_FOTMOB_JSON_SOURCE    !== 'false'; // default on
const ENABLE_AISCORE    = process.env.ENABLE_AISCORE_JSON_SOURCE   !== 'false'; // default on
const ENABLE_THESPORTSDB = process.env.ENABLE_THESPORTSDB_JSON_SOURCE !== 'false'; // default on
const ENABLE_OPENLIGADB  = process.env.ENABLE_OPENLIGADB_JSON_SOURCE  !== 'false'; // default on
const ENABLE_FLASHSCORE  = process.env.ENABLE_FLASHSCORE_FEED_SOURCE  !== 'false'; // default on, public x-feed scraper
// v11.01: production safety — never publish demo/mock matches unless explicitly disabled.
const DISABLE_MOCK_FALLBACK = String(process.env.DISABLE_MOCK_FALLBACK || 'true').toLowerCase() === 'true';

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
const thesportsdbMod = require('./sources/source_thesportsdb_json');
const openligadbMod  = require('./sources/source_openligadb_json');
const flashscoreMod  = require('./sources/source_flashscore');
const mockMod     = require('./sources/source_mock');

// Audit always includes all JSON probes
AUDIT_ADAPTERS.push(espnMod, flashscoreMod, fotmobMod, aiscoreMod, thesportsdbMod, openligadbMod);
// v11.10: SofaScore intentionally excluded from audit/live by policy.

// Live adapters — v11.11 ESPN-first/no-IP-sensitive coverage.
// SofaScore removed. Primary live source is ESPN public JSON.
if (ENABLE_ESPN)    { LIVE_ADAPTERS.push(espnMod);    log('Adapter: espn_json (HTTP-only, primary)'); }
if (ENABLE_FLASHSCORE) { LIVE_ADAPTERS.push(flashscoreMod); log('Adapter: flashscore_feed (HTTP-only public x-feed)'); }
// v11.15: API-key providers intentionally removed. Scraper-only policy.
if (ENABLE_FOTMOB)  { LIVE_ADAPTERS.push(fotmobMod);  log('Adapter: fotmob_json (HTTP-only)'); }
if (ENABLE_OPENLIGADB)  { LIVE_ADAPTERS.push(openligadbMod);  log('Adapter: openligadb_json (HTTP-only)'); }
if (ENABLE_THESPORTSDB) { LIVE_ADAPTERS.push(thesportsdbMod); log('Adapter: thesportsdb_json (HTTP-only)'); }
// AIScore usually returns Cloudflare 403 from Render; keep opt-in to avoid slow live cycles.
if (String(process.env.ENABLE_AISCORE_LIVE || 'false').toLowerCase() === 'true' && ENABLE_AISCORE) { LIVE_ADAPTERS.push(aiscoreMod); log('Adapter: aiscore_json (HTTP-only, opt-in)'); }
if (ENABLE_MOCK)    { LIVE_ADAPTERS.push(mockMod);    log('Adapter: mock (fallback)'); }

const anyPlaywright = ENABLE_SOFASCORE && false; // sofascore v10.87 is HTTP-only too
if (!anyPlaywright) log('Chromium disabled / skipped — no Playwright adapter active');

// ── Cache ─────────────────────────────────────────────────────────────────────
let _snapshot = null;
let _lastAuditResult = null;
let _lastStatsAuditResult = null;
const _sourceSuccessCounts = {};
const _sourceFailReasons   = {};

function isCacheValid() { return _snapshot && Date.now() < _snapshot.expiresAt; }

// ── Fetch cycle ───────────────────────────────────────────────────────────────
async function runFetchCycle() {
  const t0 = Date.now();
  const results = [], tried = [], counts = {};

  for (const adapter of LIVE_ADAPTERS) {
    const name = adapter.provider;

    // v11.00: mock is only a development fallback. Do not call it when disabled.
    if (name === 'mock' && DISABLE_MOCK_FALLBACK) {
      log('[mock] skipped — DISABLE_MOCK_FALLBACK=true');
      tried.push(name + ':skipped');
      counts[name] = 0;
      continue;
    }

    const t1 = Date.now();
    let r;
    try { r = await adapter.fetch(null, { cache:_snapshot, fullScan:false }); }
    catch(err) { r = { provider:name, success:false, matches:[], error:err.message, fetchedAt:Date.now() }; }
    const ms = Date.now()-t1;
    log(`[${name}] done`, { ok:r.success, n:r.matches?.length??0, ms, err:r.error??null });
    results.push(r); tried.push(name); counts[name]=r.success?(r.matches?.length??0):0;

    _sourceSuccessCounts[name] = (_sourceSuccessCounts[name]||0) + (r.success ? 1 : 0);
    if (!r.success) _sourceFailReasons[name] = r.error || 'unknown';

    // v11.10: continue through enabled public JSON sources, but SofaScore/IP-sensitive sources are excluded.
  }

  const merged = mergeAdapterResults(results);
  const live   = merged.filter(m => m.match_live === '1' && m.source !== 'mock' && String(m.match_id || '').indexOf('mock_') !== 0);
  const meta   = {
    fetchedAt:t0, durationMs:Date.now()-t0, sourcesTried:tried,
    sourceSuccessCounts:counts, liveMatches:live.length,
    oddsMatchedCount:live.filter(m=>m.hasOdds).length,
    statsCoverage:live.filter(m=>m.hasStats).length,
    signalCoverage:live.filter(m=>m.signalCount > 0).length,
    actionableSignals:live.reduce((a,m)=>a+(m.signalCount||0),0),
    qualityTiers: live.reduce((acc,m)=>{ const k=m.liveQualityTier||'UNKNOWN'; acc[k]=(acc[k]||0)+1; return acc; },{}),
    statsProviderSelected:null,
    statsSourcesTried:[],
    statsSourceFailReasons:{},
    cacheHit:false, lastFetchAt:new Date(t0).toISOString(),
    lastLiveSource: results.find(r=>r.success&&r.matches?.length>0&&r.provider!=='mock')?.provider || null,
    mockSuppressed: DISABLE_MOCK_FALLBACK,
    note: live.length ? 'real_live_matches_found_multi_source' : 'no_real_live_matches_from_current_sources',
    scraperOnlyNote: 'No API-key provider connections are used. ESPN/FotMob/OpenLigaDB/TheSportsDB/AIScore are public scraper/HTTP probes only; SofaScore/IP-sensitive sources are excluded.',
    sourceGlobalAudit: results.find(r=>r && r._globalAudit)?._globalAudit ||
                       results.find(r=>r && r.sourceGlobalAudit)?.sourceGlobalAudit || null,
    dataNetwork: {
      policy:'NO_BROWSER_NO_PROXY_NO_IP_ROTATION_NO_SOFASCORE',
      apiKeyProviders:'REMOVED_BY_POLICY',
      coverageReality: 'Coverage depends on scraper/public HTTP sources only. ESPN is primary; extra non-IP-sensitive scraper probes can be added later after audit.'
    }
  };

  _snapshot = { matches:live, allMatches:merged, meta, fetchedAt:t0, expiresAt:t0+CACHE_TTL_MS };
  log('Cycle done', { live:live.length, source:meta.lastLiveSource, mockSuppressed:DISABLE_MOCK_FALLBACK, ms:meta.durationMs });
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
      for (const ep of endpoints) {
        try {
          const r = await adapter.probe(ep, { fetchStats:true, debug:true });
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
  status:'ok', version:'v11.17-scraper-data-network-flashscore', uptime:Math.round(process.uptime()),
  cacheValid:isCacheValid(), cacheAge:_snapshot?Math.round((Date.now()-_snapshot.fetchedAt)/1000)+'s':null,
  enabledSources: {
    espn_json:    ENABLE_ESPN,
    fotmob_json:  ENABLE_FOTMOB,
    aiscore_json: ENABLE_AISCORE,
    thesportsdb_json: ENABLE_THESPORTSDB,
    openligadb_json: ENABLE_OPENLIGADB,
    flashscore_feed: ENABLE_FLASHSCORE,
    sofascore:    false,
    api_key_providers: false,
    mock:         ENABLE_MOCK,
  },
  lastLiveSource:  _snapshot?.meta?.lastLiveSource || null,
  lastAuditSummary:_lastAuditResult ? {
    testedAt:       _lastAuditResult.testedAt,
    bestCandidates: _lastAuditResult.bestCandidates,
    sourcesCount:   _lastAuditResult.sources.length,
  } : null,
  lastStatsAuditSummary:_lastStatsAuditResult ? {
    testedAt:       _lastStatsAuditResult.testedAt,
    bestCandidates: _lastStatsAuditResult.bestCandidates,
    sourcesCount:   _lastStatsAuditResult.sources.length,
  } : null,
  sourceSuccessCounts: _sourceSuccessCounts,
  sourceFailReasons:   _sourceFailReasons,
  env:{ PORT, CACHE_TTL_MS },
}));

app.get('/live', async (req,res) => {
  try {
    const force = req.query.force === 'true' || req.query.refresh === '1';
    const s = await getSnapshot(force);
    res.json({ success:true, provider:'scraper', matches:s.matches, debug:{
      selectedProvider:s.meta.lastLiveSource||'unknown',
      sourcesTried:s.meta.sourcesTried, sourceSuccessCounts:s.meta.sourceSuccessCounts,
      liveMatches:s.meta.liveMatches, oddsMatchedCount:s.meta.oddsMatchedCount,
      statsCoverage:s.meta.statsCoverage,
      signalCoverage:s.meta.signalCoverage, actionableSignals:s.meta.actionableSignals,
      topSignals:s.matches.map(m=>m.topSignal).filter(Boolean).slice(0,5),
      derivedCoverage:s.matches.filter(m=>m.derived&&m.derived.isRealStatsDerived).length,
      avgPressure:s.matches.length?Number((s.matches.reduce((a,m)=>a+(Number(m.pressureScore)||0),0)/s.matches.length).toFixed(1)):0,
      avgTempo:s.matches.length?Number((s.matches.reduce((a,m)=>a+(Number(m.tempoScore)||0),0)/s.matches.length).toFixed(1)):0,
      avgReadiness:s.matches.length?Number((s.matches.reduce((a,m)=>a+(Number(m.transitionReadiness)||0),0)/s.matches.length).toFixed(1)):0,
      statsProviderSelected:s.meta.statsProviderSelected,
      statsSourcesTried:s.meta.statsSourcesTried,
      statsSourceFailReasons:s.meta.statsSourceFailReasons,
      cacheHit:s.meta.cacheHit, lastFetchAt:s.meta.lastFetchAt, durationMs:s.meta.durationMs,
      // v11.08: ESPN global scan audit — visible at /live?force=true
      sourceGlobalAudit: s.meta.sourceGlobalAudit || null,
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
    // v11.08: attach ESPN global scan audit from last snapshot if available
    const espnGlobalAudit = _snapshot?.meta?.sourceGlobalAudit || null;
    res.json({ success:true, renderHost:true, ...result,
      espnGlobalAudit,
      espnAuditSummary: espnGlobalAudit ? {
        endpointsTried:    espnGlobalAudit.endpointsTried,
        workingEndpoints:  espnGlobalAudit.workingEndpoints?.length || 0,
        liveAcceptedCount: espnGlobalAudit.liveAcceptedCount,
        parsedAfterDedupe: espnGlobalAudit.parsedAfterDedupe,
        topEndpoints:      (espnGlobalAudit.topEndpoints||[]).map(e=>({slug:e.slug,parsedMatches:e.parsedMatches})),
      } : null,
    });
  } catch(err) {
    log('[ERROR] /audit', { error:err.message });
    res.status(200).json({ success:false, error:err.message, sources:[], bestCandidates:[] });
  }
});


app.get('/stats-audit', async (req,res) => {
  try {
    log('[stats-audit] Starting public JSON stats source audit...');
    const result = await statsAudit.runStatsAudit();
    _lastStatsAuditResult = result;
    res.json(result);
  } catch(err) {
    log('[ERROR] /stats-audit', { error:err.message });
    res.status(200).json({ success:false, error:err.message, sources:[], bestCandidates:[] });
  }
});

app.get('/odds', async (req,res) => {
  try {
    const s = await getSnapshot(String(req.query.force || '').toLowerCase() === 'true');
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
  log(`CanliBet scraper service v11.15-scraper-only-data-network listening on :${PORT}`);
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
