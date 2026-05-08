/**
 * server.js — CanliBet Scraper Service v10.81
 *
 * Playwright is NOT launched globally.
 * Each Playwright adapter calls global._scraperLazyGetBrowser() when it needs a browser.
 * HTTP-only adapters (mock) never touch Playwright.
 * Render Free tier: build = "npm install", no playwright install needed.
 */
'use strict';

const express = require('express');
const cors    = require('cors');
const { mergeAdapterResults } = require('./normalizer');

const PORT             = process.env.PORT             || 3847;
const CACHE_TTL_MS     = parseInt(process.env.CACHE_TTL_MS || '30000', 10);
const LOG_REQUESTS     = process.env.LOG_REQUESTS !== 'false';
const ENABLE_MOCK      = process.env.ENABLE_MOCK_SOURCE       !== 'false'; // default true
const ENABLE_SOFASCORE = process.env.ENABLE_SOFASCORE_SOURCE  === 'true';  // default false
const ENABLE_FLASHSCORE= process.env.ENABLE_FLASHSCORE_SOURCE === 'true';
const ENABLE_ODDSPORTAL= process.env.ENABLE_ODDSPORTAL_SOURCE === 'true';

function log(msg, data) {
  const ts = new Date().toISOString();
  const extra = data != null ? ' ' + JSON.stringify(data) : '';
  console.log(`[${ts}] ${msg}${extra}`);
}

// ── Lazy browser — only created when a Playwright adapter actually calls it ──
let _browser = null;
let _pwAvailable = null;

async function lazyGetBrowser() {
  if (_browser) { try { await _browser.version(); return _browser; } catch(e) { _browser = null; } }
  if (_pwAvailable === false) throw new Error('Playwright not available');
  try {
    const { chromium } = require('playwright');
    log('Launching Chromium (lazy)...');
    _browser = await chromium.launch({ headless:true, args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'] });
    _pwAvailable = true;
    return _browser;
  } catch(err) {
    _pwAvailable = false;
    throw new Error('Chromium launch failed: ' + err.message);
  }
}
global._scraperLazyGetBrowser = lazyGetBrowser;

// ── Load only enabled adapters ────────────────────────────────────────────────
const ADAPTERS = [];
if (ENABLE_MOCK)       { ADAPTERS.push(require('./sources/source_mock'));       log('Adapter: mock (HTTP-only)'); }
if (ENABLE_SOFASCORE)  { ADAPTERS.push(require('./sources/source_sofascore'));  log('Adapter: sofascore (HTTP-only, no Playwright)'); }
if (ENABLE_FLASHSCORE) { ADAPTERS.push(require('./sources/source_flashscore')); log('Adapter: flashscore (Playwright)'); }
if (ENABLE_ODDSPORTAL) { ADAPTERS.push(require('./sources/source_oddsportal')); log('Adapter: oddsportal (Playwright)'); }

const anyPlaywright = ENABLE_FLASHSCORE || ENABLE_ODDSPORTAL; // sofascore is now HTTP-only
if (!anyPlaywright) log('Chromium disabled / skipped — no Playwright adapter active');

log(`CanliBet scraper service v10.81 — adapters: ${ADAPTERS.map(a=>a.provider).join(', ') || '(none)'}`);

// ── Cache ─────────────────────────────────────────────────────────────────────
let _snapshot = null;
function isCacheValid() { return _snapshot && Date.now() < _snapshot.expiresAt; }

// ── Fetch cycle ───────────────────────────────────────────────────────────────
async function runFetchCycle() {
  const t0 = Date.now();
  if (!ADAPTERS.length) {
    _snapshot = { matches:[], allMatches:[], meta:{ fetchedAt:t0, durationMs:0, sourcesTried:[], sourceSuccessCounts:{}, liveMatches:0, oddsMatchedCount:0, statsCoverage:0, cacheHit:false, lastFetchAt:new Date(t0).toISOString(), warning:'no_adapters_enabled' }, fetchedAt:t0, expiresAt:t0+CACHE_TTL_MS };
    return _snapshot;
  }

  const results = [], tried = [], counts = {};
  for (const adapter of ADAPTERS) {
    const name = adapter.provider;
    log(`[${name}] fetching...`);
    const t1 = Date.now();
    let r;
    try { r = await adapter.fetch(null, { cache:_snapshot }); }
    catch(err) { r = { provider:name, success:false, matches:[], error:err.message, fetchedAt:Date.now() }; }
    log(`[${name}] done`, { ok:r.success, n:r.matches?.length??0, ms:Date.now()-t1, err:r.error??null });
    results.push(r); tried.push(name); counts[name] = r.success ? (r.matches?.length??0) : 0;
  }

  const merged = mergeAdapterResults(results);
  const live   = merged.filter(m => m.match_live === '1');
  const meta = { fetchedAt:t0, durationMs:Date.now()-t0, sourcesTried:tried, sourceSuccessCounts:counts, liveMatches:live.length, oddsMatchedCount:live.filter(m=>m.hasOdds).length, statsCoverage:live.filter(m=>m.hasStats).length, cacheHit:false, lastFetchAt:new Date(t0).toISOString() };
  _snapshot = { matches:live, allMatches:merged, meta, fetchedAt:t0, expiresAt:t0+CACHE_TTL_MS };
  log('Cycle done', { live:live.length, ms:meta.durationMs });
  return _snapshot;
}

async function getSnapshot(force=false) {
  if (!force && isCacheValid()) return { ..._snapshot, meta:{..._snapshot.meta, cacheHit:true} };
  return runFetchCycle();
}

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin:'*' }));
app.use(express.json());
if (LOG_REQUESTS) app.use((req,_,next)=>{ log(`${req.method} ${req.path}`); next(); });

