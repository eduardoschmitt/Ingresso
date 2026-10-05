# Load tests (Phase 2)

k6 scenarios against a dedicated `ingresso_load` database. Never against
production, never against an unknown database, never against dev without
thinking twice (the harness refuses non-`_load` names).

## Prerequisites

- k6 v2.2.0 (`winget install --id GrafanaLabs.k6 -e`; or
  `C:\Program Files\k6\k6.exe` by full path if PATH is stale).
- Monitoring stack: `docker compose up -d` (db, prometheus, grafana).
- Built API: `pnpm --filter @ingresso/api build`.

## Procedure (order matters)

```powershell
# 1. Prepare the load database (creates ingresso_load, migrates, seeds 6 rooms).
#    Refuses any database whose name does not end with _load.
pnpm --filter @ingresso/api load:setup

# 2. Start the load API instance (dev stays on 3001).
$env:PORT='3002'
$env:DATABASE_URL='postgres://ingresso:ingresso@localhost:5544/ingresso_load'
node apps/api/dist/index.js   # keep running; note the PID for later kill

# 3. Run scenarios from this directory with explicit acknowledgement:
$env:LOAD_BASE_URL='http://localhost:3002'
$env:LOAD_CONFIRM='LOAD'
k6 run --quiet a-catalog.js       # A: reads, 20 rps x 60 s
k6 run --quiet c-distributed.js   # C: writes x 4 rooms, 30 rps x 90 s
k6 run --quiet b-contention.js    # B: writes x 1 room, 30 rps x 90 s
k6 run --quiet d-mixed.js         # D: 50/20/20/10, 40 rps x 120 s
k6 run --quiet e-idempotent-retry.js  # E: one shared key, 10 rps x 60 s

# Saturation (same script, env overrides):
$env:LOAD_RATE='100'; $env:LOAD_DURATION='60s'
k6 run --quiet b-contention.js

# 4. Verify invariants after every write scenario (all SELECTs must be empty
#    except the Q5 summary):
Get-Content verify-invariants.sql -Raw | docker compose exec -T db psql -U ingresso -d ingresso_load -q -P pager=off
```

Raw JSON summaries land in `results/` (gitignored); metric snapshots via
`GET /metrics` before/after each run; server quantiles via Prometheus
`histogram_quantile`. See `docs/experiments/phase-2-baseline.md`.

## Cleanup

No destructive cleanup needed: load holds expire in `HOLD_MINUTES` and the
load database is disposable (`load:setup` re-creates the dataset from zero).
To drop it entirely: `docker compose exec db psql -U ingresso -d postgres -c "DROP DATABASE ingresso_load"`.
