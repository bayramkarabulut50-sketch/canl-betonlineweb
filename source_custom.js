/**
 * source_custom.js — CanliBet Scraper Service
 * Custom adapter template. Copy and rename for each new source.
 *
 * To add a new source:
 * 1. Copy this file to source_YourSource.js
 * 2. Set SOURCE_URL and ENABLED=true
 * 3. Implement parsePage() using Playwright selectors
 * 4. Register in server.js ADAPTERS array
 */

'use strict';

const { normalizeMatches } = require('../normalizer');

const ENABLED   = false;
const SOURCE_URL = 'https://example.com/live';

async function fetch(browser, options = {}) {
  const fetchedAt = Date.now();
  if (!ENABLED) {
    return { provider:'custom', success:false, matches:[], error:'adapter_disabled', fetchedAt };
  }

  let page;
  try {
    page = await browser.newPage();
    await page.goto(SOURCE_URL, { waitUntil:'networkidle', timeout:20000 });

    // ── Implement selector logic here ──────────────────────────────────
    // Example:
    // const matches = await page.evaluate(() => {
    //   return Array.from(document.querySelectorAll('.match-row')).map(row => ({
    //     home: row.querySelector('.home')?.textContent?.trim(),
    //     away: row.querySelector('.away')?.textContent?.trim(),
    //     hg:   parseInt(row.querySelector('.score-home')?.textContent || '0'),
    //     ag:   parseInt(row.querySelector('.score-away')?.textContent || '0'),
    //     minute: parseInt(row.querySelector('.minute')?.textContent || '0'),
    //     status: 'live',
    //   }));
    // });
    // ──────────────────────────────────────────────────────────────────

    const matches = []; // replace with selector output

    return {
      provider:  'custom',
      success:   matches.length > 0,
      matches:   normalizeMatches(matches, 'custom'),
      error:     matches.length === 0 ? 'no_matches_found' : null,
      fetchedAt,
    };
  } catch (err) {
    return { provider:'custom', success:false, matches:[], error:err.message, fetchedAt };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

module.exports = { fetch, provider: 'custom', enabled: ENABLED };
