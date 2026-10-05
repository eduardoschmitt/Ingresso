import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { reservationSeats, reservations } from '../src/db/schema.js';
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

function postReservation(body: Record<string, unknown>, key?: string) {
  return app.inject({
    method: 'POST',
    url: '/reservations',
    headers: key === undefined ? {} : { 'idempotency-key': key },
    payload: body,
  });
}

describe('reservations lifecycle', () => {
  it('creates a hold with 201 and reads it back', async () => {
    const fixture = await createScreeningFixture(testDb(pool));
    const seatIds = [fixture.seatIds[0] as number, fixture.seatIds[1] as number];

    const created = await postReservation(
      { screeningId: fixture.screeningId, seatIds },
      `happy-${fixture.screeningId}`,
    );
    expect(created.statusCode).toBe(201);
    const body = created.json() as {
      id: number;
      status: string;
      seatIds: number[];
      expiresAt: string;
      created: boolean;
    };
    expect(body).toMatchObject({ status: 'HELD', seatIds, created: true });
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const fetched = await app.inject({ method: 'GET', url: `/reservations/${body.id}` });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toMatchObject({ id: body.id, status: 'HELD', seatIds });
  });

  it('validates input and requires the idempotency header', async () => {
    const fixture = await createScreeningFixture(testDb(pool));

    const noHeader = await postReservation({
      screeningId: fixture.screeningId,
      seatIds: [fixture.seatIds[0]],
    });
    expect(noHeader.statusCode).toBe(400);
    expect(noHeader.json()).toMatchObject({ error: { code: 'idempotency_key_missing' } });

    const empty = await postReservation(
      { screeningId: fixture.screeningId, seatIds: [] },
      'k-empty',
    );
    expect(empty.statusCode).toBe(400);

    const duplicates = await postReservation(
      { screeningId: fixture.screeningId, seatIds: [fixture.seatIds[0], fixture.seatIds[0]] },
      'k-dup',
    );
    expect(duplicates.statusCode).toBe(400);
    expect(duplicates.json()).toMatchObject({ error: { code: 'reservation_duplicate_seats' } });

    const unknownScreening = await postReservation(
      { screeningId: 999999, seatIds: [1] },
      'k-noscreen',
    );
    expect(unknownScreening.statusCode).toBe(404);

    const missingReservation = await app.inject({ method: 'GET', url: '/reservations/999999' });
    expect(missingReservation.statusCode).toBe(404);
  });

  it('rejects seats from another auditorium', async () => {
    const roomA = await createScreeningFixture(testDb(pool));
    const roomB = await createScreeningFixture(testDb(pool));

    const response = await postReservation(
      { screeningId: roomA.screeningId, seatIds: [roomB.seatIds[0]] },
      `wrong-room-${roomA.screeningId}`,
    );
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'seat_not_found' } });
  });

  it('rolls back atomically when any seat is taken', async () => {
    const fixture = await createScreeningFixture(testDb(pool));
    const db = testDb(pool);
    const [taken, free] = [fixture.seatIds[0] as number, fixture.seatIds[1] as number];

    const first = await postReservation(
      { screeningId: fixture.screeningId, seatIds: [taken] },
      `atomic-1-${fixture.screeningId}`,
    );
    expect(first.statusCode).toBe(201);

    const second = await postReservation(
      { screeningId: fixture.screeningId, seatIds: [taken, free] },
      `atomic-2-${fixture.screeningId}`,
    );
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: { code: 'seat_unavailable' } });

    // The free seat must not have been partially reserved.
    const seatRows = await db
      .select()
      .from(reservationSeats)
      .where(eq(reservationSeats.seatId, free));
    expect(seatRows).toHaveLength(0);

    const map = await app.inject({
      method: 'GET',
      url: `/screenings/${fixture.screeningId}/seats`,
    });
    const seats = (map.json() as { seats: { id: number; status: string }[] }).seats;
    expect(seats.find((s) => s.id === free)?.status).toBe('available');
  });

  it('cancels a hold and rejects a second cancellation', async () => {
    const fixture = await createScreeningFixture(testDb(pool));
    const created = await postReservation(
      { screeningId: fixture.screeningId, seatIds: [fixture.seatIds[0]] },
      `cancel-${fixture.screeningId}`,
    );
    const { id } = created.json() as { id: number };

    const cancelled = await app.inject({ method: 'DELETE', url: `/reservations/${id}` });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ id, status: 'CANCELLED' });

    const again = await app.inject({ method: 'DELETE', url: `/reservations/${id}` });
    expect(again.statusCode).toBe(409);

    const unknown = await app.inject({ method: 'DELETE', url: '/reservations/999999' });
    expect(unknown.statusCode).toBe(404);

    // Seats are released back to inventory.
    const map = await app.inject({
      method: 'GET',
      url: `/screenings/${fixture.screeningId}/seats`,
    });
    const seats = (map.json() as { seats: { id: number; status: string }[] }).seats;
    expect(seats.find((s) => s.id === fixture.seatIds[0])?.status).toBe('available');
  });

  it('expires holds transactionally and frees the seats', async () => {
    const fixture = await createScreeningFixture(testDb(pool));
    const db = testDb(pool);
    const seatId = fixture.seatIds[0] as number;

    await db.insert(reservations).values({
      screeningId: fixture.screeningId,
      status: 'HELD',
      expiresAt: new Date(Date.now() - 60_000),
      idempotencyKey: `expired-${fixture.screeningId}`,
      requestHash: 'test',
    });

    const all = await db.select({ id: reservations.id }).from(reservations);
    const read = await app.inject({ method: 'GET', url: `/reservations/${all[0]?.id}` });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ status: 'EXPIRED' });

    // The seat is reservable again.
    const retry = await postReservation(
      { screeningId: fixture.screeningId, seatIds: [seatId] },
      `after-expiry-${fixture.screeningId}`,
    );
    expect(retry.statusCode).toBe(201);
  });

  it('treats confirmed seats as sold and refuses to cancel them', async () => {
    const fixture = await createScreeningFixture(testDb(pool));
    const db = testDb(pool);
    const seatId = fixture.seatIds[0] as number;

    const [sold] = await db
      .insert(reservations)
      .values({
        screeningId: fixture.screeningId,
        status: 'CONFIRMED',
        expiresAt: new Date(Date.now() + 5 * 60_000),
        confirmedAt: new Date(),
        idempotencyKey: `sold-${fixture.screeningId}`,
        requestHash: 'test',
      })
      .returning({ id: reservations.id });
    if (sold === undefined) throw new Error('fixture insert failed');
    await db.insert(reservationSeats).values({
      reservationId: sold.id,
      seatId,
      screeningId: fixture.screeningId,
      auditoriumId: fixture.auditoriumId,
    });

    const attempt = await postReservation(
      { screeningId: fixture.screeningId, seatIds: [seatId] },
      `sold-attempt-${fixture.screeningId}`,
    );
    expect(attempt.statusCode).toBe(409);

    const map = await app.inject({
      method: 'GET',
      url: `/screenings/${fixture.screeningId}/seats`,
    });
    const seats = (map.json() as { seats: { id: number; status: string }[] }).seats;
    expect(seats.find((s) => s.id === seatId)?.status).toBe('sold');

    const cancel = await app.inject({ method: 'DELETE', url: `/reservations/${sold.id}` });
    expect(cancel.statusCode).toBe(409);
    expect(cancel.json()).toMatchObject({ error: { code: 'reservation_confirmed' } });
  });

  it('replays identical retries and rejects conflicting payloads', async () => {
    const fixture = await createScreeningFixture(testDb(pool));
    const db = testDb(pool);
    const payload = { screeningId: fixture.screeningId, seatIds: [fixture.seatIds[0]] };

    const first = await postReservation(payload, 'replay-key');
    expect(first.statusCode).toBe(201);
    const firstBody = first.json() as { id: number };

    const replay = await postReservation(payload, 'replay-key');
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ id: firstBody.id, created: false });

    const rows = await db
      .select()
      .from(reservations)
      .where(eq(reservations.idempotencyKey, 'replay-key'));
    expect(rows).toHaveLength(1);

    const conflictPayload = { screeningId: fixture.screeningId, seatIds: [fixture.seatIds[1]] };
    const conflicting = await postReservation(conflictPayload, 'replay-key');
    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json()).toMatchObject({ error: { code: 'idempotency_conflict' } });
  });

  it('preserves idempotency after cancellation', async () => {
    const fixture = await createScreeningFixture(testDb(pool));
    const db = testDb(pool);
    const payload = { screeningId: fixture.screeningId, seatIds: [fixture.seatIds[0]] };

    const first = await postReservation(payload, 'cancel-replay-key');
    const { id } = first.json() as { id: number };
    await app.inject({ method: 'DELETE', url: `/reservations/${id}` });

    // Identical retry returns the original (now CANCELLED) result, no new row.
    const replay = await postReservation(payload, 'cancel-replay-key');
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ id, status: 'CANCELLED', created: false });

    const rows = await db
      .select()
      .from(reservations)
      .where(eq(reservations.idempotencyKey, 'cancel-replay-key'));
    expect(rows).toHaveLength(1);
  });
});
