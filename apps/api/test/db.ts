import 'dotenv/config';

import { z } from 'zod';
import { Client, Pool, type QueryResult } from 'pg';

import { createDb, type Db } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';

// Test database harness (adjustment 6: identity + isolation guards).
//
// - The test database name MUST end with `_test`; anything else throws before
//   any connection is used destructively.
// - Before every truncate we re-verify `current_database()` on the live
//   connection matches the expected name (protects against pool/URL drift).
// - Only the allowlisted Ingresso tables are truncated; nothing else.

const testEnvSchema = z.object({
  TEST_DATABASE_URL: z
    .string()
    .min(1)
    .default('postgres://ingresso:ingresso@localhost:5432/ingresso_test'),
});

const TRUNCATED_TABLES = [
  'reservation_seats',
  'reservations',
  'screenings',
  'seats',
  'auditoriums',
  'cinemas',
  'movies',
] as const;

export function testConnectionString(): string {
  return testEnvSchema.parse(process.env).TEST_DATABASE_URL;
}

export function expectedTestDatabaseName(connectionString: string): string {
  const name = new URL(connectionString).pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) {
    throw new Error(
      `refusing to run integration tests against database "${name}": name must end with _test`,
    );
  }
  return name;
}

// Creates the database (if missing) and applies migrations. Safe to call
// repeatedly; throws before doing anything unless the name guard passes.
export async function ensureTestDatabase(): Promise<string> {
  const connectionString = testConnectionString();
  const dbName = expectedTestDatabaseName(connectionString);

  const adminUrl = new URL(connectionString);
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } catch (err) {
    if (!isDuplicateDatabase(err)) throw err;
  } finally {
    await admin.end();
  }

  await runMigrations(connectionString);
  return connectionString;
}

export function testPool(connectionString: string, max = 5): Pool {
  return new Pool({ connectionString, max });
}

export function testDb(pool: Pool): Db {
  return createDb(pool);
}

export async function resetDatabase(pool: Pool, connectionString: string): Promise<void> {
  const expected = expectedTestDatabaseName(connectionString);
  const client = await pool.connect();
  try {
    const result: QueryResult<{ current_database: string }> = await client.query(
      'select current_database()',
    );
    const actual = result.rows[0]?.current_database;
    if (actual !== expected) {
      throw new Error(
        `refusing to truncate: connected to "${actual ?? 'unknown'}", expected "${expected}"`,
      );
    }
    await client.query(`TRUNCATE ${TRUNCATED_TABLES.join(', ')} CASCADE`);
  } finally {
    client.release();
  }
}

function isDuplicateDatabase(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === '42P04';
}
