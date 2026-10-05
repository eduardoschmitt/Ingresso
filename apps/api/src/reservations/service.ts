import { createHash } from 'node:crypto';

import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Db, DbTx } from '../db/client.js';
import {
  reservationSeats,
  reservations,
  screenings,
  seats,
  type ReservationStatus,
} from '../db/schema.js';
import { badRequest, conflict, notFound } from '../http/errors.js';
import type { ReservationObserver } from '../observability/metrics.js';

// Transactional seat holds (Phase 1).
//
// Concurrency model (see docs/adr/0001-*):
// - One transaction per mutation, READ COMMITTED (PostgreSQL default).
// - Lock ordering is always screening first, reservation second.
// - The screening row lock serializes all writers of one screening, so a
//   second contender always observes the first contender's committed rows.
// - `now()` is the transaction-start timestamp: stable across every
//   statement of the transaction, so all expiry decisions within one
//   transaction agree with each other (adjustment 5).
// - Idempotency uses INSERT ... ON CONFLICT DO NOTHING: no transaction ever
//   aborts on a key collision; the conflicting row is read back in the same
//   transaction and the fingerprint decides 200-replay vs 409 (adjustment 4).

const MAX_SEATS_PER_RESERVATION = 200;

export const createReservationSchema = z.object({
  screeningId: z.number().int().positive(),
  seatIds: z.array(z.number().int().positive()).min(1).max(MAX_SEATS_PER_RESERVATION),
  idempotencyKey: z.string().min(1).max(200),
});

export type ReservationDto = {
  id: number;
  screeningId: number;
  seatIds: number[];
  status: ReservationStatus;
  expiresAt: string;
  idempotencyKey: string;
};

export type ReservationResult = ReservationDto & { created: boolean };

