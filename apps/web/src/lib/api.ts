import { z } from 'zod';

import type { CinemaDto, MovieDto, Paged, ScreeningDto, SeatMapDto } from '@ingresso/shared';

// Runtime-safe HTTP client for the catalog API.
//
// Usable at BUILD time (Astro frontmatter prerendering, Milestone 1) and at
// REQUEST time (React islands with client:load for screenings/seats/
// reservations, Milestones 2-4). Only catalog data ever crosses the build
// boundary — mutable seat availability and reservation state must NEVER be
// prerendered; those always go through islands at runtime.

// Exact-equality guard: the zod schemas below are runtime validators for
// untrusted HTTP responses; the static contract lives in @ingresso/shared.
// If the API shape drifts, this assignment fails typecheck (loud, not silent).
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

function assertContract<T extends true>(value: T): void {
  void value;
}

const movieSchema = z.object({
  id: z.number(),
  title: z.string(),
  titlePtBr: z.string().nullable(),
  releaseYear: z.number(),
  durationMinutes: z.number().nullable(),
  synopsis: z.string().nullable(),
  genre: z.string().nullable(),
  posterUrl: z.string().nullable(),
});

assertContract<Equals<z.infer<typeof movieSchema>, MovieDto>>(true);

const cinemaSchema = z.object({
  id: z.number(),
  name: z.string(),
  location: z.string(),
});

assertContract<Equals<z.infer<typeof cinemaSchema>, CinemaDto>>(true);

const screeningSchema = z.object({
  id: z.number(),
  movieId: z.number(),
  movieTitle: z.string(),
  auditoriumId: z.number(),
  auditoriumName: z.string(),
  cinemaId: z.number(),
  cinemaName: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  priceCents: z.number(),
});

assertContract<Equals<z.infer<typeof screeningSchema>, ScreeningDto>>(true);

const seatSchema = z.object({
  id: z.number(),
  row: z.string(),
  number: z.number(),
  status: z.enum(['available', 'held', 'sold']),
});

const seatMapSchema = z.object({
  screeningId: z.number(),
  seats: z.array(seatSchema),
});

assertContract<Equals<z.infer<typeof seatMapSchema>, SeatMapDto>>(true);

function pagedSchema<T>(item: z.ZodType<T>) {
  return z.object({
    data: z.array(item),
    page: z.number(),
    pageSize: z.number(),
    total: z.number(),
  });
}

export class ApiError extends Error {
  constructor(
    public endpoint: string,
    public status: number | null,
    message: string,
  ) {
    super(message);
  }
}

async function fetchJson(endpoint: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(endpoint, init);
  } catch (err) {
    // Cancellation is not a failure: let callers detect AbortError as-is.
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(endpoint, null, `Catalog API unreachable at ${endpoint}: ${String(err)}`);
  }
  if (!response.ok) {
    throw new ApiError(endpoint, response.status, `Catalog API ${response.status} at ${endpoint}`);
  }
  return response.json() as Promise<unknown>;
}

function parseWith<T>(schema: z.ZodType<T>, endpoint: string, payload: unknown): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiError(endpoint, null, `Unexpected catalog payload at ${endpoint}`);
  }
  return parsed.data;
}

// Fetches EVERY page (pageSize 100) so callers always see the full set,
// never just the first page. Throws on any transport or shape failure so
// `astro build` fails explicitly (adjustment 2).
export async function listAllMovies(baseUrl: string): Promise<MovieDto[]> {
  return listAllPaged(baseUrl, '/movies', {}, pagedSchema(movieSchema));
}

async function listAllPaged<T>(
  baseUrl: string,
  path: string,
  params: Record<string, number | undefined>,
  schema: z.ZodType<Paged<T>>,
): Promise<T[]> {
  const query = new URLSearchParams({ page: '1', pageSize: '100' });
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const items: T[] = [];
  let page = 1;
  let total = Number.POSITIVE_INFINITY;
  while (items.length < total) {
    query.set('page', String(page));
    const endpoint = `${baseUrl}${path}?${query.toString()}`;
    const chunk = parseWith(schema, endpoint, await fetchJson(endpoint));
    items.push(...chunk.data);
    total = chunk.total;
    page += 1;
    if (page > 100) {
      throw new ApiError(baseUrl, null, 'Catalog pagination did not converge after 100 pages');
    }
  }
  return items;
}

export async function listAllCinemas(baseUrl: string): Promise<CinemaDto[]> {
  return listAllPaged(baseUrl, '/cinemas', {}, pagedSchema(cinemaSchema));
}

export type ScreeningFilter = {
  movieId?: number;
  cinemaId?: number;
};

export async function listAllScreenings(
  baseUrl: string,
  filter: ScreeningFilter = {},
): Promise<ScreeningDto[]> {
  return listAllPaged(baseUrl, '/screenings', filter, pagedSchema(screeningSchema));
}

// Returns null on 404 (unknown screening); throws ApiError otherwise.
// Used by the runtime island; static shells never fetch availability.
export async function getScreening(
  baseUrl: string,
  screeningId: number,
  init?: RequestInit,
): Promise<ScreeningDto | null> {
  const endpoint = `${baseUrl}/screenings/${screeningId}`;
  let response: Response;
  try {
    response = await fetch(endpoint, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(endpoint, null, `Catalog API unreachable at ${endpoint}: ${String(err)}`);
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new ApiError(endpoint, response.status, `Catalog API ${response.status} at ${endpoint}`);
  }
  return parseWith(screeningSchema, endpoint, await response.json());
}

export async function getSeatMap(
  baseUrl: string,
  screeningId: number,
  init?: RequestInit,
): Promise<SeatMapDto> {
  const endpoint = `${baseUrl}/screenings/${screeningId}/seats`;
  return parseWith(seatMapSchema, endpoint, await fetchJson(endpoint, init));
}
