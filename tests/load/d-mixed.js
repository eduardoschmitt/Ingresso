// Scenario D — mixed traffic with documented proportions:
//   50% catalog reads, 20% seat-map reads, 20% reservations, 10% cancel-after-create.
// Cancellations create-then-cancel within the same iteration (no cross-VU ids).

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
    mixed: {
      executor: 'constant-arrival-rate',
      rate: 40,
      timeUnit: '1s',
      duration: '120s',
      preAllocatedVUs: 25,
      maxVUs: 100,
    },
  },
  thresholds: catastropheThresholds(2000, 8000, 15000),
};

// Loaded at init time: k6 open() is unavailable after init.
const TARGETS = loadTargets();

export function setup() {
  confirmTarget();
  return {
    base: baseUrl(),
    contention: TARGETS.contention,
    screenings: TARGETS.distributed,
  };
}

function randomScreening(data) {
  const all = [data.contention, ...data.screenings];
  return all[Math.floor(Math.random() * all.length)];
}

export default function (data) {
  const roll = Math.random();
  if (roll < 0.5) {
    const res = http.get(`${data.base}/movies?page=1&pageSize=20`);
    record(res, [200]);
  } else if (roll < 0.7) {
    const screening = randomScreening(data);
    const res = http.get(`${data.base}/screenings/${screening.screeningId}/seats`);
    record(res, [200]);
  } else if (roll < 0.9) {
    const screening = randomScreening(data);
    const seatId = screening.seatIds[Math.floor(Math.random() * screening.seatIds.length)];
    const res = http.post(
      `${data.base}/reservations`,
      JSON.stringify({ screeningId: screening.screeningId, seatIds: [seatId] }),
      {
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `load-d-${__VU}-${__ITER}`,
        },
      },
    );
    record(res, [200, 201, 409]);
  } else {
    const screening = randomScreening(data);
    const seatId = screening.seatIds[Math.floor(Math.random() * screening.seatIds.length)];
    const created = http.post(
      `${data.base}/reservations`,
      JSON.stringify({ screeningId: screening.screeningId, seatIds: [seatId] }),
      {
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `load-dc-${__VU}-${__ITER}`,
        },
      },
    );
    if (created.status === 201) {
      const id = created.json().id;
      const cancelled = http.del(`${data.base}/reservations/${id}`);
      const ok = check(cancelled, { cancelled: (r) => r.status === 200 });
      if (!ok) unexpectedErrors.add(1);
    } else {
      record(created, [409]);
    }
  }
  sleep(0.05);
}

export function handleSummary(data) {
  return writeSummary('d-mixed', data);
}
