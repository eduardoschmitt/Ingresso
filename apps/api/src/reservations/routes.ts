import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Db } from '../db/client.js';
import { badRequest } from '../http/errors.js';
import { idParamSchema } from '../http/pagination.js';
import type {
  ReservationOperation,
  ReservationOutcome,
  Metrics,
} from '../observability/metrics.js';
import { outcomeFromError } from '../observability/metrics.js';
import { cancelReservation, createReservation, getReservation } from './service.js';

const bodySchema = z.object({
  screeningId: z.unknown(),
  seatIds: z.unknown(),
});

const idempotencyKeySchema = z.string().min(1).max(200);

export function registerReservationRoutes(
  app: FastifyInstance,
  deps: { db: Db; holdMinutes: number; metrics: Metrics },
): void {
  const timed = async <T>(
    operation: ReservationOperation,
    run: () => Promise<T>,
    onSuccess: (result: T) => ReservationOutcome,
  ): Promise<T> => {
    const startedAt = performance.now();
    try {
      const result = await run();
      deps.metrics.observeReservationOutcome(onSuccess(result));
      return result;
    } catch (err) {
      deps.metrics.observeReservationOutcome(outcomeFromError(err));
      throw err;
    } finally {
      // Recorded on success and failure alike (adjustment 3): contention
      // shows up as slow failed transactions too.
      deps.metrics.observeReservationTransaction(operation, (performance.now() - startedAt) / 1000);
    }
  };

  app.post('/reservations', async (request, reply) => {
    const header = request.headers['idempotency-key'];
    const rawKey = Array.isArray(header) ? header[0] : header;
    if (rawKey === undefined) {
      throw badRequest('idempotency_key_missing', 'Idempotency-Key header is required');
    }
    const idempotencyKey = idempotencyKeySchema.parse(rawKey);
    const body = bodySchema.parse(request.body);
    const result = await timed(
      'create',
      () =>
        createReservation(
          deps.db,
          { ...body, idempotencyKey },
          { holdMinutes: deps.holdMinutes, observe: deps.metrics.observer },
        ),
      (created) => (created.created ? 'created' : 'replayed'),
    );
    return reply.code(result.created ? 201 : 200).send(result);
  });

  app.get('/reservations/:id', async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return timed(
      'read',
      () => getReservation(deps.db, id, deps.metrics.observer),
      (reservation) => (reservation.status === 'EXPIRED' ? 'expired_observed' : 'read'),
    );
  });

  app.delete('/reservations/:id', async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return timed(
      'cancel',
      () => cancelReservation(deps.db, id, deps.metrics.observer),
      () => 'cancelled',
    );
  });
}
