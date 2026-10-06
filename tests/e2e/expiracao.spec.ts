import { expect, test } from '@playwright/test';

import { resolveE2EEnv } from './env.js';
import { cleanupScreenings, slotScreenings } from './fixtures.js';

const env = resolveE2EEnv();

async function apiGetReservation(id: number) {
  const response = await fetch(`${env.apiUrl}/reservations/${id}`);
  if (!response.ok) throw new Error(`backend GET failed: ${response.status}`);
  return (await response.json()) as { status: string };
}

test.describe('expiracao real do hold', () => {
  // Exclusive slot: screening 2 (Ratatouille, Sala 1).
  test.afterEach(async () => {
    await cleanupScreenings(env.databaseUrl, [2]);
  });

  test('hold ativo expira no backend e a UI apresenta EXPIRED', async ({ page }) => {
    const slots = await slotScreenings(env.databaseUrl);
    if (slots[1]?.screeningId !== 2) throw new Error('e2e: deterministic seed mismatch');

    await page.goto('/sessoes/2');
    await page.getByRole('button', { name: 'Fileira A, assento 1, disponível' }).click();
    await page.getByRole('button', { name: 'Continuar' }).click();
    await page.getByRole('button', { name: 'Reservar assentos' }).click();
    const heading = page.getByRole('heading', { name: /Reserva \d+/ });
    await expect(heading).toBeVisible();
    const reservationId = Number((await heading.textContent())?.match(/\d+/)?.[0]);

    // Countdown renders from the server timestamp (tick behavior itself is
    // covered by the web unit suite with fake timers — headless throttling
    // makes ticking assertions flaky here).
    await expect(page.getByText(/Expira em/)).toBeVisible();

    // Authoritative wait: poll the BACKEND until EXPIRED (no exact timing).
    await expect
      .poll(
        async () => {
          try {
            return (await apiGetReservation(reservationId)).status;
          } catch {
            return 'unknown';
          }
        },
        { timeout: 120_000 },
      )
      .toBe('EXPIRED');

    // The UI adopts the authoritative state. Headless throttles timers, so
    // nudge the re-sync path explicitly (the same handler real background
    // tabs use) instead of depending on the 1s interval firing.
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.getByText('Expirada')).toBeVisible({ timeout: 30_000 });
  });
});
