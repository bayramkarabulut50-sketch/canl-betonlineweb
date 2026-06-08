/**
 * server.js — CanliBet Scraper Service v11.30-intelligence-rebuild
 *
 * Scraper-only data network.
 * No paid/API-key provider connections. No API-Sports. No API-Football.
 * No SofaScore/IP-sensitive source. No proxy/IP rotation/browser automation.
 * Only public scraper/HTTP JSON probes are used.
 */
'use strict';

const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const { mergeAdapterResults, splitLiveLayers, isStaleRiskMatch, monitorReason, summarizeDataQuality } = require('./normalizer');
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
const ENABLE_FLASHSCORE_MOBILE = process.env.ENABLE_FLASHSCORE_MOBILE_SOURCE !== 'false'; // default on, public mobile HTML scraper
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
const flashscoreMobileMod = require('./sources/source_flashscore_mobile');
const mockMod     = require('./sources/source_mock');

// Audit always includes all JSON probes
AUDIT_ADAPTERS.push(espnMod, flashscoreMod, flashscoreMobileMod, fotmobMod, aiscoreMod, thesportsdbMod, openligadbMod);
// v11.10: SofaScore intentionally excluded from audit/live by policy.

// Live adapters — v11.11 ESPN-first/no-IP-sensitive coverage.
// SofaScore removed. Primary live source is ESPN public JSON.
if (ENABLE_ESPN)    { LIVE_ADAPTERS.push(espnMod);    log('Adapter: espn_json (HTTP-only, primary)'); }
if (ENABLE_FLASHSCORE_MOBILE) { LIVE_ADAPTERS.push(flashscoreMobileMod); log('Adapter: flashscore_mobile (HTTP-only public mobile HTML live page)'); }
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

function readAgentDataJson(name, fallback = null) {
  try {
    const dir = process.env.CANLIBET_AGENT_DATA_DIR || path.join(__dirname, 'agent', 'data');
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeAgentDataJson(name, value) {
  const dir = process.env.CANLIBET_AGENT_DATA_DIR || path.join(__dirname, 'agent', 'data');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2));
}

function appendAgentDataJsonl(name, value) {
  const dir = process.env.CANLIBET_AGENT_DATA_DIR || path.join(__dirname, 'agent', 'data');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, name), JSON.stringify(Object.assign({ at: new Date().toISOString() }, value)) + '\n');
}

function readAgentDataJsonl(name, limit = 5000) {
  try {
    const dir = process.env.CANLIBET_AGENT_DATA_DIR || path.join(__dirname, 'agent', 'data');
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).slice(-limit).map(line => JSON.parse(line));
  } catch (_) {
    return [];
  }
}

function getActiveLiveAdapters() {
  const bindings = readAgentDataJson('source-bindings.json', {});
  const disabled = new Set([...(bindings.disabledProviders || []), ...(bindings.quarantinedProviders || [])]);
  const active = LIVE_ADAPTERS.filter(adapter => !disabled.has(adapter.provider));
  if (active.length === 0) return LIVE_ADAPTERS;
  return active;
}


function buildProviderReport(results, live, signalEligible, rejectedProviderCounts) {
  const report = {};
  for (const r of (results || [])) {
    const k = r.provider || 'unknown';
    report[k] = report[k] || { raw:0, parsed:0, visible:0, signalEligible:0, rejected:0, blocked:false, error:null, statsCoverage:0, lowDataVisible:0 };
    report[k].raw = r._auditResult?.rawEventCount || 0;
    report[k].parsed = r._auditResult?.parsedMatches || r.matches?.length || 0;
    report[k].error = r.success ? null : (r.error || r._auditResult?.failReason || 'unknown');
    report[k].blocked = !!(report[k].error && String(report[k].error).includes('403'));
  }
  for (const m of (live || [])) {
    const k = m._mergeProvider || m.source || 'unknown';
    report[k] = report[k] || { raw:0, parsed:0, visible:0, signalEligible:0, rejected:0, blocked:false, error:null, statsCoverage:0, lowDataVisible:0 };
    report[k].visible += 1;
    if (m.hasStats) report[k].statsCoverage += 1;
    else report[k].lowDataVisible += 1;
  }
  for (const m of (signalEligible || [])) {
    const k = m._mergeProvider || m.source || 'unknown';
    report[k] = report[k] || { raw:0, parsed:0, visible:0, signalEligible:0, rejected:0, blocked:false, error:null, statsCoverage:0, lowDataVisible:0 };
    report[k].signalEligible += 1;
  }
  for (const [k,v] of Object.entries(rejectedProviderCounts || {})) {
    report[k] = report[k] || { raw:0, parsed:0, visible:0, signalEligible:0, rejected:0, blocked:false, error:null, statsCoverage:0, lowDataVisible:0 };
    report[k].rejected += v;
  }
  return report;
}

