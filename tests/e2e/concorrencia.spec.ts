import { expect, test, type Locator, type Page } from '@playwright/test';

import { resolveE2EEnv } from './env.js';
import { cleanupScreenings, countActiveHolders, slotScreenings } from './fixtures.js';

const env = resolveE2EEnv();

async function prepareRacer(page: Page, screeningId: number): Promise<void> {
  await page.goto(`/sessoes/${screeningId}`);
  await page.getByRole('button', { name: 'Fileira A, assento 1, disponível' }).click();
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.getByRole('button', { name: 'Reservar assentos' })).toBeVisible();
}

test.describe('concorrencia entre dois navegadores', () => {
  // Exclusive slot: screening 3 (Inception, Sala 1).
  test.afterEach(async () => {
    await cleanupScreenings(env.databaseUrl, [3]);
  });

  test('um hold vence, o outro conflita, sem double-hold', async ({ browser }) => {
    const slots = await slotScreenings(env.databaseUrl);
    const slot = slots[2];
    if (slot === undefined || slot.screeningId !== 3) {
      throw new Error('e2e: deterministic seed mismatch on slot 2');
    }
    const seatId = slot.seatIds[0] as number;

    // Two independent contexts, both ready before either submits.
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    try {
      const pageA = await contextA.newPage();
      const pageB = await contextB.newPage();
      await prepareRacer(pageA, slot.screeningId);
      await prepareRacer(pageB, slot.screeningId);

      // Synchronized submission: both clicks dispatched together.
      await Promise.all([
        pageA.getByRole('button', { name: 'Reservar assentos' }).click(),
        pageB.getByRole('button', { name: 'Reservar assentos' }).click(),
      ]);

      // Exactly one HELD panel and one conflict panel, in either order.
      const outcome = async (held: Locator, conflict: Locator): Promise<string> => {
        if ((await held.count()) > 0) return 'held';
        if ((await conflict.count()) > 0) return 'conflict';
        return 'pending';
      };
      await expect
        .poll(
          async () =>
            [
              await outcome(
                pageA.getByRole('heading', { name: /Reserva \d+/ }),
                pageA.getByText(/foram ocupados/),
              ),
              await outcome(
                pageB.getByRole('heading', { name: /Reserva \d+/ }),
                pageB.getByText(/foram ocupados/),
              ),
            ]
              .sort()
              .join('+'),
          { timeout: 30_000 },
        )
        .toBe('conflict+held');

      // Authoritative check: a single active holder in PostgreSQL.
      expect(await countActiveHolders(env.databaseUrl, slot.screeningId, seatId)).toBe(1);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});
