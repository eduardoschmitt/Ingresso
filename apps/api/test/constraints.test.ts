import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { createScreening } from '../src/catalog/service.js';
import {
  auditoriums,
  cinemas,
  movies,
  reservationSeats,
  reservations,
  screenings,
  seats,
} from '../src/db/schema.js';
import { HttpError } from '../src/http/errors.js';
import { ensureTestDatabase, resetDatabase, testDb, testPool } from './db.js';
import { createScreeningFixture } from './fixtures.js';

let connectionString: string;
let pool: Pool;

beforeAll(async () => {
  connectionString = await ensureTestDatabase();
  pool = testPool(connectionString);
});

beforeEach(async () => {
  await resetDatabase(pool, connectionString);
});

afterAll(async () => {
  await pool.end();
});

function pgCode(err: unknown): string | undefined {
  // Drizzle wraps driver errors in `cause`; walk the chain.
  let current: unknown = err;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== 'object' || current === null) return undefined;
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

async function expectPgCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (err) {
    expect(pgCode(err)).toBe(code);
    return;
  }
  throw new Error(`expected PostgreSQL error ${code}, but the statement succeeded`);
}

describe('database constraints', () => {
  it('enforces movie and seat uniqueness', async () => {
    const db = testDb(pool);
    await db.insert(movies).values({ title: 'Dup Film', releaseYear: 2005 });
    await expectPgCode(db.insert(movies).values({ title: 'Dup Film', releaseYear: 2005 }), '23505');
    // Same title, different year is a different canonical film.
    await db.insert(movies).values({ title: 'Dup Film', releaseYear: 2006 });
  });

  it('enforces foreign keys on seats', async () => {
    const db = testDb(pool);
    await expectPgCode(
      db.insert(seats).values({ auditoriumId: 999999, rowLabel: 'A', seatNumber: 1 }),
      '23503',
    );
  });

  it('rejects overlapping screenings at the database level', async () => {
    const db = testDb(pool);
    const fixture = await createScreeningFixture(db);

    // Starts 30 minutes into the fixture screening: overlaps.
    const overlap: Parameters<typeof createScreening>[1] = {
      movieId: fixture.movieId,
      auditoriumId: fixture.auditoriumId,
      startsAt: new Date(fixture.startsAt.getTime() + 30 * 60_000),
      endsAt: new Date(fixture.endsAt.getTime() + 30 * 60_000),
      priceCents: 3000,
    };
    try {
      await createScreening(db, overlap);
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect(err).toMatchObject({ statusCode: 409, code: 'screening_overlap' });
      return;
    }
    throw new Error('expected overlapping screening to be rejected');
  });

  it('allows adjacent screenings in the same auditorium', async () => {
    const db = testDb(pool);
    const fixture = await createScreeningFixture(db);

    // Starting exactly when the fixture ends must succeed ([) ranges).
    const created = await createScreening(db, {
      movieId: fixture.movieId,
      auditoriumId: fixture.auditoriumId,
      startsAt: fixture.endsAt,
      endsAt: new Date(fixture.endsAt.getTime() + 2 * 60 * 60_000),
      priceCents: 3000,
    });
    expect(created.id).toBeGreaterThan(0);
  });

  it('rejects invalid ranges and negative prices', async () => {
    const db = testDb(pool);
    const fixture = await createScreeningFixture(db);

    try {
      await createScreening(db, {
        movieId: fixture.movieId,
        auditoriumId: fixture.auditoriumId,
        startsAt: new Date(Date.UTC(2026, 11, 21, 14, 0, 0)),
        endsAt: new Date(Date.UTC(2026, 11, 21, 14, 0, 0)),
        priceCents: 3000,
      });
    } catch (err) {
      expect(err).toMatchObject({ statusCode: 409, code: 'screening_invalid_range' });
    }

    // Bypass the service guard to prove the CHECK constraint itself.
    await expectPgCode(
      db.insert(screenings).values({
        movieId: fixture.movieId,
        auditoriumId: fixture.auditoriumId,
        startsAt: new Date(Date.UTC(2026, 11, 21, 14, 0, 0)),
        endsAt: new Date(Date.UTC(2026, 11, 21, 16, 0, 0)),
        priceCents: -1,
      }),
      '23514',
    );
  });

  it('enforces seat-to-screening auditorium consistency with composite keys', async () => {
    const db = testDb(pool);
    const roomA = await createScreeningFixture(db);
    const roomB = await createScreeningFixture(db);

    const [reservation] = await db
      .insert(reservations)
      .values({
        screeningId: roomA.screeningId,
        status: 'HELD',
        expiresAt: new Date(Date.now() + 5 * 60_000),
        idempotencyKey: `composite-fk-${roomA.screeningId}`,
        requestHash: 'test',
      })
      .returning({ id: reservations.id });
    if (reservation === undefined) throw new Error('fixture insert failed');

    // Seat from room B attached to room A's screening: must fail (23503)
    // even though both ids exist individually.
    await expectPgCode(
      db.insert(reservationSeats).values({
        reservationId: reservation.id,
        seatId: roomB.seatIds[0] as number,
        screeningId: roomA.screeningId,
        auditoriumId: roomA.auditoriumId,
      }),
      '23503',
    );

    // Matching room succeeds.
    await db.insert(reservationSeats).values({
      reservationId: reservation.id,
      seatId: roomA.seatIds[0] as number,
      screeningId: roomA.screeningId,
      auditoriumId: roomA.auditoriumId,
    });
  });

  it('enforces reservation idempotency-key uniqueness', async () => {
    const db = testDb(pool);
    const fixture = await createScreeningFixture(db);
    const values = {
      screeningId: fixture.screeningId,
      status: 'HELD' as const,
      expiresAt: new Date(Date.now() + 5 * 60_000),
      idempotencyKey: 'dup-key',
      requestHash: 'test',
    };
    await db.insert(reservations).values(values);
    await expectPgCode(db.insert(reservations).values(values), '23505');
  });

  it('cascades seat rows when a reservation row is deleted', async () => {
    const db = testDb(pool);
    const fixture = await createScreeningFixture(db);
    const [reservation] = await db
      .insert(reservations)
      .values({
        screeningId: fixture.screeningId,
        status: 'CANCELLED',
        expiresAt: new Date(Date.now() + 5 * 60_000),
        idempotencyKey: `cascade-${fixture.screeningId}`,
        requestHash: 'test',
      })
      .returning({ id: reservations.id });
    if (reservation === undefined) throw new Error('fixture insert failed');
    await db.insert(reservationSeats).values({
      reservationId: reservation.id,
      seatId: fixture.seatIds[0] as number,
      screeningId: fixture.screeningId,
      auditoriumId: fixture.auditoriumId,
    });

    await db.delete(reservations).where(eq(reservations.id, reservation.id));
    const remaining = await db
      .select()
      .from(reservationSeats)
      .where(eq(reservationSeats.reservationId, reservation.id));
    expect(remaining).toHaveLength(0);
  });

  it('restricts catalog deletion while inventory references it', async () => {
    const db = testDb(pool);
    const fixture = await createScreeningFixture(db);
    await expectPgCode(db.delete(movies).where(eq(movies.id, fixture.movieId)), '23503');
    await expectPgCode(db.delete(cinemas).where(eq(cinemas.id, fixture.cinemaId)), '23503');
    await expectPgCode(
      db.delete(auditoriums).where(eq(auditoriums.id, fixture.auditoriumId)),
      '23503',
    );
  });
});
