// Scenario B — high contention on ONE screening with a small seat pool.
// Every VU races for seats in the same 20-seat room: the screening lock
// serializes writers. Expected: exactly the seat count succeeds, the rest get
// 409 seat_unavailable, zero 5xx. Invariants verified post-run with
// verify-invariants.sql (HTTP codes alone prove nothing).

import http from 'k6/http';
import { sleep } from 'k6';

import {
  baseUrl,
  catastropheThresholds,
  confirmTarget,
  loadTargets,
  record,
  writeSummary,
} from './common.js';

export const options = {
  scenarios: {
    contention: {
      executor: 'constant-arrival-rate',
      // Overridable for the saturation experiment (defaults: 30 rps, 90 s).
      rate: Number(__ENV.LOAD_RATE || 30),
      timeUnit: '1s',
      duration: __ENV.LOAD_DURATION || '90s',
      preAllocatedVUs: 20,
      maxVUs: 150,
    },
  },
  thresholds: catastropheThresholds(2000, 8000, 15000),
};

// Loaded at init time: k6 open() is unavailable after init.
const TARGETS = loadTargets();

export function setup() {
  confirmTarget();
  return { base: baseUrl(), screening: TARGETS.contention };
}

export default function (data) {
  const seatIds = data.screening.seatIds;
  const seatId = seatIds[Math.floor(Math.random() * seatIds.length)];
  const res = http.post(
    `${data.base}/reservations`,
    JSON.stringify({ screeningId: data.screening.screeningId, seatIds: [seatId] }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `load-b-${__VU}-${__ITER}`,
      },
    },
  );
  record(res, [200, 201, 409]);
  sleep(0.05);
}

export function handleSummary(data) {
  return writeSummary('b-contention', data);
}
