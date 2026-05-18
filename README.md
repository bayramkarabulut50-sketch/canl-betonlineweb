# CanliBet Scraper Service v11.00 — No Fake Mock + Global ESPN Audit

- Mock/demo matches are suppressed by default.
- `/audit` probes all configured ESPN league endpoints.
- `/live` returns empty list if no real live ESPN match is found.

Env:
```
DISABLE_MOCK_FALLBACK=true
ENABLE_MOCK_SOURCE=true  # can stay true; mock will be skipped unless DISABLE_MOCK_FALLBACK=false
```
