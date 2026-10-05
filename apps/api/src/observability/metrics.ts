import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

import { HttpError } from '../http/errors.js';

// Prometheus instrumentation (Phase 2). Kept in this module, away from
// business logic: services receive at most an optional `ReservationObserver`
// (default: no-op); routes map results/errors to outcome labels.
//
// Cardinality rules:
// - `route` is the registered pattern (`/movies/:id`), never a concrete URL.
// - `status` is the numeric HTTP status (bounded set).
// - `operation`/`outcome` are fixed enums below. No ids, keys, or user data.
// - `/metrics` itself is excluded from HTTP metrics.

export type ReservationOperation = 'create' | 'read' | 'cancel';

export type ReservationObserver = {
  lockWait(operation: ReservationOperation, seconds: number): void;
};

export const noopObserver: ReservationObserver = {
  lockWait: () => {},
};

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
const TXN_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

export type Metrics = {
  registry: Registry;
  render(): Promise<string>;
  observeReservationOutcome(outcome: ReservationOutcome): void;
  observeReservationTransaction(operation: ReservationOperation, seconds: number): void;
  observer: ReservationObserver;
  watchPool(pool: Pool): void;
  registerHttpHooks(app: FastifyInstance): void;
  registerMetricsRoute(app: FastifyInstance): void;
};

export type ReservationOutcome =
  | 'created'
  | 'replayed'
  | 'read'
  | 'expired_observed'
  | 'cancelled'
  | 'cancel_rejected'
  | 'conflict_seat'
  | 'conflict_idempotency'
  | 'conflict_concurrent'
  | 'invalid_request'
  | 'not_found';

export function outcomeFromError(err: unknown): ReservationOutcome {
  if (err instanceof HttpError) {
    switch (err.code) {
      case 'seat_unavailable':
        return 'conflict_seat';
      case 'idempotency_conflict':
        return 'conflict_idempotency';
      case 'reservation_conflict':
        return 'conflict_concurrent';
      case 'reservation_confirmed':
      case 'reservation_not_cancellable':
        return 'cancel_rejected';
      case 'seat_not_found':
      case 'screening_not_found':
      case 'movie_not_found':
      case 'cinema_not_found':
      case 'reservation_not_found':
        return 'not_found';
      default:
        return 'invalid_request';
    }
  }
  return 'invalid_request';
}

export function createMetrics(): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const httpRequests = new Counter({
    name: 'ingresso_http_requests_total',
    help: 'Completed HTTP requests by method, registered route pattern, and status.',
    labelNames: ['method', 'route', 'status'],
    registers: [registry],
  });

  const httpDuration = new Histogram({
    name: 'ingresso_http_request_duration_seconds',
    help: 'HTTP request duration by method, route pattern, and status (adjustment 3).',
    labelNames: ['method', 'route', 'status'],
    buckets: LATENCY_BUCKETS,
    registers: [registry],
  });

  const httpInFlight = new Gauge({
    name: 'ingresso_http_in_flight_requests',
    help: 'Currently active HTTP requests.',
    registers: [registry],
  });

  const poolConnections = new Gauge({
    name: 'ingresso_db_pool_connections',
    help: 'PostgreSQL pool connections by state (read from pg Pool at scrape time).',
    labelNames: ['state'],
    registers: [registry],
    collect() {
      // `this` is the gauge; the pool is attached via watchPool().
      const pool = watchedPool;
      if (pool === undefined) return;
      this.set({ state: 'total' }, pool.totalCount);
      this.set({ state: 'idle' }, pool.idleCount);
      this.set({ state: 'waiting' }, pool.waitingCount);
    },
  });

  const reservationOutcomes = new Counter({
    name: 'ingresso_reservation_outcomes_total',
    help: 'Reservation operation results by outcome (bounded enum, no request data).',
    labelNames: ['outcome'],
    registers: [registry],
  });

  const reservationTxnDuration = new Histogram({
    name: 'ingresso_reservation_transaction_duration_seconds',
    help: 'Reservation transaction wall time by operation, recorded on success and failure (adjustment 3).',
    labelNames: ['operation'],
    buckets: TXN_BUCKETS,
    registers: [registry],
  });

  const screeningLockWait = new Histogram({
    name: 'ingresso_reservation_screening_lock_wait_seconds',
    help: 'Wall time to acquire the screening row lock (FOR UPDATE) by operation.',
    labelNames: ['operation'],
    buckets: TXN_BUCKETS,
    registers: [registry],
  });

  // Pool attached by watchPool(); read inside collect() above so scrapes
  // always see current values without timers.
  let watchedPool: Pool | undefined;

  const metrics: Metrics = {
    registry,
    render: () => registry.metrics(),
    observeReservationOutcome: (outcome) => reservationOutcomes.inc({ outcome }),
    observeReservationTransaction: (operation, seconds) =>
      reservationTxnDuration.observe({ operation }, seconds),
    observer: {
      lockWait: (operation, seconds) => screeningLockWait.observe({ operation }, seconds),
    },
    watchPool: (pool) => {
      watchedPool = pool;
      poolConnections.set({ state: 'total' }, pool.totalCount);
      poolConnections.set({ state: 'idle' }, pool.idleCount);
      poolConnections.set({ state: 'waiting' }, pool.waitingCount);
    },
    registerHttpHooks: (app) => {
      app.addHook('onRequest', async (request) => {
        if (request.url.startsWith('/metrics')) return;
        httpInFlight.inc();
      });
      app.addHook('onResponse', async (request, reply) => {
        if (request.url.startsWith('/metrics')) return;
        httpInFlight.dec();
        const route = request.routeOptions?.url ?? 'unknown';
        const status = String(reply.statusCode);
        httpRequests.inc({ method: request.method, route, status });
        const durationSeconds = reply.elapsedTime / 1000;
        httpDuration.observe({ method: request.method, route, status }, durationSeconds);
      });
    },
    registerMetricsRoute: (app) => {
      app.get('/metrics', async (_request, reply) => {
        reply.header('Content-Type', registry.contentType);
        return registry.metrics();
      });
    },
  };

  return metrics;
}
