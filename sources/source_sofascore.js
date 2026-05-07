/**
 * source_sofascore.js v10.81 — Playwright adapter.
 * Calls global._scraperLazyGetBrowser() — only launches Chromium when this adapter runs.
 * ONLY loaded by server.js when ENABLE_SOFASCORE_SOURCE=true.
 */
'use strict';

const { normalizeMatches, safeNum, safeStr } = require('../normalizer');

const LIVE_URL = 'https://api.sofascore.com/api/v1/sport/football/events/live';
const HEADERS  = {
  'User-Agent': 'Mozilla/5.0 (compatible; CanliBetBot/1.0)',
  'Accept':     'application/json',
  'Referer':    'https://www.sofascore.com/',
};

function normEvent(ev) {
  if (!ev) return null;
  const ht = ev.homeTeam || {};
  const at = ev.awayTeam || {};
  const hScore = ev.homeScore || {};
  const aScore = ev.awayScore || {};
  const status = (ev.status && (ev.status.description || ev.status.code)) || '';
  return {
    match_id:             String(ev.id || ''),
    match_hometeam_name:  safeStr(ht.name || ht.shortName),
    match_awayteam_name:  safeStr(at.name || at.shortName),
    match_hometeam_score: safeNum(hScore.current ?? hScore.display, 0),
    match_awayteam_score: safeNum(aScore.current ?? aScore.display, 0),
    match_live:           '1',
    match_status:         status,
    minute:               safeNum(ev.time && ev.time.played),
    league_name:          (ev.tournament && ev.tournament.name) || '',
    odds: {}, stats: {}, source: 'sofascore',
  };
}

async function fetch(_browser, _options) {
  // _browser arg is ignored — we get our own via lazy init
  const fetchedAt = Date.now();
  let page;
  try {
    const browser = await global._scraperLazyGetBrowser();
    page = await browser.newPage();
    await page.setExtraHTTPHeaders(HEADERS);
    const response = await page.goto(LIVE_URL, { waitUntil:'domcontentloaded', timeout:15000 });
    if (!response || response.status() !== 200) throw new Error(`HTTP ${response?.status()||0}`);
    const data   = JSON.parse(await response.text());
    const events = data.events || data.data || [];
    if (!Array.isArray(events)) throw new Error('Unexpected response shape');
    const raw  = events.filter(ev=>ev&&ev.id).map(normEvent).filter(Boolean);
    return { provider:'sofascore', success:raw.length>0, matches:normalizeMatches(raw,'sofascore'), error:raw.length===0?'no_live_matches':null, fetchedAt };
  } catch(err) {
    return { provider:'sofascore', success:false, matches:[], error:err.message, fetchedAt };
  } finally {
    if (page) await page.close().catch(()=>{});
  }
}

module.exports = { fetch, provider:'sofascore', needsPlaywright:true };
