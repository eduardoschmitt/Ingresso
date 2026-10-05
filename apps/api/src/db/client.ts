import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { env } from '../env.js';
import * as schema from './schema.js';

// Factories only — no connections are opened at import time.
// The pool connects lazily on the first query.
export function createPool(connectionString: string = env.DATABASE_URL): Pool {
  return new Pool({ connectionString });
}

export function createDb(pool: Pool = createPool()): Db {
  return drizzle(pool, { schema });
}

export type Db = NodePgDatabase<typeof schema>;

// Transaction handle passed to domain logic. Extracted from the transaction
// callback signature so services accept both root handles and transactions.
export type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];
