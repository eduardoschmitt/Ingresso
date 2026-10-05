# Phase 2 baseline report — measurements before any optimization

Date: 2026-10-05 · Git revision: `75a01f5` (+ uncommitted Phase 2 tree) ·
Code: single API instance, screening-level serialization unchanged.

> Observations and hypotheses are separated on purpose. Numbers below are
> measured; interpretations are labeled as such.

## Hypotheses (before measuring)

1. Same-screening writes serialize on the screening row lock; tail latency
   grows with arrival rate while medians stay flat.
2. Distributed writes across independent screenings scale better than
   same-screening writes at equal total rate.
3. Reads are an order of magnitude faster than writes and unaffected by
   reservation contention.
4. No load level produces 5xx or inventory violations — degradation shows as
   latency + 409s, never as incorrectness.

## Methodology

- Dedicated `ingresso_load` database (guarded `_load` suffix + `current_database()`
  re-verification); dev database never touched by load. Deterministic dataset:
  1 contention room (20 seats), 4 distributed rooms (24 seats each),
  1 retry room (4 seats); `tests/load/target.json` (gitignored).
- Load API: built `dist/`, `PORT=3002`, `DATABASE_URL=…/ingresso_load`,
  default `pg` pool (**max 10**, recorded — not tuned).
- k6 `2.2.0` native, arrival-rate executors (no coordinated omission),
  unique `load-*` keys per attempt; 409 = expected conflict (passes checks),
  only 5xx/network errors fail (`load_unexpected_errors == 0` threshold).
- Server-side p50/p95/p99 from Prometheus `histogram_quantile` over the run
  window; client-side med/p95 from k6 (`med` ≈ median; k6 v2 summaries do not
  emit p50/p99); API counters are process-lifetime → per-run attribution via
  before/after `/metrics` snapshots (`tests/load/results/`).
- `verify-invariants.sql` after every write scenario: Q1 conflicting active
  holders (expiry-aware), Q2 double sales, Q3/Q4 FK consistency, Q5 summary.

### Environment

| Item       | Value                                                                  |
| ---------- | ---------------------------------------------------------------------- |
| CPU / RAM  | i5-1334U (10C/12T) / 16 GiB, Windows + Docker Desktop                  |
| API        | Node 22.22.2, single instance, Fastify 5, pool max 10                  |
| PostgreSQL | 16.15 alpine, defaults (`max_connections=100`, `shared_buffers=128MB`) |
| Dataset    | 6 screenings, 120 seats (20 + 4×24 + 4)                                |
| Monitoring | Prometheus v3.9.1 (5s scrape), Grafana 12.4.9                          |

## Results

### A — catalog reads, 20 rps × 60 s (1201 reqs)

| Source            | p50       | p95   | p99   | Errors |
| ----------------- | --------- | ----- | ----- | ------ |
| k6 client         | med 5.1ms | 8.1ms | —     | 0      |
| Prometheus server | 4.0ms     | 9.4ms | 9.9ms | 0      |

### C — distributed writes, 30 rps × 90 s (2701 reqs, 4 rooms)

| Source                   | p50       | p95    | p99    |
| ------------------------ | --------- | ------ | ------ |
| k6 client                | med 9.0ms | 16.3ms | —      |
| Prometheus server (HTTP) | 7.6ms     | 21.2ms | 24.3ms |
| Txn `create`             | 8.2ms     | 21.8ms | 24.4ms |
| Lock wait                | 2.5ms     | 4.8ms  | 5.0ms  |

Outcomes: **96 created** (exactly 4×24 seats), 2605 `conflict_seat`, 0 unexpected.
Invariants Q1–Q4: 0 rows.

### B — same-screening contention, 30 rps × 90 s (2700 reqs, 20-seat room)

| Source                   | p50       | p95    | p99    |
| ------------------------ | --------- | ------ | ------ |
| k6 client                | med 9.2ms | 15.4ms | —      |
| Prometheus server (HTTP) | 8.4ms     | 22.3ms | 24.7ms |
| Txn `create`             | 8.2ms     | 21.8ms | 24.6ms |
| Lock wait                | 2.5ms     | 4.8ms  | 5.0ms  |

