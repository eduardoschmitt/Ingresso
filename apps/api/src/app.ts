import Fastify, { type FastifyInstance } from 'fastify';

export const HEALTH_RESPONSE = {
  status: 'ok',
  service: 'ingresso-api',
} as const;

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/health', async () => HEALTH_RESPONSE);

  return app;
}
