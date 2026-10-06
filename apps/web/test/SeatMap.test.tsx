import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import SeatMap from '../src/components/SeatMap';

type Seat = { id: number; row: string; number: number; status: string };

const SCREENING = {
  id: 7,
  movieId: 16,
  movieTitle: 'The Dark Knight',
  auditoriumId: 1,
  auditoriumName: 'Sala 1',
  cinemaId: 1,
  cinemaName: 'Cine Ingresso Paulista',
  startsAt: '2026-12-18T21:00:00.000Z',
  endsAt: '2026-12-19T00:02:00.000Z',
  priceCents: 3200,
};

function seatsFixture(statuses: Record<number, string> = {}): Seat[] {
  const seats: Seat[] = [];
  let id = 101;
  for (const row of ['A', 'B']) {
    for (let number = 1; number <= 4; number += 1) {
      seats.push({ id: id++, row, number, status: statuses[id - 1] ?? 'available' });
    }
  }
  return seats;
}

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  } as Response;
}

// Routes by URL suffix: /screenings/:id vs /screenings/:id/seats.
function installFetch(
  impl: (url: string, init?: RequestInit) => Promise<Response>,
): ReturnType<typeof vi.fn> {
  const spy = vi.fn(impl);
  vi.stubGlobal('fetch', spy);
  return spy;
}

