// Scenario E — identical-key retries under concurrency (tested separately).
// ALL VUs share ONE idempotency key and payload: exactly one reservation row
// must exist afterwards and every response must be 200/201. Cross-VU id
// equality cannot be asserted client-side (k6 has no shared memory); the row
// count is verified server-side with verify-invariants.sql / SQL count.

import http from 'k6/http';
import { check, sleep } from 'k6';

import {
  baseUrl,
  catastropheThresholds,
  confirmTarget,
  loadTargets,
  record,
  unexpectedErrors,
  writeSummary,
} from './common.js';

export const options = {
  scenarios: {
    retry: {
      executor: 'constant-arrival-rate',
      rate: 10,
      timeUnit: '1s',
      duration: '60s',
      preAllocatedVUs: 10,
      maxVUs: 30,
    },
  },
  thresholds: catastropheThresholds(2000, 8000, 15000),
};

// Loaded at init time: k6 open() is unavailable after init.
const TARGETS = loadTargets();

export function setup() {
  confirmTarget();
  return { base: baseUrl(), screening: TARGETS.retry };
}

export default function (data) {
  const payload = JSON.stringify({
    screeningId: data.screening.screeningId,
    seatIds: [data.screening.seatIds[0]],
  });
  for (let i = 0; i < 3; i += 1) {
    const res = http.post(`${data.base}/reservations`, payload, {
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'load-e-shared-retry' },
    });
    const ok = check(res, { 'replay ok': (r) => r.status === 200 || r.status === 201 });
    if (!ok) {
      unexpectedErrors.add(1);
    }
    sleep(0.1);
  }
}

export function handleSummary(data) {
  return writeSummary('e-idempotent-retry', data);
}
