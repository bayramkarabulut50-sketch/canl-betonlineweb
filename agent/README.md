# CanliBet Agent Network

This is the first autonomous agent scaffold for CanliBet.

It runs beside the scraper backend and starts in `active` mode. The agents can
collect live signals, watch source health, learn from settled outcomes, create
candidate strategies, train a simple calibration model, benchmark candidates,
and prepare promotion decisions.

## Run

Free Render Web Service mode:

```bash
npm start
```

The backend starts the embedded agent automatically unless
`CANLIBET_EMBED_AGENT=false`.

Separate worker mode:

```bash
cd backend
node agent/supervisor.js
```

Useful environment variables:

```bash
CANLIBET_BACKEND_URL=http://localhost:3847
CANLIBET_AGENT_MODE=active
CANLIBET_AUTO_PROMOTE=false
CANLIBET_AGENT_LOOP_MS=60000
CANLIBET_EMBED_AGENT=true
```

## Agents

- `source-health-agent`: checks `/health` and `/live?force=true`, tracks provider health.
- `source-discovery-agent`: probes candidate public sources and ranks them for adapter work.
- `source-auto-bind-agent`: enables healthy known providers and quarantines blocked ones.
- `signal-capture-agent`: stores analyzable, stats-backed signals in `data/signals.jsonl`.
- `learning-agent`: reads settled outcomes and finds weak/strong patterns.
- `strategy-mutator-agent`: creates `candidate-strategy.json` from learning output.
- `model-trainer-agent`: creates a calibration table model from historical outcomes.
- `model-benchmark-agent`: compares current and candidate models.
- `promotion-guardian-agent`: promotes only when rules allow it.
- `improvement-orchestrator-agent`: proposes bounded improvement work for
  features scoring 6/10 or lower.
- `storage-guard-agent`: checks critical free-mode data files and export readiness.
- `performance-analytics-agent`: builds source, league, market, and confidence-band performance reports.
- `adapter-blueprint-agent`: turns healthy source candidates into adapter implementation briefs.
- `threshold-tuning-agent`: proposes safe threshold changes without auto-applying risky changes.
- `alert-agent`: creates action-oriented warnings for source, learning, model, and storage issues.
- `root-cause-fix-planner-agent`: converts alerts into evidence-backed root-cause fix cards.
- `daily-report-agent`: writes a daily operator report with top actions.
- `capability-scorecard-agent`: tracks which agent capabilities are active, limited, or external-token dependent.

## Free Improvement Layer

This version adds the highest-value features that can run without paid services:

- `/agents/report`: daily report, alerts, analytics, scorecard, and improvement plan.
- `/agents/alerts`: current action-oriented warnings.
- `/agents/analytics`: source/league/market performance, threshold proposals, and adapter blueprints.
- `/agents/export`: JSON export of critical agent data and recent JSONL rows.
- `/agents/outcomes`: settlement bridge endpoint used by the frontend to feed won/lost/void results into learning.

`root-cause-fix-planner-agent` is the 9.5-target diagnosis layer. Each fix
card contains:

- issue code;
- collected evidence;
- probable root cause;
- affected files;
- exact fix steps;
- validation metrics;
- regression guards;
- priority order.

The free layer does not open GitHub PRs or run true always-on infrastructure.
Instead, it provides reviewable tasks, adapter blueprints, alerts, export/import
readiness, and learning data capture inside the existing Render web service.

## Improvement Orchestrator Agent

The `improvement-orchestrator-agent` is a design-only coordinator for weak
feature areas. It reads review scores, benchmark notes, learning output, and
source-health summaries, then selects only features with a score of 6/10 or
lower. For each selected feature it creates a small improvement brief with:

- the feature name and current score;
- the failing evidence or missing capability;
- a target outcome that would justify a higher score;
- the narrowest safe task that can be delegated to a sub-agent;
- the files or data contracts the sub-agent may inspect or propose changes for.

Sub-agent tasks are produced as independent work packets. Each packet must name
one owner agent, one objective, expected inputs, expected output artifacts, and
acceptance checks. Example task types include source reliability investigation,
signal-quality analysis, strategy mutation proposal, model calibration review,
benchmark comparison, and promotion-readiness review. The orchestrator does not
merge packets together unless they touch the same feature and can be completed
without expanding the file scope.

Safety boundaries:

- it may propose changes, candidate strategies, or review tasks, but must not
  directly promote a strategy or model;
- it must keep each sub-agent packet scoped to the files and contracts required
  for that packet;
- it must avoid reverting or overwriting unrelated changes from concurrent
  agents;
- it must require benchmark evidence before any promotion request reaches
  `promotion-guardian-agent`;
- it must quarantine tasks that depend on blocked, rate-limited, or unhealthy
  public sources until `source-health-agent` reports recovery.

## Data Files

The system writes under `backend/agent/data` by default.

The most important files are:

- `signals.jsonl`
- `outcomes.jsonl`
- `source-health.jsonl`
- `source-discovery.jsonl`
- `source-bindings.json`
- `latest-learning.json`
- `candidate-strategy.json`
- `candidate-model.json`
- `latest-promotion-decision.json`

## Safety

The default mode is active. It records, learns, creates candidate strategies,
and benchmarks candidate models. It still does not change the live strategy
unless `CANLIBET_AUTO_PROMOTE=true` and the benchmark says promotion is allowed.
