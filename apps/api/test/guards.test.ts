import { afterEach, describe, expect, it, vi } from 'vitest';

import { assertLocalDatabaseUrl } from '../src/db/guards.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('database safety guard', () => {
  it('accepts loopback hosts', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      expect(() => assertLocalDatabaseUrl(`postgres://u:p@${host}:5432/db`, 'test')).not.toThrow();
    }
  });

  it('refuses remote hosts without explicit opt-out', () => {
    for (const url of [
      'postgres://u:p@db.example.com:5432/db',
      'postgres://u:p@192.168.1.10:5432/db',
      'postgres://u:p@10.0.0.5/db',
    ]) {
      expect(() => assertLocalDatabaseUrl(url, 'test')).toThrow(/non-local/);
    }
  });

  it('refuses malformed URLs', () => {
    expect(() => assertLocalDatabaseUrl('not-a-url', 'test')).toThrow(/invalid/);
  });

  it('honors the explicit remote opt-out with a warning', () => {
    vi.stubEnv('INGRESSO_ALLOW_REMOTE_DB', '1');
    const warned: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((message: string) => {
      warned.push(message);
    });
    expect(() =>
      assertLocalDatabaseUrl('postgres://u:p@db.example.com:5432/db', 'test'),
    ).not.toThrow();
    expect(warned.join(' ')).toContain('INGRESSO_ALLOW_REMOTE_DB=1');
  });
});
