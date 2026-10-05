// Scenario A — catalog browsing (read-only).
// Measures read performance independently of reservation writes.
// Arrival-rate executor avoids coordinated omission.

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
    browse: {
      executor: 'constant-arrival-rate',
      rate: 20,
      timeUnit: '1s',
      duration: '60s',
      preAllocatedVUs: 10,
      maxVUs: 40,
    },
  },
  thresholds: catastropheThresholds(500, 2000, 4000),
};

let BASE;
let SCREENINGS;

// Loaded at init time: k6 open() is unavailable after init.
const TARGETS = loadTargets();

export function setup() {
  confirmTarget();
  BASE = baseUrl();
  SCREENINGS = [TARGETS.contention.screeningId, ...TARGETS.distributed.map((s) => s.screeningId)];
  return { base: BASE, screenings: SCREENINGS };
}

const ROUTES = [
  (base) => `${base}/movies?page=1&pageSize=20`,
  (base) => `${base}/movies?page=2&pageSize=20`,
  (base) => `${base}/cinemas`,
  (base) => `${base}/screenings`,
];

export default function (data) {
  const pick = Math.floor(Math.random() * (ROUTES.length + 1));
  let url;
  if (pick < ROUTES.length) {
    url = ROUTES[pick](data.base);
  } else {
    const screeningId = data.screenings[Math.floor(Math.random() * data.screenings.length)];
    url = `${data.base}/screenings/${screeningId}/seats`;
  }
  const res = http.get(url);
  record(res, [200]);
  sleep(0.1);
}

export function handleSummary(data) {
  return writeSummary('a-catalog', data);
}
