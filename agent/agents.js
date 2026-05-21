'use strict';

const config = require('./config');
const store = require('./store');
const { fetchJson } = require('./http');

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
  sourceHealthAgent,
  signalCaptureAgent,
  learningAgent,
  strategyMutatorAgent,
  modelTrainerAgent,
  modelBenchmarkAgent,
  promotionGuardianAgent
};
