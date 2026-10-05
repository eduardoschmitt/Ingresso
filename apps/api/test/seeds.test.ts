import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runSeed } from '../src/db/seed.js';
import { movies } from '../src/db/schema.js';
import { ensureTestDatabase, resetDatabase, testDb, testPool } from './db.js';

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

const REQUIRED_TITLES = [
  'The Dark Knight',
  'Iron Man',
  'Transformers',
  'X-Men',
  'Inception',
  'The Departed',
  'Catch Me If You Can',
];

describe('deterministic seeds', () => {
  it('is idempotent and contains the required catalog', async () => {
    const db = testDb(pool);

    const first = await runSeed(db);
    const second = await runSeed(db);
    expect(second).toEqual(first);
    expect(first.movies).toBeGreaterThanOrEqual(15);
    expect(first.movies).toBeLessThanOrEqual(20);

    const titles = (await db.select({ title: movies.title }).from(movies)).map((m) => m.title);
    for (const required of REQUIRED_TITLES) {
      expect(titles).toContain(required);
    }

    const years = await db.select({ year: movies.releaseYear }).from(movies);
    for (const { year } of years) {
      expect(year).toBeGreaterThanOrEqual(2000);
      expect(year).toBeLessThanOrEqual(2010);
    }
  });

  it('keeps seat counts consistent with auditorium capacity', async () => {
    const db = testDb(pool);
    await runSeed(db);

    const mismatches = await db.execute(sql`
      select a.id, a.capacity, count(s.id) as seats
      from auditoriums a
      left join seats s on s.auditorium_id = a.id
      group by a.id
      having count(s.id) <> a.capacity
    `);
    expect(mismatches.rows).toHaveLength(0);
  });

  it('leaves poster references absent without verified sources', async () => {
    const db = testDb(pool);
    await runSeed(db);

    const rows = await db.execute(
      sql`select count(*) as n from movies where poster_url is not null`,
    );
    expect((rows.rows[0] as { n: string }).n).toBe('0');
  });
});
