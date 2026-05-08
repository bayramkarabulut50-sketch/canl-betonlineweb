/**
 * http-client.js — CanliBet Scraper Service v10.86
 *
 * Centralized HTTP client with production-grade hygiene:
 * - Stable Chrome User-Agent (not rotating, not spoofing)
 * - Standard browser Accept / Accept-Language / Referer headers
 * - gzip/br decompression support via Accept-Encoding
 * - keep-alive connections
 * - Request pacing (min gap between calls to same host)
 * - Retry: 429/503 → exponential backoff; 403 → single retry only
 * - Full request/response logging
 *
 * NOT included: stealth plugins, fingerprint spoofing, CAPTCHA solving,
 * proxy rotation, JS execution, cookie forgery.
 */
'use strict';

// Stable UA — recent Chrome on Windows, not rotated
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

const DEFAULT_HEADERS = {
  'User-Agent':      DEFAULT_UA,
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection':      'keep-alive',
  'Cache-Control':   'no-cache',
  'Pragma':          'no-cache',
};

// Per-host last-request timestamp for pacing
const _lastRequestAt = {};

/**
 * createHttpClient(options) → { get(url, extraHeaders) }
 *
 * options:
 *   referer       string  — Referer header value
 *   origin        string  — Origin header value
 *   minPaceMs     number  — minimum ms between requests to same host (default 1200)
 *   timeoutMs     number  — per-request timeout (default 8000)
 *   maxRetries    number  — max retry count (default 1)
 */
function createHttpClient(options = {}) {
  const {
    referer   = '',
    origin    = '',
    minPaceMs = 1200,
    timeoutMs = 8000,
    maxRetries = 1,
  } = options;

  const baseHeaders = Object.assign({}, DEFAULT_HEADERS);
  if (referer) baseHeaders['Referer'] = referer;
  if (origin)  baseHeaders['Origin']  = origin;

  async function get(url, extraHeaders = {}) {
    // ── Pacing ──────────────────────────────────────────────────────────────
    let host;
    try { host = new URL(url).hostname; } catch (e) { host = url; }
    const now   = Date.now();
    const last  = _lastRequestAt[host] || 0;
    const wait  = minPaceMs - (now - last);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));

    const headers = Object.assign({}, baseHeaders, extraHeaders);
    let attempt = 0;
    let lastResult = null;

    while (attempt <= maxRetries) {
      const t0         = Date.now();
      const controller = new AbortController();
      const timer      = setTimeout(() => controller.abort(), timeoutMs);

      try {
        _lastRequestAt[host] = Date.now();
        const resp = await globalThis.fetch(url, {
          method:  'GET',
          headers,
          signal:  controller.signal,
        });
        clearTimeout(timer);

        const durationMs    = Date.now() - t0;
        const contentType   = resp.headers.get('content-type') || '';
        const retryAfterHdr = resp.headers.get('retry-after');
        const text          = await resp.text();

        console.log(`[http-client] ${resp.status} ${url.split('?')[0]} (${durationMs}ms attempt=${attempt} ct=${contentType.slice(0,30)})`);

        // ── Success ─────────────────────────────────────────────────────────
        if (resp.ok) {
          return { ok:true, status:resp.status, contentType, text, durationMs, attempts:attempt+1 };
        }

        lastResult = { ok:false, status:resp.status, contentType, text, durationMs, attempts:attempt+1 };

        // ── Retry logic ─────────────────────────────────────────────────────
        if (resp.status === 429 || resp.status === 503) {
          // Rate-limited or overloaded — exponential backoff
          const backoff = retryAfterHdr
            ? parseInt(retryAfterHdr, 10) * 1000
            : Math.min(2000 * Math.pow(2, attempt), 16000);
          console.log(`[http-client] ${resp.status} — backoff ${backoff}ms (attempt=${attempt})`);
          if (attempt < maxRetries) {
            await new Promise(r => setTimeout(r, backoff));
            attempt++;
            continue;
          }
        } else if (resp.status === 403) {
          // 403 — single cautious retry after short pause; no aggressive retry
          if (attempt === 0) {
            console.log(`[http-client] 403 — single retry after 2s. body preview=${text.slice(0,200)}`);
            await new Promise(r => setTimeout(r, 2000));
            attempt++;
            continue;
          }
          console.log(`[http-client] 403 persists after retry — graceful fail`);
        } else {
          // 404, 410, 451, 5xx etc. — no retry
          console.log(`[http-client] ${resp.status} — no retry`);
        }

        return lastResult;

      } catch (err) {
        clearTimeout(timer);
        const durationMs = Date.now() - t0;
        const isTimeout  = err.name === 'AbortError';
        console.log(`[http-client] ${isTimeout ? 'timeout' : 'error'}: ${err.message} (attempt=${attempt} ${durationMs}ms)`);
        lastResult = { ok:false, status:null, error: isTimeout ? 'timeout' : err.message, durationMs, attempts:attempt+1 };
        // Don't retry timeouts — they indicate server unresponsiveness
        break;
      }
    }

    return lastResult || { ok:false, status:null, error:'unknown', attempts:attempt };
  }

  return { get };
}

module.exports = { createHttpClient, DEFAULT_UA, DEFAULT_HEADERS };
