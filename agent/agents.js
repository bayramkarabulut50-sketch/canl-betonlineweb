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

module.exports = {
  sourceDiscoveryAgent,
  sourceAutoBindAgent,
  sourceHealthAgent,
  signalCaptureAgent,
  learningAgent,
  strategyMutatorAgent,
  modelTrainerAgent,
  modelBenchmarkAgent,
  promotionGuardianAgent
};
