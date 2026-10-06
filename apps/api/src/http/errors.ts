import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

// Stable error contract: every expected failure is { error: { code, message } }.
// Diagnostic details stay out of 5xx responses.
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function notFound(resource: string): HttpError {
  return new HttpError(404, `${resource}_not_found`, `${resource} not found`);
}

export function conflict(code: string, message: string): HttpError {
  return new HttpError(409, code, message);
}

export function badRequest(code: string, message: string): HttpError {
  return new HttpError(400, code, message);
}

type ErrorBody = { error: { code: string; message: string; details?: unknown } };

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof HttpError) {
      const body: ErrorBody = { error: { code: err.code, message: err.message } };
      void reply.code(err.statusCode).send(body);
      return;
    }
    if (err instanceof ZodError) {
      const body: ErrorBody = {
        error: {
          code: 'validation_error',
          message: 'Invalid request',
          details: err.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      };
      void reply.code(400).send(body);
      return;
    }
    const statusCode =
      typeof (err as { statusCode?: unknown }).statusCode === 'number'
        ? (err as { statusCode: number }).statusCode
        : 500;
    if (statusCode >= 500) {
      // Sanitized stderr log: error class + driver code only, never messages
      // (which may embed SQL, params, or connection details). The client
      // always receives the generic body below.
      const code =
        typeof (err as { code?: unknown }).code === 'string'
          ? (err as { code: string }).code
          : 'unknown';
      console.error(
        JSON.stringify({
          scope: 'api-error',
          error: err instanceof Error ? err.constructor.name : typeof err,
          code,
        }),
      );
      const body: ErrorBody = { error: { code: 'internal_error', message: 'Unexpected error' } };
      void reply.code(500).send(body);
      return;
    }
    // Echo messages only for Fastify's own client errors (FST_*); anything
    // else becomes generic so library internals never leak.
    const fastifyCode =
      typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : null;
    const body: ErrorBody = {
      error: {
        code: 'bad_request',
        message:
          fastifyCode !== null && fastifyCode.startsWith('FST_') && err instanceof Error
            ? err.message
            : 'Bad request',
      },
    };
    void reply.code(statusCode).send(body);
  });
}
