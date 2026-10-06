import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ReservationFlow from '../src/components/ReservationFlow';

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

const SEATS = [
  { id: 101, row: 'A', number: 1, status: 'available' },
  { id: 102, row: 'A', number: 2, status: 'available' },
] as const;

type SeatRow = (typeof SEATS)[number];

function heldReservation(overrides: Record<string, unknown> = {}) {
  return {
    id: 55,
    screeningId: 7,
    seatIds: [101, 102],
    status: 'HELD',
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    idempotencyKey: 'k',
    ...overrides,
  };
}

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  } as Response;
}

function errorBody(code: string) {
  return { error: { code, message: code } };
}

type PostCall = { url: string; key: string | null; body: unknown };

function postCalls(spy: ReturnType<typeof vi.fn>): PostCall[] {
  return spy.mock.calls
    .filter((call) => (call[1] as RequestInit)?.method === 'POST')
    .map((call) => {
      const init = call[1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      return {
        url: String(call[0]),
        key: headers['Idempotency-Key'] ?? null,
        body: JSON.parse(String(init.body)),
      };
    });
}

function install(routes: (url: string, method: string) => Promise<Response>) {
  const spy = vi.fn((url: string | URL | Request, init?: RequestInit) =>
    routes(String(url), init?.method ?? 'GET'),
  );
  vi.stubGlobal('fetch', spy);
  return spy;
}

function renderFlow(props: Record<string, unknown> = {}) {
  return render(
    <ReservationFlow
      apiUrl="http://test"
      screening={SCREENING}
      seats={[...SEATS] as unknown as SeatRow[]}
      initialSeatIds={[101, 102]}
      onReconcile={() => {}}
      onClose={() => {}}
      {...props}
    />,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useRealTimers();
});

describe('ReservationFlow', () => {
  it('creates a hold and shows authoritative details', async () => {
    const user = userEvent.setup();
    install(() => Promise.resolve(jsonResponse({ ...heldReservation(), created: true })));
    renderFlow();

    await user.click(screen.getByRole('button', { name: 'Reservar assentos' }));
    expect(await screen.findByText(/Reserva 55/)).toBeDefined();
    expect(screen.getByText('Ativa')).toBeDefined();
    expect(screen.getByText(/A1, A2/)).toBeDefined();
    expect(screen.getByText(/Cancelar reserva/)).toBeDefined();
  });

  it('sends a single POST on double click', async () => {
    const user = userEvent.setup();
    const spy = install(() =>
      Promise.resolve(jsonResponse({ ...heldReservation(), created: true })),
    );
    renderFlow();

    const button = screen.getByRole('button', { name: 'Reservar assentos' });
    await Promise.all([user.click(button), user.click(button)]);
    await screen.findByText(/Reserva 55/);
    expect(postCalls(spy)).toHaveLength(1);
  });

  it('preserves the frozen key and payload across uncertain retries (adjustments 1-2)', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const spy = install(() => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(new TypeError('network down'));
      return Promise.resolve(jsonResponse({ ...heldReservation(), created: true }));
    });
    renderFlow();

    await user.click(screen.getByRole('button', { name: 'Reservar assentos' }));
    expect(await screen.findByText(/pode ter sido concluída/)).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Verificar estado' }));
    await screen.findByText(/Reserva 55/);
    const posts = postCalls(spy);
    expect(posts).toHaveLength(2);
    expect(posts[0]?.key).toBeTruthy();
    // Identical key AND identical payload: no reconstruction, no duplicate.
    expect(posts[1]).toEqual(posts[0]);
  });

  it('abandons the uncertain attempt only through explicit action', async () => {
    const user = userEvent.setup();
    let closed = 0;
    install(() => Promise.reject(new TypeError('network down')));
    renderFlow({ onClose: () => (closed += 1) });

    await user.click(screen.getByRole('button', { name: 'Reservar assentos' }));
    await screen.findByText(/pode ter sido concluída/);
    await user.click(screen.getByRole('button', { name: /Abandonar tentativa/ }));
    expect(closed).toBe(1);
  });

  it('reconciles only on availability conflicts, not on idempotency conflicts (adjustment 3)', async () => {
    const user = userEvent.setup();
    let reconciled = 0;
    install(() => Promise.resolve(jsonResponse(errorBody('seat_unavailable'), 409)));
    renderFlow({ onReconcile: () => (reconciled += 1) });

    await user.click(screen.getByRole('button', { name: 'Reservar assentos' }));
    expect(await screen.findByText(/foram ocupados/)).toBeDefined();
    expect(reconciled).toBe(1);
  });

  it('handles idempotency conflicts without reconciliation (adjustment 3)', async () => {
    const user = userEvent.setup();
    let reconciled = 0;
    install(() => Promise.resolve(jsonResponse(errorBody('idempotency_conflict'), 409)));
    renderFlow({ onReconcile: () => (reconciled += 1) });

    await user.click(screen.getByRole('button', { name: 'Reservar assentos' }));
    expect(await screen.findByText(/chave de idempotência já foi usada/)).toBeDefined();
    expect(reconciled).toBe(0);
    expect(screen.getByRole('button', { name: /Recomeçar com nova chave/ })).toBeDefined();
  });

  it('refreshes authoritative status on demand', async () => {
    const user = userEvent.setup();
    let gets = 0;
    install((_url: string, method: string) => {
      if (method === 'POST')
        return Promise.resolve(jsonResponse({ ...heldReservation(), created: true }));
      gets += 1;
      return Promise.resolve(jsonResponse(heldReservation({ status: 'CONFIRMED' })));
    });
    renderFlow();

    await user.click(screen.getByRole('button', { name: 'Reservar assentos' }));
    await screen.findByText(/Reserva 55/);
    await user.click(screen.getByRole('button', { name: 'Atualizar estado' }));
    expect(await screen.findByText('Confirmada')).toBeDefined();
    expect(gets).toBeGreaterThanOrEqual(1);
  });

  it('cancels a hold and blocks repeat submission', async () => {
    const user = userEvent.setup();
    let deletes = 0;
    install((_url: string, method: string) => {
      if (method === 'POST')
        return Promise.resolve(jsonResponse({ ...heldReservation(), created: true }));
      if (method === 'DELETE') {
        deletes += 1;
        return Promise.resolve(jsonResponse(heldReservation({ status: 'CANCELLED' })));
      }
      return Promise.resolve(jsonResponse(heldReservation()));
    });
    renderFlow();

    await user.click(screen.getByRole('button', { name: 'Reservar assentos' }));
    await screen.findByText(/Reserva 55/);
    const cancel = screen.getByRole('button', { name: 'Cancelar reserva' });
    await Promise.all([user.click(cancel), user.click(cancel)]);
    expect(await screen.findByText('Cancelada')).toBeDefined();
    expect(deletes).toBe(1);
  });

  it('resolves rejected cancellations against the backend truth', async () => {
    const user = userEvent.setup();
    install((_url: string, method: string) => {
      if (method === 'POST')
        return Promise.resolve(jsonResponse({ ...heldReservation(), created: true }));
      if (method === 'DELETE')
        return Promise.resolve(jsonResponse(errorBody('reservation_not_cancellable'), 409));
      return Promise.resolve(jsonResponse(heldReservation({ status: 'EXPIRED' })));
    });
    renderFlow();

    await user.click(screen.getByRole('button', { name: 'Reservar assentos' }));
    await screen.findByText(/Reserva 55/);
    await user.click(screen.getByRole('button', { name: 'Cancelar reserva' }));
    expect(await screen.findByText('Expirada')).toBeDefined();
  });

  it('blocks new actions while a cancel outcome is uncertain (adjustment 4)', async () => {
    const user = userEvent.setup();
    let getCalls = 0;
    install((_url: string, method: string) => {
      if (method === 'POST')
        return Promise.resolve(jsonResponse({ ...heldReservation(), created: true }));
      if (method === 'DELETE') return Promise.reject(new TypeError('network down'));
      getCalls += 1;
      return Promise.resolve(jsonResponse(heldReservation({ status: 'CANCELLED' })));
    });
    renderFlow();

    await user.click(screen.getByRole('button', { name: 'Reservar assentos' }));
    await screen.findByText(/Reserva 55/);
    await user.click(screen.getByRole('button', { name: 'Cancelar reserva' }));
    expect(await screen.findByText(/bloqueadas até o estado ser verificado/)).toBeDefined();
    // Actions resolve only through the backend: verify, then adopt.
    await user.click(screen.getByRole('button', { name: 'Verificar estado' }));
    expect(await screen.findByText('Cancelada')).toBeDefined();
    expect(getCalls).toBeGreaterThanOrEqual(1);
  });

  it('counts down from the server timestamp and refreshes at zero', async () => {
    vi.useFakeTimers();
    install((_url: string, method: string) => {
      if (method === 'POST')
        return Promise.resolve(
          jsonResponse({
            ...heldReservation({
              expiresAt: new Date(Date.now() + 65_000).toISOString(),
            }),
            created: true,
          }),
        );
      return Promise.resolve(jsonResponse(heldReservation({ status: 'EXPIRED' })));
    });
    renderFlow();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reservar assentos' }));
    });
    expect(screen.getByText(/Reserva 55/)).toBeDefined();
    expect(screen.getByText(/\(1:0\d\)/)).toBeDefined();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(70_000);
    });
    expect(screen.getByText('Expirada')).toBeDefined();
    vi.useRealTimers();
  });

  it('discards stale responses and cleans up on unmount', async () => {
    let resolvePost!: (value: Response) => void;
    install(
      () =>
        new Promise<Response>((resolve) => {
          resolvePost = resolve;
        }),
    );
    const { unmount } = renderFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Reservar assentos' }));
    unmount();
    resolvePost(jsonResponse({ ...heldReservation(), created: true }));
    await Promise.resolve();
    expect(screen.queryByText(/Reserva 55/)).toBeNull();
  });

  it('operates the flow by keyboard', async () => {
    const user = userEvent.setup();
    install((_url: string, method: string) => {
      if (method === 'DELETE')
        return Promise.resolve(jsonResponse(heldReservation({ status: 'CANCELLED' })));
      return Promise.resolve(jsonResponse({ ...heldReservation(), created: true }));
    });
    renderFlow();

    screen.getByRole('button', { name: 'Reservar assentos' }).focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByText(/Reserva 55/)).toBeDefined();
    screen.getByRole('button', { name: 'Cancelar reserva' }).focus();
    await user.keyboard(' ');
    expect(await screen.findByText('Cancelada')).toBeDefined();
  });

  it('re-syncs the clock on visibility change without waiting for the interval', async () => {
    vi.useFakeTimers();
    install(() =>
      Promise.resolve(
        jsonResponse({
          ...heldReservation({
            expiresAt: new Date(Date.now() + 65_000).toISOString(),
          }),
          created: true,
        }),
      ),
    );
    renderFlow();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reservar assentos' }));
    });
    expect(screen.getByText(/\(1:0\d\)/)).toBeDefined();
    // 30s pass but the interval never fires (throttled background tab).
    vi.setSystemTime(new Date(Date.now() + 30_000));
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(screen.getByText(/\(0:3\d\)/)).toBeDefined();
    vi.useRealTimers();
  });
});
