'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');

function ensureDir(dir = config.dataDir) {
  fs.mkdirSync(dir, { recursive: true });
}

function file(name) {
  ensureDir();
  return path.join(config.dataDir, name);
}

function appendJsonl(name, record) {
  const row = JSON.stringify(Object.assign({ at: new Date().toISOString() }, record));
  fs.appendFileSync(file(name), row + '\n');
}

function readJson(name, fallback) {
  try {
    const p = file(name);
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(name, value) {
  fs.writeFileSync(file(name), JSON.stringify(value, null, 2));
}

function readJsonl(name, limit = 5000) {
  try {
    const p = file(name);
    if (!fs.existsSync(p)) return [];
    const lines = fs.readFileSync(p, 'utf8').trim().split(/\r?\n/).filter(Boolean);
    return lines.slice(-limit).map(line => JSON.parse(line));
  } catch (_) {
    return [];
  }
}

module.exports = { appendJsonl, readJson, writeJson, readJsonl, file, ensureDir };