Outcomes: **20 created** (room filled exactly), ~2680 conflicts, 0 unexpected.
Mid-run: 2 PG sessions, 0 ungranted locks, pool total 1. Invariants: 0 rows.

### D — mixed (50/20/20/10), 40 rps × 120 s (4859 reqs)

k6: med 5.0ms, p90 10.3ms, p95 13.2ms, max 220ms; checks 4801/4801 pass;
`failed_rate` 0.26 (= expected 409s), unexpected 0.
Outcome deltas: +150 created, +58 cancelled, +1283 `conflict_seat`.
Invariants Q1–Q4: 0 rows (96 older holds correctly appear as EXPIRED).

### Saturation — contention room, 100 rps × 60 s (5913 reqs)

| Source                   | p50       | p95         | p99         |
| ------------------------ | --------- | ----------- | ----------- |
| k6 client                | med 8.2ms | **833.6ms** | —           |
| Prometheus server (HTTP) | 8.8ms     | 790.9ms     | 1740ms      |
| Txn `create`             | 8.7ms     | 790.9ms     | 1740ms      |
| Lock wait                | 3.3ms     | **147.8ms** | **232.2ms** |

Mid-run: 7 PG sessions, **8 ungranted locks** (RowExclusiveLock waits),
pool total **10/10 (ceiling)**, DB CPU 22%. Zero 5xx (unexpected 0).
Invariants: 0 rows; room filled with exactly 20 HELD.

### E — identical-key retries (1803 reqs, 1 shared key)

All 200/201, unexpected 0; exactly **1 row** for the shared key.

### Recovery

60 s idle → first read 2.1 s (cold pool reconnect), then 15–25 ms;
invariants clean (21 HELD = 20 + 1). No stuck holds, no intervention needed.

## Bottlenecks (evidence-backed, top 3)

1. **Screening row lock (serialization).** Lock-wait p99 grows 5ms → 232ms
   from 30 to 100 rps on one screening; HTTP p99 follows (25ms → 1740ms)
   while the median barely moves — the classic serialization signature
   (hypothesis 1 confirmed).
2. **`pg` pool ceiling (max 10, default).** Saturation hit total=10 with
   queued demand; caps DB parallelism before PG itself strains (DB CPU only
   22%). Cheapest knob for Phase 3 measurement — not changed in this phase.
3. **Cold pool after idle.** First request after 60 s idle cost 2.1 s
   (reconnect). Matters for latency-sensitive paths after quiet periods;
   `min`/warmup policy is a Phase 3 measurement candidate.

Not bottlenecks (measured): reads (p99 9.9ms at 20 rps, unaffected by
writes — hypothesis 3 confirmed); distributed writes ≈ same-screening writes
at 30 rps (hypothesis 2 **not visible at this rate** — C and B nearly
identical; the difference only appears at saturation pressure); DB CPU/IO.

Correctness held everywhere: zero double-holds, zero double-sales, zero 5xx
across ~17k write attempts (hypothesis 4 confirmed).

## Limitations

- Generator, API, and DB share one laptop: absolute numbers are
  machine-relative; **comparisons between scenarios are the valid readout**.
- k6 v2 end-of-test summaries omit p50/p99 for trends; server-side
  Prometheus quantiles fill the gap (method above).
- `http_req_failed.fails` counts non-2xx including expected 409s in k6 2.x;
  the report uses `checks` + `load_unexpected_errors` instead.
- API counters are process-lifetime; per-run outcomes come from snapshot
  deltas.
- Pool/lock mid-run samples are instants, not traces.
- Dashboard was verified via API (provisioned + datasource OK); panels
  eyeballed, not screenshot-archived.

## Recommendations (Phase 3+, each needs its own experiment)

1. Pool sizing sweep (10 → 25 → 50) under B@100rps; expect lock-wait, not
   pool, to dominate — verify before/after.
2. Per-seat locking or predicate-based acquisition to relax screening
   serialization; must re-run B + invariants (double-sale risk moves).
3. Read-path indexes/HTTP caching for seat maps (highest read volume in D);
   never cache authorization.
4. Pool `min`/warmup vs cold-start latency after idle.
5. Longer soak (30+ min) for EXPIRED-row accumulation and sweep cost.
