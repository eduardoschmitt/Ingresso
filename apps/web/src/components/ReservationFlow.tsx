import { useCallback, useEffect, useRef, useState } from 'react';

import type { ReservationDto, ScreeningDto, SeatDto } from '@ingresso/shared';

import { ApiError, cancelReservation, createReservation, fetchReservation } from '../lib/api.js';
import { formatDayLabel, formatPrice, formatStartTime } from '../lib/format.js';

type Props = {
  apiUrl: string;
  screening: ScreeningDto;
  seats: SeatDto[];
  initialSeatIds: number[];
  onReconcile: () => void;
  onClose: () => void;
};

// Frozen logical attempt (adjustments 1–2): key + payload snapshotted at POST
// time and never reconstructed from mutable UI state. Selection edits cannot
// silently invalidate it; only explicit abandon clears it.
type FrozenAttempt = {
  key: string;
  screeningId: number;
  seatIds: number[];
};

type TransientOp = 'idle' | 'creating' | 'cancelling' | 'refreshing';

type Failure =
  | { kind: 'conflict-seat' }
  | { kind: 'conflict-idempotency' }
  | { kind: 'conflict-concurrent' }
  | { kind: 'definitive'; message: string }
  | { kind: 'uncertain-create' }
  | { kind: 'uncertain-cancel' };

function seatLabels(seats: SeatDto[], seatIds: number[]): string {
  const byId = new Map(seats.map((s) => [s.id, s] as const));
  return seatIds
    .map((id) => {
      const seat = byId.get(id);
      return seat === undefined ? `#${id}` : `${seat.row}${seat.number}`;
    })
    .join(', ');
}

