import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ScreeningDto, SeatDto } from '@ingresso/shared';

import { ApiError, getScreening, getSeatMap } from '../lib/api.js';
import { formatPrice, formatStartTime } from '../lib/format.js';

type Props = {
  screeningId: number;
  apiUrl: string;
};

type Snapshot = {
  screening: ScreeningDto;
  seats: SeatDto[];
};

type Phase =
  | { status: 'loading' }
  | { status: 'not-found' }
  | { status: 'error'; message: string }
  | { status: 'ready' };

function seatLabel(seat: SeatDto): string {
  return `${seat.row}${seat.number}`;
}

function describeSeat(seat: SeatDto, selected: boolean): string {
  if (selected) return `Fileira ${seat.row}, assento ${seat.number}, selecionado`;
  if (seat.status !== 'available')
    return `Fileira ${seat.row}, assento ${seat.number}, indisponível`;
  return `Fileira ${seat.row}, assento ${seat.number}, disponível`;
}

// Runtime island: screening + availability always fetched in the browser —
// never prerendered. Selection is local only: it creates no hold, and a
// selected seat is not guaranteed to remain available (server decides in M4).
export default function SeatMap({ screeningId, apiUrl }: Props) {
  const [phase, setPhase] = useState<Phase>({ status: 'loading' });
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [showM4, setShowM4] = useState(false);

  // Only the latest request may mutate state — success, error, and
  // completion paths all compare generations (adjustment 4).
  const requestId = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const refreshingRef = useRef(false);
  // Ref mirrors for reconciliation inside async flows (never setState inside
  // another setState updater).
  const selectedRef = useRef<number[]>([]);
  const snapshotRef = useRef<Snapshot | null>(null);

  const setSelection = (updater: (current: number[]) => number[]) => {
    selectedRef.current = updater(selectedRef.current);
    setSelected(selectedRef.current);
  };

  const load = useCallback(
    async (isRefresh: boolean) => {
      if (isRefresh) {
        if (refreshingRef.current) return;
        refreshingRef.current = true;
        setRefreshing(true);
      }
      const id = (requestId.current += 1);
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const init = { signal: controller.signal };

      try {
        // Sequential: a 404 on the screening means "unknown screening"
        // (not-found state). Fetching seats first would turn that into a
        // generic error, since /seats also 404s for unknown ids.
        const screening = await getScreening(apiUrl, screeningId, init);
        if (requestId.current !== id) return;
        if (screening === null) {
          snapshotRef.current = null;
          setSnapshot(null);
          setSelection(() => []);
          setPhase({ status: 'not-found' });
          return;
        }
        const seatMap = await getSeatMap(apiUrl, screeningId, init);
        if (requestId.current !== id) return;
        // Reconcile the previous selection against the fresh snapshot:
        // drop seats that are no longer available and announce them.
        const freshById = new Map(seatMap.seats.map((s) => [s.id, s] as const));
        const kept = selectedRef.current.filter(
          (seatId) => freshById.get(seatId)?.status === 'available',
        );
        const removedIds = selectedRef.current.filter(
          (seatId) => freshById.get(seatId)?.status !== 'available',
        );
        if (removedIds.length > 0) {
          const previousById = new Map(
            (snapshotRef.current?.seats ?? []).map((s) => [s.id, s] as const),
          );
          const labels = removedIds
            .map((seatId) => {
              const seat = previousById.get(seatId) ?? freshById.get(seatId);
              return seat === undefined ? `#${seatId}` : seatLabel(seat);
            })
            .join(', ');
          setNotice(`Assentos ${labels} ficaram indisponíveis e foram removidos da seleção.`);
        } else if (isRefresh) {
          setNotice('Disponibilidade atualizada.');
        }
        setSelection(() => kept);
        snapshotRef.current = { screening, seats: seatMap.seats };
        setSnapshot(snapshotRef.current);
        setPhase({ status: 'ready' });
      } catch (err) {
        if (requestId.current !== id) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setPhase({
          status: 'error',
          message: err instanceof ApiError ? err.message : 'Não foi possível carregar os assentos.',
        });
      } finally {
        if (requestId.current === id) {
          refreshingRef.current = false;
          setRefreshing(false);
        }
      }
    },
    [apiUrl, screeningId],
  );

  useEffect(() => {
    void load(false);
    return () => {
      requestId.current += 1;
      abortRef.current?.abort();
    };
  }, [load]);

  const rows = useMemo(() => {
    const grouped = new Map<string, SeatDto[]>();
    for (const seat of snapshot?.seats ?? []) {
      const group = grouped.get(seat.row);
      if (group === undefined) {
        grouped.set(seat.row, [seat]);
      } else {
        group.push(seat);
      }
    }
    return [...grouped.entries()].map(([row, seats]) => ({ row, seats }));
  }, [snapshot]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const orderedSelection = useMemo(() => {
    const byId = new Map((snapshot?.seats ?? []).map((s) => [s.id, s] as const));
    return [...selected]
      .map((id) => byId.get(id))
      .filter((s): s is SeatDto => s !== undefined)
      .sort((a, b) => (a.row === b.row ? a.number - b.number : a.row < b.row ? -1 : 1));
  }, [selected, snapshot]);

  if (phase.status === 'loading') {
    return (
      <p role="status" className="font-mono text-sm text-white/50">
        Carregando mapa de assentos…
      </p>
    );
  }

  if (phase.status === 'not-found') {
    return (
      <div className="border border-white/10 bg-white/[0.02] p-6">
        <p className="text-white/70">Sessão não encontrada.</p>
        <a
          href="/"
          className="mt-4 inline-block border border-white/20 px-4 py-2 font-mono text-xs uppercase tracking-widest transition-colors hover:border-white"
        >
          Voltar ao catálogo
        </a>
      </div>
    );
  }

  if (phase.status === 'error') {
    return (
      <div role="alert" className="border border-ingresso/50 bg-ingresso/5 p-6">
        <p className="text-white/80">{phase.message}</p>
        <button
          type="button"
          onClick={() => void load(false)}
          className="mt-4 border border-white/20 px-4 py-2 font-mono text-xs uppercase tracking-widest transition-colors hover:border-white"
        >
          Tentar novamente
        </button>
      </div>
    );
  }

  if (snapshot === null || snapshot.seats.length === 0) {
    return (
      <div className="border border-white/10 bg-white/[0.02] p-6">
        <p className="text-white/70">Esta sala ainda não tem assentos configurados.</p>
      </div>
    );
  }

  const { screening } = snapshot;
  const total = selected.length * screening.priceCents;
  // Provisional VISUAL restriction only: the backend has no past-screening
  // rule, so real eligibility is decided server-side (adjustment 3).
  const sessionEnded = new Date(screening.endsAt).getTime() < Date.now();

  const toggle = (seat: SeatDto) => {
    if (seat.status !== 'available' || sessionEnded) return;
    setSelection((current) =>
      current.includes(seat.id) ? current.filter((id) => id !== seat.id) : [...current, seat.id],
    );
    setNotice(null);
  };

  return (
    <div>
      <div className="border border-white/10 bg-white/[0.02] p-4">
        <p className="font-mono text-xs uppercase tracking-widest text-white/50">
          {screening.cinemaName} · {screening.auditoriumName} ·{' '}
          {formatStartTime(screening.startsAt)}
        </p>
        <p className="font-display mt-1 text-xl font-bold">{screening.movieTitle}</p>
      </div>

      {sessionEnded && (
        <p
          role="note"
          className="mt-4 border border-signal/30 bg-signal/5 px-4 py-3 text-sm text-white/70"
        >
          Sessão já encerrada — seleção desabilitada nesta tela. A elegibilidade real é decidida
          pelo servidor.
        </p>
      )}

      <div className="mt-8" aria-hidden="true">
        <div className="mx-auto h-1.5 max-w-md rounded-full bg-gradient-to-b from-white/40 to-white/5" />
        <p className="mt-1 text-center font-mono text-[11px] uppercase tracking-[0.3em] text-white/40">
          Tela
        </p>
      </div>

      <div role="group" aria-label="Mapa de assentos" className="mt-6 space-y-2">
        {rows.map(({ row, seats }) => (
          <div key={row} className="flex flex-wrap items-center justify-center gap-1.5">
            <span className="w-6 font-mono text-xs text-white/40" aria-hidden="true">
              {row}
            </span>
            {seats.map((seat) => {
              const isSelected = selectedSet.has(seat.id);
              const disabled = seat.status !== 'available' || sessionEnded;
              return (
                <button
                  key={seat.id}
                  type="button"
                  disabled={disabled}
                  aria-pressed={isSelected}
                  aria-label={describeSeat(seat, isSelected)}
                  onClick={() => toggle(seat)}
                  className={[
                    'h-9 min-w-9 px-1 font-mono text-xs transition-colors',
                    'border focus-visible:border-signal focus-visible:outline-none',
                    isSelected
                      ? 'border-ingresso bg-ingresso font-bold text-white'
                      : seat.status === 'available'
                        ? 'border-white/20 text-white/70 hover:border-ingresso hover:text-white'
                        : 'cursor-not-allowed border-white/5 text-white/25',
                  ].join(' ')}
                >
                  {seat.number}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <ul
        aria-label="Legenda"
        className="mt-6 flex flex-wrap gap-x-5 gap-y-2 font-mono text-xs text-white/60"
      >
        <li>
          <span aria-hidden="true" className="mr-2 inline-block h-3 w-3 border border-white/20" />
          Disponível
        </li>
        <li>
          <span
            aria-hidden="true"
            className="mr-2 inline-block h-3 w-3 border border-white/5 bg-white/5"
          />
          Indisponível
        </li>
        <li>
          <span
            aria-hidden="true"
            className="mr-2 inline-block h-3 w-3 border border-ingresso bg-ingresso"
          />
          Selecionado
        </li>
      </ul>

      <div className="mt-6 flex flex-col gap-3 border border-white/10 bg-white/[0.02] p-4 sm:flex-row sm:items-center sm:justify-between">
        <p role="status" aria-live="polite" className="font-mono text-sm text-white/70">
          {selected.length === 0
            ? 'Nenhum assento selecionado.'
            : `${selected.length} ${selected.length === 1 ? 'assento' : 'assentos'}: ${orderedSelection.map(seatLabel).join(', ')} · Total estimado ${formatPrice(total)}`}
        </p>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => void load(true)}
            disabled={refreshing}
            className="border border-white/20 px-4 py-2 font-mono text-xs uppercase tracking-widest transition-colors hover:border-white disabled:cursor-wait disabled:opacity-50"
          >
            {refreshing ? 'Atualizando…' : 'Atualizar'}
          </button>
          <button
            type="button"
            disabled={selected.length === 0}
            onClick={() => setShowM4(true)}
            className="border border-ingresso bg-ingresso/10 px-4 py-2 font-mono text-xs uppercase tracking-widest transition-colors hover:bg-ingresso/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Continuar
          </button>
        </div>
      </div>

      {notice !== null && (
        <p role="status" aria-live="polite" className="mt-3 font-mono text-xs text-signal">
          {notice}
        </p>
      )}

      {showM4 && (
        <div
          role="note"
          className="mt-4 border border-signal/30 bg-signal/5 p-4 text-sm text-white/75"
        >
          Reserva chega no Milestone 4. Nenhum assento foi reservado e nenhuma compra foi concluída
          — a seleção acima é local e temporária.
        </div>
      )}

      <p className="mt-4 font-mono text-[11px] leading-relaxed text-white/40">
        Disponibilidade do último carregamento; o servidor decide no checkout. Preço unitário{' '}
        {formatPrice(screening.priceCents)}; total estimado, nunca autoritativo.
      </p>
    </div>
  );
}
