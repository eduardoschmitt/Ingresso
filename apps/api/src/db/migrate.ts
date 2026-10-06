import 'dotenv/config';

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client } from 'pg';

import { loadEnv } from '../env.js';
import { assertLocalDatabaseUrl } from './guards.js';

/** Absolute path of the drizzle migrations folder, independent of CWD. */
export function migrationsFolder(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');
}

export async function runMigrations(connectionString: string): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await migrate(drizzle(client), { migrationsFolder: migrationsFolder() });
  } finally {
    await client.end();
  }
}

const invokedAsCli =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsCli) {
  const { DATABASE_URL } = loadEnv();
  assertLocalDatabaseUrl(DATABASE_URL, 'db:migrate');
  await runMigrations(DATABASE_URL);
}
