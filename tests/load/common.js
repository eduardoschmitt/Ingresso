// Shared helpers for Ingresso Phase 2 load scenarios.
//
// Safety: every scenario file calls confirmTarget() in setup() — k6 aborts
// unless LOAD_CONFIRM=LOAD is exported, forcing an explicit acknowledgement
// of the target. Scenarios only ADD holds (unique keys); they never delete
// or truncate. Holds expire automatically (HOLD_MINUTES).
//
// 409 responses are EXPECTED business conflicts (seat taken, key reused) and
// pass checks. Only anything else (notably 5xx / network errors) increments
// load_unexpected_errors, which every scenario thresholds at zero.

import { check } from 'k6';
import { Counter } from 'k6/metrics';

export const unexpectedErrors = new Counter('load_unexpected_errors');

export function baseUrl() {
  const url = __ENV.LOAD_BASE_URL;
  if (!url) {
    throw new Error('LOAD_BASE_URL is required, e.g. http://localhost:3002');
  }
  return url;
}

export function confirmTarget() {
  if (__ENV.LOAD_CONFIRM !== 'LOAD') {
    throw new Error('Refusing to run: export LOAD_CONFIRM=LOAD to acknowledge the load target');
  }
}

export function loadTargets() {
  try {
    return JSON.parse(open('./target.json'));
  } catch (err) {
    throw new Error(`Run the load setup first (writes tests/load/target.json): ${err}`);
  }
}

// Accepts the given statuses (409 included: expected conflict). Anything else
// fails the check and counts as unexpected.
export function record(res, allowed) {
  const ok = check(res, { 'expected status': (r) => allowed.includes(r.status) });
  if (!ok) {
    unexpectedErrors.add(1);
  }
  return ok;
}

export function catastropheThresholds(p50ms, p95ms, p99ms) {
  // Measurement first: thresholds only catch catastrophes (5xx storms,
  // hangs), they are NOT performance goals. Listing p50/p95/p99 also forces
  // k6 to compute those percentiles in the end-of-test summary.
  return {
    checks: ['rate==1.0'],
    load_unexpected_errors: ['count==0'],
    http_req_duration: [`p(50)<${p50ms}`, `p(95)<${p95ms}`, `p(99)<${p99ms}`],
  };
}

export function writeSummary(name, data) {
  // k6 v2 handleSummary: metric aggregates sit directly on data.metrics[name]
  // (no .values nesting). Store them whole; read p(50)/p(95)/p(99)/count/rate.
  const pick = (metric) => data.metrics[metric];
  return {
    [`results/${name}.json`]: JSON.stringify(
      {
        name,
        timestamp: new Date().toISOString(),
        metrics: {
          http_req_duration: pick('http_req_duration'),
          http_reqs: pick('http_reqs'),
          http_req_failed: pick('http_req_failed'),
          checks: pick('checks'),
          load_unexpected_errors: pick('load_unexpected_errors'),
          vus_max: pick('vus_max'),
        },
      },
      null,
      2,
    ),
    stdout: JSON.stringify(
      {
        scenario: name,
        // k6 v2 summaries expose med (median) but not p(50)/p(99); server-side
        // p50/p95/p99 come from Prometheus histogram_quantile (see report).
        p50_med: data.metrics.http_req_duration?.values.med,
        p95: data.metrics.http_req_duration?.values['p(95)'],
        p99: data.metrics.http_req_duration?.values['p(99)'],
        reqs: data.metrics.http_reqs?.values.count,
        failed_rate: data.metrics.http_req_failed?.values.rate,
        unexpected: data.metrics.load_unexpected_errors?.values.count ?? 0,
      },
      null,
      2,
    ),
  };
}
