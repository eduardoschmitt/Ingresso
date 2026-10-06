// E2E preparation: reproducible database + freshly built frontend.
//
// Runs automatically as `pretest:e2e` before `playwright test`:
//   1. Resolves env (mirror of tests/e2e/env.ts defaults — keep in sync).
//   2. Refuses unless PUBLIC_API_URL matches the e2e API (adjustment 2:
//      a stale dist built against dev can never run here).
//   3. Creates ingresso_e2e if missing (guarded), applies canonical migrations.
//   4. Rebuilds the web with the e2e API URL baked in.
//   5. Verifies the built marker (dist/index.html references the e2e port).
//
// Only node builtins + root pg dependency. Never touches dev databases:
// every step re-asserts the exact database name.

import { execSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const databaseUrl =
  process.env.E2E_DATABASE_URL ?? 'postgres://ingresso:ingresso@localhost:5432/ingresso_e2e';
const apiPort = process.env.E2E_API_PORT ?? '3003';
const expectedApiUrl = `http://localhost:${apiPort}`;

function dbName(url) {
  const name = new URL(url).pathname.replace(/^\//, '');
  if (name !== 'ingresso_e2e') {
    throw new Error(`refusing e2e prepare against database "${name}": must be ingresso_e2e`);
  }
  return name;
}

function portInUse(port) {
  return new Promise((resolve) => {
    const probe = net
      .connect({ host: '127.0.0.1', port: Number(port) }, () => {
        probe.end();
        resolve(true);
      })
      .on('error', () => resolve(false));
    probe.setTimeout(2000, () => {
      probe.destroy();
      resolve(false);
    });
  });
}

function killTree(proc) {
  // shell:true spawns via cmd.exe: kill() alone would orphan the children.
  try {
    if (process.platform === 'win32' && proc.pid !== undefined) {
      execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' });
    } else {
      proc.kill();
    }
  } catch {
    // Already gone.
  }
}

const run = (command, env = {}) =>
  execSync(command, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });

const name = dbName(databaseUrl);
const publicApiUrl = process.env.PUBLIC_API_URL;
if (publicApiUrl !== expectedApiUrl) {
  throw new Error(
    `refusing e2e prepare: PUBLIC_API_URL must be exactly "${expectedApiUrl}" (got "${publicApiUrl ?? 'unset'}"). Stale artifacts are not allowed.`,
  );
}

const admin = new Client({
  connectionString: databaseUrl.replace(`/${name}`, '/postgres'),
});
await admin.connect();
try {
  await admin.query(`CREATE DATABASE "${name}"`);
  console.log(`e2e db created: ${name}`);
} catch (err) {
  if (err?.code !== '42P04') throw err;
  console.log(`e2e db exists: ${name}`);
} finally {
  await admin.end();
}

run('pnpm --filter @ingresso/api db:migrate', { DATABASE_URL: databaseUrl });

// Deterministic catalog seed (same rows every run on a fresh database).
// Tests own their reservations; catalog rows are read-only shared fixtures.
run('pnpm --filter @ingresso/api db:seed', { DATABASE_URL: databaseUrl });

// The static build prerenders catalog routes, so it needs a live API.
// A temporary instance (same env as the test servers) serves the build,
// then its whole tree is killed — the Playwright webServer starts fresh
// ones per run. A busy port aborts early instead of shadowing anything.
if (await portInUse(apiPort)) {
  throw new Error(
    `refusing e2e prepare: port ${apiPort} is already in use. Stop the stale server first.`,
  );
}
const apiEnv = {
  ...process.env,
  PORT: apiPort,
  DATABASE_URL: databaseUrl,
  HOLD_MINUTES: '1',
};
const tempApi = spawn('pnpm', ['--filter', '@ingresso/api', 'exec', 'tsx', 'src/index.ts'], {
  cwd: path.join(root, 'apps/api'),
  env: apiEnv,
  stdio: 'ignore',
  shell: true,
});
async function waitForHealth() {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const response = await fetch(`${expectedApiUrl}/health`);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) throw new Error('temporary e2e API never became healthy');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
try {
  await waitForHealth();
  run('pnpm --filter @ingresso/web build', { PUBLIC_API_URL: expectedApiUrl });
} finally {
  killTree(tempApi);
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

const indexHtml = readFileSync(path.join(root, 'apps/web/dist/index.html'), 'utf8');
if (!indexHtml.includes(`localhost:${apiPort}`)) {
  throw new Error('stale dist detected: built index.html does not reference the e2e API port');
}
console.log(`e2e prepare ok: db=${name} api=${expectedApiUrl}`);
