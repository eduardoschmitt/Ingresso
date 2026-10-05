import 'dotenv/config';

import { buildApp } from './app.js';
import { env } from './env.js';

async function main(): Promise<void> {
  const app = buildApp();
  await app.listen({ port: env.PORT, host: env.HOST });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
