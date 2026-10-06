import { Client } from 'pg';

import { assertE2EDatabase } from './env.js';

// E2E data strategy (deterministic, isolated without per-test DDL):
// - `prepare.mjs` seeds ingresso_e2e deterministically (19 movies, 7
//   screenings — same rows every run on a fresh database).
// - Each spec file owns EXCLUSIVE screening slots; with workers:1 no two
//   tests ever touch the same inventory concurrently.
// - Tests create ONLY reservations (their own rows); cleanup deletes exactly
//   those rows by screening slot. Catalog rows are read-only shared fixtures.

export type SlotScreening = {
  screeningId: number;
  movieId: number;
  movieTitle: string;
  seatIds: number[];
};

async function withClient<T>(databaseUrl: string, fn: (client: Client) => Promise<T>): Promise<T> {
  assertE2EDatabase(databaseUrl);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function movieIdByTitle(databaseUrl: string, title: string): Promise<number> {
  return withClient(databaseUrl, async (client) => {
    const result = await client.query<{ id: number }>('select id from movies where title = $1', [
      title,
    ]);
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error(`e2e: seeded movie missing: ${title}`);
    return id;
  });
}

export async function slotScreenings(databaseUrl: string): Promise<SlotScreening[]> {
  return withClient(databaseUrl, async (client) => {
    const screenings = await client.query<{
      screening_id: number;
      movie_id: number;
      movie_title: string;
    }>(
      `select s.id as screening_id, s.movie_id as movie_id, m.title as movie_title
       from screenings s join movies m on m.id = s.movie_id order by s.id`,
    );
    const slots: SlotScreening[] = [];
    for (const row of screenings.rows) {
      const seats = await client.query<{ id: number }>(
        `select st.id from seats st
         join screenings s on s.auditorium_id = st.auditorium_id
         where s.id = $1 order by st.row_label, st.seat_number`,
        [row.screening_id],
      );
      slots.push({
        screeningId: row.screening_id,
        movieId: row.movie_id,
        movieTitle: row.movie_title,
        seatIds: seats.rows.map((s) => s.id),
      });
    }
    return slots;
  });
}

// Deletes ONLY reservations on the given screenings (FK-safe order).
// With exclusive slots + workers:1 these are always this file's own rows.
export async function cleanupScreenings(
  databaseUrl: string,
  screeningIds: number[],
): Promise<void> {
  if (screeningIds.length === 0) return;
  await withClient(databaseUrl, async (client) => {
    const found = await client.query<{ id: number }>(
      'select id from reservations where screening_id = any($1)',
      [screeningIds],
    );
    const ids = found.rows.map((r) => r.id);
    if (ids.length > 0) {
      await client.query('delete from reservation_seats where reservation_id = any($1)', [ids]);
      await client.query('delete from reservations where id = any($1)', [ids]);
    }
  });
}

// Expiry-aware active holder count (matches backend semantics).
export async function countActiveHolders(
  databaseUrl: string,
  screeningId: number,
  seatId: number,
): Promise<number> {
  return withClient(databaseUrl, async (client) => {
    const result = await client.query<{ count: string }>(
      `select count(*) as count from reservation_seats rs
       join reservations r on r.id = rs.reservation_id
       where rs.screening_id = $1 and rs.seat_id = $2
         and (r.status = 'CONFIRMED' or (r.status = 'HELD' and r.expires_at > now()))`,
      [screeningId, seatId],
    );
    return Number(result.rows[0]?.count ?? 0);
  });
}

export async function countByIdempotencyKey(
  databaseUrl: string,
  key: string,
): Promise<{ count: number; id: number | null }> {
  return withClient(databaseUrl, async (client) => {
    const result = await client.query<{ id: number }>(
      'select id from reservations where idempotency_key = $1',
      [key],
    );
    return { count: result.rows.length, id: result.rows[0]?.id ?? null };
  });
}

export async function reservationStatus(
  databaseUrl: string,
  reservationId: number,
): Promise<string | null> {
  return withClient(databaseUrl, async (client) => {
    const result = await client.query<{ status: string }>(
      'select status from reservations where id = $1',
      [reservationId],
    );
    return result.rows[0]?.status ?? null;
  });
}
