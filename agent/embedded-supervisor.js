'use strict';

const config = require('./config');
const store = require('./store');
const agents = require('./agents');

let started = false;

const state = {
  embedded: true,
  startedAt: null,
  lastRuns: {},
  errors: {}
};

function log(msg, data) {
  const suffix = data ? ' ' + JSON.stringify(data) : '';
  console.log(`[embedded-agent] ${new Date().toISOString()} ${msg}${suffix}`);
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

async function runNamed(name, fn) {
  const startedAt = Date.now();
  try {
    const result = await fn();
    state.lastRuns[name] = {
      at: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
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

async function runFastLoop() {
  await runNamed('source-health-agent', agents.sourceHealthAgent);
  await runNamed('signal-capture-agent', agents.signalCaptureAgent);
}

async function runDiscoveryLoop() {
  await runNamed('source-discovery-agent', agents.sourceDiscoveryAgent);
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

function startEmbeddedAgent() {
  if (started) return state;
  started = true;
  state.startedAt = new Date().toISOString();
  store.ensureDir();
  store.writeJson('agent-supervisor-state.json', state);
  log('started', {
    mode: config.mode,
    backendBaseUrl: config.backendBaseUrl,
    loopMs: config.loopMs
  });

  setTimeout(runFastLoop, 5000);
  setTimeout(runDiscoveryLoop, 10000);
  setTimeout(runLearningLoop, 15000);
  setTimeout(runModelLoop, 30000);
  setTimeout(runPromotionLoop, 45000);

  setInterval(runFastLoop, config.loopMs);
  setInterval(runDiscoveryLoop, config.sourceHealthMs);
  setInterval(runLearningLoop, config.learningMs);
  setInterval(runModelLoop, config.modelTrainingMs);
  setInterval(runPromotionLoop, config.promotionMs);
  return state;
}

module.exports = { startEmbeddedAgent };
