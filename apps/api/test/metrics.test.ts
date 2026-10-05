import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { ensureTestDatabase, resetDatabase, testDb, testPool } from './db.js';
import { createScreeningFixture } from './fixtures.js';

let connectionString: string;
let pool: Pool;
let app: FastifyInstance;

beforeAll(async () => {
  connectionString = await ensureTestDatabase();
  pool = testPool(connectionString);
  app = buildApp({ db: testDb(pool) });
});

beforeEach(async () => {
  await resetDatabase(pool, connectionString);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

async function metricsBody(): Promise<string> {
  const response = await app.inject({ method: 'GET', url: '/metrics' });
  expect(response.statusCode).toBe(200);
  expect(response.headers['content-type']).toContain('text/plain');
  return response.body;
}

describe('metrics endpoint', () => {
  it('exposes Prometheus series without altering API contracts', async () => {
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.headers['content-type']).toContain('application/json');
    expect(health.json()).toEqual({ status: 'ok', service: 'ingresso-api' });

    const body = await metricsBody();
    expect(body).toContain('ingresso_http_requests_total');
    expect(body).toContain('ingresso_http_request_duration_seconds_bucket');
    expect(body).toContain('ingresso_reservation_outcomes_total');
    expect(body).toContain('process_cpu_seconds_total');
  });

  it('keeps route labels bounded (no ids or raw urls)', async () => {
    await app.inject({ method: 'GET', url: '/movies/12345' });
    await app.inject({ method: 'GET', url: '/totally-unknown-xyz-999' });
    await app.inject({ method: 'GET', url: '/movies/12345' });

    const body = await metricsBody();
    expect(body).toContain('route="/movies/:id"');
    expect(body).toContain('route="unknown"');
    expect(body).not.toContain('12345');
    expect(body).not.toContain('totally-unknown-xyz-999');
  });

  it('never exposes secrets or request data', async () => {
    const fixture = await createScreeningFixture(testDb(pool));
    await app.inject({
      method: 'POST',
      url: '/reservations',
      headers: { 'idempotency-key': 'secret-probe-77431' },
      payload: { screeningId: fixture.screeningId, seatIds: [fixture.seatIds[0]] },
    });

    const body = await metricsBody();
    expect(body).not.toContain('secret-probe-77431');
    expect(body).not.toContain('postgres://');
    expect(body).not.toContain('GRAFANA');
    expect(body).not.toMatch(/seatIds|screeningId/i);
  });

  it('records reservation outcomes and transaction durations on success and failure', async () => {
    // Counters accumulate per app instance (not reset by DB truncation),
    // so assert increments, not absolute values.
    const countOutcome = (body: string, outcome: string): number => {
      const match = body.match(
        new RegExp(`ingresso_reservation_outcomes_total\\{outcome="${outcome}"\\} (\\d+)`),
      );
      return match === null ? 0 : Number(match[1]);
    };
    const countTxn = (body: string): number => {
      const matches = [
        ...body.matchAll(
          /ingresso_reservation_transaction_duration_seconds_count\{operation="create"\} (\d+)/g,
        ),
      ];
      return matches.reduce((sum, m) => sum + Number(m[1]), 0);
    };

    const fixture = await createScreeningFixture(testDb(pool));
    const seatId = fixture.seatIds[0] as number;
    const before = await metricsBody();

    const created = await app.inject({
      method: 'POST',
      url: '/reservations',
      headers: { 'idempotency-key': 'metrics-created' },
      payload: { screeningId: fixture.screeningId, seatIds: [seatId] },
    });
    expect(created.statusCode).toBe(201);

    const conflicting = await app.inject({
      method: 'POST',
      url: '/reservations',
      headers: { 'idempotency-key': 'metrics-conflict' },
      payload: { screeningId: fixture.screeningId, seatIds: [seatId] },
    });
    expect(conflicting.statusCode).toBe(409);

    const after = await metricsBody();
    expect(countOutcome(after, 'created') - countOutcome(before, 'created')).toBe(1);
    expect(countOutcome(after, 'conflict_seat') - countOutcome(before, 'conflict_seat')).toBe(1);
    // Transaction durations recorded for both the 201 and the 409.
    expect(countTxn(after) - countTxn(before)).toBe(2);
  });
});
