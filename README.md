# CanliBet Scraper Service v10.81

## Key fix in v10.81
- Playwright is **never launched globally**.
- Chromium only starts when a Playwright adapter is actually enabled.
- `ENABLE_MOCK_SOURCE=true + ENABLE_SOFASCORE_SOURCE=false` → **no Chromium, no error**.
- Playwright is an **optional** dependency.

## Render Free Tier Deploy

```
Build Command:  npm install
Start Command:  node server.js
```

**Environment Variables:**
| Variable | Value | Effect |
|----------|-------|--------|
| `PORT` | `10000` | Render default |
| `ENABLE_MOCK_SOURCE` | `true` | Mock data (no Chromium) |
| `ENABLE_SOFASCORE_SOURCE` | `false` | SofaScore disabled |
| `CACHE_TTL_MS` | `30000` | 30s cache |
| `LOG_REQUESTS` | `true` | Request logging |

Expected startup log:
```
[...] Adapter: mock (HTTP-only)
[...] Chromium disabled / skipped — no Playwright adapter active
[...] CanliBet scraper service v10.81 — adapters: mock
[...] CanliBet scraper service listening on :10000
[...] Initial fetch complete
```

## To Enable SofaScore (requires Playwright)

Change build command to:
```
npm install && npx playwright install chromium
```
Set env: `ENABLE_SOFASCORE_SOURCE=true`

## GET /health
```json
{
  "status": "ok",
  "version": "10.81",
  "uptime": 12,
  "cacheValid": true,
  "cacheAge": "8s",
  "adapters": [{ "provider": "mock", "needsPlaywright": false }],
  "env": {
    "PORT": 10000,
    "CACHE_TTL_MS": 30000,
    "ENABLE_MOCK_SOURCE": true,
    "ENABLE_SOFASCORE_SOURCE": false,
    "playwrightActive": false
  }
}
```

## GET /live
```json
{
  "success": true,
  "provider": "scraper",
  "matches": [{
    "match_id": "mock_001",
    "match_hometeam_name": "Fenerbahçe",
    "match_awayteam_name": "Beşiktaş",
    "match_hometeam_score": 1,
    "match_awayteam_score": 0,
    "match_live": "1",
    "match_status": "2H",
    "minute": 67,
    "league_name": "Süper Lig",
    "source": "mock",
    "hasOdds": true,
    "hasStats": true,
    "stats": { "attacks": 52, "dangerous_attacks": 18 },
    "odds": { "home": 1.75, "draw": 3.40, "away": 4.50 }
  }],
  "debug": {
    "selectedProvider": "scraper",
    "sourcesTried": ["mock"],
    "liveMatches": 3,
    "cacheHit": false
  }
}
```

## CanliBet Frontend Activation
```js
// core.js
C.scraperBaseUrl     = 'https://your-service.onrender.com';
C.liveScraperEnabled = true;
```
