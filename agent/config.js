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
  }
};
