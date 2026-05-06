/**
 * source_flashscore.js — CanliBet Scraper Service
 * FlashScore adapter — PLACEHOLDER.
 *
 * FlashScore uses WebSocket + heavy obfuscation. Direct HTTP fetch is not
 * reliable. Implement via Playwright page interaction if needed.
 *
 * Current status: returns empty success (no-op) so the pipeline continues.
 * Set enabled=true and implement selector logic when ready.
 */

'use strict';

const ENABLED = false;

async function fetch(browser, options = {}) {
  const fetchedAt = Date.now();
  if (!ENABLED) {
    return {
      provider:  'flashscore',
      success:   false,
      matches:   [],
      error:     'adapter_disabled',
      fetchedAt,
    };
  }

  // TODO: Implement Playwright-based page scraping here.
  // Rate limit: max 1 request per 60 seconds.
  // Do NOT bypass CAPTCHA or fingerprint protection.
  return { provider:'flashscore', success:false, matches:[], error:'not_implemented', fetchedAt };
}

module.exports = { fetch, provider: 'flashscore', enabled: ENABLED };
