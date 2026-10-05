import { describe, expect, it } from 'vitest';

import { HEALTH_RESPONSE, buildApp } from '../src/app.js';

describe('GET /health', () => {
  it('responds 200 with the service status', async () => {
    const app = buildApp();
    try {
      const response = await app.inject({ method: 'GET', url: '/health' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ...HEALTH_RESPONSE });
    } finally {
      await app.close();
    }
  });

  it('returns 404 for unknown routes', async () => {
    const app = buildApp();
    try {
      const response = await app.inject({ method: 'GET', url: '/unknown' });

      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
