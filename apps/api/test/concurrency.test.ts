import { count, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { reservations } from '../src/db/schema.js';
import { cancelReservation, createReservation } from '../src/reservations/service.js';
import { ensureTestDatabase, resetDatabase, testDb, testPool } from './db.js';
import { createScreeningFixture } from './fixtures.js';

// Real competing transactions: every actor gets its own connection pool
// (distinct PostgreSQL sessions). No mocks, no in-memory substitutes.

let connectionString: string;

beforeAll(async () => {
  connectionString = await ensureTestDatabase();
});

beforeEach(async () => {
  const janitor = testPool(connectionString, 2);
  try {
    await resetDatabase(janitor, connectionString);
  } finally {
    await janitor.end();
  }
});

afterAll(async () => {
  // Pools are per-actor and closed inside each test.
});

type Actor = { run: () => Promise<unknown>; pool: Pool };

function actor<T>(fn: (db: ReturnType<typeof testDb>) => Promise<T>): Actor {
  const pool = testPool(connectionString, 2);
  return {
    pool,
    run: () => fn(testDb(pool)),
  };
}

async function settle(actors: Actor[]): Promise<PromiseSettledResult<unknown>[]> {
  try {
    return await Promise.allSettled(actors.map((a) => a.run()));
  } finally {
    await Promise.all(actors.map((a) => a.pool.end()));
  }
}

describe('concurrent reservations', () => {
  it('lets exactly one contender hold the same seat', async () => {
    const setup = testPool(connectionString, 2);
    const fixture = await createScreeningFixture(testDb(setup));
    await setup.end();
    const seatId = fixture.seatIds[0] as number;

    const actors = Array.from({ length: 8 }, (_, i) =>
      actor((db) =>
        createReservation(
          db,
          { screeningId: fixture.screeningId, seatIds: [seatId], idempotencyKey: `race-${i}` },
          { holdMinutes: 5 },
        ),
      ),
    );
    const outcomes = await settle(actors);

    const wins = outcomes.filter((o) => o.status === 'fulfilled');
    const losses = outcomes.filter((o) => o.status === 'rejected');
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(7);
    for (const loss of losses) {
      expect(loss).toMatchObject({ reason: { statusCode: 409, code: 'seat_unavailable' } });
    }

    const check = testPool(connectionString, 2);
    try {
      const [{ total }] = await testDb(check)
        .select({ total: count() })
        .from(reservations)
        .then((rows) => rows);
      expect(total).toBe(1);
    } finally {
      await check.end();
    }
  });

  it('holds disjoint seats for concurrent buyers', async () => {
    const setup = testPool(connectionString, 2);
    const fixture = await createScreeningFixture(testDb(setup));
    await setup.end();

    const actors = fixture.seatIds.slice(0, 6).map((seatId, i) =>
      actor((db) =>
        createReservation(
          db,
          {
            screeningId: fixture.screeningId,
            seatIds: [seatId],
            idempotencyKey: `disjoint-${i}`,
          },
          { holdMinutes: 5 },
        ),
      ),
    );
    const outcomes = await settle(actors);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(6);

    const check = testPool(connectionString, 2);
    try {
      const [{ total }] = await testDb(check)
        .select({ total: count() })
        .from(reservations)
        .then((rows) => rows);
      expect(total).toBe(6);
    } finally {
      await check.end();
    }
  });

  it('cancels exactly once under concurrent cancellation', async () => {
    const setup = testPool(connectionString, 2);
    const setupDb = testDb(setup);
    const fixture = await createScreeningFixture(setupDb);
    const created = await createReservation(
      setupDb,
      {
        screeningId: fixture.screeningId,
        seatIds: [fixture.seatIds[0] as number],
        idempotencyKey: `cancel-race-${fixture.screeningId}`,
      },
      { holdMinutes: 5 },
    );
    await setup.end();

    const actors = Array.from({ length: 5 }, () =>
      actor((db) => cancelReservation(db, created.id)),
    );
    const outcomes = await settle(actors);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(4);

    const check = testPool(connectionString, 2);
    try {
      const rows = await testDb(check)
        .select()
        .from(reservations)
        .where(eq(reservations.id, created.id));
      expect(rows[0]?.status).toBe('CANCELLED');
    } finally {
      await check.end();
    }
  });

  it('returns the single original row for concurrent identical retries', async () => {
    const setup = testPool(connectionString, 2);
    const fixture = await createScreeningFixture(testDb(setup));
    await setup.end();
    const payload = {
      screeningId: fixture.screeningId,
      seatIds: [fixture.seatIds[0] as number],
      idempotencyKey: `retry-race-${fixture.screeningId}`,
    };

    const actors = Array.from({ length: 6 }, () =>
      actor((db) => createReservation(db, payload, { holdMinutes: 5 })),
    );
    const outcomes = await settle(actors);

    const wins = outcomes.filter((o) => o.status === 'fulfilled');
    expect(wins).toHaveLength(6);
    const ids = new Set(wins.map((w) => (w as PromiseFulfilledResult<{ id: number }>).value.id));
    expect(ids.size).toBe(1);

    const check = testPool(connectionString, 2);
    try {
      const rows = await testDb(check)
        .select()
        .from(reservations)
        .where(eq(reservations.idempotencyKey, payload.idempotencyKey));
      expect(rows).toHaveLength(1);
    } finally {
      await check.end();
    }
  });
});
