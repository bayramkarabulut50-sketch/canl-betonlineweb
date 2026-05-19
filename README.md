# CanliBet Scraper Service v11.07 — Critical Fix + ESPN Global Aggregation

Base: uploaded v11.06-critical-fix.

Fix:
- Keeps safe `fetchEventDetails`.
- Keeps provider crash resilience.
- Adds professional ESPN global aggregation across all configured no-key ESPN scoreboards.
- Removes known dead 400 slugs from the curated list.
- Deduplicates matches by quality score.
- Adds `sourceGlobalAudit` to `/live` debug.

No API key.
No paid API.
No mock live matches.
No HTML scraping.
