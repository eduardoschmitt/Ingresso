// Scenario C — distributed demand across four screenings.
// Same total arrival rate as B, but writers spread over independent
// screening locks. Compare against B to isolate the cost of same-screening
// serialization.

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
    distributed: {
      executor: 'constant-arrival-rate',
      rate: 30,
      timeUnit: '1s',
      duration: '90s',
      preAllocatedVUs: 20,
      maxVUs: 80,
    },
  },
  thresholds: catastropheThresholds(2000, 8000, 15000),
};

// Loaded at init time: k6 open() is unavailable after init.
const TARGETS = loadTargets();

export function setup() {
  confirmTarget();
  return { base: baseUrl(), screenings: TARGETS.distributed };
}

export default function (data) {
  const screening = data.screenings[Math.floor(Math.random() * data.screenings.length)];
  const seatId = screening.seatIds[Math.floor(Math.random() * screening.seatIds.length)];
  const res = http.post(
    `${data.base}/reservations`,
    JSON.stringify({ screeningId: screening.screeningId, seatIds: [seatId] }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `load-c-${__VU}-${__ITER}`,
      },
    },
  );
  record(res, [200, 201, 409]);
  sleep(0.05);
}

export function handleSummary(data) {
  return writeSummary('c-distributed', data);
}