function apiOk(screening: unknown, seats: Seat[]) {
  return installFetch((url: string) => {
    if (url.endsWith('/seats')) return Promise.resolve(jsonResponse({ screeningId: 7, seats }));
    return Promise.resolve(jsonResponse(screening));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SeatMap island', () => {
  it('renders rows in API order with legend and empty summary', async () => {
    apiOk(SCREENING, seatsFixture());
    render(<SeatMap screeningId={7} apiUrl="http://test" />);

    const map = await screen.findByRole('group', { name: 'Mapa de assentos' });
    const rows = within(map).getAllByRole('generic');
    expect(rows.length).toBeGreaterThan(0);
    const firstSeat = within(map).getByRole('button', { name: 'Fileira A, assento 1, disponível' });
    expect(firstSeat).toBeDefined();
    expect(screen.getByText('Disponível')).toBeDefined();
    expect(screen.getByText(/Nenhum assento selecionado/)).toBeDefined();
    expect(screen.getByText('Tela')).toBeDefined();
  });

  it('toggles selection and updates quantity and total', async () => {
    const user = userEvent.setup();
    apiOk(SCREENING, seatsFixture());
    render(<SeatMap screeningId={7} apiUrl="http://test" />);

    await user.click(await screen.findByRole('button', { name: /Fileira A, assento 1/ }));
    await user.click(screen.getByRole('button', { name: /Fileira A, assento 2/ }));
    expect(screen.getByText(/2 assentos: A1, A2/)).toBeDefined();
    expect(screen.getByText(/R\$ 64,00/)).toBeDefined();

    await user.click(screen.getByRole('button', { name: /Fileira A, assento 1, selecionado/ }));
    expect(screen.getByText(/1 assento: A2/)).toBeDefined();
  });

  it('keeps unavailable seats disabled and unselectable', async () => {
    const user = userEvent.setup();
    apiOk(SCREENING, seatsFixture({ 101: 'held', 102: 'sold' }));
    render(<SeatMap screeningId={7} apiUrl="http://test" />);

    const held = await screen.findByRole('button', { name: 'Fileira A, assento 1, indisponível' });
    expect((held as HTMLButtonElement).disabled).toBe(true);
    await user.click(held);
    expect(screen.getByText(/Nenhum assento selecionado/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Continuar' })).toHaveProperty('disabled', true);
  });

  it('operates by keyboard', async () => {
    const user = userEvent.setup();
    apiOk(SCREENING, seatsFixture());
    render(<SeatMap screeningId={7} apiUrl="http://test" />);

    const seat = await screen.findByRole('button', { name: /Fileira B, assento 3/ });
    seat.focus();
    await user.keyboard(' ');
    expect(await screen.findByText(/1 assento: B3/)).toBeDefined();
  });

  it('reconciles after refresh and announces removed seats', async () => {
    const user = userEvent.setup();
    let live = seatsFixture();
    const spy = installFetch((url: string) => {
      if (url.endsWith('/seats'))
        return Promise.resolve(jsonResponse({ screeningId: 7, seats: live }));
      return Promise.resolve(jsonResponse(SCREENING));
    });
    render(<SeatMap screeningId={7} apiUrl="http://test" />);

    await user.click(await screen.findByRole('button', { name: /Fileira A, assento 1/ }));
    await user.click(screen.getByRole('button', { name: /Fileira A, assento 2/ }));
    expect(spy).toHaveBeenCalledTimes(2);

    live = seatsFixture({ 102: 'sold' });
    await user.click(screen.getByRole('button', { name: 'Atualizar' }));
    expect(await screen.findByText(/A2 ficaram indisponíveis/)).toBeDefined();
    expect(screen.getByText(/1 assento: A1/)).toBeDefined();
  });

  it('ignores stale responses when screening changes mid-flight', async () => {
    let resolveFirst!: (value: Response) => void;
    const first = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const secondSeats = seatsFixture();
    installFetch((url: string) => {
      if (url.includes('/screenings/7/seats')) return first;
      if (url.includes('/screenings/8/seats'))
        return Promise.resolve(jsonResponse({ screeningId: 8, seats: secondSeats }));
      if (url.endsWith('/screenings/7')) return Promise.resolve(jsonResponse(SCREENING));
      return Promise.resolve(jsonResponse({ ...SCREENING, id: 8, auditoriumName: 'Sala 2' }));
    });

    const { rerender } = render(<SeatMap screeningId={7} apiUrl="http://test" />);
    rerender(<SeatMap screeningId={8} apiUrl="http://test" />);
    // Stale first response resolves last: must not overwrite screening 8.
    // ("Sala 2" shares its <p> with separators, so match the leaf node.)
    const leafWith = (text: string) => (_: string | null, el: Element | null) =>
      el?.tagName === 'P' && (el.textContent ?? '').includes(text);
    resolveFirst(jsonResponse({ screeningId: 7, seats: seatsFixture() }));
    expect(await screen.findByText(leafWith('Sala 2'))).toBeDefined();
    expect(screen.queryByText(leafWith('Sala 1'))).toBeNull();
  });

  it('serializes overlapping refreshes into a single consistent reload', async () => {
    const user = userEvent.setup();
    let calls = 0;
    let release!: (value: Response) => void;
    const gate = () => new Promise<Response>((resolve) => (release = resolve));
    let pending = gate();
    installFetch((url: string) => {
      if (url.endsWith('/seats')) {
        calls += 1;
        return pending;
      }
      return Promise.resolve(jsonResponse(SCREENING));
    });
    render(<SeatMap screeningId={7} apiUrl="http://test" />);
    // Release the initial load, then hold the refresh in flight.
    release(jsonResponse({ screeningId: 7, seats: seatsFixture() }));
    await screen.findByRole('group', { name: 'Mapa de assentos' });
    expect(calls).toBe(1);

    pending = gate();
    const refresh = screen.getByRole('button', { name: 'Atualizar' });
    // Three clicks while one refresh is in flight: the guard drops extras.
    await Promise.all([user.click(refresh), user.click(refresh), user.click(refresh)]);
    release(jsonResponse({ screeningId: 7, seats: seatsFixture() }));
    await waitFor(() => expect(screen.getByText(/Disponibilidade atualizada/)).toBeDefined());
    // Initial seats fetch + exactly one refresh cycle.
    expect(calls).toBe(2);
  });

  it('recovers from network failure via retry', async () => {
    const user = userEvent.setup();
    const spy = installFetch(() => Promise.reject(new TypeError('network down')));
    render(<SeatMap screeningId={7} apiUrl="http://test" />);

    expect(await screen.findByRole('alert')).toBeDefined();
    spy.mockImplementation((url: string) => {
      if (url.endsWith('/seats'))
        return Promise.resolve(jsonResponse({ screeningId: 7, seats: seatsFixture() }));
      return Promise.resolve(jsonResponse(SCREENING));
    });
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByRole('group', { name: 'Mapa de assentos' })).toBeDefined();
  });

  it('reports unknown screenings distinctly from failures', async () => {
    installFetch((url: string) => {
      if (url.endsWith('/seats')) return Promise.resolve(jsonResponse({}, 404));
      return Promise.resolve(jsonResponse({}, 404));
    });
    render(<SeatMap screeningId={999} apiUrl="http://test" />);
    expect(await screen.findByText('Sessão não encontrada.')).toBeDefined();
  });

  it('reports auditoriums without configured seats', async () => {
    installFetch((url: string) => {
      if (url.endsWith('/seats'))
        return Promise.resolve(jsonResponse({ screeningId: 7, seats: [] }));
      return Promise.resolve(jsonResponse(SCREENING));
    });
    render(<SeatMap screeningId={7} apiUrl="http://test" />);
    expect(await screen.findByText(/ainda não tem assentos configurados/)).toBeDefined();
  });

  it('disables selection for past sessions as a visual-only restriction', async () => {
    const user = userEvent.setup();
    installFetch((url: string) => {
      if (url.endsWith('/seats'))
        return Promise.resolve(jsonResponse({ screeningId: 7, seats: seatsFixture() }));
      return Promise.resolve(
        jsonResponse({
          ...SCREENING,
          startsAt: '2020-01-01T20:00:00.000Z',
          endsAt: '2020-01-01T22:00:00.000Z',
        }),
      );
    });
    render(<SeatMap screeningId={7} apiUrl="http://test" />);

    expect(await screen.findByText(/Sessão já encerrada/)).toBeDefined();
    const seat = screen.getByRole('button', { name: /Fileira A, assento 1/ });
    expect((seat as HTMLButtonElement).disabled).toBe(true);
    await user.click(seat);
    expect(screen.getByText(/Nenhum assento selecionado/)).toBeDefined();
  });

  it('continues to an explicit M4 notice without creating reservations', async () => {
    const user = userEvent.setup();
    const spy = apiOk(SCREENING, seatsFixture());
    render(<SeatMap screeningId={7} apiUrl="http://test" />);

    await user.click(await screen.findByRole('button', { name: /Fileira A, assento 1/ }));
    await user.click(screen.getByRole('button', { name: 'Continuar' }));
    expect(await screen.findByText(/Reserva chega no Milestone 4/)).toBeDefined();
    const urls = spy.mock.calls.map((call) => String(call[0]));
    expect(urls.some((u) => u.includes('/reservations'))).toBe(false);
  });
});