function buildCoverageEstimate(rawTotal, visibleCount, rejectedReasons) {
  const rejectedTotal = Object.values(rejectedReasons || {}).reduce((a,b)=>a+(Number(b)||0),0);
  const rejectedRatio = rawTotal ? rejectedTotal / Math.max(rawTotal, 1) : 0;
  let status = 'normal';
  if (visibleCount === 0 && rawTotal > 0) status = 'undercount_or_overfilter';
  else if (visibleCount < 8 && rawTotal > 20) status = 'possible_undercount';
  else if (visibleCount > 70) status = 'possible_overcount';
  return {
    rawTotal, validatedVisible: visibleCount, rejectedTotal,
    rejectedRatio: Number(rejectedRatio.toFixed(3)),
    expectedRangeStatus: status,
    topRejectReasons: Object.entries(rejectedReasons || {}).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([reason,count])=>({reason,count}))
  };
}

// ── Fetch cycle ───────────────────────────────────────────────────────────────
// v11.18: PARALLEL provider fetch — all adapters run simultaneously.
// ESPN scan can take 20-30s; running it in parallel with Flashscore/FotMob
// means total time = slowest provider, not sum of all providers.
async function runFetchCycle() {
  const t0 = Date.now();
  const tried = [], counts = {};
  const activeLiveAdapters = getActiveLiveAdapters();

  const adapterTasks = activeLiveAdapters.map(async (adapter) => {
    const name = adapter.provider;

    if (name === 'mock' && DISABLE_MOCK_FALLBACK) {
      log('[mock] skipped — DISABLE_MOCK_FALLBACK=true');
      tried.push(name + ':skipped');
      counts[name] = 0;
      return { provider:name, success:false, matches:[], error:'mock_skipped', fetchedAt:Date.now(), _skipped:true };
    }

    const t1 = Date.now();
    let r;
    try { r = await adapter.fetch(null, { cache:_snapshot, fullScan:false }); }
    catch(err) {
      r = { provider:name, success:false, matches:[], error:err.message, fetchedAt:Date.now() };
    }
    const ms = Date.now()-t1;
    log(`[${name}] done`, { ok:r.success, n:r.matches?.length??0, ms, err:r.error??null });
    tried.push(name);
    counts[name] = r.success ? (r.matches?.length??0) : 0;
    _sourceSuccessCounts[name] = (_sourceSuccessCounts[name]||0) + (r.success ? 1 : 0);
    if (!r.success) _sourceFailReasons[name] = r.error || 'unknown';
    return r;
  });

  // Run all providers in parallel — winner-takes-all on speed, all results merged
  const results = await Promise.all(adapterTasks);

  // Synthesize per-provider counts for debug
  const rawProviderCounts     = {};
  const parsedProviderCounts  = {};
  const acceptedProviderCounts = {};
  const blockedProviderCounts  = {};
  const providerErrors         = {};
  for (const r of results) {
    const n = r.provider;
    rawProviderCounts[n]      = r._auditResult?.rawEventCount || 0;
    parsedProviderCounts[n]   = r._auditResult?.parsedMatches || r.matches?.length || 0;
    acceptedProviderCounts[n] = r.success ? (r.matches?.length||0) : 0;
    if (r.error === 'HTTP_403' || (r._auditResult?.failReason||'').includes('403')) blockedProviderCounts[n] = 'HTTP_403';
    if (!r.success && r.error) providerErrors[n] = r.error;
  }

  const merged = mergeAdapterResults(results);
  const layerSplit = splitLiveLayers(merged);
  // v11.23: dual-layer pipeline. Public response uses visibleLiveMatches;
  // signalEligibleMatches is exposed in debug and used by frontend for watch/hero.
  let live = layerSplit.visibleLiveMatches
    .filter(m => m.source !== 'mock' && String(m.match_id || '').indexOf('mock_') !== 0);
  let finalSignalEligible = layerSplit.signalEligibleMatches.filter(m => live.includes(m) || live.some(x => x.match_id === m.match_id));
  let impossibleCountGuard = null;
  if (live.length > 90) {
    impossibleCountGuard = `suspicious_visible_count:${live.length}>90`;
    const statsRich = live.filter(m => m.hasStats || (m.signalCount || 0) > 0 || m.source === 'espn' || m.source === 'espn_json').length;
    const targetMax = Math.max(40, Math.min(80, statsRich * 6 + 36));
    log(`[GUARD] suspicious visible live count ${live.length} — final calibrated cap ${targetMax}`);
    live = live
      .filter(m => (m.validationScore || 0) >= 45 && m.minute != null && m.minute > 0 && m.minute < 130)
      .sort((a,b) => (b.hasStats?1:0) - (a.hasStats?1:0) || (b.signalCount||0) - (a.signalCount||0) || (b.validationScore||0) - (a.validationScore||0))
      .slice(0, targetMax);
    log(`[GUARD] after calibrated visible gate: ${live.length} matches`);
    finalSignalEligible = layerSplit.signalEligibleMatches.filter(m => live.some(x => x.match_id === m.match_id));
  }
  const providerReport = buildProviderReport(results, live, finalSignalEligible, layerSplit.rejectedProviderCounts);
  const coverageEstimate = buildCoverageEstimate(merged.length + ((mergeAdapterResults.lastDebug && mergeAdapterResults.lastDebug.duplicateRemoved) || 0), live.length, layerSplit.rejectedReasons);
  const visibleVsSignalEligibleComparison = { visible: live.length, signalEligible: finalSignalEligible.length, lowDataVisible: layerSplit.lowDataVisibleCount, signalStarvation: live.length > 8 && finalSignalEligible.length === 0 };
  const dataQualitySummary = summarizeDataQuality(live);
  const providerQualityReport = Object.fromEntries(Object.entries(providerReport).map(([k,v]) => [k, Object.assign({}, v, {
    statsCoverageRatio: v.visible ? Number((v.statsCoverage / v.visible).toFixed(3)) : 0,
    signalEligibleRatio: v.visible ? Number((v.signalEligible / v.visible).toFixed(3)) : 0,
    lowDataRatio: v.visible ? Number((v.lowDataVisible / v.visible).toFixed(3)) : 0,
  })]));

  const meta   = {
    fetchedAt:t0, durationMs:Date.now()-t0, sourcesTried:tried,
    sourceSuccessCounts:counts, liveMatches:live.length,
    oddsMatchedCount:live.filter(m=>m.hasOdds).length,
    statsCoverage:live.filter(m=>m.hasStats).length,
    signalCoverage:live.filter(m=>m.signalCount > 0).length,
    actionableSignals:live.reduce((a,m)=>a+(m.signalCount||0),0),
    visibleLiveMatchesCount: live.length,
    signalEligibleMatchesCount: finalSignalEligible.length,
    visibleProviderCounts: layerSplit.visibleProviderCounts,
    signalEligibleProviderCounts: finalSignalEligible.reduce((acc,m)=>{ const k=m._mergeProvider||m.source||'unknown'; acc[k]=(acc[k]||0)+1; return acc; },{}),
    rejectedProviderCounts: layerSplit.rejectedProviderCounts || {},
    rejectedReasons: layerSplit.rejectedReasons,
    rejectedSamples: layerSplit.rejectedSamples || [],
    duplicateRemoved: (mergeAdapterResults.lastDebug && mergeAdapterResults.lastDebug.duplicateRemoved) || 0,
    qualityRejected: layerSplit.rejectedReasons.quality_low || 0,
    youthRejected: layerSplit.rejectedReasons.excluded_competition || 0,
    friendlyRejected: layerSplit.rejectedReasons.excluded_competition || 0,
    finishedRejected: layerSplit.rejectedReasons.finished || 0,
    scheduledRejected: layerSplit.rejectedReasons.scheduled || 0,
    lowDataVisibleCount: layerSplit.lowDataVisibleCount,
    staleRiskCount: live.filter(isStaleRiskMatch).length,
    monitorMatchesCount: live.filter(m => !finalSignalEligible.some(x => x.match_id === m.match_id)).length,
    monitorReasons: live.filter(m => !finalSignalEligible.some(x => x.match_id === m.match_id)).reduce((acc,m)=>{ const r=monitorReason(m); acc[r]=(acc[r]||0)+1; return acc; },{}),
    watchSignalsCount: live.filter(m => (m.signalCount||0)>0 || m.topSignal || (Array.isArray(m.signals)&&m.signals.length)).length,
    impossibleCountGuard,
    qualityTiers: live.reduce((acc,m)=>{ const k=m.validationTier||m.liveQualityTier||'UNKNOWN'; acc[k]=(acc[k]||0)+1; return acc; },{}),
    validationTiers: live.reduce((acc,m)=>{ const k=m.validationTier||'UNKNOWN'; acc[k]=(acc[k]||0)+1; return acc; },{}),
    sourceCounts: live.reduce((acc,m)=>{ const k=m._mergeProvider||m.source||'unknown'; acc[k]=(acc[k]||0)+1; return acc; },{}),
    statsProviderSelected:null,
    statsSourcesTried:[],
    statsSourceFailReasons:{},
    cacheHit:false, lastFetchAt:new Date(t0).toISOString(),
    lastLiveSource: results.find(r=>r.success&&r.matches?.length>0&&r.provider!=='mock')?.provider || null,
    mockSuppressed: DISABLE_MOCK_FALLBACK,
    note: live.length ? 'real_live_matches_found_multi_source' : 'no_real_live_matches_from_current_sources',
    scraperOnlyNote: 'No API-key provider connections are used. ESPN/FotMob/OpenLigaDB/TheSportsDB/AIScore are public scraper/HTTP probes only; SofaScore/IP-sensitive sources are excluded.',
    // v11.18: per-provider breakdown in /live debug
    rawProviderCounts,
    parsedProviderCounts,
    acceptedProviderCounts,
    blockedProviderCounts,
    providerErrors,
    dedupeBefore: merged.length,
    dedupeAfter:  live.length,
    topProviders: results.filter(r=>r.success&&r.matches?.length>0).map(r=>({ provider:r.provider, count:r.matches.length })),
    providerReport,
    coverageEstimate,
    visibleVsSignalEligibleComparison,
    dataQualitySummary,
    providerQualityReport,
    signalStarvationDiagnostics: visibleVsSignalEligibleComparison.signalStarvation ? { message:'visible live exists but signal layer is empty', gates:['stats','pressure','tempo','confidence','odds'] } : null,
    canonicalQuality: mergeAdapterResults.lastDebug || {},
    pipelineHealth: Object.assign({}, layerSplit.health, {
      duplicateRatio: merged.length ? Number((((mergeAdapterResults.lastDebug && mergeAdapterResults.lastDebug.duplicateRemoved) || 0) / Math.max(merged.length + ((mergeAdapterResults.lastDebug && mergeAdapterResults.lastDebug.duplicateRemoved) || 0),1)).toFixed(3)) : 0
    }),
    validationRejectDebug: require('./normalizer').normalizeMatches.lastDebug || {},
    sourceGlobalAudit: results.find(r=>r && r._globalAudit)?._globalAudit ||
                       results.find(r=>r && r.sourceGlobalAudit)?.sourceGlobalAudit || null,
    dataNetwork: {
      policy:'NO_BROWSER_NO_PROXY_NO_IP_ROTATION_NO_SOFASCORE',
      apiKeyProviders:'REMOVED_BY_POLICY',
      coverageReality: 'Coverage depends on scraper/public HTTP sources only. ESPN is quality/stats; Flashscore mobile/x-feed provide coverage; extra non-IP-sensitive probes can be added after audit.'
    },
    agentSourceBindings: readAgentDataJson('source-bindings.json', null)
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

  const auditSummary = {
    rawTotal: sources.reduce((a,s)=>a+(Number(s.rawEventCount)||0),0),
    parsedTotal: sources.reduce((a,s)=>a+(Number(s.parsedMatches)||0),0),
    acceptedTotal: sources.reduce((a,s)=>a+(Number(s.acceptedEventCount)||0),0),
    providerBreakdown: sources.reduce((acc,s)=>{ const k=s.provider||s.source||'unknown'; acc[k]=acc[k]||{raw:0,parsed:0,accepted:0,failReasons:{}}; acc[k].raw += Number(s.rawEventCount)||0; acc[k].parsed += Number(s.parsedMatches)||0; acc[k].accepted += Number(s.acceptedEventCount)||0; const fr=s.failReason||'OK'; acc[k].failReasons[fr]=(acc[k].failReasons[fr]||0)+1; return acc; },{}),
    topRejectReasons: sources.reduce((acc,s)=>{ (s.rejectedReasons?Object.entries(s.rejectedReasons):[]).forEach(([r,c])=>{ acc[r]=(acc[r]||0)+Number(c||0); }); return acc; },{})
  };

  if (_snapshot && _snapshot.meta) { auditSummary.lastLiveSummary = { visibleLive:_snapshot.meta.visibleLiveMatchesCount||0, signalEligible:_snapshot.meta.signalEligibleMatchesCount||0, watchSignals:_snapshot.meta.watchSignalsCount||0, staleRiskCount:_snapshot.meta.staleRiskCount||0, lowDataCount:_snapshot.meta.lowDataVisibleCount||0, dataQualitySummary:_snapshot.meta.dataQualitySummary||{}, providerQualityReport:_snapshot.meta.providerQualityReport||{}, monitorReasons:_snapshot.meta.monitorReasons||{}, providerReport:_snapshot.meta.providerReport||{} }; }
  _lastAuditResult = { testedAt, sources, bestCandidates, summary:auditSummary };
  return _lastAuditResult;
}

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin:'*' }));
app.use(express.json());
if (LOG_REQUESTS) app.use((req,_,next)=>{ log(`${req.method} ${req.path}`); next(); });

