# CanliBet Scraper Service v10.94 — Canonical Stats Mapping Fix

ESPN public JSON remains the primary live backbone. This release fixes the canonical stats mapping so useful ESPN summary fields are not lost.

## Key fixes

Mapped ESPN stat names into canonical fields:

- `won_corners` → `stats.corners`
- `total_shots` → `stats.shots_total`
- `shots_on_target` → `stats.shots_on_target`
- `possession_pct` → `stats.possession_home` / `stats.possession_away`
- `yellow_cards` → `stats.yellow_cards`
- `red_cards` → `stats.red_cards`

## Endpoints

- `GET /health`
- `GET /audit`
- `GET /live`
- `GET /stats-audit`

## Expected result

`/live` should now show ESPN matches like:

```json
{
  "source": "espn",
  "hasStats": true,
  "stats": {
    "shots_total": 5,
    "shots_on_target": 2,
    "corners": 3,
    "possession_home": 41.5,
    "possession_away": 58.5
  }
}
```

## Render env

```
ENABLE_MOCK_SOURCE=true
ENABLE_SOFASCORE_SOURCE=false
ENABLE_ESPN_JSON_SOURCE=true
ENABLE_FOTMOB_JSON_SOURCE=true
ENABLE_AISCORE_JSON_SOURCE=true
FORCE_ESPN_DETAILS=true
CACHE_TTL_MS=30000
PORT=10000
```

No HTML scraping, no Playwright, no proxy, no CAPTCHA or fingerprint bypass.
