import 'dotenv/config';

import { ZodError } from 'zod';

import { buildApp } from './app.js';
import { env } from './env.js';

async function main(): Promise<void> {
  const app = buildApp();
  await app.listen({ port: env.PORT, host: env.HOST });
}

main().catch((err) => {
  // Never print raw boot errors: Zod messages can echo environment values.
  // Paths + rule names are enough to fix configuration.
  if (err instanceof ZodError) {
    console.error('Invalid environment configuration:');
    for (const issue of err.issues) {
      console.error(` - ${issue.path.join('.')}: ${issue.code}`);
    }
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});
