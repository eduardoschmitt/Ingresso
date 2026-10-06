import { and, asc, count, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Db, DbTx } from '../db/client.js';
import {
  auditoriums,
  cinemas,
  movies,
  reservationSeats,
  reservations,
  screenings,
  seats,
} from '../db/schema.js';
import { conflict, notFound } from '../http/errors.js';
import { paged, type Pagination } from '../http/pagination.js';
import type {
  CinemaDetailDto,
  CinemaDto,
  MovieDto,
  Paged,
  ScreeningDto,
  SeatMapDto,
} from '@ingresso/shared';

type Queryable = Db | DbTx;

// Re-exported so existing import sites keep working; single definition lives
// in @ingresso/shared.
export type {
  CinemaDetailDto,
  CinemaDto,
  MovieDto,
  ScreeningDto,
  SeatMapDto,
  SeatStatus,
} from '@ingresso/shared';

export async function listMovies(db: Queryable, pagination: Pagination): Promise<Paged<MovieDto>> {
  const rows = await db
    .select()
    .from(movies)
    .orderBy(asc(movies.id))
    .limit(pagination.pageSize)
    .offset((pagination.page - 1) * pagination.pageSize);
  const [{ total }] = await db.select({ total: count() }).from(movies);
  return paged(
    rows.map((m) => ({
      id: m.id,
      title: m.title,
      titlePtBr: m.titlePtBr,
      releaseYear: m.releaseYear,
      durationMinutes: m.durationMinutes,
      synopsis: m.synopsis,
      genre: m.genre,
      posterUrl: m.posterUrl,
    })),
    total,
    pagination,
  );
}

export async function getMovie(db: Queryable, id: number): Promise<MovieDto> {
  const rows = await db.select().from(movies).where(eq(movies.id, id)).limit(1);
  const movie = rows[0];
  if (movie === undefined) throw notFound('movie');
  return {
    id: movie.id,
    title: movie.title,
    titlePtBr: movie.titlePtBr,
    releaseYear: movie.releaseYear,
    durationMinutes: movie.durationMinutes,
    synopsis: movie.synopsis,
    genre: movie.genre,
    posterUrl: movie.posterUrl,
  };
}

export async function listCinemas(
  db: Queryable,
  pagination: Pagination,
): Promise<Paged<CinemaDto>> {
  const rows = await db
    .select()
    .from(cinemas)
    .orderBy(asc(cinemas.id))
    .limit(pagination.pageSize)
    .offset((pagination.page - 1) * pagination.pageSize);
  const [{ total }] = await db.select({ total: count() }).from(cinemas);
  return paged(
    rows.map((c) => ({ id: c.id, name: c.name, location: c.location })),
    total,
    pagination,
  );
}

export async function getCinema(db: Queryable, id: number): Promise<CinemaDetailDto> {
  const rows = await db.select().from(cinemas).where(eq(cinemas.id, id)).limit(1);
  const cinema = rows[0];
  if (cinema === undefined) throw notFound('cinema');
  const rooms = await db
    .select()
    .from(auditoriums)
    .where(eq(auditoriums.cinemaId, id))
    .orderBy(asc(auditoriums.id));
  return {
    id: cinema.id,
    name: cinema.name,
    location: cinema.location,
    auditoriums: rooms.map((r) => ({ id: r.id, name: r.name, capacity: r.capacity })),
  };
}

const screeningSelection = {
  id: screenings.id,
  movieId: screenings.movieId,
  movieTitle: movies.title,
  auditoriumId: screenings.auditoriumId,
  auditoriumName: auditoriums.name,
  cinemaId: auditoriums.cinemaId,
  cinemaName: cinemas.name,
  startsAt: screenings.startsAt,
  endsAt: screenings.endsAt,
  priceCents: screenings.priceCents,
};

type ScreeningRow = {
  id: number;
  movieId: number;
  movieTitle: string;
  auditoriumId: number;
  auditoriumName: string;
  cinemaId: number;
  cinemaName: string;
  startsAt: Date;
  endsAt: Date;
  priceCents: number;
};

function toScreeningDto(row: ScreeningRow): ScreeningDto {
  return {
    id: row.id,
    movieId: row.movieId,
    movieTitle: row.movieTitle,
    auditoriumId: row.auditoriumId,
    auditoriumName: row.auditoriumName,
    cinemaId: row.cinemaId,
    cinemaName: row.cinemaName,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    priceCents: row.priceCents,
  };
}

export type ScreeningFilters = {
  movieId?: number;
  cinemaId?: number;
};

