// Canonical E2E environment (single source; prepare.mjs mirrors it).
// Everything points at the dedicated load-test stack — never dev ports/DBs.

export type E2EEnv = {
  databaseUrl: string;
  apiPort: number;
  apiUrl: string;
  webPort: number;
  baseUrl: string;
  holdMinutes: number;
};

export function resolveE2EEnv(source: NodeJS.ProcessEnv = process.env): E2EEnv {
  const apiPort = Number(source.E2E_API_PORT ?? 3003);
  const webPort = Number(source.E2E_WEB_PORT ?? 4323);
  return {
    databaseUrl:
      source.E2E_DATABASE_URL ?? 'postgres://ingresso:ingresso@localhost:5432/ingresso_e2e',
    apiPort,
    apiUrl: `http://localhost:${apiPort}`,
    webPort,
    baseUrl: `http://localhost:${webPort}`,
    holdMinutes: 1,
  };
}

// Hard guard (adjustment 4): the ONLY acceptable database is ingresso_e2e,
// by exact name. Every helper — including cleanup — calls this first.
export function assertE2EDatabase(databaseUrl: string): string {
  const name = new URL(databaseUrl).pathname.replace(/^\//, '');
  if (name !== 'ingresso_e2e') {
    throw new Error(`refusing e2e operation against database "${name}": must be ingresso_e2e`);
  }
  return name;
}
