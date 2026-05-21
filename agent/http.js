'use strict';

async function fetchJson(url, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_) {}
    return {
      ok: res.ok,
      status: res.status,
      durationMs: Date.now() - startedAt,
      data,
      textPreview: text.slice(0, 300)
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      durationMs: Date.now() - startedAt,
      error: err.name === 'AbortError' ? 'timeout' : err.message
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchJson };
