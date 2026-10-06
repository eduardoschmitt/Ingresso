// Safety guard for schema/data CLIs (db:migrate, db:seed).
//
// These commands run with ambient credentials and no database-name context,
// so a misconfigured DATABASE_URL could target a shared or production host.
// Rule: only loopback hosts are accepted implicitly; anything else requires
// the explicit, deliberate opt-out INGRESSO_ALLOW_REMOTE_DB=1 (which prints
// a loud warning). No name allowlists — local reproduction with any database
// name keeps working.

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function assertLocalDatabaseUrl(rawUrl: string, purpose: string): void {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    throw new Error(`${purpose}: refusing invalid DATABASE_URL`);
  }
  if (LOOPBACK_HOSTS.has(host)) return;
  if (process.env.INGRESSO_ALLOW_REMOTE_DB === '1') {
    console.warn(
      `${purpose}: continuing against non-local host "${host}" via explicit INGRESSO_ALLOW_REMOTE_DB=1`,
    );
    return;
  }
  throw new Error(
    `${purpose}: refusing non-local database host "${host}" ` +
      `(set INGRESSO_ALLOW_REMOTE_DB=1 to override explicitly)`,
  );
}
