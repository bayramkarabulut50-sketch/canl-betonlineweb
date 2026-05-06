/**
 * source_oddsportal.js — CanliBet Scraper Service
 * OddsPortal adapter — PLACEHOLDER.
 *
 * OddsPortal is useful for pre-match and live odds aggregation.
 * Implement using Playwright page.goto + page.evaluate when ready.
 *
 * Rate limit: max 1 request per 90 seconds to be respectful.
 * Do NOT bypass any bot protection mechanisms.
 */

'use strict';

const ENABLED = false;

async function fetch(browser, options = {}) {
  const fetchedAt = Date.now();
  if (!ENABLED) {
    return {
      provider:  'oddsportal',
      success:   false,
      matches:   [],
      error:     'adapter_disabled',
      fetchedAt,
    };
  }

  // TODO: Implement odds scraping here.
  // Output should include: match_id, home, away, odds.home, odds.draw, odds.away, odds.over_25
  return { provider:'oddsportal', success:false, matches:[], error:'not_implemented', fetchedAt };
}

module.exports = { fetch, provider: 'oddsportal', enabled: ENABLED };
