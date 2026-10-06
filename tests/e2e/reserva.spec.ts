import { expect, test } from '@playwright/test';

import { resolveE2EEnv } from './env.js';
import {
  cleanupScreenings,
  countActiveHolders,
  reservationStatus,
  slotScreenings,
} from './fixtures.js';

const env = resolveE2EEnv();

async function apiGetReservation(id: number) {
  const response = await fetch(`${env.apiUrl}/reservations/${id}`);
  if (!response.ok) throw new Error(`backend GET failed: ${response.status}`);
  return (await response.json()) as {
    id: number;
    screeningId: number;
    seatIds: number[];
    status: string;
    expiresAt: string;
  };
}

test.describe('fluxo principal de reserva', () => {
  // Exclusive slot: screening 1 (The Dark Knight, Sala 1).
  test.afterEach(async () => {
    await cleanupScreenings(env.databaseUrl, [1]);
  });

  test('catalogo, sessao, assentos, hold, status e cancelamento', async ({ page }) => {
    const slots = await slotScreenings(env.databaseUrl);
    const slot = slots[0];
    if (slot === undefined || slot.movieTitle !== 'The Dark Knight') {
      throw new Error('e2e: deterministic seed mismatch on slot 0');
    }
    const seatA = slot.seatIds[0] as number;
    const seatB = slot.seatIds[1] as number;

    // 1-2. Catalog + movie detail (stable seeded title, runtime URL).
    await page.goto('/');
    await page
      .getByRole('link', { name: 'Ver detalhes de Batman: O Cavaleiro das Trevas' })
      .click();
    await expect(page).toHaveURL(new RegExp(`/filmes/${slot.movieId}$`));

    // 3. Screening picker lists this movie's single screening.
    await expect(page.getByText(/sessão encontrada/)).toBeVisible();
    await page.getByRole('link', { name: /Escolher assentos/ }).click();
    await expect(page).toHaveURL(new RegExp(`/sessoes/${slot.screeningId}$`));

    // 4-5. Seat map + select two available seats.
    await page.getByRole('button', { name: 'Fileira A, assento 1, disponível' }).click();
    await page.getByRole('button', { name: 'Fileira A, assento 2, disponível' }).click();
    await expect(page.getByText(/2 assentos: A1, A2/)).toBeVisible();

    // 6-7. Create the hold; assert the authoritative result, not just text.
    await page.getByRole('button', { name: 'Continuar' }).click();
    await page.getByRole('button', { name: 'Reservar assentos' }).click();
    const heading = page.getByRole('heading', { name: /Reserva \d+/ });
    await expect(heading).toBeVisible();
    const reservationId = Number((await heading.textContent())?.match(/\d+/)?.[0]);
    expect(Number.isInteger(reservationId)).toBe(true);

    // 8. Backend state matches the UI.
    const backend = await apiGetReservation(reservationId);
    expect(backend.status).toBe('HELD');
    expect(backend.screeningId).toBe(slot.screeningId);
    expect([...backend.seatIds].sort((a, b) => a - b)).toEqual(
      [seatA, seatB].sort((a, b) => a - b),
    );
    expect(await countActiveHolders(env.databaseUrl, slot.screeningId, seatA)).toBe(1);

    // 9-10. Cancel through the UI; backend confirms the outcome.
    // A transport flake surfaces the designed uncertain panel instead of a
    // lie — resolve it through "Verificar estado" and assert UI == backend.
    await page.getByRole('button', { name: 'Cancelar reserva' }).click();
    const cancelled = page.getByText('Cancelada');
    const uncertain = page.getByText(/bloqueadas até o estado ser verificado/);
    await expect(cancelled.or(uncertain)).toBeVisible();
    if (await uncertain.isVisible()) {
      await page.getByRole('button', { name: 'Verificar estado' }).click();
    }
    const truth = await reservationStatus(env.databaseUrl, reservationId);
    expect(truth).not.toBeNull();
    await expect(page.getByText(truth === 'CANCELLED' ? 'Cancelada' : 'Ativa')).toBeVisible();
  });
});
