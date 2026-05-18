# CanliBet Scraper Service v10.93 — Stats Source Audit

HTTP-only backend for CanliBet Pro.

## Safety line

This build does **not** do HTML DOM scraping, browser automation, CAPTCHA bypass, fingerprint spoofing, proxy rotation, or paid/free API-key integrations. It only probes public JSON endpoints and gracefully fails when a source blocks or returns non-JSON.

## Current architecture

- ESPN public JSON remains the primary live backbone for live matches, scores, minutes, status and partial odds.
- `/stats-audit` probes secondary public JSON sources only for match-level statistics discovery.
- Mock remains last fallback and must not be treated as real betting data.

## Endpoints

```text
GET /health
GET /live
GET /audit
GET /stats-audit
GET /odds
GET /snapshot
```

## New in v10.93

`GET /stats-audit` returns:

```json
{
  "success": true,
  "testedAt": "...",
  "sources": [
    {
      "provider": "fotmob_stats",
      "endpoint": "...",
      "status": 200,
      "contentType": "application/json",
      "responseLength": 12345,
      "jsonParseOk": true,
      "topLevelKeys": [],
      "hasMatchStats": true,
      "foundStatKeys": ["shots_on_target", "corners"],
      "sampleStats": [],
      "failReason": "OK_STATS_KEYS_FOUND"
    }
  ],
  "bestCandidates": []
}
```

## Recommended Render env

```text
PORT=10000
CACHE_TTL_MS=30000
ENABLE_MOCK_SOURCE=true
ENABLE_SOFASCORE_SOURCE=false
ENABLE_ESPN_JSON_SOURCE=true
ENABLE_FOTMOB_JSON_SOURCE=true
ENABLE_AISCORE_JSON_SOURCE=true
```

## Render commands

```text
Build Command: npm install
Start Command: node server.js
```