app.get('/health', (_,res) => res.json({
  status:'ok', version:'10.86', uptime:Math.round(process.uptime()),
  cacheValid:isCacheValid(), cacheAge:_snapshot ? Math.round((Date.now()-_snapshot.fetchedAt)/1000)+'s' : null,
  adapters: ADAPTERS.map(a=>({ provider:a.provider, needsPlaywright:!!a.needsPlaywright })),
  env:{ PORT, CACHE_TTL_MS, ENABLE_MOCK_SOURCE:ENABLE_MOCK, ENABLE_SOFASCORE_SOURCE:ENABLE_SOFASCORE, playwrightActive:_pwAvailable===true },
}));

app.get('/live', async (req,res) => {
  try {
    const s = await getSnapshot(req.query.refresh==='1');
    res.json({ success:true, provider:'scraper', matches:s.matches, debug:{ selectedProvider:'scraper', sourcesTried:s.meta.sourcesTried, sourceSuccessCounts:s.meta.sourceSuccessCounts, liveMatches:s.meta.liveMatches, oddsMatchedCount:s.meta.oddsMatchedCount, statsCoverage:s.meta.statsCoverage, cacheHit:s.meta.cacheHit, lastFetchAt:s.meta.lastFetchAt, durationMs:s.meta.durationMs, warning:s.meta.warning||null } });
  } catch(err) {
    log('[ERROR] /live', { error:err.message });
    res.status(200).json({ success:false, provider:'scraper', matches:[], error:err.message, debug:{} });
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
  try { const s = await getSnapshot(); res.json({ success:true, ...s }); }
  catch(err) { res.status(200).json({ success:false, matches:[], meta:{}, error:err.message }); }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  log(`CanliBet scraper service listening on :${PORT}`);
  try { await runFetchCycle(); log('Initial fetch complete'); }
  catch(err) { log('[ERROR] Initial fetch (non-fatal)', { error:err.message }); }
  const interval = Math.max(Math.round(CACHE_TTL_MS/2), 15000);
  setInterval(async () => { if (!isCacheValid()) { try { await runFetchCycle(); } catch(e) { log('[ERROR] Background refresh', { error:e.message }); } } }, interval);
});

process.on('SIGTERM', async () => { if (_browser) await _browser.close().catch(()=>{}); process.exit(0); });
