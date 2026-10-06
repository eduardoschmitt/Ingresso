import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { createReservation } from '../src/reservations/service.js';
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

describe('catalog endpoints', () => {
  it('paginates movies with a stable contract', async () => {
    await createScreeningFixture(testDb(pool));
    await createScreeningFixture(testDb(pool));
    await createScreeningFixture(testDb(pool));

    const first = await app.inject({ method: 'GET', url: '/movies?page=1&pageSize=2' });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as {
      data: unknown[];
      page: number;
      pageSize: number;
      total: number;
    };
    expect(firstBody.data).toHaveLength(2);
    expect(firstBody).toMatchObject({ page: 1, pageSize: 2, total: 3 });

    const second = await app.inject({ method: 'GET', url: '/movies?page=2&pageSize=2' });
    expect(second.json()).toMatchObject({ page: 2, pageSize: 2, total: 3 });
    expect((second.json() as { data: unknown[] }).data).toHaveLength(1);
  });

  it('rejects invalid pagination and ids', async () => {
    const oversized = await app.inject({ method: 'GET', url: '/movies?pageSize=101' });
    expect(oversized.statusCode).toBe(400);
    expect(oversized.json()).toMatchObject({ error: { code: 'validation_error' } });

    const zeroPage = await app.inject({ method: 'GET', url: '/movies?page=0' });
    expect(zeroPage.statusCode).toBe(400);

    const badId = await app.inject({ method: 'GET', url: '/movies/abc' });
    expect(badId.statusCode).toBe(400);

    const missing = await app.inject({ method: 'GET', url: '/movies/999999' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: 'movie_not_found' } });
  });

  it('returns cinema detail with auditoriums', async () => {
    const fixture = await createScreeningFixture(testDb(pool));

    const response = await app.inject({ method: 'GET', url: `/cinemas/${fixture.cinemaId}` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      id: number;
      name: string;
      auditoriums: { id: number; name: string; capacity: number }[];
    };
    expect(body.auditoriums).toHaveLength(1);
    expect(body.auditoriums[0]).toMatchObject({ name: 'Sala F', capacity: 24 });

    const missing = await app.inject({ method: 'GET', url: '/cinemas/999999' });
    expect(missing.statusCode).toBe(404);
  });

  it('lists screenings with denormalized names', async () => {
    const fixture = await createScreeningFixture(testDb(pool));

    const response = await app.inject({ method: 'GET', url: '/screenings' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      data: {
        id: number;
        movieTitle: string;
        auditoriumName: string;
        cinemaName: string;
        priceCents: number;
      }[];
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.data[0]).toMatchObject({
      id: fixture.screeningId,
      auditoriumName: 'Sala F',
      priceCents: 3000,
    });
    expect(typeof body.data[0]?.movieTitle).toBe('string');
  });

  it('filters screenings by movie and cinema', async () => {
    const first = await createScreeningFixture(testDb(pool));
    const second = await createScreeningFixture(testDb(pool));

    const byMovie = await app.inject({
      method: 'GET',
      url: `/screenings?movieId=${first.movieId}`,
    });
    expect(byMovie.statusCode).toBe(200);
    const byMovieBody = byMovie.json() as { data: { id: number }[]; total: number };
    expect(byMovieBody.total).toBe(1);
    expect(byMovieBody.data.map((s) => s.id)).toEqual([first.screeningId]);

    const byCinema = await app.inject({
      method: 'GET',
      url: `/screenings?cinemaId=${second.cinemaId}`,
    });
    expect(byCinema.statusCode).toBe(200);
    expect((byCinema.json() as { total: number }).total).toBe(1);

    const both = await app.inject({
      method: 'GET',
      url: `/screenings?movieId=${first.movieId}&cinemaId=${second.cinemaId}`,
    });
    expect(both.statusCode).toBe(200);
    expect((both.json() as { total: number }).total).toBe(0);

    const invalid = await app.inject({ method: 'GET', url: '/screenings?movieId=abc' });
    expect(invalid.statusCode).toBe(400);
  });

  it('reflects authoritative reservation state in the seat map', async () => {
    const fixture = await createScreeningFixture(testDb(pool));
    const db = testDb(pool);

    const fresh = await app.inject({
      method: 'GET',
      url: `/screenings/${fixture.screeningId}/seats`,
    });
    expect(fresh.statusCode).toBe(200);
    const freshSeats = (fresh.json() as { seats: { status: string }[] }).seats;
    expect(freshSeats).toHaveLength(24);
    expect(new Set(freshSeats.map((s) => s.status))).toEqual(new Set(['available']));

    const created = await createReservation(
      db,
      {
        screeningId: fixture.screeningId,
        seatIds: [fixture.seatIds[0] as number, fixture.seatIds[1] as number],
        idempotencyKey: `seat-map-${fixture.screeningId}`,
      },
      { holdMinutes: 5 },
    );

    const held = await app.inject({
      method: 'GET',
      url: `/screenings/${fixture.screeningId}/seats`,
    });
    const heldSeats = (held.json() as { seats: { id: number; status: string }[] }).seats;
    const byId = new Map(heldSeats.map((s) => [s.id, s.status]));
    expect(byId.get(fixture.seatIds[0])).toBe('held');
    expect(byId.get(fixture.seatIds[1])).toBe('held');
    expect(byId.get(fixture.seatIds[2])).toBe('available');
    void created;

    const missing = await app.inject({ method: 'GET', url: '/screenings/999999/seats' });
    expect(missing.statusCode).toBe(404);
  });
});
