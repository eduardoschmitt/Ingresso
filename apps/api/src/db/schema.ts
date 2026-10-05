import {
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  smallint,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Phase 1 domain model. Conventions:
// - `serial` integer primary keys (no extension dependencies).
// - `timestamptz` for every timestamp; monetary values as integer minor units.
// - Catalog deletions are RESTRICTed while referenced by inventory.
// - Seat-to-screening auditorium consistency is enforced by composite foreign
//   keys on `reservation_seats` (adjustment 1), not only by application code.
// - No overlapping screenings per auditorium: enforced by a GiST exclusion
//   constraint appended to the initial migration (Drizzle cannot express it;
//   see docs/adr/0001-inventory-authority-and-concurrency.md).

function createdAt() {
  return timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`);
}

export const reservationStatus = pgEnum('reservation_status', [
  'HELD',
  'CONFIRMED',
  'EXPIRED',
  'CANCELLED',
]);

export type ReservationStatus = (typeof reservationStatus.enumValues)[number];

export const movies = pgTable(
  'movies',
  {
    id: serial('id').primaryKey(),
    title: text('title').notNull(),
    titlePtBr: text('title_pt_br'),
    releaseYear: smallint('release_year').notNull(),
    durationMinutes: integer('duration_minutes'),
    synopsis: text('synopsis'),
    genre: text('genre'),
    posterUrl: text('poster_url'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('movies_title_release_year_uniq').on(t.title, t.releaseYear),
    check(
      'movies_duration_minutes_check',
      sql`${t.durationMinutes} IS NULL OR ${t.durationMinutes} > 0`,
    ),
  ],
);

export const cinemas = pgTable('cinemas', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(),
  location: text('location').notNull(),
  createdAt: createdAt(),
});

export const auditoriums = pgTable(
  'auditoriums',
  {
    id: serial('id').primaryKey(),
    cinemaId: integer('cinema_id')
      .notNull()
      .references(() => cinemas.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    capacity: integer('capacity').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('auditoriums_cinema_name_uniq').on(t.cinemaId, t.name),
    check('auditoriums_capacity_check', sql`${t.capacity} > 0`),
  ],
);

export const seats = pgTable(
  'seats',
  {
    id: serial('id').primaryKey(),
    auditoriumId: integer('auditorium_id')
      .notNull()
      .references(() => auditoriums.id, { onDelete: 'restrict' }),
    rowLabel: text('row_label').notNull(),
    seatNumber: integer('seat_number').notNull(),
  },
  (t) => [
    unique('seats_auditorium_row_number_uniq').on(t.auditoriumId, t.rowLabel, t.seatNumber),
    // Anchor for the composite foreign keys on `reservation_seats`.
    unique('seats_auditorium_id_uniq').on(t.auditoriumId, t.id),
    check('seats_seat_number_check', sql`${t.seatNumber} > 0`),
  ],
);

export const screenings = pgTable(
  'screenings',
  {
    id: serial('id').primaryKey(),
    movieId: integer('movie_id')
      .notNull()
      .references(() => movies.id, { onDelete: 'restrict' }),
    auditoriumId: integer('auditorium_id')
      .notNull()
      .references(() => auditoriums.id, { onDelete: 'restrict' }),
    startsAt: timestamp('starts_at', { withTimezone: true, mode: 'date' }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true, mode: 'date' }).notNull(),
    priceCents: integer('price_cents').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('screenings_ends_after_starts_check', sql`${t.endsAt} > ${t.startsAt}`),
    check('screenings_price_cents_check', sql`${t.priceCents} >= 0`),
    // Anchor for the composite foreign keys on `reservation_seats`.
    unique('screenings_auditorium_id_uniq').on(t.auditoriumId, t.id),
    // Idempotency anchor for deterministic seeds (two screenings cannot start
    // at the same instant in the same room).
    unique('screenings_auditorium_starts_uniq').on(t.auditoriumId, t.startsAt),
    index('screenings_auditorium_starts_idx').on(t.auditoriumId, t.startsAt),
    index('screenings_movie_starts_idx').on(t.movieId, t.startsAt),
  ],
);

export const reservations = pgTable(
  'reservations',
  {
    id: serial('id').primaryKey(),
    screeningId: integer('screening_id')
      .notNull()
      .references(() => screenings.id, { onDelete: 'restrict' }),
    status: reservationStatus('status').notNull().default('HELD'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    // Canonical fingerprint of { screeningId, sorted seatIds }. Identical
    // retries return the original; conflicting payloads get 409.
    requestHash: text('request_hash').notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true, mode: 'date' }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('reservations_screening_status_idx').on(t.screeningId, t.status),
    // Anchor for the composite foreign key on `reservation_seats`.
    unique('reservations_id_screening_uniq').on(t.id, t.screeningId),
  ],
);

export const reservationSeats = pgTable(
  'reservation_seats',
  {
    reservationId: integer('reservation_id').notNull(),
    seatId: integer('seat_id').notNull(),
    screeningId: integer('screening_id').notNull(),
    auditoriumId: integer('auditorium_id').notNull(),
  },
  (t) => [
    primaryKey({ name: 'reservation_seats_pkey', columns: [t.reservationId, t.seatId] }),
    // Composite chain: the seat and the screening provably share one
    // auditorium, and the reservation provably belongs to that screening.
    foreignKey({
      name: 'reservation_seats_reservation_fk',
      columns: [t.reservationId, t.screeningId],
      foreignColumns: [reservations.id, reservations.screeningId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'reservation_seats_seat_fk',
      columns: [t.auditoriumId, t.seatId],
      foreignColumns: [seats.auditoriumId, seats.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'reservation_seats_screening_fk',
      columns: [t.auditoriumId, t.screeningId],
      foreignColumns: [screenings.auditoriumId, screenings.id],
    }).onDelete('restrict'),
    index('reservation_seats_screening_seat_idx').on(t.screeningId, t.seatId),
  ],
);
