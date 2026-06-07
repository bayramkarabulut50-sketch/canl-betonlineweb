'use strict';

const config = require('./config');
const store = require('./store');
const agents = require('./agents');

const state = {
  startedAt: new Date().toISOString(),
  lastRuns: {},
  errors: {}
};

function log(msg, data) {
  const suffix = data ? ' ' + JSON.stringify(data) : '';
  console.log(`[agent-supervisor] ${new Date().toISOString()} ${msg}${suffix}`);
}

async function runNamed(name, fn) {
  const started = Date.now();
  try {
    const result = await fn();
    state.lastRuns[name] = {
      at: new Date().toISOString(),
      durationMs: Date.now() - started,
      ok: true,
      summary: summarize(result)
    };
    delete state.errors[name];
    store.writeJson('agent-supervisor-state.json', state);
    log(`${name} ok`, state.lastRuns[name].summary);
  } catch (err) {
    state.errors[name] = {
      at: new Date().toISOString(),
      message: err.message,
      stack: String(err.stack || '').split('\n').slice(0, 5)
    };
    store.writeJson('agent-supervisor-state.json', state);
    log(`${name} error`, { message: err.message });
  }
}

function summarize(result) {
  if (!result || typeof result !== 'object') return result;
  const out = {};
  for (const key of [
    'ok', 'liveCount', 'signalEligible', 'captured', 'liveMatches',
    'sampleSize', 'settledSignals', 'samples', 'recommendation',
    'decision', 'candidateVersion', 'modelVersion'
  ]) {
    if (result[key] !== undefined) out[key] = result[key];
  }
  return out;
}

async function runFastLoop() {
  await runNamed('source-health-agent', agents.sourceHealthAgent);
  await runNamed('signal-capture-agent', agents.signalCaptureAgent);
}

async function runDiscoveryLoop() {
  await runNamed('source-discovery-agent', agents.sourceDiscoveryAgent);
  await runNamed('source-auto-bind-agent', agents.sourceAutoBindAgent);
}

async function runLearningLoop() {
  await runNamed('learning-agent', agents.learningAgent);
  await runNamed('strategy-mutator-agent', agents.strategyMutatorAgent);
}

async function runModelLoop() {
  await runNamed('model-trainer-agent', agents.modelTrainerAgent);
  await runNamed('model-benchmark-agent', agents.modelBenchmarkAgent);
}

async function runPromotionLoop() {
  await runNamed('promotion-guardian-agent', agents.promotionGuardianAgent);
}

async function runImprovementLoop() {
  await runNamed('improvement-orchestrator-agent', agents.improvementOrchestratorAgent);
  await runNamed('storage-guard-agent', agents.storageGuardAgent);
  await runNamed('performance-analytics-agent', agents.performanceAnalyticsAgent);
  await runNamed('adapter-blueprint-agent', agents.adapterBlueprintAgent);
  await runNamed('threshold-tuning-agent', agents.thresholdTuningAgent);
  await runNamed('alert-agent', agents.alertAgent);
  await runNamed('daily-report-agent', agents.dailyReportAgent);
  await runNamed('capability-scorecard-agent', agents.capabilityScorecardAgent);
}

async function main() {
  store.ensureDir();
  store.writeJson('agent-supervisor-state.json', state);
  log('started', {
    mode: config.mode,
    backendBaseUrl: config.backendBaseUrl,
    loopMs: config.loopMs
  });

  await runFastLoop();
  await runDiscoveryLoop();
  await runLearningLoop();
  await runModelLoop();
  await runPromotionLoop();
  await runImprovementLoop();

  setInterval(runFastLoop, config.loopMs);
  setInterval(runDiscoveryLoop, config.sourceHealthMs);
  setInterval(runLearningLoop, config.learningMs);
  setInterval(runModelLoop, config.modelTrainingMs);
  setInterval(runPromotionLoop, config.promotionMs);
  setInterval(runImprovementLoop, config.improvementMs);
}

main().catch(err => {
  log('fatal', { message: err.message });
  process.exitCode = 1;
});
