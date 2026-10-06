// TMDB poster sync (Phase 2.5). One-shot local cache builder — NOT part of
// the app bundle and NEVER committed (see .gitignore).
//
// Terms compliance (verified 2026-10-06 against the official API Terms of
// Use and FAQ):
// - Official TMDB API with a personal key, non-commercial study use.
// - Attribution (approved logo + exact notice) rendered in the UI whenever
//   posters are displayed; no poster is EVER shown with incomplete
//   attribution (see lib/posters.ts).
// - Local cache only, refreshed with --force well within the 6-month limit.
//   Downloaded files stay out of git (no redistribution via the repo).
// - No TMDB content is used for ML training or datasets.
//
// Usage (key lives ONLY in apps/web/.env, gitignored, never logged):
//   TMDB_API_KEY is read from the environment.
//   pnpm --filter @ingresso/web posters:sync          # fill missing only
//   pnpm --filter @ingresso/web posters:sync --force  # renew the whole cache
//
// Exit codes: 0 ok (even with per-movie pendings, all logged), 1 on missing
// key, logo failure, or unexpected errors. Valid cached images are never
// overwritten on error (download + convert in memory, single atomic write).

import 'dotenv/config';

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';

const API_BASE = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';
// Approved "blue_short" logo asset served by TMDB itself (verified 200 +
// valid SVG on 2026-10-06 via the asset URL observed on themoviedb.org).
// If TMDB rotates this fingerprint, sync fails loudly here — do NOT guess a
// replacement; re-verify against https://www.themoviedb.org/about/logos-attribution.
const LOGO_URL =
  'https://www.themoviedb.org/assets/2/v4/logos/v2/blue_short-8e7b30f73a4020692ccca9c88bafe5dcb6f8a62a4c6bc55cd9ba82bb2cd95f6c.svg';

const POSTERS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/posters');
const LOGO_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../public/tmdb-logo.svg',
);

// Deterministic seed mirror: local movie id → canonical original title/year.
// Must match apps/api/src/db/seed.ts; mismatches fail loudly below.
const MOVIES = [
  { id: 1, title: 'X-Men', year: 2000 },
  { id: 2, title: 'Gladiator', year: 2000 },
  { id: 3, title: 'The Lord of the Rings: The Fellowship of the Ring', year: 2001 },
  { id: 4, title: 'Spider-Man', year: 2002 },
  { id: 5, title: 'Catch Me If You Can', year: 2002 },
  { id: 6, title: 'Cidade de Deus', year: 2002 },
  { id: 7, title: 'The Lord of the Rings: The Two Towers', year: 2002 },
  { id: 8, title: 'The Lord of the Rings: The Return of the King', year: 2003 },
  { id: 9, title: 'Pirates of the Caribbean: The Curse of the Black Pearl', year: 2003 },
  { id: 10, title: 'Finding Nemo', year: 2003 },
  { id: 11, title: 'Batman Begins', year: 2005 },
  { id: 12, title: 'The Departed', year: 2006 },
  { id: 13, title: 'Transformers', year: 2007 },
  { id: 14, title: 'Ratatouille', year: 2007 },
  { id: 15, title: 'Iron Man', year: 2008 },
  { id: 16, title: 'The Dark Knight', year: 2008 },
  { id: 17, title: 'WALL-E', year: 2008 },
  { id: 18, title: 'Up', year: 2009 },
  { id: 19, title: 'Inception', year: 2010 },
] as const;

type SearchResult = {
  id: number;
  title?: string;
  original_title?: string;
  release_date?: string;
  poster_path: string | null;
};

async function fetchJson(url: string, apiKey: string): Promise<unknown> {
  const separator = url.includes('?') ? '&' : '?';
  let response: Response;
  try {
    response = await fetch(`${url}${separator}api_key=${encodeURIComponent(apiKey)}`);
  } catch (err) {
    throw new Error(`network failure for ${url.split('?')[0]}: ${String(err)}`);
  }
  if (response.status === 401) {
    throw new Error('TMDB rejected the key (401). Check TMDB_API_KEY, never share it.');
  }
  if (response.status === 429) {
    throw new Error('TMDB rate limit hit (429). Wait and retry; requests are sequential.');
  }
  if (!response.ok) {
    throw new Error(`TMDB HTTP ${response.status} for ${url.split('?')[0]}`);
  }
  return response.json() as Promise<unknown>;
}