// Authoritative reservation state (`reservation`) is kept strictly separate
// from transient operation state (`op`, adjustment 4): the UI never derives
// status from clicks, timers, or local selection — only from backend DTOs.
export default function ReservationFlow({
  apiUrl,
  screening,
  seats,
  initialSeatIds,
  onReconcile,
  onClose,
}: Props) {
  const [reservation, setReservation] = useState<ReservationDto | null>(null);
  const [op, setOp] = useState<TransientOp>('idle');
  const [failure, setFailure] = useState<Failure | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // One logical attempt per mount: fresh key, frozen on first POST.
  const attemptRef = useRef<FrozenAttempt | null>(null);
  const inFlightRef = useRef(false);
  const zeroRefreshRef = useRef(false);

  const busy = op !== 'idle';

  const startCreate = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setOp('creating');
    setFailure(null);
    // Freeze key + payload once; every retry below reuses this exact object.
    if (attemptRef.current === null) {
      attemptRef.current = {
        key: crypto.randomUUID(),
        screeningId: screening.id,
        seatIds: [...initialSeatIds],
      };
    }
    const attempt = attemptRef.current;
    try {
      const result = await createReservation(apiUrl, {
        screeningId: attempt.screeningId,
        seatIds: attempt.seatIds,
        idempotencyKey: attempt.key,
      });
      const { created: _created, ...dto } = result;
      void _created;
      setReservation(dto);
      setFailure(null);
    } catch (err) {
      if (!(err instanceof ApiError)) {
        setFailure({ kind: 'uncertain-create' });
      } else if (err.code === 'seat_unavailable') {
        setFailure({ kind: 'conflict-seat' });
        onReconcile();
      } else if (err.code === 'idempotency_conflict') {
        setFailure({ kind: 'conflict-idempotency' });
      } else if (err.code === 'reservation_conflict') {
        setFailure({ kind: 'conflict-concurrent' });
      } else if (err.status === null) {
        // Transport failure: outcome unknown, frozen attempt preserved.
        setFailure({ kind: 'uncertain-create' });
      } else {
        setFailure({ kind: 'definitive', message: err.message });
      }
    } finally {
      inFlightRef.current = false;
      setOp('idle');
    }
  }, [apiUrl, initialSeatIds, onReconcile, screening.id]);

  const refreshStatus = useCallback(async () => {
    if (reservation === null || inFlightRef.current) return;
    inFlightRef.current = true;
    setOp('refreshing');
    try {
      const fresh = await fetchReservation(apiUrl, reservation.id);
      setReservation(fresh);
      setFailure(null);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status === null) {
        setFailure({ kind: 'uncertain-create' });
      } else {
        setFailure({ kind: 'definitive', message: err.message });
      }
    } finally {
      inFlightRef.current = false;
      setOp('idle');
    }
  }, [apiUrl, reservation]);

  const cancel = useCallback(async () => {
    if (reservation === null || inFlightRef.current) return;
    inFlightRef.current = true;
    setOp('cancelling');
    setFailure(null);
    try {
      const cancelled = await cancelReservation(apiUrl, reservation.id);
      setReservation(cancelled);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status === null) {
        // Uncertain cancel: block further actions until GET resolves.
        setFailure({ kind: 'uncertain-cancel' });
      } else {
        // Definitive rejection (409/404): refresh to present the truth.
        try {
          setReservation(await fetchReservation(apiUrl, reservation.id));
          setFailure(null);
        } catch {
          setFailure({ kind: 'definitive', message: err.message });
        }
      }
    } finally {
      inFlightRef.current = false;
      setOp('idle');
    }
  }, [apiUrl, reservation]);

  const abandonUncertain = useCallback(() => {
    attemptRef.current = null;
    setFailure(null);
    onClose();
  }, [onClose]);

  // Informational countdown from the server timestamp. Never declares expiry
  // locally: at zero it refreshes authoritatively exactly once per hold.
  // Re-syncs on visibility/focus because background tabs throttle timers —
  // without this the countdown (and the zero-refresh) could stall.
  // A slow authoritative refresh (20s) covers fully missed crossings
  // (e.g. laptop asleep): server truth always wins over local clock.
  useEffect(() => {
    if (reservation === null || reservation.status !== 'HELD') return;
    const syncClock = () => setNow(Date.now());
    const timer = setInterval(syncClock, 1000);
    const slowRefresh = setInterval(() => {
      void refreshStatus();
    }, 20_000);
    document.addEventListener('visibilitychange', syncClock);
    window.addEventListener('focus', syncClock);
    return () => {
      clearInterval(timer);
      clearInterval(slowRefresh);
      document.removeEventListener('visibilitychange', syncClock);
      window.removeEventListener('focus', syncClock);
    };
  }, [reservation, refreshStatus]);

  useEffect(() => {
    if (
      reservation !== null &&
      reservation.status === 'HELD' &&
      Date.now() >= new Date(reservation.expiresAt).getTime() &&
      !zeroRefreshRef.current
    ) {
      zeroRefreshRef.current = true;
      void refreshStatus();
    }
    if (reservation === null || reservation.status !== 'HELD') {
      zeroRefreshRef.current = false;
    }
  });

  const remainingMs = reservation !== null ? new Date(reservation.expiresAt).getTime() - now : null;
  const remainingLabel =
    remainingMs === null
      ? null
      : remainingMs <= 0
        ? 'verificando…'
        : `${Math.floor(remainingMs / 60000)}:${String(Math.floor((remainingMs % 60000) / 1000)).padStart(2, '0')}`;

  const estimatedTotal =
    (reservation?.seatIds.length ?? initialSeatIds.length) * screening.priceCents;

  return (
    <section
      aria-labelledby="reserva-title"
      className="mt-6 border border-white/10 bg-white/[0.02] p-5"
    >
      <p className="font-mono text-xs uppercase tracking-widest text-white/40">Reserva</p>
      <h2 id="reserva-title" className="font-display mt-2 text-2xl font-black uppercase">
        {reservation === null ? 'Confirmar hold' : `Reserva ${reservation.id}`}
      </h2>

      {reservation === null ? (
        <div className="mt-4">
          <p className="text-sm text-white/70">
            {initialSeatIds.length} {initialSeatIds.length === 1 ? 'assento' : 'assentos'}:{' '}
            {seatLabels(seats, initialSeatIds)} · {screening.cinemaName} ·{' '}
            {formatStartTime(screening.startsAt)} · Total estimado {formatPrice(estimatedTotal)}
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => void startCreate()}
              className="border border-ingresso bg-ingresso/10 px-4 py-2 font-mono text-xs uppercase tracking-widest transition-colors hover:bg-ingresso/20 disabled:cursor-wait disabled:opacity-50"
            >
              {op === 'creating' ? 'Reservando…' : 'Reservar assentos'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onClose}
              className="border border-white/20 px-4 py-2 font-mono text-xs uppercase tracking-widest transition-colors hover:border-white disabled:opacity-50"
            >
              Voltar
            </button>
          </div>
        </div>
      ) : (
        <dl className="mt-4 space-y-2 text-sm">
          <div className="flex gap-3">
            <dt className="w-28 shrink-0 font-mono text-xs uppercase tracking-widest text-white/40">
              Estado
            </dt>
            <dd aria-live="polite">
              <span
                className={[
                  'inline-block px-2 py-0.5 font-mono text-xs uppercase tracking-widest',
                  reservation.status === 'HELD'
                    ? 'border border-signal/40 text-signal'
                    : reservation.status === 'CANCELLED'
                      ? 'border border-white/20 text-white/60'
                      : 'border border-white/20 text-white/60',
                ].join(' ')}
              >
                {reservation.status === 'HELD'
                  ? 'Ativa'
                  : reservation.status === 'CANCELLED'
                    ? 'Cancelada'
                    : reservation.status === 'EXPIRED'
                      ? 'Expirada'
                      : 'Confirmada'}
              </span>
            </dd>
          </div>
          <div className="flex gap-3">
            <dt className="w-28 shrink-0 font-mono text-xs uppercase tracking-widest text-white/40">
              Assentos
            </dt>
            <dd>{seatLabels(seats, reservation.seatIds)}</dd>
          </div>
          <div className="flex gap-3">
            <dt className="w-28 shrink-0 font-mono text-xs uppercase tracking-widest text-white/40">
              Expira em
            </dt>
            <dd>
              {formatDayLabel(reservation.expiresAt)} · {formatStartTime(reservation.expiresAt)}
              {reservation.status === 'HELD' && remainingLabel !== null && (
                <span className="ml-2 font-mono text-signal" aria-live="polite">
                  ({remainingLabel})
                </span>
              )}
            </dd>
          </div>
          <div className="flex gap-3">
            <dt className="w-28 shrink-0 font-mono text-xs uppercase tracking-widest text-white/40">
              Sessão
            </dt>
            <dd>
              {screening.movieTitle} · {screening.cinemaName} · {screening.auditoriumName}
            </dd>
          </div>
        </dl>
      )}

      {reservation?.status === 'HELD' && (
        <div className="mt-4 flex flex-wrap gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => void refreshStatus()}
            className="border border-white/20 px-4 py-2 font-mono text-xs uppercase tracking-widest transition-colors hover:border-white disabled:cursor-wait disabled:opacity-50"
          >
            {op === 'refreshing' ? 'Verificando…' : 'Atualizar estado'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void cancel()}
            className="border border-ingresso bg-ingresso/10 px-4 py-2 font-mono text-xs uppercase tracking-widest transition-colors hover:bg-ingresso/20 disabled:cursor-wait disabled:opacity-50"
          >
            {op === 'cancelling' ? 'Cancelando…' : 'Cancelar reserva'}
          </button>
        </div>
      )}

      {reservation !== null && reservation.status !== 'HELD' && (
        <div className="mt-4">
          <button
            type="button"
            onClick={onClose}
            className="border border-white/20 px-4 py-2 font-mono text-xs uppercase tracking-widest transition-colors hover:border-white"
          >
            Voltar à seleção
          </button>
        </div>
      )}

      {failure?.kind === 'conflict-seat' && (
        <div role="alert" className="mt-4 border border-ingresso/50 bg-ingresso/5 p-4 text-sm">
          <p className="text-white/85">
            Um ou mais assentos foram ocupados por outra pessoa. A disponibilidade foi atualizada e
            os assentos perdidos saíram da sua seleção.
          </p>
          <button
            type="button"
            onClick={onClose}
            className="mt-3 border border-white/20 px-4 py-2 font-mono text-xs uppercase tracking-widest transition-colors hover:border-white"
          >
            Escolher novamente
          </button>
        </div>
      )}

      {failure?.kind === 'conflict-idempotency' && (
        <div role="alert" className="mt-4 border border-ingresso/50 bg-ingresso/5 p-4 text-sm">
          <p className="text-white/85">
            Esta chave de idempotência já foi usada com outros assentos. Por segurança, nenhuma nova
            reserva foi criada com ela.
          </p>
          <button
            type="button"
            onClick={() => {
              attemptRef.current = null;
              setFailure(null);
              onClose();
            }}
            className="mt-3 border border-white/20 px-4 py-2 font-mono text-xs uppercase tracking-widest transition-colors hover:border-white"
          >
            Recomeçar com nova chave
          </button>
        </div>
      )}

      {failure?.kind === 'conflict-concurrent' && (
        <div role="alert" className="mt-4 border border-ingresso/50 bg-ingresso/5 p-4 text-sm">
          <p className="text-white/85">
            Outra requisição com esta chave está em andamento. Aguarde e verifique o resultado.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void startCreate()}
            className="mt-3 border border-white/20 px-4 py-2 font-mono text-xs uppercase tracking-widest transition-colors hover:border-white disabled:opacity-50"
          >
            Verificar resultado
          </button>
        </div>
      )}

      {(failure?.kind === 'uncertain-create' || failure?.kind === 'uncertain-cancel') && (
        <div role="alert" className="mt-4 border border-signal/40 bg-signal/5 p-4 text-sm">
          <p className="text-white/85">
            {failure.kind === 'uncertain-create'
              ? 'A requisição pode ter sido concluída no servidor, mas a resposta não chegou. Nada foi descartado: a mesma chave e os mesmos assentos serão reutilizados.'
              : 'O cancelamento pode ter sido concluído no servidor. Novas ações estão bloqueadas até o estado ser verificado.'}
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void (failure.kind === 'uncertain-create' ? startCreate() : refreshStatus())
              }
              className="border border-white/20 px-4 py-2 font-mono text-xs uppercase tracking-widest transition-colors hover:border-white disabled:opacity-50"
            >
              Verificar estado
            </button>
            {failure.kind === 'uncertain-create' && (
              <button
                type="button"
                disabled={busy}
                onClick={abandonUncertain}
                className="border border-white/20 px-4 py-2 font-mono text-xs uppercase tracking-widest transition-colors hover:border-white disabled:opacity-50"
              >
                Abandonar tentativa
              </button>
            )}
          </div>
        </div>
      )}

      {failure?.kind === 'definitive' && (
        <div role="alert" className="mt-4 border border-ingresso/50 bg-ingresso/5 p-4 text-sm">
          <p className="text-white/85">{failure.message}</p>
        </div>
      )}
    </section>
  );
}
