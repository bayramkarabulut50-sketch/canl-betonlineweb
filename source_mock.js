/**
 * source_sofascore.js — CanliBet Scraper Service
 * SofaScore public JSON API adapter (no scraping, uses their public endpoint).
 *
 * SofaScore provides a public API at api.sofascore.com for their own apps.
 * We read only publicly available data at low frequency (≤ 1 req/60s).
 * robots.txt: /api/ is not disallowed for well-behaved bots at this rate.
 *
 * Contract: async (browser, options) → { provider, success, matches, error, fetchedAt }
 *
 * NOTE: Selectors and endpoints may change. Monitor and update as needed.
 * If SofaScore blocks this endpoint, set enabled=false in config.
 */

'use strict';

const { normalizeMatches, safeNum, safeStr } = require('../normalizer');

const SOFASCORE_LIVE_URL = 'https://api.sofascore.com/api/v1/sport/football/events/live';
const REQUEST_HEADERS = {
  'User-Agent':  'Mozilla/5.0 (compatible; CanliBetBot/1.0; +https://canlibet.pro/bot)',
  'Accept':      'application/json',
  'Referer':     'https://www.sofascore.com/',
};

function normSofaScoreMatch(ev) {
  if (!ev) return null;
  const ht = ev.homeTeam || ev.home || {};
  const at = ev.awayTeam || ev.away || {};
  const score = ev.homeScore || {};
  const aScore = ev.awayScore || {};
  const status = (ev.status && (ev.status.description || ev.status.code)) || '';
  const minute = safeNum(ev.time && ev.time.played);
  const leagueId = ev.tournament && (ev.tournament.name || '');

  return {
    match_id:             String(ev.id || ''),
    match_hometeam_name:  safeStr(ht.name || ht.shortName),
    match_awayteam_name:  safeStr(at.name || at.shortName),
    match_hometeam_score: safeNum(score.current ?? score.display, 0),
    match_awayteam_score: safeNum(aScore.current ?? aScore.display, 0),
    match_live:           '1',
    match_status:         status,
    minute,
    league_name:          leagueId,
    // SofaScore live endpoint doesn't include odds — separate request needed
    odds: {},
    stats: {},
    source: 'sofascore',
  };
}

async function fetch(browser, options = {}) {
  const fetchedAt = Date.now();
  let page;
  try {
    page = await browser.newPage();
    await page.setExtraHTTPHeaders(REQUEST_HEADERS);

    const response = await page.goto(SOFASCORE_LIVE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });

    if (!response || response.status() !== 200) {
      const status = response ? response.status() : 0;
      throw new Error(`HTTP ${status} from SofaScore live endpoint`);
    }

    const body = await response.text();
    const data = JSON.parse(body);
    const events = data.events || data.data || [];

    if (!Array.isArray(events)) throw new Error('Unexpected response shape');

    const raw = events
      .filter(ev => ev && ev.id)
      .map(normSofaScoreMatch)
      .filter(Boolean);

    return {
      provider:  'sofascore',
      success:   raw.length > 0,
      matches:   normalizeMatches(raw, 'sofascore'),
      error:     raw.length === 0 ? 'no_live_matches' : null,
      fetchedAt,
    };
  } catch (err) {
    return { provider:'sofascore', success:false, matches:[], error:err.message, fetchedAt };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

module.exports = { fetch, provider: 'sofascore' };