// Canonical fingerprint of a reservation request. Sorted seat ids make
// [3,1,2] and [1,2,3] the same request; any other difference changes the hash.
export function fingerprintRequest(screeningId: number, seatIds: number[]): string {
  const canonical = JSON.stringify({
    screeningId,
    seatIds: [...seatIds].sort((a, b) => a - b),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function toDto(
  row: {
    id: number;
    screeningId: number;
    status: ReservationStatus;
    expiresAt: Date;
    idempotencyKey: string;
  },
  seatIds: number[],
): ReservationDto {
  return {
    id: row.id,
    screeningId: row.screeningId,
    seatIds,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
    idempotencyKey: row.idempotencyKey,
  };
}

async function expireOverdueHolds(tx: DbTx, screeningId: number): Promise<void> {
  await tx
    .update(reservations)
    .set({ status: 'EXPIRED' })
    .where(
      and(
        eq(reservations.screeningId, screeningId),
        eq(reservations.status, 'HELD'),
        lte(reservations.expiresAt, sql`now()`),
      ),
    );
}

async function loadSeatIds(tx: DbTx, reservationId: number): Promise<number[]> {
  const rows = await tx
    .select({ seatId: reservationSeats.seatId })
    .from(reservationSeats)
    .where(eq(reservationSeats.reservationId, reservationId))
    .orderBy(asc(reservationSeats.seatId));
  return rows.map((r) => r.seatId);
}

export type ReservationServiceOptions = {
  holdMinutes?: number;
  // Optional instrumentation hook (default: none). Observes lock acquisition
  // wall time only; business logic is identical with or without it.
  observe?: ReservationObserver;
};

export async function createReservation(
  db: Db,
  input: unknown,
  options?: ReservationServiceOptions,
): Promise<ReservationResult> {
  const parsed = createReservationSchema.parse(input);
  const holdMinutes = options?.holdMinutes ?? 5;
  if (new Set(parsed.seatIds).size !== parsed.seatIds.length) {
    throw badRequest('reservation_duplicate_seats', 'Seat selection contains duplicates');
  }
  const requestHash = fingerprintRequest(parsed.screeningId, parsed.seatIds);

  return db.transaction(async (tx) => {
    // 1. Screening first in lock order; also proves the screening exists.
    const lockStartedAt = performance.now();
    const screeningRows = await tx
      .select()
      .from(screenings)
      .where(eq(screenings.id, parsed.screeningId))
      .for('update')
      .limit(1);
    options?.observe?.lockWait('create', (performance.now() - lockStartedAt) / 1000);
    const screening = screeningRows[0];
    if (screening === undefined) throw notFound('screening');

    // 2. Enforce expiration transactionally (database clock), scoped to this
    //    screening so no background job is required for correctness.
    await expireOverdueHolds(tx, screening.id);

    // 3. Idempotency first: an identical retry must return the original row
    //    instead of colliding with its own seats in the holder check below.
    //    The lookup runs after the expiry sweep, so a replay observes the
    //    reservation's current lifecycle state (HELD, EXPIRED, CANCELLED…).
    const replay = await tx
      .select()
      .from(reservations)
      .where(eq(reservations.idempotencyKey, parsed.idempotencyKey))
      .limit(1)
      .then((rows) => rows[0]);
    if (replay !== undefined) {
      if (replay.requestHash !== requestHash) {
        throw conflict('idempotency_conflict', 'Idempotency key was used with a different payload');
      }
      return { ...toDto(replay, await loadSeatIds(tx, replay.id)), created: false };
    }

    // 4. Seats must exist in this screening's auditorium. The composite
    //    foreign keys on `reservation_seats` re-enforce this at the database
    //    level; this check exists to return precise errors.
    const seatRows = await tx
      .select({ id: seats.id })
      .from(seats)
      .where(
        and(eq(seats.auditoriumId, screening.auditoriumId), inArray(seats.id, parsed.seatIds)),
      );
    if (seatRows.length !== parsed.seatIds.length) {
      throw notFound('seat');
    }

    // 5. No seat may have an active holder (unexpired HELD or CONFIRMED).
    const holders = await tx
      .select({ seatId: reservationSeats.seatId })
      .from(reservationSeats)
      .innerJoin(reservations, eq(reservations.id, reservationSeats.reservationId))
      .where(
        and(
          eq(reservationSeats.screeningId, screening.id),
          inArray(reservationSeats.seatId, parsed.seatIds),
          inArray(reservations.status, ['HELD', 'CONFIRMED']),
        ),
      );
    if (holders.length > 0) {
      throw conflict('seat_unavailable', 'One or more seats are already reserved');
    }

    // 6. Idempotent insert: ON CONFLICT DO NOTHING keeps the transaction
    //    alive (no abort on key collision). Reaching the conflict branch here
    //    means a concurrent winner on a *different* screening (a different
    //    payload by construction of the hash) — or an in-flight one — so the
    //    replay lookup decides between returning the original and 409.
    const inserted = await tx
      .insert(reservations)
      .values({
        screeningId: screening.id,
        status: 'HELD',
        expiresAt: sql`now() + make_interval(mins => ${holdMinutes})`,
        idempotencyKey: parsed.idempotencyKey,
        requestHash,
      })
      .onConflictDoNothing({ target: reservations.idempotencyKey })
      .returning();

    const created = inserted[0];
    if (created !== undefined) {
      await tx.insert(reservationSeats).values(
        parsed.seatIds.map((seatId) => ({
          reservationId: created.id,
          seatId,
          screeningId: screening.id,
          auditoriumId: screening.auditoriumId,
        })),
      );
      return {
        ...toDto(
          created,
          [...parsed.seatIds].sort((a, b) => a - b),
        ),
        created: true,
      };
    }

    const raced = await tx
      .select()
      .from(reservations)
      .where(eq(reservations.idempotencyKey, parsed.idempotencyKey))
      .limit(1)
      .then((rows) => rows[0]);
    if (raced !== undefined && raced.requestHash === requestHash) {
      // Identical retry: return the original result, whatever its lifecycle
      // state — idempotency survives expiration and cancellation.
      return { ...toDto(raced, await loadSeatIds(tx, raced.id)), created: false };
    }
    if (raced !== undefined) {
      throw conflict('idempotency_conflict', 'Idempotency key was used with a different payload');
    }
    throw conflict('reservation_conflict', 'Idempotency key is held by a concurrent request');
  });
}

export async function getReservation(
  db: Db,
  id: number,
  observe?: ReservationObserver,
): Promise<ReservationDto> {
  return db.transaction(async (tx) => {
    const current = await tx
      .select()
      .from(reservations)
      .where(eq(reservations.id, id))
      .limit(1)
      .then((rows) => rows[0]);
    if (current === undefined) throw notFound('reservation');

    // Lock ordering: screening first, reservation second.
    const readLockStartedAt = performance.now();
    const screeningRows = await tx
      .select({ id: screenings.id })
      .from(screenings)
      .where(eq(screenings.id, current.screeningId))
      .for('update')
      .limit(1);
    observe?.lockWait('read', (performance.now() - readLockStartedAt) / 1000);
    if (screeningRows.length === 0) throw notFound('screening');
    await expireOverdueHolds(tx, current.screeningId);

    const locked = await tx
      .select()
      .from(reservations)
      .where(eq(reservations.id, id))
      .for('update')
      .limit(1)
      .then((rows) => rows[0]);
    if (locked === undefined) throw notFound('reservation');
    return toDto(locked, await loadSeatIds(tx, locked.id));
  });
}

export async function cancelReservation(
  db: Db,
  id: number,
  observe?: ReservationObserver,
): Promise<ReservationDto> {
  return db.transaction(async (tx) => {
    const current = await tx
      .select()
      .from(reservations)
      .where(eq(reservations.id, id))
      .limit(1)
      .then((rows) => rows[0]);
    if (current === undefined) throw notFound('reservation');

    // Lock ordering: screening first, reservation second.
    const cancelLockStartedAt = performance.now();
    const screeningRows = await tx
      .select({ id: screenings.id })
      .from(screenings)
      .where(eq(screenings.id, current.screeningId))
      .for('update')
      .limit(1);
    observe?.lockWait('cancel', (performance.now() - cancelLockStartedAt) / 1000);
    if (screeningRows.length === 0) throw notFound('screening');
    await expireOverdueHolds(tx, current.screeningId);

    const locked = await tx
      .select()
      .from(reservations)
      .where(eq(reservations.id, id))
      .for('update')
      .limit(1)
      .then((rows) => rows[0]);
    if (locked === undefined) throw notFound('reservation');
    if (locked.status !== 'HELD') {
      if (locked.status === 'CONFIRMED') {
        throw conflict('reservation_confirmed', 'Confirmed reservations cannot be cancelled here');
      }
      throw conflict(
        'reservation_not_cancellable',
        `Reservation is ${locked.status.toLowerCase()} and cannot be cancelled`,
      );
    }
    const [cancelled] = await tx
      .update(reservations)
      .set({ status: 'CANCELLED', cancelledAt: sql`now()` })
      .where(eq(reservations.id, id))
      .returning();
    if (cancelled === undefined) throw notFound('reservation');
    return toDto(cancelled, await loadSeatIds(tx, cancelled.id));
  });
}
