// Ingresso shared contracts — TypeScript types ONLY, zero dependencies.
// These describe the HTTP API's JSON shapes for static typing. They perform
// no runtime validation: the API validates request INPUTS with zod but does
// NOT validate its own RESPONSES; consumers must validate untrusted
// responses themselves (the web app does so with zod in lib/api.ts).

export type Paged<T> = {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
};

export type MovieDto = {
  id: number;
  title: string;
  titlePtBr: string | null;
  releaseYear: number;
  durationMinutes: number | null;
  synopsis: string | null;
  genre: string | null;
  posterUrl: string | null;
};

export type CinemaDto = {
  id: number;
  name: string;
  location: string;
};

export type AuditoriumDto = {
  id: number;
  name: string;
  capacity: number;
};

export type CinemaDetailDto = CinemaDto & {
  auditoriums: AuditoriumDto[];
};

export type ScreeningDto = {
  id: number;
  movieId: number;
  movieTitle: string;
  auditoriumId: number;
  auditoriumName: string;
  cinemaId: number;
  cinemaName: string;
  startsAt: string;
  endsAt: string;
  priceCents: number;
};

export type SeatStatus = 'available' | 'held' | 'sold';

export type SeatDto = {
  id: number;
  row: string;
  number: number;
  status: SeatStatus;
};

export type SeatMapDto = {
  screeningId: number;
  seats: SeatDto[];
};

export type ReservationStatus = 'HELD' | 'CONFIRMED' | 'EXPIRED' | 'CANCELLED';

export type ReservationDto = {
  id: number;
  screeningId: number;
  seatIds: number[];
  status: ReservationStatus;
  expiresAt: string;
  idempotencyKey: string;
};

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};