export async function listScreenings(
  db: Queryable,
  pagination: Pagination,
  filters: ScreeningFilters = {},
): Promise<Paged<ScreeningDto>> {
  const conditions = [];
  if (filters.movieId !== undefined) conditions.push(eq(screenings.movieId, filters.movieId));
  if (filters.cinemaId !== undefined) conditions.push(eq(auditoriums.cinemaId, filters.cinemaId));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select(screeningSelection)
    .from(screenings)
    .innerJoin(movies, eq(screenings.movieId, movies.id))
    .innerJoin(auditoriums, eq(screenings.auditoriumId, auditoriums.id))
    .innerJoin(cinemas, eq(auditoriums.cinemaId, cinemas.id))
    .where(where)
    .orderBy(asc(screenings.startsAt), asc(screenings.id))
    .limit(pagination.pageSize)
    .offset((pagination.page - 1) * pagination.pageSize);
  // The total honors the same filters (cinemaId needs the auditoriums join).
  let counted: Promise<{ total: number }[]>;
  if (filters.cinemaId === undefined) {
    counted =
      where === undefined
        ? db.select({ total: count() }).from(screenings)
        : db.select({ total: count() }).from(screenings).where(where);
  } else {
    counted = db
      .select({ total: count() })
      .from(screenings)
      .innerJoin(auditoriums, eq(screenings.auditoriumId, auditoriums.id))
      .where(where);
  }
  const [{ total }] = await counted;
  if (total === undefined) throw new Error('screening count returned no row');
  return paged(rows.map(toScreeningDto), total, pagination);
}

export async function getScreening(db: Queryable, id: number): Promise<ScreeningDto> {
  const rows = await db
    .select(screeningSelection)
    .from(screenings)
    .innerJoin(movies, eq(screenings.movieId, movies.id))
    .innerJoin(auditoriums, eq(screenings.auditoriumId, auditoriums.id))
    .innerJoin(cinemas, eq(auditoriums.cinemaId, cinemas.id))
    .where(eq(screenings.id, id))
    .limit(1);
  const row = rows[0];
  if (row === undefined) throw notFound('screening');
  return toScreeningDto(row);
}

// Screening creation has no HTTP route in Phase 1 (admin concern); the
// service exists for seeds-adjacent flows and overlap tests. Overlaps are
// rejected by the exclusion constraint; we translate the PG error.
export const createScreeningSchema = z.object({
  movieId: z.number().int().positive(),
  auditoriumId: z.number().int().positive(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  priceCents: z.number().int().min(0),
});

export async function createScreening(
  db: Queryable,
  input: z.input<typeof createScreeningSchema>,
): Promise<{ id: number }> {
  const parsed = createScreeningSchema.parse(input);
  if (parsed.endsAt <= parsed.startsAt) {
    throw conflict('screening_invalid_range', 'endsAt must be after startsAt');
  }
  try {
    const [row] = await db.insert(screenings).values(parsed).returning({ id: screenings.id });
    if (row === undefined) throw new Error('screening insert returned no row');
    return { id: row.id };
  } catch (err) {
    if (isExclusionViolation(err)) {
      throw conflict('screening_overlap', 'Screening overlaps another in the same auditorium');
    }
    throw err;
  }
}

export function isExclusionViolation(err: unknown): boolean {
  // Drizzle wraps driver errors in `cause`; walk the chain instead of
  // assuming the code sits on the top-level error.
  let current: unknown = err;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    if ((current as { code?: unknown }).code === '23P01') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// Authoritative seat map: derived live from reservation state with the
// database clock. HELD rows are unexpired here because writers reclassify
// overdue holds inside their own transaction before any read.
export async function getSeatMap(db: Queryable, screeningId: number): Promise<SeatMapDto> {
  const screening = await getScreening(db, screeningId);
  const rows = await db
    .select({
      id: seats.id,
      row: seats.rowLabel,
      number: seats.seatNumber,
      status: reservations.status,
    })
    .from(seats)
    .leftJoin(
      reservationSeats,
      and(eq(reservationSeats.seatId, seats.id), eq(reservationSeats.screeningId, screeningId)),
    )
    .leftJoin(reservations, eq(reservations.id, reservationSeats.reservationId))
    .where(eq(seats.auditoriumId, screening.auditoriumId))
    .orderBy(asc(seats.rowLabel), asc(seats.seatNumber));
  return {
    screeningId,
    seats: rows.map((r) => ({
      id: r.id,
      row: r.row,
      number: r.number,
      status: r.status === 'CONFIRMED' ? 'sold' : r.status === 'HELD' ? 'held' : 'available',
    })),
  };
}