app.get('/health', (_,res) => res.json({
  status:'ok', version:'v11.30-intelligence-rebuild', uptime:Math.round(process.uptime()),
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
    summary: _lastAuditResult.summary || null,
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
      // v11.18: per-provider breakdown
      rawProviderCounts:      s.meta.rawProviderCounts      || {},
      parsedProviderCounts:   s.meta.parsedProviderCounts   || {},
      acceptedProviderCounts: s.meta.acceptedProviderCounts || {},
      blockedProviderCounts:  s.meta.blockedProviderCounts  || {},
      providerErrors:         s.meta.providerErrors         || {},
      dedupeBefore:           s.meta.dedupeBefore           || 0,
      dedupeAfter:            s.meta.dedupeAfter            || 0,
      topProviders:           s.meta.topProviders           || [],
      validationTiers:        s.meta.validationTiers        || {},
      sourceCounts:           s.meta.sourceCounts           || {},
      canonicalQuality:       s.meta.canonicalQuality       || {},
      validationRejectDebug:  s.meta.validationRejectDebug  || {},
      summary: { rawTotal:s.meta.coverageEstimate?.rawTotal||0, visibleLive:s.meta.visibleLiveMatchesCount||0, signalEligible:s.meta.signalEligibleMatchesCount||0, watchSignals:s.meta.watchSignalsCount||0, actionableSignals:s.meta.actionableSignals||0, rejectedTotal:s.meta.coverageEstimate?.rejectedTotal||0, duplicateRemoved:s.meta.duplicateRemoved||0, staleRiskCount:s.meta.staleRiskCount||0, lowDataCount:s.meta.lowDataVisibleCount||0, monitorMatches:s.meta.monitorMatchesCount||0, topRejectReasons:s.meta.coverageEstimate?.topRejectReasons||[], providerBreakdown:s.meta.providerReport||{}, coverageHealth:s.meta.coverageEstimate?.expectedRangeStatus||'unknown', signalHealth:(s.meta.visibleVsSignalEligibleComparison?.signalStarvation?'starvation':'ok') },
      dataQualitySummary: s.meta.dataQualitySummary || {},
      providerQualityReport: s.meta.providerQualityReport || {},
      providerReport: s.meta.providerReport || {},
      staleRiskCount: s.meta.staleRiskCount || 0,
      lowDataVisibleCount: s.meta.lowDataVisibleCount || 0,
      monitorMatchesCount: s.meta.monitorMatchesCount || 0,
      monitorReasons: s.meta.monitorReasons || {},
      watchSignalsCount: s.meta.watchSignalsCount || 0,
      coverageEstimate: s.meta.coverageEstimate || {},
      visibleVsSignalEligibleComparison: s.meta.visibleVsSignalEligibleComparison || {},
      rejectedSamples: s.meta.rejectedSamples || [],
      pipelineHealth: s.meta.pipelineHealth || {},
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

function readAgentJson(name, fallback = null) {
  return readAgentDataJson(name, fallback);
}

function compactFinalText(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function teamLikelyMatches(a, b) {
  const x = compactFinalText(a);
  const y = compactFinalText(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

function extractEspnFinalScore(data) {
  const comp = data?.header?.competitions?.[0] || data?.competitions?.[0] || null;
  const status = comp?.status || {};
  const statusText = String(status.type?.name || status.type?.description || status.displayClock || status.detail || '').toLowerCase();
  const completed = status.type?.completed === true || status.completed === true || /final|ft|full time|aet|pen/.test(statusText);
  const competitors = comp?.competitors || [];
  if (!completed || !Array.isArray(competitors) || competitors.length < 2) return null;
  const home = competitors.find(c => c.homeAway === 'home') || competitors[0];
  const away = competitors.find(c => c.homeAway === 'away') || competitors[1];
  const hg = parseInt(home.score, 10);
  const ag = parseInt(away.score, 10);
  if (!Number.isFinite(hg) || !Number.isFinite(ag)) return null;
  return { hg, ag, status: status.type?.description || status.type?.name || 'final', source: 'espn_summary' };
}

async function fetchJsonLoose(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json,*/*' } });
    const text = await res.text();
    if (!res.ok || !text) return null;
    return JSON.parse(text);
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function dateCandidates(dateLike) {
  const out = new Set();
  const base = dateLike ? new Date(dateLike) : new Date();
  if (Number.isNaN(base.getTime())) return [new Date().toISOString().slice(0,10).replace(/-/g, '')];
  for (const offset of [-1, 0, 1]) {
    const d = new Date(base.getTime() + offset * 86400000);
    out.add(String(d.getUTCFullYear()) + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0'));
  }
  return Array.from(out);
}

async function resolveEspnFinal({ matchId, home, away, date }) {
  const slugs = ['all','eng.1','esp.1','ger.1','ita.1','fra.1','ned.1','por.1','swe.1','nor.1','den.1','fin.1','uefa.champions','uefa.europa','uefa.europa.conf'];
  if (matchId && /^\d+$/.test(String(matchId))) {
    for (const slug of slugs) {
      for (const url of [
        `https://site.web.api.espn.com/apis/site/v2/sports/soccer/${slug}/summary?event=${encodeURIComponent(matchId)}&lang=en&region=us`,
        `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/summary?event=${encodeURIComponent(matchId)}`
      ]) {
        const finalScore = extractEspnFinalScore(await fetchJsonLoose(url));
        if (finalScore) return finalScore;
      }
    }
  }

  for (const d of dateCandidates(date)) {
    for (const slug of slugs) {
      const data = await fetchJsonLoose(`https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard?dates=${d}&limit=300`);
      const events = Array.isArray(data?.events) ? data.events : [];
      for (const ev of events) {
        const comp = ev.competitions?.[0] || {};
        const status = comp.status || ev.status || {};
        const completed = status.type?.completed === true || /final|ft|full time|aet|pen/i.test(String(status.type?.description || status.type?.name || ''));
        const competitors = comp.competitors || [];
        const h = competitors.find(c => c.homeAway === 'home') || competitors[0];
        const a = competitors.find(c => c.homeAway === 'away') || competitors[1];
        if (!completed || !teamLikelyMatches(h?.team?.displayName || h?.team?.name, home) || !teamLikelyMatches(a?.team?.displayName || a?.team?.name, away)) continue;
        const hg = parseInt(h.score, 10);
        const ag = parseInt(a.score, 10);
        if (Number.isFinite(hg) && Number.isFinite(ag)) return { hg, ag, status: status.type?.description || 'final', source:'espn_scoreboard' };
      }
    }
  }
  return null;
}

app.get('/agents/status', (_, res) => {
  res.json({
    success: true,
    supervisor: readAgentJson('agent-supervisor-state.json', null),
    sourceDiscovery: readAgentJson('latest-source-discovery.json', null),
    sourceBindings: readAgentJson('source-bindings.json', null),
    sourceHealth: readAgentJson('latest-source-health.json', null),
    signalCapture: readAgentJson('latest-signal-capture.json', null),
    learning: readAgentJson('latest-learning.json', null),
    benchmark: readAgentJson('latest-benchmark.json', null),
    promotion: readAgentJson('latest-promotion-decision.json', null),
    improvement: readAgentJson('latest-improvement-plan.json', null),
    improvementTaskBoard: readAgentJson('improvement-task-board.json', null),
    storage: readAgentJson('latest-storage-guard.json', null),
    analytics: readAgentJson('latest-performance-analytics.json', null),
    adapterBlueprints: readAgentJson('latest-adapter-blueprints.json', null),
    thresholdTuning: readAgentJson('latest-threshold-tuning.json', null),
    alerts: readAgentJson('latest-alerts.json', null),
    rootCauseFixPlan: readAgentJson('latest-root-cause-fix-plan.json', null),
    dailyReport: readAgentJson('latest-daily-report.json', null),
    capabilityScorecard: readAgentJson('latest-capability-scorecard.json', null),
  });
});

app.get('/agents/strategy', (_, res) => {
  res.json({
    success: true,
    current: readAgentJson('current-strategy.json', null),
    candidate: readAgentJson('candidate-strategy.json', null),
    rollback: readAgentJson('rollback-strategy.json', null),
  });
});

app.get('/agents/model', (_, res) => {
  res.json({
    success: true,
    current: readAgentJson('current-model.json', null),
    candidate: readAgentJson('candidate-model.json', null),
    rollback: readAgentJson('rollback-model.json', null),
  });
});

app.get('/agents/promotion', (_, res) => {
  res.json({
    success: true,
    decision: readAgentJson('latest-promotion-decision.json', null),
    benchmark: readAgentJson('latest-benchmark.json', null),
  });
});

app.get('/agents/improvement', (_, res) => {
  res.json({
    success: true,
    plan: readAgentJson('latest-improvement-plan.json', null),
    taskBoard: readAgentJson('improvement-task-board.json', null),
  });
});

app.get('/agents/report', (_, res) => {
  res.json({
    success: true,
    dailyReport: readAgentJson('latest-daily-report.json', null),
    alerts: readAgentJson('latest-alerts.json', null),
    analytics: readAgentJson('latest-performance-analytics.json', null),
    scorecard: readAgentJson('latest-capability-scorecard.json', null),
    improvement: readAgentJson('latest-improvement-plan.json', null),
    rootCauseFixPlan: readAgentJson('latest-root-cause-fix-plan.json', null),
  });
});

app.get('/agents/alerts', (_, res) => {
  res.json({
    success: true,
    alerts: readAgentJson('latest-alerts.json', null)
  });
});

app.get('/agents/analytics', (_, res) => {
  res.json({
    success: true,
    analytics: readAgentJson('latest-performance-analytics.json', null),
    thresholdTuning: readAgentJson('latest-threshold-tuning.json', null),
    adapterBlueprints: readAgentJson('latest-adapter-blueprints.json', null),
    rootCauseFixPlan: readAgentJson('latest-root-cause-fix-plan.json', null)
  });
});

app.get('/agents/export', (_, res) => {
  const payload = {
    exportedAt: new Date().toISOString(),
    json: {
      supervisor: readAgentJson('agent-supervisor-state.json', null),
      sourceBindings: readAgentJson('source-bindings.json', null),
      sourceHealth: readAgentJson('latest-source-health.json', null),
      learning: readAgentJson('latest-learning.json', null),
      currentModel: readAgentJson('current-model.json', null),
      candidateModel: readAgentJson('candidate-model.json', null),
      currentStrategy: readAgentJson('current-strategy.json', null),
      candidateStrategy: readAgentJson('candidate-strategy.json', null),
      improvement: readAgentJson('latest-improvement-plan.json', null),
      alerts: readAgentJson('latest-alerts.json', null),
      dailyReport: readAgentJson('latest-daily-report.json', null),
      scorecard: readAgentJson('latest-capability-scorecard.json', null),
      rootCauseFixPlan: readAgentJson('latest-root-cause-fix-plan.json', null)
    },
    jsonlTail: {
      signals: readAgentDataJsonl('signals.jsonl', 1000),
      outcomes: readAgentDataJsonl('outcomes.jsonl', 1000),
      sourceHealth: readAgentDataJsonl('source-health.jsonl', 200),
      improvementRuns: readAgentDataJsonl('improvement-runs.jsonl', 100)
    }
  };
  res.json({ success: true, export: payload });
});

app.post('/agents/outcomes', (req, res) => {
  const body = req.body || {};
  const rows = Array.isArray(body) ? body : (Array.isArray(body.outcomes) ? body.outcomes : [body]);
  const accepted = [];
  for (const row of rows) {
    const result = String(row.result || row.state || '').toLowerCase();
    if (!['won', 'lost', 'void'].includes(result)) continue;
    const record = {
      agent: 'frontend-settlement-bridge',
      key: row.key || [
        row.matchId || row.id || '?',
        row.signalId || row.type || row.market || row.bet || '?',
        row.minute || 0,
        row.score || ''
      ].join('|'),
      result,
      matchId: row.matchId || row.id || null,
      home: row.home || null,
      away: row.away || null,
      match: row.match || null,
      league: row.league || null,
      bet: row.bet || null,
      type: row.type || row.market || null,
      signalId: row.signalId || null,
      minute: row.minute || null,
      score: row.score || null,
      finalScore: row.finalScore || null,
      odds: row.odds || null,
      stake: row.stake || null,
      pnl: row.pnl || null,
      source: row.settlementSource || row.source || 'frontend',
      reason: row.settlementReason || row.reason || '',
      settledAt: row.settledAt || new Date().toISOString()
    };
    appendAgentDataJsonl('outcomes.jsonl', record);
    accepted.push(record);
  }
  writeAgentDataJson('latest-outcome-import.json', {
    at: new Date().toISOString(),
    accepted: accepted.length,
    samples: accepted.slice(0, 20)
  });
  res.json({ success: true, accepted: accepted.length });
});

app.get('/final-score', async (req, res) => {
  try {
    const result = await resolveEspnFinal({
      matchId: req.query.matchId || req.query.id,
      home: req.query.home,
      away: req.query.away,
      date: req.query.date || req.query.createdAt
    });
    if (result) return res.json({ success:true, found:true, ...result });
    res.json({ success:true, found:false, reason:'final_score_not_found' });
  } catch (err) {
    res.status(200).json({ success:false, found:false, error:err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  log(`CanliBet scraper service v11.30-intelligence-rebuild listening on :${PORT}`);
  if (String(process.env.CANLIBET_EMBED_AGENT || 'true').toLowerCase() !== 'false') {
    try {
      if (!process.env.CANLIBET_BACKEND_URL) process.env.CANLIBET_BACKEND_URL = `http://localhost:${PORT}`;
      require('./agent/embedded-supervisor').startEmbeddedAgent();
      log('Embedded agent supervisor started');
    } catch (err) {
      log('[ERROR] Embedded agent supervisor failed', { error: err.message });
    }
  }
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
