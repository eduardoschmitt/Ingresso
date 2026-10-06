import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';

import { registerCatalogRoutes } from './catalog/routes.js';
import { createDb, createPool, type Db } from './db/client.js';
import { env } from './env.js';
import { registerErrorHandler } from './http/errors.js';
import { createMetrics, type Metrics } from './observability/metrics.js';
import { registerReservationRoutes } from './reservations/routes.js';

export const HEALTH_RESPONSE = {
  status: 'ok',
  service: 'ingresso-api',
} as const;

export type AppDeps = {
  db?: Db;
  holdMinutes?: number;
  metrics?: Metrics;
};

export function buildApp(deps: AppDeps = {}): FastifyInstance {
  const app = Fastify({ logger: false });

  let pool: ReturnType<typeof createPool> | undefined;
  let db = deps.db;
  if (db === undefined) {
    pool = createPool();
    db = createDb(pool);
  }
  if (pool !== undefined) {
    const owned = pool;
    app.addHook('onClose', async () => {
      await owned.end();
    });
  }

  const metrics = deps.metrics ?? createMetrics();
  if (pool !== undefined) {
    metrics.watchPool(pool);
  }
  metrics.registerHttpHooks(app);

  // Restricted CORS so browser islands (web dev/preview origins) can read
  // the API. No wildcard: only explicitly configured origins are reflected.
  // Queued before route registration; Fastify resolves it at ready/listen.
  const allowedOrigins = env.CORS_ORIGIN.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  void app.register(cors, { origin: allowedOrigins });

  registerErrorHandler(app);

  app.get('/health', async () => HEALTH_RESPONSE);
  metrics.registerMetricsRoute(app);

  registerCatalogRoutes(app, { db });
  registerReservationRoutes(app, {
    db,
    holdMinutes: deps.holdMinutes ?? env.HOLD_MINUTES,
    metrics,
  });

  return app;
}
