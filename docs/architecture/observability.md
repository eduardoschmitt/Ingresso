# Observability (Phase 2)

How Ingresso measures itself. Companion to the live dashboard
(`Ingresso — Phase 2 baseline` in Grafana) and the experiment report in
`docs/experiments/phase-2-baseline.md`.

## Metrics endpoint

`GET /metrics` returns Prometheus exposition format (no auth: local-only
bind in dev; never expose unauthenticated in a shared environment).
Implementation: `apps/api/src/observability/metrics.ts`, one registry per
app instance (test isolation), `prom-client` default process metrics
included.

## Metric catalog

| Metric                                                                                 | Type / labels   | Semantics                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ingresso_http_requests_total{method,route,status}`                                    | Counter         | Completed requests. `route` = registered pattern (`/movies/:id`); unknown paths collapse to `unknown`.                                                                                                   |
| `ingresso_http_request_duration_seconds{method,route,status}`                          | Histogram       | Request wall time incl. status label (adjustment 3). Buckets 5ms–5s.                                                                                                                                     |
| `ingresso_http_in_flight_requests`                                                     | Gauge           | Currently executing requests.                                                                                                                                                                            |
| `ingresso_db_pool_connections{state}`                                                  | Gauge           | `total`/`idle`/`waiting` read from the `pg` Pool at scrape time. Zero in tests (injected DBs are not watched).                                                                                           |
| `ingresso_reservation_outcomes_total{outcome}`                                         | Counter         | Bounded outcome enum: `created`, `replayed`, `read`, `expired_observed`, `cancelled`, `cancel_rejected`, `conflict_seat`, `conflict_idempotency`, `conflict_concurrent`, `invalid_request`, `not_found`. |
| `ingresso_reservation_transaction_duration_seconds{operation}`                         | Histogram       | Reservation transaction wall time for `create`/`read`/`cancel`, recorded on success **and** failure. Buckets 5ms–30s.                                                                                    |
| `ingresso_reservation_screening_lock_wait_seconds{operation}`                          | Histogram       | Wall time to acquire the screening `FOR UPDATE` lock — the direct signal of screening-level serialization. Same buckets.                                                                                 |
| `process_cpu_seconds_total`, `process_resident_memory_bytes`, `nodejs_eventloop_lag_*` | Gauges/counters | Standard `prom-client` process metrics (API resource consumption).                                                                                                                                       |

## Limitations (deliberate)

- **No per-statement DB timing.** It would require wrapping the driver inside
  business code. Transaction duration is the contention signal: under
  serialization, lock waits dominate it (measured: saturation p99 lock wait
  232ms vs idle ~5ms).
- **Lock wait = acquisition wall time**, including scheduling jitter — an
  upper bound on true lock blocking, good enough to compare scenarios.
- **Counters are process-lifetime.** Per-experiment attribution uses
  before/after `/metrics` snapshots (see `tests/load/results/`), not absolute
  values.
- `/metrics` itself is excluded from HTTP metrics to avoid scrape
  self-observation.
- Cardinality is bounded by construction: no ids, URLs, idempotency keys,
  or user data in any label (asserted in `test/metrics.test.ts`).

## Monitoring stack

- Prometheus `v3.9.1` scrapes the host API every 5s (dev `:3001`, load
  `:3002`; either may be down outside experiments).
- Grafana `12.4.9` with file provisioning only:
  `infrastructure/monitoring/grafana/{provisioning,dashboards}`.
- Admin password is a **required** env var (`GRAFANA_ADMIN_PASSWORD` in local
  `.env`, gitignored); Compose fails fast without it. No default is
  versioned — not even for development.
- Ports configurable: `PROM_PORT` (9090), `GRAFANA_PORT` (3000).
