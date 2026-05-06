/**
 * server.js — CanliBet Scraper Service
 * Express + Playwright orchestrator.
 *
 * Endpoints:
 *   GET /health    → service status
 *   GET /live      → live matches (canonical format)
 *   GET /odds      → odds only (from last snapshot)
 *   GET /snapshot  → full last snapshot (matches + meta)
 */

'use strict';

const express    = require('express');
const cors       = require('cors');
const { chromium } = require('playwright');
const { mergeAdapterResults, normalizeMatches } = require('./normalizer');

// ── Adapters ──────────────────────────────────────────────────────────────────
// Controlled by environment variables — set to 'false' to disable at runtime.
const ENABLE_MOCK      = process.env.ENABLE_MOCK_SOURCE       !== 'false';
const ENABLE_SOFASCORE = process.env.ENABLE_SOFASCORE_SOURCE  !== 'false';

const ADAPTERS = [
  ENABLE_MOCK      ? require('./sources/source_mock')        : null,
  ENABLE_SOFASCORE ? require('./sources/source_sofascore')   : null,
  require('./sources/source_flashscore'),  // disabled via adapter.enabled flag
  require('./sources/source_oddsportal'), // disabled via adapter.enabled flag
  require('./sources/source_custom'),     // disabled via adapter.enabled flag
].filter(Boolean);

// ── Config ────────────────────────────────────────────────────────────────────
const PORT         = process.env.PORT        || 3847;
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS || '30000', 10); // 30s default
const LOG_REQUESTS = process.env.LOG_REQUESTS !== 'false';

// ── Cache ─────────────────────────────────────────────────────────────────────
let _snapshot = null;  // { matches, meta, fetchedAt, expiresAt }

function isCacheValid() {
  return _snapshot && Date.now() < _snapshot.expiresAt;
}

