import { useEffect, useMemo, useState } from 'react';

import type { CinemaDto, ScreeningDto } from '@ingresso/shared';

import { ApiError, listAllCinemas, listAllScreenings } from '../lib/api.js';
import { formatDayLabel, formatPrice, formatStartTime, screeningDayKey } from '../lib/format.js';

type Props = {
  movieId: number;
  apiUrl: string;
};

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; cinemas: CinemaDto[]; screenings: ScreeningDto[] };

type DayGroup = {
  key: string;
  label: string;
  screenings: ScreeningDto[];
};

function groupByDay(screenings: ScreeningDto[]): DayGroup[] {
  const groups = new Map<string, ScreeningDto[]>();
  for (const screening of screenings) {
    const key = screeningDayKey(screening.startsAt);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [screening]);
    } else {
      group.push(screening);
    }
  }
  return [...groups.entries()].map(([key, items]) => ({
    key,
    label: formatDayLabel(items[0]?.startsAt ?? ''),
    screenings: items,
  }));
}

// Dynamic island: screenings are mutable catalog data, always fetched at
// runtime — never prerendered (Milestone 1 migration-path invariant).
export default function ScreeningPicker({ movieId, apiUrl }: Props) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [cinemaFilter, setCinemaFilter] = useState<number | 'all'>('all');
  const [dayFilter, setDayFilter] = useState<string | 'all'>('all');

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    Promise.all([listAllCinemas(apiUrl), listAllScreenings(apiUrl, { movieId })])
      .then(([cinemas, screenings]) => {
        if (!cancelled) setState({ status: 'ready', cinemas, screenings });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            message:
              err instanceof ApiError ? err.message : 'Não foi possível carregar as sessões.',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [apiUrl, movieId, attempt]);

  const groups = useMemo(() => {
    if (state.status !== 'ready') return [];
    const filtered = state.screenings.filter(
      (s) =>
        (cinemaFilter === 'all' || s.cinemaId === cinemaFilter) &&
        (dayFilter === 'all' || screeningDayKey(s.startsAt) === dayFilter),
    );
    return groupByDay(filtered);
  }, [state, cinemaFilter, dayFilter]);

  const dayOptions = useMemo(() => {
    if (state.status !== 'ready') return [];
    return groupByDay(state.screenings).map((g) => ({ key: g.key, label: g.label }));
  }, [state]);

  if (state.status === 'loading') {
    return (
      <p role="status" className="font-mono text-sm text-white/50">
        Carregando sessões…
      </p>
    );
  }

  if (state.status === 'error') {
    return (
      <div role="alert" className="border border-ingresso/50 bg-ingresso/5 p-6">
        <p className="text-white/80">{state.message}</p>
        <button
          type="button"
          onClick={() => setAttempt((n) => n + 1)}
          className="mt-4 border border-white/20 px-4 py-2 font-mono text-xs uppercase tracking-widest transition-colors hover:border-white"
        >
          Tentar novamente
        </button>
      </div>
    );
  }

  if (state.screenings.length === 0) {
    return (
      <div className="border border-white/10 bg-white/[0.02] p-6">
        <p className="text-white/70">
          Nenhuma sessão programada para este filme no momento. Volte em breve.
        </p>
      </div>
    );
  }

  const visibleCount = groups.reduce((n, g) => n + g.screenings.length, 0);

  return (
    <div>
      <form
        className="grid grid-cols-1 gap-4 sm:grid-cols-2"
        onSubmit={(e) => e.preventDefault()}
        aria-label="Filtrar sessões"
      >
        <label className="flex flex-col gap-2">
          <span className="font-mono text-xs uppercase tracking-widest text-white/50">Cinema</span>
          <select
            value={cinemaFilter === 'all' ? 'all' : String(cinemaFilter)}
            onChange={(e) =>
              setCinemaFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))
            }
            className="border border-white/15 bg-screen px-3 py-2 text-phosphor"
          >
            <option value="all">Todos os cinemas</option>
            {state.cinemas.map((cinema) => (
              <option key={cinema.id} value={cinema.id}>
                {cinema.name} — {cinema.location}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-2">
          <span className="font-mono text-xs uppercase tracking-widest text-white/50">Data</span>
          <select
            value={dayFilter}
            onChange={(e) => setDayFilter(e.target.value as string | 'all')}
            className="border border-white/15 bg-screen px-3 py-2 text-phosphor"
          >
            <option value="all">Todas as datas</option>
            {dayOptions.map((day) => (
              <option key={day.key} value={day.key}>
                {day.label}
              </option>
            ))}
          </select>
        </label>
      </form>

      <p role="status" aria-live="polite" className="mt-6 font-mono text-xs text-white/50">
        {visibleCount === 0
          ? 'Nenhuma sessão para os filtros escolhidos.'
          : `${visibleCount} ${visibleCount === 1 ? 'sessão encontrada' : 'sessões encontradas'}.`}
      </p>

      {groups.map((group) => (
        <section key={group.key} aria-label={group.label} className="mt-6">
          <h3 className="font-display text-lg font-bold uppercase tracking-wide">{group.label}</h3>
          <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {group.screenings.map((screening) => (
              <li
                key={screening.id}
                className="border border-white/10 bg-white/[0.02] p-4 transition-colors hover:border-ingresso/60"
              >
                <p className="font-mono text-xs uppercase tracking-widest text-white/50">
                  {screening.cinemaName} · {screening.auditoriumName}
                </p>
                <p className="font-display mt-2 text-2xl font-black">
                  {formatStartTime(screening.startsAt)}
                  <span className="ml-3 align-middle font-sans text-sm font-normal text-white/60">
                    {formatPrice(screening.priceCents)}
                  </span>
                </p>
                <a
                  href={`/sessoes/${screening.id}`}
                  className="mt-3 inline-block border border-white/20 px-4 py-2 font-mono text-xs uppercase tracking-widest transition-colors hover:border-ingresso hover:text-white"
                  aria-label={`Escolher assentos para a sessão das ${formatStartTime(screening.startsAt)} em ${screening.cinemaName}`}
                >
                  Escolher assentos →
                </a>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
