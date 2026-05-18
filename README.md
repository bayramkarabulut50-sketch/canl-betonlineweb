# CanliBet Scraper Service v11.02 — Public JSON Source Expansion

Goal:
- Keep mock/demo disabled.
- If ESPN has no live events, try additional public JSON endpoints.
- No HTML scraping, no Playwright, no proxy, no CAPTCHA/fingerprint bypass.

New adapters:
- TheSportsDB public JSON live score probe
- OpenLigaDB public JSON probe

Recommended Render env:
```text
DISABLE_MOCK_FALLBACK=true
ENABLE_MOCK_SOURCE=true
ENABLE_ESPN_JSON_SOURCE=true
ENABLE_THESPORTSDB_JSON_SOURCE=true
ENABLE_OPENLIGADB_JSON_SOURCE=true
ENABLE_FOTMOB_JSON_SOURCE=true
ENABLE_AISCORE_JSON_SOURCE=true
ENABLE_SOFASCORE_SOURCE=false
CACHE_TTL_MS=30000
PORT=10000
```

Validation URLs:
```text
/live?force=true
/audit
```

If all public JSON sources return 0 live matches, the service correctly returns `matches: []` rather than fake/demo matches.
