import { defineConfig, devices } from '@playwright/test';

import { resolveE2EEnv } from './tests/e2e/env.js';

const env = resolveE2EEnv();

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  retries: 0,
  // Sequential workers: exclusive screening slots make tests
  // order-independent, but serial execution removes all timing
  // cross-talk (especially around the 1-minute expiry test).
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: './test-results',
  use: {
    baseURL: env.baseUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter @ingresso/api exec tsx src/index.ts',
      cwd: './apps/api',
      env: {
        PORT: String(env.apiPort),
        DATABASE_URL: env.databaseUrl,
        HOLD_MINUTES: String(env.holdMinutes),
        // The preview origin must be allowed, otherwise every browser fetch
        // fails while curl keeps working (CORS is browser-enforced).
        CORS_ORIGIN: env.baseUrl,
      },
      url: `${env.apiUrl}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command:
        'pnpm --filter @ingresso/web exec astro preview --port ' +
        String(env.webPort) +
        ' --host 127.0.0.1',
      url: env.baseUrl,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
