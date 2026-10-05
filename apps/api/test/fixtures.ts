import type { Db } from '../src/db/client.js';
import { auditoriums, cinemas, movies, screenings, seats } from '../src/db/schema.js';

// Minimal deterministic fixtures. Each call builds an isolated chain
// (movie → cinema → auditorium → seats → screening) so tests never share
// inventory. A module counter keeps natural keys unique across calls.

let counter = 0;

export type ScreeningFixture = {
  movieId: number;
  cinemaId: number;
  auditoriumId: number;
  screeningId: number;
  seatIds: number[];
  startsAt: Date;
  endsAt: Date;
};

export async function createScreeningFixture(
  db: Db,
  options?: { rows?: number; seatsPerRow?: number; priceCents?: number },
): Promise<ScreeningFixture> {
  counter += 1;
  const n = counter;
  const rows = options?.rows ?? 4;
  const seatsPerRow = options?.seatsPerRow ?? 6;

  const [movie] = await db
    .insert(movies)
    .values({ title: `Fixture Film ${n}`, releaseYear: 2005, durationMinutes: 120 })
    .returning({ id: movies.id });
  const [cinema] = await db
    .insert(cinemas)
    .values({ name: `Fixture Cinema ${n}`, location: 'São Paulo, SP' })
    .returning({ id: cinemas.id });
  if (movie === undefined || cinema === undefined) throw new Error('fixture insert failed');

  const [room] = await db
    .insert(auditoriums)
    .values({ cinemaId: cinema.id, name: 'Sala F', capacity: rows * seatsPerRow })
    .returning({ id: auditoriums.id });
  if (room === undefined) throw new Error('fixture insert failed');

  const seatValues = Array.from({ length: rows }, (_, r) =>
    Array.from({ length: seatsPerRow }, (_, s) => ({
      auditoriumId: room.id,
      rowLabel: String.fromCharCode('A'.charCodeAt(0) + r),
      seatNumber: s + 1,
    })),
  ).flat();
  const seatRows = await db.insert(seats).values(seatValues).returning({ id: seats.id });

  const startsAt = new Date(Date.UTC(2026, 11, 20, 12 + (n % 8), 0, 0));
  const [screening] = await db
    .insert(screenings)
    .values({
      movieId: movie.id,
      auditoriumId: room.id,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 150 * 60_000),
      priceCents: options?.priceCents ?? 3000,
    })
    .returning({ id: screenings.id });
  if (screening === undefined) throw new Error('fixture insert failed');

  return {
    movieId: movie.id,
    cinemaId: cinema.id,
    auditoriumId: room.id,
    screeningId: screening.id,
    seatIds: seatRows.map((s) => s.id),
    startsAt,
    endsAt: new Date(startsAt.getTime() + 150 * 60_000),
  };
}
