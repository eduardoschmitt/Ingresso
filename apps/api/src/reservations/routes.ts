import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Db } from '../db/client.js';
import { badRequest } from '../http/errors.js';
import { idParamSchema } from '../http/pagination.js';
import { cancelReservation, createReservation, getReservation } from './service.js';

const bodySchema = z.object({
  screeningId: z.unknown(),
  seatIds: z.unknown(),
});

const idempotencyKeySchema = z.string().min(1).max(200);

export function registerReservationRoutes(
  app: FastifyInstance,
  deps: { db: Db; holdMinutes: number },
): void {
  app.post('/reservations', async (request, reply) => {
    const header = request.headers['idempotency-key'];
    const rawKey = Array.isArray(header) ? header[0] : header;
    if (rawKey === undefined) {
      throw badRequest('idempotency_key_missing', 'Idempotency-Key header is required');
    }
    const idempotencyKey = idempotencyKeySchema.parse(rawKey);
    const body = bodySchema.parse(request.body);
    const result = await createReservation(
      deps.db,
      { ...body, idempotencyKey },
      { holdMinutes: deps.holdMinutes },
    );
    return reply.code(result.created ? 201 : 200).send(result);
  });

  app.get('/reservations/:id', async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return getReservation(deps.db, id);
  });

  app.delete('/reservations/:id', async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return cancelReservation(deps.db, id);
  });
}
