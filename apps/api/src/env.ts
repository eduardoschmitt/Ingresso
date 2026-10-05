import { z } from 'zod';

// All server configuration is validated at the system boundary.
// Every variable has a safe local default so a zero-config run works;
// invalid values fail fast instead of starting a misconfigured server.
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: z.string().min(1).default('postgres://ingresso:ingresso@localhost:5432/ingresso'),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(source);
}

export const env: Env = loadEnv();
