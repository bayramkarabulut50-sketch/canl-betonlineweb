# CanliBet Scraper Service v11.01 — Live Status Final Fix

Fixes:
- `DISABLE_MOCK_FALLBACK is not defined` runtime error is fixed.
- Mock/demo matches are suppressed by default.
- ESPN live status detection now accepts multiple ESPN soccer live status forms:
  - STATUS_IN_PROGRESS
  - STATUS_FIRST_HALF
  - STATUS_SECOND_HALF
  - STATUS_HALFTIME / STATUS_HALF_TIME
  - STATUS_END_PERIOD
  - extra-time / penalty live states
  - state/detail forms like IN, LIVE, 1H, 2H, HT
- Final and scheduled matches remain rejected.
- `/live?force=true` forces a fresh backend fetch.

Recommended Render env:
```text
DISABLE_MOCK_FALLBACK=true
ENABLE_MOCK_SOURCE=true
ENABLE_ESPN_JSON_SOURCE=true
ENABLE_FOTMOB_JSON_SOURCE=true
ENABLE_AISCORE_JSON_SOURCE=true
ENABLE_SOFASCORE_SOURCE=false
CACHE_TTL_MS=30000
PORT=10000
```

Important:
If `/audit` shows only STATUS_SCHEDULED / STATUS_FULL_TIME / STATUS_FINAL_PEN across all ESPN endpoints, then ESPN is not returning currently live matches for its covered leagues at that moment. In that case `/live` correctly returns 0 real matches, not mock data.
