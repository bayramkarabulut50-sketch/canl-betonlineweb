# CanliBet Scraper Service v11.06 — Professional ESPN Global Aggregation

No API key. No paid API. No mock live matches.

What changed:
- ESPN adapter no longer stops at `/all/scoreboard`.
- It scans all configured ESPN league slugs and aggregates matches.
- Duplicate matches are removed by quality score.
- `/live` debug includes `sourceGlobalAudit`:
  - endpointsTried
  - endpoints200
  - rawEventsTotal
  - parsedBeforeDedupe
  - parsedAfterDedupe
  - topEndpoints
  - sampledFailures
- League name fallback improved.

Why:
If ESPN `/all` only shows 3 live matches, league-specific scoreboards may expose more. This build makes that visible and usable without API keys.

Validation:
```text
/live?force=true
/audit
```
