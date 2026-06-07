'use strict';

const config = require('./config');
const store = require('./store');
const { fetchJson } = require('./http');
const fs = require('fs');
const path = require('path');

function n(v, fallback = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function signalKey(match, signal) {
  return [
    match.match_id || match.id || '?',
    signal.id || signal.label || '?',
    match.minute || match.match_elapsed || 0,
    match.match_hometeam_score || 0,
    match.match_awayteam_score || 0
  ].join('|');
}

function isAnalyzable(match) {
  if (!match || String(match.match_live) !== '1') return false;
  if (n(match.validationScore) < config.thresholds.minValidationScore) return false;
  if (n(match.dataReliabilityScore) < config.thresholds.minReliabilityScore) return false;
  if (n(match.fakeRiskScore) > config.thresholds.maxFakeRiskScore) return false;
  if (match.qualityClass && match.qualityClass !== 'REAL_ANALYZABLE') return false;
  return true;
}

function todayYyyymmdd() {
  const d = new Date();
  return String(d.getUTCFullYear()) +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    String(d.getUTCDate()).padStart(2, '0');
}

function loadSourceCandidates() {
  try {
    const p = path.join(__dirname, 'source-candidates.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return [];
  }
}

function countJsonEvents(data) {
  if (!data || typeof data !== 'object') return 0;
  const candidates = [
    data.events,
    data.matches,
    data.fixtures,
    data.data,
    data.response,
    data.livescore,
    data.results
  ];
  for (const item of candidates) {
    if (Array.isArray(item)) return item.length;
    if (item && typeof item === 'object') {
      const arr = Object.values(item).find(Array.isArray);
      if (arr) return arr.length;
    }
  }
  return 0;
}

function detectLiveHintsFromJson(data) {
  const txt = JSON.stringify(data || {}).slice(0, 120000).toLowerCase();
  const liveWords = ['live', 'in_play', 'in-play', 'in progress', 'status_in_progress', '1h', '2h', 'halftime'];
  const statWords = ['shots', 'corner', 'possession', 'statistics', 'stats', 'xg', 'on target'];
  const oddsWords = ['odds', 'bookmaker', 'price', 'decimal'];
  return {
    hasLiveHints: liveWords.some(w => txt.includes(w)),
    hasStatHints: statWords.some(w => txt.includes(w)),
    hasOddsHints: oddsWords.some(w => txt.includes(w))
  };
}

function scoreCandidateProbe(candidate, probe) {
  let score = 0;
  if (probe.status === 200) score += 30;
  if (probe.contentType && /json/i.test(probe.contentType)) score += 20;
  if (probe.eventCount > 0) score += Math.min(25, probe.eventCount);
  if (probe.hasLiveHints) score += 10;
  if (probe.hasStatHints) score += 10;
  if (probe.hasOddsHints) score += 5;
  if (probe.error) score -= 30;
  if (probe.status === 403 || probe.status === 429) score -= 50;
  if (probe.status && probe.status >= 500) score -= 20;
  return Math.max(0, Math.min(100, score));
}

async function probeCandidate(candidate) {
  const url = String(candidate.url || '').replace('{YYYYMMDD}', todayYyyymmdd());
  const startedAt = Date.now();
  const result = {
    id: candidate.id,
    provider: candidate.provider,
    type: candidate.type,
    url,
    status: null,
    ok: false,
    durationMs: 0,
    contentType: '',
    eventCount: 0,
    hasLiveHints: false,
    hasStatHints: false,
    hasOddsHints: false,
    score: 0,
    recommendation: 'reject',
    error: null,
    textPreview: ''
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 18000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: candidate.type === 'html' ? 'text/html,application/xhtml+xml,application/json,*/*' : 'application/json,*/*',
        'User-Agent': 'CanliBetSourceDiscovery/1.0'
      }
    });
    result.status = res.status;
    result.ok = res.ok;
    result.contentType = res.headers.get('content-type') || '';
    const text = await res.text();
    result.textPreview = text.slice(0, 220);
    if (/json/i.test(result.contentType) || /^[\s{[]/.test(text)) {
      try {
        const data = JSON.parse(text);
        result.eventCount = countJsonEvents(data);
        Object.assign(result, detectLiveHintsFromJson(data));
      } catch (_) {
        result.error = 'json_parse_failed';
      }
    } else {
      const plain = text.toLowerCase();
      result.eventCount = (plain.match(/\b\d{1,2}'|\bht\b|\blive\b|canli|canlı/g) || []).length;
      result.hasLiveHints = /live|canli|canlı|ht|1h|2h/.test(plain);
      result.hasStatHints = /shots|corner|possession|istatistik|statistics/.test(plain);
      result.hasOddsHints = /odds|oran|bookmaker/.test(plain);
    }
  } catch (err) {
    result.error = err.name === 'AbortError' ? 'timeout' : err.message;
  } finally {
    clearTimeout(timer);
    result.durationMs = Date.now() - startedAt;
  }

  result.score = scoreCandidateProbe(candidate, result);
  if (result.score >= 65) result.recommendation = 'adapter_candidate';
  else if (result.score >= 40) result.recommendation = 'watch_candidate';
  else if (result.status === 403 || result.status === 429) result.recommendation = 'blocked_do_not_use';
  return result;
}

async function sourceDiscoveryAgent() {
  const candidates = loadSourceCandidates();
  const probes = [];
  for (const candidate of candidates) {
    probes.push(await probeCandidate(candidate));
  }
  const ranked = probes.slice().sort((a, b) => b.score - a.score);
  const report = {
    agent: 'source-discovery-agent',
    tested: probes.length,
    adapterCandidates: ranked.filter(x => x.recommendation === 'adapter_candidate'),
    watchCandidates: ranked.filter(x => x.recommendation === 'watch_candidate'),
    blocked: ranked.filter(x => x.recommendation === 'blocked_do_not_use'),
    ranked
  };
  store.appendJsonl('source-discovery.jsonl', report);
  store.writeJson('latest-source-discovery.json', report);
  return report;
}

function sourceProviderFromCandidate(candidate) {
  const id = String(candidate.id || '');
  const provider = String(candidate.provider || '');
  if (provider.includes('espn') || id.startsWith('espn_')) return 'espn_json';
  if (provider.includes('flashscore_mobile') || id.includes('flashscore_mobile')) return 'flashscore_mobile';
  if (provider.includes('flashscore') || id.includes('flashscore')) return 'flashscore_feed';
  if (provider.includes('fotmob') || id.includes('fotmob')) return 'fotmob_json';
  if (provider.includes('openligadb') || id.includes('openligadb')) return 'openligadb_json';
  if (provider.includes('thesportsdb') || id.includes('thesportsdb')) return 'thesportsdb_json';
  if (provider.includes('aiscore') || id.includes('aiscore')) return 'aiscore_json';
  return null;
}

function sourceAutoBindAgent() {
  const discovery = store.readJson('latest-source-discovery.json', null);
  const previous = store.readJson('source-bindings.json', {
    enabledProviders: [],
    quarantinedProviders: [],
    disabledProviders: [],
    candidateSources: [],
    decisions: []
  });

  const enabled = new Set(previous.enabledProviders || []);
  const quarantined = new Set(previous.quarantinedProviders || []);
  const disabled = new Set(previous.disabledProviders || []);
  const decisions = [];

  if (!discovery) {
    const empty = Object.assign({}, previous, {
      updatedAt: new Date().toISOString(),
      lastDecision: 'no_discovery_report'
    });
    store.writeJson('source-bindings.json', empty);
    return empty;
  }

  for (const candidate of discovery.ranked || []) {
    const provider = sourceProviderFromCandidate(candidate);
    if (!provider) {
      decisions.push({
        sourceId: candidate.id,
        action: 'needs_adapter',
        reason: 'unknown_provider_mapping',
        score: candidate.score
      });
      continue;
    }

    if (candidate.recommendation === 'blocked_do_not_use' || candidate.status === 403 || candidate.status === 429) {
      enabled.delete(provider);
      quarantined.add(provider);
      decisions.push({
        sourceId: candidate.id,
        provider,
        action: 'quarantine_provider',
        reason: candidate.status === 403 || candidate.status === 429 ? 'blocked_or_rate_limited' : 'blocked_candidate',
        score: candidate.score,
        status: candidate.status
      });
      continue;
    }

    if (candidate.recommendation === 'adapter_candidate' && candidate.score >= 65) {
      if (!disabled.has(provider)) {
        quarantined.delete(provider);
        enabled.add(provider);
        decisions.push({
          sourceId: candidate.id,
          provider,
          action: 'enable_provider',
          reason: 'healthy_candidate',
          score: candidate.score,
          eventCount: candidate.eventCount,
          hasLiveHints: candidate.hasLiveHints,
          hasStatHints: candidate.hasStatHints,
          hasOddsHints: candidate.hasOddsHints
        });
      }
      continue;
    }

    if (candidate.recommendation === 'watch_candidate') {
      decisions.push({
        sourceId: candidate.id,
        provider,
        action: 'watch_only',
        reason: 'candidate_not_strong_enough',
        score: candidate.score,
        eventCount: candidate.eventCount
      });
    }
  }

  const bindings = {
    updatedAt: new Date().toISOString(),
    mode: config.mode,
    enabledProviders: Array.from(enabled),
    quarantinedProviders: Array.from(quarantined),
    disabledProviders: Array.from(disabled),
    candidateSources: (discovery.adapterCandidates || []).map(c => ({
      id: c.id,
      provider: sourceProviderFromCandidate(c),
      score: c.score,
      eventCount: c.eventCount,
      hasLiveHints: c.hasLiveHints,
      hasStatHints: c.hasStatHints,
      hasOddsHints: c.hasOddsHints
    })),
    decisions: decisions.slice(-100)
  };

  store.writeJson('source-bindings.json', bindings);
  store.appendJsonl('source-bindings.jsonl', {
    agent: 'source-auto-bind-agent',
    enabledProviders: bindings.enabledProviders,
    quarantinedProviders: bindings.quarantinedProviders,
    decisions: bindings.decisions
  });
  return bindings;
}

async function sourceHealthAgent() {
  const health = await fetchJson(`${config.backendBaseUrl}/health`, 15000);
  const live = await fetchJson(`${config.backendBaseUrl}/live?force=true`, 45000);
  const debug = live.data && live.data.debug ? live.data.debug : {};
  const report = {
    agent: 'source-health-agent',
    ok: health.ok && live.ok && !!live.data,
    healthStatus: health.data && health.data.status,
    liveCount: debug.summary ? debug.summary.visibleLive : 0,
    signalEligible: debug.summary ? debug.summary.signalEligible : 0,
    providerReport: debug.providerReport || {},
    providerQualityReport: debug.providerQualityReport || {},
    providerErrors: debug.providerErrors || {},
    coverageEstimate: debug.coverageEstimate || {},
    recommendation: []
  };

  for (const [provider, p] of Object.entries(report.providerReport || {})) {
    const raw = n(p.raw);
    const parsed = n(p.parsed);
    const visible = n(p.visible);
    const rejected = n(p.rejected);
    const failureRate = raw > 0 ? rejected / Math.max(raw, 1) : (p.error ? 1 : 0);
    if (p.blocked || failureRate >= config.thresholds.sourceDisableFailureRate) {
      report.recommendation.push({
        action: 'quarantine_source',
        provider,
        reason: p.blocked ? 'blocked' : 'high_reject_rate',
        raw, parsed, visible, rejected, failureRate: Number(failureRate.toFixed(3))
      });
    }
  }

  store.appendJsonl('source-health.jsonl', report);
  store.writeJson('latest-source-health.json', report);
  return report;
}

async function signalCaptureAgent() {
  const res = await fetchJson(`${config.backendBaseUrl}/live?force=true`, 45000);
  const matches = (res.data && Array.isArray(res.data.matches)) ? res.data.matches : [];
  const seen = new Set(store.readJson('seen-signals.json', []));
  const captured = [];

  for (const match of matches) {
    if (!isAnalyzable(match)) continue;
    const signals = Array.isArray(match.signals) ? match.signals : [];
    for (const signal of signals) {
      if (n(signal.confidence) < config.thresholds.minSignalConfidence) continue;
      const key = signalKey(match, signal);
      if (seen.has(key)) continue;
      seen.add(key);
      const record = {
        agent: 'signal-capture-agent',
        key,
        matchId: match.match_id,
        home: match.match_hometeam_name,
        away: match.match_awayteam_name,
        league: match.league_name,
        minute: match.minute,
        score: `${match.match_hometeam_score || 0}-${match.match_awayteam_score || 0}`,
        source: match._mergeProvider || match.source,
        signal,
        derived: match.derived || {},
        validationScore: match.validationScore,
        dataReliabilityScore: match.dataReliabilityScore,
        fakeRiskScore: match.fakeRiskScore,
        qualityClass: match.qualityClass,
        signalReadinessClass: match.signalReadinessClass,
        decision: n(signal.confidence) >= config.thresholds.strongSignalConfidence ? 'STRONG_WATCH' : 'WATCH',
        systemMode: 'SIGNAL_ONLY_SHADOW'
      };
      captured.push(record);
      store.appendJsonl('signals.jsonl', record);
    }
  }

  store.writeJson('seen-signals.json', Array.from(seen).slice(-20000));
  store.writeJson('latest-signal-capture.json', {
    at: new Date().toISOString(),
    captured: captured.length,
    liveMatches: matches.length
  });
  return { captured: captured.length, liveMatches: matches.length };
}

function learningAgent() {
  const signals = store.readJsonl('signals.jsonl', 20000);
  const outcomes = store.readJsonl('outcomes.jsonl', 20000);
  const outcomeByKey = new Map(outcomes.map(o => [o.key, o]));
  const groups = {};

  for (const s of signals) {
    const out = outcomeByKey.get(s.key);
    if (!out || !['won', 'lost'].includes(out.result)) continue;
    const signalId = s.signal && (s.signal.id || s.signal.label) || 'unknown';
    const minuteBand = Math.floor(n(s.minute) / 10) * 10;
    const source = s.source || 'unknown';
    const keys = [
      `signal:${signalId}`,
      `minute:${minuteBand}`,
      `source:${source}`,
      `signal_source:${signalId}|${source}`
    ];
    for (const key of keys) {
      groups[key] = groups[key] || { key, total: 0, won: 0, lost: 0, confSum: 0 };
      groups[key].total++;
      if (out.result === 'won') groups[key].won++;
      else groups[key].lost++;
      groups[key].confSum += n(s.signal && s.signal.confidence, 50) / 100;
    }
  }

  const report = Object.values(groups).map(g => {
    const winRate = g.total ? g.won / g.total : 0;
    const avgConf = g.total ? g.confSum / g.total : 0;
    return Object.assign(g, {
      winRate: Number(winRate.toFixed(3)),
      avgConfidence: Number(avgConf.toFixed(3)),
      calibrationGap: Number((winRate - avgConf).toFixed(3)),
      reliable: g.total >= 30
    });
  }).sort((a, b) => b.total - a.total);

  const weakPatterns = report.filter(r => r.reliable && r.winRate < Math.max(0.45, r.avgConfidence - 0.12));
  const strongPatterns = report.filter(r => r.reliable && r.winRate > r.avgConfidence + 0.08);
  const payload = {
    agent: 'learning-agent',
    sampleSize: outcomes.length,
    settledSignals: report.reduce((a, r) => Math.max(a, r.total), 0),
    weakPatterns: weakPatterns.slice(0, 20),
    strongPatterns: strongPatterns.slice(0, 20),
    groups: report.slice(0, 200)
  };
  store.appendJsonl('learning-runs.jsonl', payload);
  store.writeJson('latest-learning.json', payload);
  return payload;
}

function strategyMutatorAgent() {
  const learning = store.readJson('latest-learning.json', null);
  const current = store.readJson('current-strategy.json', {
    version: 'agent_shadow_v1',
    blockedPatterns: [],
    boostedPatterns: [],
    confidenceAdjustments: {}
  });
  const candidate = JSON.parse(JSON.stringify(current));
  candidate.version = `candidate_${Date.now()}`;
  candidate.createdAt = new Date().toISOString();
  candidate.mode = 'shadow';
  candidate.blockedPatterns = Array.from(new Set([
    ...(current.blockedPatterns || []),
    ...((learning && learning.weakPatterns) || []).slice(0, 10).map(p => p.key)
  ]));
  candidate.boostedPatterns = Array.from(new Set([
    ...(current.boostedPatterns || []),
    ...((learning && learning.strongPatterns) || []).slice(0, 10).map(p => p.key)
  ]));

  for (const p of ((learning && learning.weakPatterns) || []).slice(0, 20)) {
    candidate.confidenceAdjustments[p.key] = -3;
  }
  for (const p of ((learning && learning.strongPatterns) || []).slice(0, 20)) {
    candidate.confidenceAdjustments[p.key] = 2;
  }

  store.writeJson('candidate-strategy.json', candidate);
  store.appendJsonl('strategy-runs.jsonl', {
    agent: 'strategy-mutator-agent',
    currentVersion: current.version,
    candidateVersion: candidate.version,
    blocked: candidate.blockedPatterns.length,
    boosted: candidate.boostedPatterns.length
  });
  return candidate;
}

function modelTrainerAgent() {
  const signals = store.readJsonl('signals.jsonl', 50000);
  const outcomes = store.readJsonl('outcomes.jsonl', 50000);
  const outcomeByKey = new Map(outcomes.map(o => [o.key, o]));
  const rows = signals
    .map(s => ({ s, o: outcomeByKey.get(s.key) }))
    .filter(x => x.o && ['won', 'lost'].includes(x.o.result));

  const model = {
    version: `model_${Date.now()}`,
    trainedAt: new Date().toISOString(),
    type: 'calibration_table_v1',
    samples: rows.length,
    buckets: {}
  };

  for (const { s, o } of rows) {
    const conf = Math.floor(n(s.signal && s.signal.confidence, 50) / 10) * 10;
    const key = `${s.signal && s.signal.id || 'unknown'}|${conf}`;
    model.buckets[key] = model.buckets[key] || { total: 0, won: 0 };
    model.buckets[key].total++;
    if (o.result === 'won') model.buckets[key].won++;
  }

  for (const b of Object.values(model.buckets)) {
    b.winRate = b.total ? Number((b.won / b.total).toFixed(3)) : 0;
    b.reliable = b.total >= 20;
  }

  store.writeJson('candidate-model.json', model);
  store.appendJsonl('model-runs.jsonl', { agent: 'model-trainer-agent', modelVersion: model.version, samples: model.samples });
  return model;
}

function modelBenchmarkAgent() {
  const candidate = store.readJson('candidate-model.json', null);
  const current = store.readJson('current-model.json', null);
  const result = {
    agent: 'model-benchmark-agent',
    candidateVersion: candidate && candidate.version,
    currentVersion: current && current.version,
    candidateSamples: candidate && candidate.samples || 0,
    currentSamples: current && current.samples || 0,
    recommendation: 'hold',
    reasons: []
  };

  if (!candidate || candidate.samples < config.thresholds.minPromotionSamples) {
    result.reasons.push('not_enough_candidate_samples');
  } else if (!current) {
    result.recommendation = 'promote';
    result.reasons.push('no_current_model');
  } else if (candidate.samples >= current.samples) {
    result.recommendation = 'promote';
    result.reasons.push('candidate_has_equal_or_more_samples');
  } else {
    result.reasons.push('candidate_not_better');
  }

  store.writeJson('latest-benchmark.json', result);
  store.appendJsonl('benchmark-runs.jsonl', result);
  return result;
}

function promotionGuardianAgent() {
  const benchmark = store.readJson('latest-benchmark.json', null);
  const candidateModel = store.readJson('candidate-model.json', null);
  const candidateStrategy = store.readJson('candidate-strategy.json', null);
  const decision = {
    agent: 'promotion-guardian-agent',
    mode: config.mode,
    autoPromote: config.promotion.autoPromote,
    decision: 'hold',
    reasons: []
  };

  if (!benchmark || benchmark.recommendation !== 'promote') {
    decision.reasons.push('benchmark_not_promotable');
  } else if (!config.promotion.autoPromote) {
    decision.decision = 'ready_for_manual_promotion';
    decision.reasons.push('auto_promote_disabled');
  } else if (candidateModel) {
    const currentModel = store.readJson('current-model.json', null);
    if (currentModel) store.writeJson('rollback-model.json', currentModel);
    store.writeJson('current-model.json', candidateModel);
    if (candidateStrategy) {
      const currentStrategy = store.readJson('current-strategy.json', null);
      if (currentStrategy) store.writeJson('rollback-strategy.json', currentStrategy);
      store.writeJson('current-strategy.json', Object.assign({}, candidateStrategy, { mode: 'live' }));
    }
    decision.decision = 'promoted';
    decision.reasons.push('benchmark_promoted');
  }

  store.writeJson('latest-promotion-decision.json', decision);
  store.appendJsonl('promotion-runs.jsonl', decision);
  return decision;
}

function featureRuntimeSignals() {
  const sourceHealth = store.readJson('latest-source-health.json', null);
  const sourceDiscovery = store.readJson('latest-source-discovery.json', null);
  const signalCapture = store.readJson('latest-signal-capture.json', null);
  const learning = store.readJson('latest-learning.json', null);
  const benchmark = store.readJson('latest-benchmark.json', null);
  const liveCount = n(sourceHealth && sourceHealth.liveCount);
  const signalEligible = n(sourceHealth && sourceHealth.signalEligible);
  const captured = n(signalCapture && signalCapture.captured);
  const adapterCandidates = (sourceDiscovery && sourceDiscovery.adapterCandidates || []).length;
  const settledSignals = n(learning && learning.settledSignals);
  const modelSamples = n(benchmark && benchmark.candidateSamples);

  return {
    liveCount,
    signalEligible,
    captured,
    adapterCandidates,
    settledSignals,
    modelSamples,
    signalEligibleRatio: liveCount ? Number((signalEligible / liveCount).toFixed(3)) : 0,
    capturedRatio: liveCount ? Number((captured / liveCount).toFixed(3)) : 0
  };
}

function runtimePenalty(featureId, signals) {
  if (featureId === 'live_coverage' && signals.liveCount < 40) return 0.5;
  if (featureId === 'stats_coverage' && signals.signalEligibleRatio < 0.2) return 1.0;
  if (featureId === 'odds_coverage') return 0.5;
  if (featureId === 'settlement' && signals.settledSignals < 50) return 0.5;
  if (featureId === 'machine_learning' && signals.modelSamples < 200) return 0.75;
  if (featureId === 'persistent_storage') return 1.0;
  return 0;
}

function solutionReportFor(featureId, signals) {
  const reports = {
    live_coverage: {
      rootCause: 'Live match count is present, but too many rows are low-data or not real signal candidates.',
      fixPlan: [
        'Prefer providers with parsed + visible + stats-backed rows, not only high raw event count.',
        'Demote sources that only create monitor rows without stats, odds, clock, score, or league confidence.',
        'Expand ESPN league slugs and bind only candidates that pass parsed/visible quality checks.'
      ],
      implementationSteps: [
        'Add provider quality scoring to source auto-bind decisions.',
        'Require minimum parsed/visible ratio before enabling a source for prediction.',
        'Keep weak sources watch-only until they produce reliable match fields.'
      ],
      successTarget: `Raise signalEligible/live ratio from ${signals.signalEligibleRatio} to at least 0.15 without increasing rejected rows.`,
      riskControl: 'Never promote a source only because eventCount is high; require valid score, clock, teams, league, and stats hints.'
    },
    source_discovery: {
      rootCause: 'Discovery finds candidates, but adapter-ready conversion is still shallow.',
      fixPlan: [
        'Separate adapter candidates, watch-only candidates, and blocked sources more aggressively.',
        'Record why a candidate cannot yet be connected.',
        'Generate a provider-specific adapter checklist for every strong source.'
      ],
      implementationSteps: [
        'Add candidate reason codes and required parser fields.',
        'Persist adapter specs for healthy JSON sources.',
        'Quarantine sources that repeatedly need API keys or return empty live data.'
      ],
      successTarget: 'Keep at least 3 strong adapter candidates and 0 blocked sources in enabled providers.',
      riskControl: 'Do not auto-enable HTML sources unless parsing quality is proven.'
    },
    stats_coverage: {
      rootCause: 'Most visible matches do not include usable shots, corners, possession, pressure, or reliability signals.',
      fixPlan: [
        'Improve ESPN detail/stat extraction first because it is the healthiest JSON source.',
        'Reject low-data matches from signal generation instead of displaying them as prediction candidates.',
        'Normalize stats into one reliability score used by both backend and frontend.'
      ],
      implementationSteps: [
        'Audit source_espn_json detail endpoint fields.',
        'Map shots, shots on target, corners, possession, attacks, and dangerous attacks where available.',
        'Raise signal eligibility only when statsCoverage and dataReliabilityScore are both acceptable.'
      ],
      successTarget: `Raise stats-backed signal candidates from ${signals.signalEligible} to at least 20% of live matches.`,
      riskControl: 'Missing stats must become watch-only, not fake pressure or fake confidence.'
    },
    odds_coverage: {
      rootCause: 'Odds availability is weak and synthetic odds can make ROI/value calculations misleading.',
      fixPlan: [
        'Mark odds as real, cached, synthetic, or missing.',
        'Allow value betting calculations only when odds are real or explicitly trusted.',
        'Show non-odds signals separately from bettable value signals.'
      ],
      implementationSteps: [
        'Add oddsSource/oddsQuality fields to normalized matches.',
        'Block ROI contribution from synthetic odds.',
        'Track oddsMatchedCount in health output.'
      ],
      successTarget: '0 synthetic odds in ROI and clear separation between signal-only and bettable picks.',
      riskControl: 'If odds are missing, the system may watch or signal, but must not call it value.'
    },
    value_predictions: {
      rootCause: 'Prediction volume is low because quality gates are strict, but this is better than producing weak picks.',
      fixPlan: [
        'Create two layers: monitor signals and actionable value signals.',
        'Require stronger evidence for actionable signals.',
        'Use historical hit rate by pattern once settlement data exists.'
      ],
      implementationSteps: [
        'Add reason codes for why a match stayed watch-only.',
        'Add minimum confidence + reliability + odds quality gate.',
        'Feed settled pattern performance back into signal thresholds.'
      ],
      successTarget: 'Fewer but higher-quality actionable signals with clear watch/action ratio.',
      riskControl: 'Do not lower thresholds just to increase prediction count.'
    },
    settlement: {
      rootCause: 'Historical predictions are not being closed reliably, so learning has no settled outcomes.',
      fixPlan: [
        'Use backend /final-score as first settlement source.',
        'Retry stale predictions for several days.',
        'Write every resolved prediction into outcomes.jsonl for learning.'
      ],
      implementationSteps: [
        'Improve final-score matching with team aliases and date window.',
        'Add settlement result reason: found, not_final_yet, source_missing, ambiguous.',
        'Append settled win/loss/void records to the agent outcome store.'
      ],
      successTarget: `Increase settledSignals from ${signals.settledSignals} to at least 50 before model promotion is allowed.`,
      riskControl: 'Ambiguous finals must go to review, not auto-win or auto-loss.'
    },
    learning_system: {
      rootCause: 'Learning cannot start because settledSignals is too low.',
      fixPlan: [
        'Make settlement feed outcomes into learning storage.',
        'Group outcomes by market, league, minute band, confidence band, and data quality.',
        'Only trust patterns after minimum sample size.'
      ],
      implementationSteps: [
        'Connect settled history to outcomes.jsonl.',
        'Add sample-size guards per pattern group.',
        'Expose weak/strong patterns in /agents/learning or /agents/status.'
      ],
      successTarget: 'At least 50 settled outcomes for basic learning and 200+ for model comparison.',
      riskControl: 'Never mutate strategy from tiny samples.'
    },
    machine_learning: {
      rootCause: 'There are no training samples yet, so the model trainer can only produce placeholder candidates.',
      fixPlan: [
        'Delay model promotion until enough settled outcomes exist.',
        'Start with calibrated bucket models before complex ML.',
        'Compare candidate model against current model using holdout metrics.'
      ],
      implementationSteps: [
        'Extract features from settled signals.',
        'Train confidence buckets by market and data quality.',
        'Benchmark lift, Brier score, and hit rate before promotion.'
      ],
      successTarget: `Raise candidateSamples from ${signals.modelSamples} to at least 200 before promotion.`,
      riskControl: 'No auto-promotion when sample size is below threshold.'
    },
    model_trainer: {
      rootCause: 'The trainer has no real outcome sample set to learn from.',
      fixPlan: [
        'Build model records from settled signals only.',
        'Track feature importance and bucket reliability.',
        'Write model metadata explaining why a candidate is better or held.'
      ],
      implementationSteps: [
        'Add feature extraction for minute, score state, pressure, odds, confidence, and source reliability.',
        'Store candidate-model.json with sample counts and calibration buckets.',
        'Reject candidate models with weak sample distribution.'
      ],
      successTarget: 'Candidate model has enough samples and documented reliability per bucket.',
      riskControl: 'A model without samples is diagnostic only, never promotable.'
    },
    benchmark_promotion: {
      rootCause: 'Promotion is correctly held because candidate samples are not enough.',
      fixPlan: [
        'Keep autoPromote false until benchmark evidence is strong.',
        'Add rollback model before any promotion.',
        'Require lift plus calibration improvement.'
      ],
      implementationSteps: [
        'Write explicit benchmark reasons.',
        'Compare candidate vs current with Brier/log-loss/lift.',
        'Save rollback-model.json before promotion.'
      ],
      successTarget: 'Promotion only when min samples, lift, and calibration gates all pass.',
      riskControl: 'Manual review remains required unless all gates pass.'
    },
    continuous_runtime: {
      rootCause: 'Free Render can sleep, so agent loops can pause after inactivity.',
      fixPlan: [
        'Persist last run state so wakeups continue cleanly.',
        'Make health output show stale agents.',
        'Use frontend/backend visits as natural wakeups in free mode.'
      ],
      implementationSteps: [
        'Add stale-run warnings to supervisor state.',
        'Avoid assuming loops ran while service was sleeping.',
        'Expose next expected run per agent.'
      ],
      successTarget: 'After Render wakeup, all agents recover and write fresh status within 2 minutes.',
      riskControl: 'Do not depend on free Render for true 24/7 continuous work.'
    },
    persistent_storage: {
      rootCause: 'Agent data stored on Render filesystem can disappear on redeploy or instance reset.',
      fixPlan: [
        'Keep JSONL local fallback but support durable external storage later.',
        'Export critical agent data regularly.',
        'Protect signals, outcomes, model, source health, and strategy files.'
      ],
      implementationSteps: [
        'Add storage status to /agents/status.',
        'Add import/export endpoints or artifact bundles.',
        'Prepare optional durable store adapter without requiring paid services.'
      ],
      successTarget: 'No loss of history, outcomes, or model state after deploy.',
      riskControl: 'Never overwrite non-empty stores with empty fallback data.'
    },
    production_maturity: {
      rootCause: 'Deployment is working, but smoke checks and release safety are still manual.',
      fixPlan: [
        'Document exact deploy checks.',
        'Expose health/smoke endpoints for live, agents, final-score, and history safety.',
        'Keep code changes review-gated.'
      ],
      implementationSteps: [
        'Add README smoke checklist.',
        'Add /agents/status interpretation guide.',
        'Package backend/frontend zips with version notes.'
      ],
      successTarget: 'Every deploy can be checked in under 2 minutes with clear pass/fail signals.',
      riskControl: 'If health drops or history is at risk, rollback before further changes.'
    },
    history_screen: {
      rootCause: 'Frontend history depends on browser storage and can be damaged by cache-clearing or version changes.',
      fixPlan: [
        'Keep backup copy before cache clear.',
        'Restore from backup if main history is empty.',
        'Make unresolved/stale reasons visible and actionable.'
      ],
      implementationSteps: [
        'Verify canlibet_v7_history_backup is written on every non-empty save.',
        'Use backend final-score checks for old open predictions.',
        'Add repair flow that does not delete history.'
      ],
      successTarget: 'History survives cache clear, reload, frontend update, and deploy.',
      riskControl: 'Never clear localStorage history during boot repair.'
    }
  };
  return reports[featureId] || {
    rootCause: 'Feature is below the target score.',
    fixPlan: ['Inspect runtime metrics and add a targeted improvement task.'],
    implementationSteps: ['Create a small reviewed change and verify with health metrics.'],
    successTarget: 'Effective score rises above the improvement threshold.',
    riskControl: 'Code changes require review.'
  };
}

function improvementTaskFor(feature, signals) {
  const templates = {
    live_coverage: {
      goal: 'Increase real global live coverage without admitting noisy/fake rows.',
      files:['backend/sources/*','backend/normalizer.js','backend/agent/source-candidates.json'],
      checks:['/live?force=true visible count', 'providerReport parsed/visible ratios', 'rejectedSamples quality']
    },
    source_discovery: {
      goal: 'Find and rank new public source candidates, then prepare adapter specs for healthy candidates.',
      files:['backend/agent/source-candidates.json','backend/agent/agents.js'],
      checks:['latest-source-discovery.json', 'adapterCandidates count', 'blocked_do_not_use count']
    },
    stats_coverage: {
      goal: 'Improve shots/corners/possession extraction and stats-backed signal eligibility.',
      files:['backend/sources/source_espn_json.js','backend/normalizer.js','backend/signal-engine.js'],
      checks:['statsCoverage', 'dataReliabilityScore distribution', 'signalEligible/live ratio']
    },
    odds_coverage: {
      goal: 'Improve real odds availability and prevent synthetic/cache odds from entering value decisions.',
      files:['frontend/core.js','frontend/analysis.js','backend/server.js'],
      checks:['oddsMatchedCount', 'hasRealOdds count', 'no synthetic odds in ROI']
    },
    value_predictions: {
      goal: 'Reduce low-value signals and require stronger quality + value evidence before surfacing predictions.',
      files:['frontend/analysis.js','backend/signal-engine.js'],
      checks:['actionable count', 'watch vs action ratio', 'false positive patterns']
    },
    history_screen: {
      goal: 'Protect prediction history, improve repair/export/import, and make review reasons actionable.',
      files:['frontend/analysis.js','frontend/app.js','frontend/index.html'],
      checks:['canlibet_v7_history_backup exists', 'open review count', 'export/import works']
    },
    settlement: {
      goal: 'Resolve historical predictions from final-score sources and reduce needs_review/stale records.',
      files:['backend/server.js','frontend/analysis.js'],
      checks:['/final-score hit rate', 'needs_review count', 'settled/open ratio']
    },
    learning_system: {
      goal: 'Use settled outcomes to find reliable weak/strong patterns with sample-size guards.',
      files:['backend/agent/agents.js','frontend/app.js'],
      checks:['latest-learning.json weakPatterns/strongPatterns', 'minimum samples respected']
    },
    machine_learning: {
      goal: 'Move from rules/calibration table toward trainable models with benchmarked promotion gates.',
      files:['backend/agent/agents.js'],
      checks:['candidate-model.json samples', 'latest-benchmark.json recommendation']
    },
    model_trainer: {
      goal: 'Improve model feature extraction, bucket calibration, and model metadata quality.',
      files:['backend/agent/agents.js'],
      checks:['model-runs.jsonl', 'bucket reliability', 'candidateSamples']
    },
    benchmark_promotion: {
      goal: 'Make old-vs-new comparison stricter with Brier/log-loss/lift and rollback evidence.',
      files:['backend/agent/agents.js'],
      checks:['latest-benchmark.json reasons', 'rollback-model.json exists before promotion']
    },
    continuous_runtime: {
      goal: 'Keep free Render mode resilient, visible, and recoverable after sleep/redeploy.',
      files:['backend/agent/embedded-supervisor.js','backend/server.js'],
      checks:['agent-supervisor-state.json lastRuns freshness', 'errors empty']
    },
    persistent_storage: {
      goal: 'Add durable storage plan/adapter so signals, outcomes, and source health survive redeploys.',
      files:['backend/agent/store.js','backend/agent/agents.js'],
      checks:['storage backend selected', 'jsonl fallback works', 'no data loss on restart']
    },
    production_maturity: {
      goal: 'Add smoke checks, deployment checklists, and safer rollout artifacts.',
      files:['backend/agent/README.md','backend/package.json'],
      checks:['manual deploy checklist', 'syntax/smoke command documented']
    }
  };
  const tpl = templates[feature.id] || { goal:'Improve weak feature safely.', files:[], checks:[] };
  return {
    id: `${feature.id}_${Date.now()}`,
    featureId: feature.id,
    featureLabel: feature.label,
    assignedAgent: feature.owner,
    goal: tpl.goal,
    solution: solutionReportFor(feature.id, signals),
    allowedFiles: tpl.files,
    validationChecks: tpl.checks,
    baseScore: feature.score,
    effectiveScore: feature.effectiveScore,
    priority: feature.priority,
    status: 'assigned',
    authority: {
      canEditCode: config.improvementAuthority.autoApplyCode,
      canApplySafeConfig: config.improvementAuthority.autoApplySafeConfig,
      requiresReviewForCode: !config.improvementAuthority.autoApplyCode
    },
    runtimeSignals: signals,
    createdAt: new Date().toISOString()
  };
}

function improvementOrchestratorAgent() {
  const authority = config.improvementAuthority || {};
  const signals = featureRuntimeSignals();
  const scorecard = (config.featureScorecard || []).map(feature => {
    const penalty = runtimePenalty(feature.id, signals);
    const effectiveScore = Math.max(0, Number((n(feature.score, 0) - penalty).toFixed(2)));
    return Object.assign({}, feature, {
      runtimePenalty: penalty,
      effectiveScore,
      priority: Number((10 - effectiveScore).toFixed(2))
    });
  });
  const weak = scorecard
    .filter(f => f.effectiveScore <= n(authority.maxScore, 6))
    .sort((a, b) => b.priority - a.priority);
  const tasks = weak.map(f => improvementTaskFor(f, signals));
  const subAgents = {};
  for (const task of tasks) {
    subAgents[task.assignedAgent] = subAgents[task.assignedAgent] || {
      name: task.assignedAgent,
      status: 'assigned',
      tasks: []
    };
    subAgents[task.assignedAgent].tasks.push(task.id);
  }
  const report = {
    agent: 'improvement-orchestrator-agent',
    enabled: authority.enabled !== false,
    mode: config.mode,
    maxScore: n(authority.maxScore, 6),
    runtimeSignals: signals,
    weakFeatureCount: weak.length,
    weakFeatures: weak,
    subAgents: Object.values(subAgents),
    tasks,
    policy: {
      autoApplySafeConfig: !!authority.autoApplySafeConfig,
      autoApplyCode: !!authority.autoApplyCode,
      codeChangesRequireReview: !authority.autoApplyCode
    }
  };

  store.writeJson('latest-improvement-plan.json', report);
  store.writeJson('improvement-task-board.json', {
    updatedAt: new Date().toISOString(),
    openTasks: tasks,
    subAgents: report.subAgents
  });
  store.appendJsonl('improvement-runs.jsonl', report);
  return report;
}

module.exports = {
  sourceDiscoveryAgent,
  sourceAutoBindAgent,
  sourceHealthAgent,
  signalCaptureAgent,
  learningAgent,
  strategyMutatorAgent,
  modelTrainerAgent,
  modelBenchmarkAgent,
  promotionGuardianAgent,
  improvementOrchestratorAgent
};
