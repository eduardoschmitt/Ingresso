import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Build-time poster gating (Astro frontmatter only — never imported by
// runtime islands). Deterministic mapping: movie id → /posters/{id}.webp.
//
// Attribution completeness (TMDB terms) is a display precondition: posters
// are shown ONLY when the approved logo file is also present. Otherwise the
// typographic fallback renders and no TMDB content is published.

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');

export function posterUrl(movieId: number): string | null {
  if (!tmdbAttributionComplete()) return null;
  return existsSync(path.join(PUBLIC_DIR, 'posters', `${movieId}.webp`))
    ? `/posters/${movieId}.webp`
    : null;
}

export function tmdbAttributionComplete(): boolean {
  return existsSync(path.join(PUBLIC_DIR, 'tmdb-logo.svg'));
}
