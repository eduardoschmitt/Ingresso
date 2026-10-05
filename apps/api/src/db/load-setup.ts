import 'dotenv/config';

import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { writeFileSync } from 'node:fs';

import { z } from 'zod';
import { Client } from 'pg';

import { createDb } from './client.js';
import { auditoriums, cinemas, movies, screenings, seats } from './schema.js';
import { runMigrations } from './migrate.js';

// Load-test dataset bootstrap (Phase 2).
//
// Safety (adjustment 2):
// - LOAD_DATABASE_URL MUST end with `_load`; anything else throws before any
//   connection is opened for writing.
// - After connecting, `current_database()` is re-verified before truncating.
// - Only the dedicated load database is ever touched; the dev database
//   (`ingresso`) can never match the guard.
// - Setup only ADDS rows (idempotent natural-key upserts); cleanup is expiry
//   (holds lapse in HOLD_MINUTES) — no destructive cascade beyond truncate.
//
// Writes tests/load/target.json (gitignored) with screening/seat ids for k6.

const loadEnvSchema = z.object({
  LOAD_DATABASE_URL: z
    .string()
    .min(1)
    .default('postgres://ingresso:ingresso@localhost:5432/ingresso_load'),
});

export type LoadTarget = {
  contention: { screeningId: number; seatIds: number[] };
  distributed: { screeningId: number; seatIds: number[] }[];
  retry: { screeningId: number; seatIds: number[] };
};

function loadConnectionString(): string {
  const { LOAD_DATABASE_URL } = loadEnvSchema.parse(process.env);
  const name = new URL(LOAD_DATABASE_URL).pathname.replace(/^\//, '');
  if (!name.endsWith('_load')) {
    throw new Error(`refusing load setup against database "${name}": name must end with _load`);
  }
  return LOAD_DATABASE_URL;
}

async function currentDatabase(connectionString: string): Promise<string> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query<{ current_database: string }>('select current_database()');
    const name = result.rows[0]?.current_database;
    if (name === undefined) throw new Error('load setup: cannot determine current database');
    return name;
  } finally {
    await client.end();
  }
}

export async function setupLoadDatabase(): Promise<LoadTarget> {
  const connectionString = loadConnectionString();

  const adminUrl = new URL(connectionString);
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const dbName = new URL(connectionString).pathname.replace(/^\//, '');
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code !== '42P04') throw err;
  } finally {
    await admin.end();
  }

  await runMigrations(connectionString);

  const verified = await currentDatabase(connectionString);
  if (!verified.endsWith('_load')) {
    throw new Error(`refusing load setup: connected to "${verified}"`);
  }

  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString });
  try {
    const db = createDb(pool);
    await pool.query(
      'TRUNCATE reservation_seats, reservations, screenings, seats, auditoriums, cinemas, movies CASCADE',
    );

    const [movie] = await db
      .insert(movies)
      .values({ title: 'Load Test Film', releaseYear: 2008, durationMinutes: 120 })
      .returning({ id: movies.id });
    const [cinema] = await db
      .insert(cinemas)
      .values({ name: 'Load Test Cinema', location: 'São Paulo, SP' })
      .returning({ id: cinemas.id });
    if (movie === undefined || cinema === undefined) throw new Error('load setup insert failed');

    const roomSpecs = [
      { name: 'Load Contention Room', rows: 5, seatsPerRow: 4 },
      { name: 'Load Room A', rows: 6, seatsPerRow: 4 },
      { name: 'Load Room B', rows: 6, seatsPerRow: 4 },
      { name: 'Load Room C', rows: 6, seatsPerRow: 4 },
      { name: 'Load Room D', rows: 6, seatsPerRow: 4 },
      // Isolated room for the identical-key retry scenario (E): fresh seats
      // regardless of what B/C/D consumed elsewhere.
      { name: 'Load Retry Room', rows: 2, seatsPerRow: 2 },
    ];
    const rooms: { id: number; seatIds: number[] }[] = [];
    for (const spec of roomSpecs) {
      const [room] = await db
        .insert(auditoriums)
        .values({ cinemaId: cinema.id, name: spec.name, capacity: spec.rows * spec.seatsPerRow })
        .returning({ id: auditoriums.id });
      if (room === undefined) throw new Error('load setup insert failed');
      const seatRows = await db
        .insert(seats)
        .values(
          Array.from({ length: spec.rows }, (_, r) =>
            Array.from({ length: spec.seatsPerRow }, (_, s) => ({
              auditoriumId: room.id,
              rowLabel: String.fromCharCode('A'.charCodeAt(0) + r),
              seatNumber: s + 1,
            })),
          ).flat(),
        )
        .returning({ id: seats.id });
      rooms.push({ id: room.id, seatIds: seatRows.map((s) => s.id) });
    }

    const base = new Date(Date.UTC(2026, 11, 25, 20, 0, 0));
    const screeningRows = await db
      .insert(screenings)
      .values(
        rooms.map((room, i) => ({
          movieId: movie.id,
          auditoriumId: room.id,
          startsAt: new Date(base.getTime() + i * 3 * 60 * 60_000),
          endsAt: new Date(base.getTime() + i * 3 * 60 * 60_000 + 150 * 60_000),
          priceCents: 3000,
        })),
      )
      .returning({ id: screenings.id });

    const target: LoadTarget = {
      contention: {
        screeningId: screeningRows[0]?.id ?? -1,
        seatIds: rooms[0]?.seatIds ?? [],
      },
      distributed: screeningRows.slice(1, 5).map((s, i) => ({
        screeningId: s.id,
        seatIds: rooms[i + 1]?.seatIds ?? [],
      })),
      retry: {
        screeningId: screeningRows[5]?.id ?? -1,
        seatIds: rooms[5]?.seatIds ?? [],
      },
    };
    if (
      target.contention.screeningId < 0 ||
      target.distributed.length !== 4 ||
      target.retry.screeningId < 0
    ) {
      throw new Error('load setup produced an incomplete target');
    }
    const here = path.dirname(fileURLToPath(import.meta.url));
    const targetPath = path.resolve(here, '../../../../tests/load/target.json');
    writeFileSync(targetPath, JSON.stringify(target, null, 2));
    console.log(
      `load-setup-ok screenings=${screeningRows.length} seats=${rooms.reduce((n, r) => n + r.seatIds.length, 0)}`,
    );
    return target;
  } finally {
    await pool.end();
  }
}

const invokedAsCli =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsCli) {
  await setupLoadDatabase();
}
