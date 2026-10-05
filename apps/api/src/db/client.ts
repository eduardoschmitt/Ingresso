import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { env } from '../env.js';
import * as schema from './schema.js';

// Factories only — no connections are opened at import time.
// The pool connects lazily on the first query.
export function createPool(connectionString: string = env.DATABASE_URL): Pool {
  return new Pool({ connectionString });
}

export function createDb(pool: Pool = createPool()): NodePgDatabase<typeof schema> {
  return drizzle(pool, { schema });
}
