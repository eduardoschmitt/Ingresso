import { expect, test } from '@playwright/test';

import { resolveE2EEnv } from './env.js';
import { cleanupScreenings, slotScreenings } from './fixtures.js';

const env = resolveE2EEnv();

async function apiPost(
  screeningId: number,
  seatIds: number[],
  key: string,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${env.apiUrl}/reservations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ screeningId, seatIds }),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

async function apiDelete(reservationId: number): Promise<number> {
  const response = await fetch(`${env.apiUrl}/reservations/${reservationId}`, {
    method: 'DELETE',
  });
  return response.status;
}

// NOTE on idempotency_conflict: it is not reproducible through the pure UI
// flow (keys are fresh UUIDs per mount). It stays covered by the API
// integration test "replays identical retries and rejects conflicting
// payloads" — referenced here instead of forged with mocks.

test.describe('erros e casos-limite', () => {
  // Exclusive slots: screening 5 (full room + taken seat), screening 6.
  test.afterEach(async () => {
    await cleanupScreenings(env.databaseUrl, [5, 6]);
  });

  test('seat_unavailable reconcilia o mapa sem travar o fluxo', async ({ page }) => {
    const slots = await slotScreenings(env.databaseUrl);
    const slot = slots[4];
    if (slot === undefined || slot.screeningId !== 5) {
      throw new Error('e2e: deterministic seed mismatch');
    }
    const seatId = slot.seatIds[0] as number;

    // User selects first; ANOTHER client takes the seat before the POST.
    await page.goto(`/sessoes/${slot.screeningId}`);
    await page.getByRole('button', { name: 'Fileira A, assento 1, disponível' }).click();
    await page.getByRole('button', { name: 'Continuar' }).click();
    const taken = await apiPost(slot.screeningId, [seatId], `e2e-tomado-${Date.now()}`);
    expect(taken.status).toBe(201);

    await page.getByRole('button', { name: 'Reservar assentos' }).click();
    // Availability conflict: explanation + reconciled map, flow intact.
    await expect(page.getByText(/foram ocupados/)).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Fileira A, assento 1, indisponível' }),
    ).toBeVisible();
  });

  test('falha de rede vira erro recuperavel, nao falha definitiva', async ({ page }) => {
    const slots = await slotScreenings(env.databaseUrl);
    if (slots[5]?.screeningId !== 6) throw new Error('e2e: deterministic seed mismatch');
    await page.route('**/reservations', (route) => route.abort('failed'));

    await page.goto('/sessoes/6');
    await page.getByRole('button', { name: 'Fileira A, assento 1, disponível' }).click();
    await page.getByRole('button', { name: 'Continuar' }).click();
    await page.getByRole('button', { name: 'Reservar assentos' }).click();
    // Uncertain — explicitly not a definitive failure.
    await expect(page.getByText(/pode ter sido concluída/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Verificar estado' })).toBeVisible();
  });

  test('cancelar apos mudanca de estado mostra a verdade do backend', async ({ page }) => {
    const slots = await slotScreenings(env.databaseUrl);
    if (slots[5]?.screeningId !== 6) throw new Error('e2e: deterministic seed mismatch');
    await page.goto('/sessoes/6');
    await page.getByRole('button', { name: 'Fileira A, assento 1, disponível' }).click();
    await page.getByRole('button', { name: 'Continuar' }).click();
    await page.getByRole('button', { name: 'Reservar assentos' }).click();
    const heading = page.getByRole('heading', { name: /Reserva \d+/ });
    await expect(heading).toBeVisible();
    const reservationId = Number((await heading.textContent())?.match(/\d+/)?.[0]);

    // Status changes behind the UI's back (direct backend cancel).
    expect(await apiDelete(reservationId)).toBe(200);
    // The UI cancel now 409s and must present the authoritative state.
    await page.getByRole('button', { name: 'Cancelar reserva' }).click();
    await expect(page.getByText('Cancelada')).toBeVisible();
  });

  test('timeout vira erro recuperavel com retry', async ({ page }) => {
    const slots = await slotScreenings(env.databaseUrl);
    if (slots[5]?.screeningId !== 6) throw new Error('e2e: deterministic seed mismatch');
    // Hang the POST forever: the 15s client timeout must surface uncertainty,
    // never a frozen UI. Uses real browser timers (unit envs can't fake them).
    await page.route('**/reservations', (route) => {
      if (route.request().method() === 'POST') return new Promise(() => {});
      return route.continue();
    });

    await page.goto('/sessoes/6');
    await page.getByRole('button', { name: 'Fileira A, assento 1, disponível' }).click();
    await page.getByRole('button', { name: 'Continuar' }).click();
    await page.getByRole('button', { name: 'Reservar assentos' }).click();
    await expect(page.getByText(/pode ter sido concluída/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Verificar estado' })).toBeVisible();
  });

  test('sessao inexistente e fileira ocupada', async ({ page }) => {
    // Unknown static route: the generic 404 page (no island is served).
    // The island's own not-found branch (stale prerendered route) is covered
    // by the web unit suite with a mocked 404.
    const missing = await page.goto('/sessoes/999999');
    expect(missing?.status()).toBe(404);
    await expect(page.getByText('404')).toBeVisible();

    // Occupied seats render disabled (row A fully held via the real API).
    const slots = await slotScreenings(env.databaseUrl);
    const slot = slots[4];
    if (slot === undefined || slot.screeningId !== 5) {
      throw new Error('e2e: deterministic seed mismatch');
    }
    for (const [index, seatId] of slot.seatIds.slice(0, 10).entries()) {
      const held = await apiPost(slot.screeningId, [seatId], `e2e-fileira-${Date.now()}-${index}`);
      expect(held.status).toBe(201);
    }
    await page.goto(`/sessoes/${slot.screeningId}`);
    for (let number = 1; number <= 10; number += 1) {
      const seat = page.getByRole('button', { name: `Fileira A, assento ${number}, indisponível` });
      await expect(seat).toBeVisible();
      await expect(seat).toBeDisabled();
    }
  });
});