function exactMatch(
  results: SearchResult[],
  title: string,
  year: number,
): { status: 'ok'; posterPath: string } | { status: 'pending'; reason: string } {
  // Punctuation-insensitive comparison ("WALL-E" vs TMDB's "WALL·E"), year
  // equality still required. Anything else is ambiguity, not a match.
  const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const wanted = normalize(title);
  const matches = results.filter(
    (r) =>
      (r.title !== undefined && normalize(r.title) === wanted) ||
      (r.original_title !== undefined && normalize(r.original_title) === wanted),
  );
  const yearMatches = matches.filter(
    (r) => typeof r.release_date === 'string' && Number(r.release_date.slice(0, 4)) === year,
  );
  if (yearMatches.length === 0) return { status: 'pending', reason: 'no exact title+year match' };
  if (yearMatches.length > 1)
    return { status: 'pending', reason: 'ambiguous: multiple exact matches' };
  const posterPath = yearMatches[0]?.poster_path ?? null;
  if (posterPath === null) return { status: 'pending', reason: 'match has no poster_path' };
  return { status: 'ok', posterPath };
}

async function sync(): Promise<void> {
  const apiKey = process.env.TMDB_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    console.error(
      'posters:sync refused: TMDB_API_KEY is not set. Put a personal key in apps/web/.env (gitignored, never commit or share it).',
    );
    process.exitCode = 1;
    return;
  }
  const force = process.argv.includes('--force');
  mkdirSync(POSTERS_DIR, { recursive: true });

  // Logo FIRST: without the approved logo, attribution is incomplete and no
  // poster may be published — abort before touching posters.
  try {
    const logoResponse = await fetch(LOGO_URL);
    if (!logoResponse.ok) {
      throw new Error(`logo HTTP ${logoResponse.status}`);
    }
    const svg = await logoResponse.text();
    if (!svg.includes('<svg')) {
      throw new Error('logo payload is not SVG');
    }
    writeFileSync(LOGO_PATH, svg);
    console.log('logo-ok tmdb-logo.svg');
  } catch (err) {
    console.error(
      `logo-failed (${String(err)}). Attribution would be incomplete: aborting, no posters touched.`,
    );
    process.exitCode = 1;
    return;
  }

  let downloaded = 0;
  let skipped = 0;
  const pending: string[] = [];
  for (const movie of MOVIES) {
    const outPath = path.join(POSTERS_DIR, `${movie.id}.webp`);
    try {
      const data = (await fetchJson(
        `${API_BASE}/search/movie?query=${encodeURIComponent(movie.title)}&year=${movie.year}&include_adult=false&language=en-US`,
        apiKey,
      )) as { results?: SearchResult[] };
      const matched = exactMatch(data.results ?? [], movie.title, movie.year);
      if (matched.status === 'pending') {
        pending.push(`${movie.id} ${movie.title} (${matched.reason})`);
        continue;
      }
      const target = path.join(POSTERS_DIR, `${movie.id}.webp`);
      const exists = await import('node:fs').then((fs) => fs.existsSync(target));
      if (exists && !force) {
        skipped += 1;
        continue;
      }
      const imageResponse = await fetch(`${IMAGE_BASE}${matched.posterPath}`);
      if (!imageResponse.ok) {
        pending.push(`${movie.id} ${movie.title} (image HTTP ${imageResponse.status})`);
        continue;
      }
      // Convert fully in memory; write once. A failure here never touches a
      // previously valid file.
      const webp = await sharp(await imageResponse.arrayBuffer())
        .webp({ quality: 82 })
        .toBuffer();
      writeFileSync(outPath, webp);
      downloaded += 1;
      console.log(`poster-ok ${movie.id} ${movie.title}`);
    } catch (err) {
      pending.push(`${movie.id} ${movie.title} (error: ${String(err)})`);
    }
  }
  console.log(
    `posters-summary downloaded=${downloaded} skipped=${skipped} pending=${pending.length}`,
  );
  for (const line of pending) {
    console.log(`poster-pending ${line}`);
  }
}

const invokedAsCli =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsCli) {
  await sync();
}
