# CanliBet Scraper Service v11.03 — Source Coverage Audit

Fix focus:
- Keep mock/demo disabled.
- Expand ESPN public JSON slug coverage for more leagues/countries.
- Keep all requests HTTP JSON only.
- No HTML scraping, no browser automation, no bypass/proxy.

Important:
If you see 10-15 live matches on other sites but only 2 here, the likely reason is source coverage:
those sites include leagues/events that ESPN public JSON does not expose. This build expands ESPN slugs and keeps audit transparent so we can see which leagues are accessible.

Validation:
```text
/live?force=true
/audit
```
