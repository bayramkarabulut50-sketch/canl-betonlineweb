'use strict';

const path = require('path');

const DATA_DIR = process.env.CANLIBET_AGENT_DATA_DIR ||
  path.join(__dirname, 'data');

module.exports = {
  backendBaseUrl: process.env.CANLIBET_BACKEND_URL || 'http://localhost:3847',
  dataDir: DATA_DIR,
  mode: process.env.CANLIBET_AGENT_MODE || 'active',
  loopMs: Number(process.env.CANLIBET_AGENT_LOOP_MS || 60000),
  sourceHealthMs: Number(process.env.CANLIBET_SOURCE_HEALTH_MS || 300000),
  learningMs: Number(process.env.CANLIBET_LEARNING_MS || 900000),
  modelTrainingMs: Number(process.env.CANLIBET_MODEL_TRAINING_MS || 3600000),
  improvementMs: Number(process.env.CANLIBET_IMPROVEMENT_MS || 1800000),
  promotionMs: Number(process.env.CANLIBET_PROMOTION_MS || 1800000),
  thresholds: {
    minValidationScore: 55,
    minReliabilityScore: 55,
    maxFakeRiskScore: 45,
    minSignalConfidence: 68,
    strongSignalConfidence: 78,
    sourceDisableFailureRate: 0.65,
    minPromotionSamples: 200,
    minBenchmarkLiftPct: 4,
    minBrierImprovement: 0.01
  },
  promotion: {
    autoPromote: String(process.env.CANLIBET_AUTO_PROMOTE || 'false').toLowerCase() === 'true',
    requireRollbackPoint: true
  },
  improvementAuthority: {
    enabled: String(process.env.CANLIBET_IMPROVEMENT_AGENT || 'true').toLowerCase() !== 'false',
    maxScore: Number(process.env.CANLIBET_IMPROVEMENT_MAX_SCORE || 6),
    autoApplySafeConfig: String(process.env.CANLIBET_IMPROVEMENT_AUTO_APPLY_SAFE_CONFIG || 'true').toLowerCase() !== 'false',
    autoApplyCode: String(process.env.CANLIBET_IMPROVEMENT_AUTO_APPLY_CODE || 'false').toLowerCase() === 'true'
  },
  featureScorecard: [
    { id:'live_coverage', label:'Canli mac cekme', score:5, owner:'source-expansion-subagent' },
    { id:'source_discovery', label:'Yeni kaynak kesif ajani', score:5, owner:'source-discovery-subagent' },
    { id:'stats_coverage', label:'Istatistik bulunabilirligi', score:4, owner:'stats-adapter-subagent' },
    { id:'odds_coverage', label:'Odds / oran sistemi', score:3.5, owner:'odds-adapter-subagent' },
    { id:'value_predictions', label:'Degerli tahmin uretimi', score:5, owner:'value-filter-subagent' },
    { id:'history_screen', label:'Gecmis tahmin ekrani', score:6, owner:'history-settlement-subagent' },
    { id:'settlement', label:'Otomatik sonuc kontrolu', score:5.5, owner:'settlement-subagent' },
    { id:'learning_system', label:'Ogrenme sistemi', score:5.5, owner:'learning-subagent' },
    { id:'machine_learning', label:'Makine ogrenmesi', score:3.5, owner:'modeling-subagent' },
    { id:'model_trainer', label:'Model trainer agent', score:4, owner:'modeling-subagent' },
    { id:'benchmark_promotion', label:'Benchmark / promotion sistemi', score:4.5, owner:'benchmark-subagent' },
    { id:'continuous_runtime', label:'Surekli calisma', score:5, owner:'runtime-subagent' },
    { id:'persistent_storage', label:'Kalici veri saklama', score:3, owner:'storage-subagent' },
    { id:'production_maturity', label:'Uretim olgunlugu', score:5.5, owner:'qa-subagent' }
  ]
};