// ── Logger ────────────────────────────────────────────────────────────────────
function log(msg, data) {
  if (!LOG_REQUESTS) return;
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`, data != null ? JSON.stringify(data) : '');
}

// ── Browser pool ─────────────────────────────────────────────────────────────
let _browser = null;

async function getBrowser() {
  if (_browser) {
    try { await _browser.version(); return _browser; } catch (e) { _browser = null; }
  }
  log('Launching Chromium...');
  _browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  return _browser;
}

// ── Fetch cycle ───────────────────────────────────────────────────────────────
async function runFetchCycle() {
  const cycleStart = Date.now();
  const browser = await getBrowser();

  const adapterResults = [];
  const sourcesTried   = [];
  const sourceSuccessCounts = {};

  for (const adapter of ADAPTERS) {
    const name = adapter.provider || 'unknown';
    // Skip explicitly disabled adapters without opening a page
    if (adapter.enabled === false) {
      log(`[${name}] skipped (disabled)`);
      adapterResults.push({ provider:name, success:false, matches:[], error:'adapter_disabled', fetchedAt:Date.now() });
      sourcesTried.push(name);
      continue;
    }

    log(`[${name}] fetching...`);
    const t0 = Date.now();
    let result;
    try {
      result = await adapter.fetch(browser, { cache: _snapshot });
    } catch (err) {
      result = { provider:name, success:false, matches:[], error:err.message, fetchedAt:Date.now() };
    }
    const elapsed = Date.now() - t0;
    log(`[${name}] done`, { success:result.success, matches:result.matches?.length ?? 0, elapsed, error:result.error ?? null });

    adapterResults.push(result);
    sourcesTried.push(name);
    sourceSuccessCounts[name] = result.success ? (result.matches?.length ?? 0) : 0;
  }

  const mergedMatches = mergeAdapterResults(adapterResults);
  const liveMatches   = mergedMatches.filter(m => m.match_live === '1');
  const oddsMatched   = liveMatches.filter(m => m.hasOdds).length;
  const statsCoverage = liveMatches.filter(m => m.hasStats).length;

  const meta = {
    fetchedAt:     cycleStart,
    durationMs:    Date.now() - cycleStart,
    sourcesTried,
    sourceSuccessCounts,
    liveMatches:   liveMatches.length,
    oddsMatchedCount: oddsMatched,
    statsCoverage,
    cacheHit:      false,
    lastFetchAt:   new Date(cycleStart).toISOString(),
  };

  _snapshot = {
    matches:   liveMatches,
    allMatches:mergedMatches,
    meta,
    fetchedAt: cycleStart,
    expiresAt: cycleStart + CACHE_TTL_MS,
  };

  log('Cycle complete', { live:liveMatches.length, odds:oddsMatched, duration:meta.durationMs });
  return _snapshot;
}

async function getSnapshot(forceRefresh = false) {
  if (!forceRefresh && isCacheValid()) {
    return { ..._snapshot, meta: { ..._snapshot.meta, cacheHit:true } };
  }
  return runFetchCycle();
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();

app.use(cors({ origin: '*' }));  // CanliBet frontend can be on any domain
app.use(express.json());

// Request logger
app.use((req, _res, next) => {
  if (LOG_REQUESTS) log(`${req.method} ${req.path} ${req.query.source || ''}`);
  next();
});

// GET /health
app.get('/health', (_req, res) => {
  res.json({
    status:     'ok',
    version:    '10.80',
    uptime:     Math.round(process.uptime()),
    cacheValid: isCacheValid(),
    cacheAge:   _snapshot ? Math.round((Date.now() - _snapshot.fetchedAt) / 1000) + 's' : null,
    adapters:   ADAPTERS.map(a => ({ provider: a.provider, enabled: a.enabled !== false })),
    env: {
      PORT:                    PORT,
      CACHE_TTL_MS:            CACHE_TTL_MS,
      ENABLE_MOCK_SOURCE:      ENABLE_MOCK,
      ENABLE_SOFASCORE_SOURCE: ENABLE_SOFASCORE,
    },
  });
});

// GET /live
app.get('/live', async (req, res) => {
  try {
    const snap = await getSnapshot(req.query.refresh === '1');
    res.json({
      success:  true,
      provider: 'scraper',
      matches:  snap.matches,
      debug: {
        selectedProvider:   'scraper',
        sourcesTried:       snap.meta.sourcesTried,
        sourceSuccessCounts:snap.meta.sourceSuccessCounts,
        liveMatches:        snap.meta.liveMatches,
        oddsMatchedCount:   snap.meta.oddsMatchedCount,
        statsCoverage:      snap.meta.statsCoverage,
        cacheHit:           snap.meta.cacheHit,
        lastFetchAt:        snap.meta.lastFetchAt,
        durationMs:         snap.meta.durationMs,
      },
    });
  } catch (err) {
    log('ERROR /live', { error:err.message });
    // Always return valid JSON — CanliBet must never get invalid response
    res.status(200).json({ success:false, provider:'scraper', matches:[], error:err.message, debug:{} });
  }
});

// GET /odds  — odds subset from last snapshot
app.get('/odds', async (req, res) => {
  try {
    const snap = await getSnapshot();
    const oddsOnly = snap.matches.map(m => ({
      match_id:            m.match_id,
      match_hometeam_name: m.match_hometeam_name,
      match_awayteam_name: m.match_awayteam_name,
      odds:                m.odds,
      hasOdds:             m.hasOdds,
      source:              m.source,
    }));
    res.json({ success:true, count:oddsOnly.length, fetchedAt:snap.fetchedAt, odds:oddsOnly });
  } catch (err) {
    res.status(200).json({ success:false, count:0, odds:[], error:err.message });
  }
});

// GET /snapshot  — full last snapshot
app.get('/snapshot', async (req, res) => {
  try {
    const snap = await getSnapshot();
    res.json({ success:true, ...snap });
  } catch (err) {
    res.status(200).json({ success:false, matches:[], meta:{}, error:err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  log(`CanliBet scraper service listening on :${PORT}`);
  log(`Cache TTL: ${CACHE_TTL_MS}ms | Adapters: ${ADAPTERS.map(a=>a.provider).join(', ')}`);

  // Warm cache immediately
  try {
    await runFetchCycle();
    log('Initial fetch cycle complete');
  } catch (err) {
    log('Initial fetch cycle error (non-fatal)', { error:err.message });
  }

  // Background refresh interval (half of TTL)
  const refreshInterval = Math.max(Math.round(CACHE_TTL_MS / 2), 15000);
  setInterval(async () => {
    if (!isCacheValid()) {
      try { await runFetchCycle(); }
      catch (err) { log('Background refresh error', { error:err.message }); }
    }
  }, refreshInterval);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  log('SIGTERM — closing browser...');
  if (_browser) await _browser.close().catch(() => {});
  process.exit(0);
});
