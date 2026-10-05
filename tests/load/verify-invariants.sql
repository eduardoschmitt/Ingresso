-- Ingresso Phase 2 — post-experiment invariant checks (adjustment 4).
-- Every SELECT below must return zero rows, except the final summary (Q5)
-- which is informational. "Active" correctly accounts for expiry:
--   active  = status CONFIRMED
--          OR (status HELD AND expires_at > now())
-- Unreclassified-but-expired HELD rows are EXPECTED (lazy transactional
-- expiry) and must NOT be counted as conflicts.

-- Q1: conflicting active holders — same seat, same screening, >1 active holder.
select rs.screening_id, rs.seat_id, count(*) as active_holders
from reservation_seats rs
join reservations r on r.id = rs.reservation_id
where r.status = 'CONFIRMED'
   or (r.status = 'HELD' and r.expires_at > now())
group by rs.screening_id, rs.seat_id
having count(*) > 1;

-- Q2: double sales — same seat CONFIRMED more than once per screening.
select rs.screening_id, rs.seat_id, count(*) as confirmed_sales
from reservation_seats rs
join reservations r on r.id = rs.reservation_id
where r.status = 'CONFIRMED'
group by rs.screening_id, rs.seat_id
having count(*) > 1;

-- Q3: seat/screening auditorium mismatch (composite FKs must prevent this).
select rs.reservation_id, rs.seat_id, rs.screening_id, rs.auditorium_id
from reservation_seats rs
join seats s on s.id = rs.seat_id
join screenings sc on sc.id = rs.screening_id
where s.auditorium_id <> rs.auditorium_id
   or sc.auditorium_id <> rs.auditorium_id;

-- Q4: reservation/screening mismatch.
select rs.reservation_id, rs.screening_id, r.screening_id as reservation_screening
from reservation_seats rs
join reservations r on r.id = rs.reservation_id
where rs.screening_id <> r.screening_id;

-- Q5 (informational): outcome summary.
select status, count(*) as reservations
from reservations
group by status
order by status;
