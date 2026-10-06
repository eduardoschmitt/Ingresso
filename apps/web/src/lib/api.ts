import { z } from 'zod';

import type {
  CinemaDto,
  MovieDto,
  Paged,
  ReservationDto,
  ScreeningDto,
  SeatMapDto,
} from '@ingresso/shared';

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
    // Machine-readable backend code (e.g. seat_unavailable,
    // idempotency_conflict), when the response carried one. Absent for
    // transport failures — callers must not treat those as business outcomes.
    public code: string | null = null,
  ) {
    super(message);
  }
}

// Hard timeout so no operation hangs forever leaving the UI frozen with
// zero feedback. Caller-initiated aborts (unmount/refresh) stay silent;
// TIMEOUT aborts surface as ApiError so callers show retry UI.
const REQUEST_TIMEOUT_MS = 15_000;

function timedSignal(init?: RequestInit): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const caller = init?.signal;
  if (caller === undefined || caller === null) return timeout;
  return AbortSignal.any([caller, timeout]);
}

function throwTransportError(endpoint: string, init: RequestInit | undefined, err: unknown): never {
  if (err instanceof DOMException && err.name === 'AbortError' && init?.signal?.aborted !== true) {
    throw new ApiError(endpoint, null, `API timeout at ${endpoint}`);
  }
  if (err instanceof DOMException && err.name === 'AbortError') throw err;
  throw new ApiError(endpoint, null, `Catalog API unreachable at ${endpoint}: ${String(err)}`);
}

async function fetchJson(endpoint: string, init?: RequestInit): Promise<unknown> {
  const signal = timedSignal(init);
  let response: Response;
  try {
    response = await fetch(endpoint, { ...init, signal });
  } catch (err) {
    throwTransportError(endpoint, init, err);
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
    response = await fetch(endpoint, { ...init, signal: timedSignal(init) });
  } catch (err) {
    throwTransportError(endpoint, init, err);
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

const reservationSchema = z.object({
  id: z.number(),
  screeningId: z.number(),
  seatIds: z.array(z.number()),
  status: z.enum(['HELD', 'CONFIRMED', 'EXPIRED', 'CANCELLED']),
  expiresAt: z.string(),
  idempotencyKey: z.string(),
});

assertContract<Equals<z.infer<typeof reservationSchema>, ReservationDto>>(true);

const reservationResultSchema = reservationSchema.extend({
  created: z.boolean(),
});

export type ReservationResult = z.infer<typeof reservationResultSchema>;

const errorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

// Reads the machine-readable backend code ({ error: { code } }) so callers
// can distinguish conflict subtypes. Never throws for a missing code —
// transport failures simply carry code null.
async function throwApiError(endpoint: string, response: Response): Promise<never> {
  let code: string | null = null;
  try {
    const body = errorBodySchema.safeParse(await response.json());
    if (body.success) code = body.data.error.code;
  } catch {
    // Non-JSON error body: keep the status-only error below.
  }
  throw new ApiError(endpoint, response.status, `API ${response.status} at ${endpoint}`, code);
}

async function requestJson(
  endpoint: string,
  init: RequestInit,
): Promise<{ response: Response; payload: unknown }> {
  let response: Response;
  try {
    response = await fetch(endpoint, { ...init, signal: timedSignal(init) });
  } catch (err) {
    throwTransportError(endpoint, init, err);
  }
  if (!response.ok) {
    await throwApiError(endpoint, response);
  }
  return { response, payload: (await response.json()) as unknown };
}

export type CreateReservationInput = {
  screeningId: number;
  seatIds: number[];
  idempotencyKey: string;
};

export async function createReservation(
  baseUrl: string,
  input: CreateReservationInput,
  init?: RequestInit,
): Promise<ReservationResult> {
  const endpoint = `${baseUrl}/reservations`;
  const { payload } = await requestJson(endpoint, {
    ...init,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': input.idempotencyKey },
    body: JSON.stringify({ screeningId: input.screeningId, seatIds: input.seatIds }),
  });
  return parseWith(reservationResultSchema, endpoint, payload);
}

export async function fetchReservation(
  baseUrl: string,
  reservationId: number,
  init?: RequestInit,
): Promise<ReservationDto> {
  const endpoint = `${baseUrl}/reservations/${reservationId}`;
  const { payload } = await requestJson(endpoint, { ...init, method: 'GET' });
  return parseWith(reservationSchema, endpoint, payload);
}

export async function cancelReservation(
  baseUrl: string,
  reservationId: number,
  init?: RequestInit,
): Promise<ReservationDto> {
  const endpoint = `${baseUrl}/reservations/${reservationId}`;
  const { payload } = await requestJson(endpoint, { ...init, method: 'DELETE' });
  return parseWith(reservationSchema, endpoint, payload);
}
