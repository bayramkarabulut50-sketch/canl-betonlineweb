# CanliBet Scraper Service v10.80

Node.js + Playwright live data backend for CanliBet.

> **Cloudflare Pages** → deploy `canlibet-v10_80-frontend.zip`  
> **Scraper Service** → deploy `canlibet-v10_80-scraper-service.zip` on Render/Railway/Fly.io/VPS

## Architecture
```
CanliBet Frontend (Cloudflare Pages)
    │  GET /live (JSON)
    ▼
Scraper Service (Render / Railway / Fly.io / VPS)
    ├── source_mock.js      (dev/fallback)
    ├── source_sofascore.js (public JSON API)
    └── source_custom.js    (add your own)
```

## Quick Start (local)
```bash
npm install && npx playwright install chromium && npm start
# → http://localhost:3847
```

## Deploy on Render (recommended)
1. Push `scraper-service/` to GitHub
2. Render → New Web Service → Connect repo
3. **Build:** `npm install && npx playwright install chromium`
4. **Start:** `npm start`
5. Set env vars (see below)
6. Copy URL → set in CanliBet `core.js`

## Deploy on Railway
```bash
npm install -g @railway/cli && railway login && railway init && railway up
```

## Deploy on Fly.io
```bash
fly launch --name canlibet-scraper && fly secrets set PORT=3847 && fly deploy
```

## Deploy on VPS (Ubuntu)
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npx playwright install-deps chromium
npm install && npx playwright install chromium
npm install -g pm2 && pm2 start server.js --name canlibet-scraper && pm2 save
```

## Environment Variables
| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3847` | HTTP port |
| `CACHE_TTL_MS` | `30000` | Cache TTL ms (30s) |
| `LOG_REQUESTS` | `true` | Request logging |
| `ENABLE_MOCK_SOURCE` | `true` | Mock adapter |
| `ENABLE_SOFASCORE_SOURCE` | `true` | SofaScore adapter |

## GET /health — Response
```json
{
  "status": "ok",
  "version": "10.80",
  "uptime": 142,
  "cacheValid": true,
  "cacheAge": "18s",
  "adapters": [
    { "provider": "mock", "enabled": true },
    { "provider": "sofascore", "enabled": true },
    { "provider": "flashscore", "enabled": false }
  ]
}
```

## GET /live — Response
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
    "stats": { "attacks": 52, "dangerous_attacks": 18, "shots_total": 9, "corners": 5, "possession_home": 54, "possession_away": 46 },
    "odds": { "home": 1.75, "draw": 3.40, "away": 4.50, "over_25": 1.85, "btts_yes": 1.90 }
  }],
  "debug": {
    "selectedProvider": "scraper",
    "sourcesTried": ["mock", "sofascore"],
    "sourceSuccessCounts": { "mock": 3 },
    "liveMatches": 3,
    "oddsMatchedCount": 3,
    "cacheHit": false,
    "lastFetchAt": "2026-05-07T00:00:00.000Z",
    "durationMs": 312
  }
}
```

## CanliBet Frontend Activation
After deploying, update `core.js`:
```js
C.scraperBaseUrl     = 'https://YOUR-SCRAPER-URL';
C.liveScraperEnabled = true;
```

When `liveScraperEnabled = false` (default), existing provider chain runs unchanged.  
When `true`: scraper → SportMonks → football-data → LiveScore → OpenLigaDB → signal-only

## Adding a New Source
1. Copy `sources/source_custom.js` → `sources/source_YourName.js`
2. Set `ENABLED = true`, implement `fetch(browser, options)`
3. Add to `ADAPTERS` in `server.js`

## Safety
- Max 1 req / 30-60s per source
- No CAPTCHA bypass, no fingerprint evasion
- All requests logged
- Only public endpoints used
