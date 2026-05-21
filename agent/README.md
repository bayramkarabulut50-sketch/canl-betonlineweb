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
- `signal-capture-agent`: stores analyzable, stats-backed signals in `data/signals.jsonl`.
- `learning-agent`: reads settled outcomes and finds weak/strong patterns.
- `strategy-mutator-agent`: creates `candidate-strategy.json` from learning output.
- `model-trainer-agent`: creates a calibration table model from historical outcomes.
- `model-benchmark-agent`: compares current and candidate models.
- `promotion-guardian-agent`: promotes only when rules allow it.

## Data Files

The system writes under `backend/agent/data` by default.

The most important files are:

- `signals.jsonl`
- `outcomes.jsonl`
- `source-health.jsonl`
- `latest-learning.json`
- `candidate-strategy.json`
- `candidate-model.json`
- `latest-promotion-decision.json`

## Safety

The default mode is active. It records, learns, creates candidate strategies,
and benchmarks candidate models. It still does not change the live strategy
unless `CANLIBET_AUTO_PROMOTE=true` and the benchmark says promotion is allowed.
