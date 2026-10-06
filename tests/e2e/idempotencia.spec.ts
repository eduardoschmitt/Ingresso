import { expect, test, type Page } from '@playwright/test';

import { resolveE2EEnv } from './env.js';
import { cleanupScreenings, countByIdempotencyKey, slotScreenings } from './fixtures.js';

const env = resolveE2EEnv();

type PostedRequest = { key: string | null; body: unknown };

async function openFlow(page: Page, screeningId: number): Promise<void> {
  await page.goto(`/sessoes/${screeningId}`);
  await page.getByRole('button', { name: 'Fileira A, assento 1, disponível' }).click();
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.getByRole('button', { name: 'Reservar assentos' })).toBeVisible();
}

test.describe('idempotencia e falhas de rede', () => {
  // Exclusive slot: screening 4 (Iron Man, Sala 2).
  test.afterEach(async () => {
    await cleanupScreenings(env.databaseUrl, [4]);
  });

  test('resposta perdida apos processamento: retry mesma chave, uma unica reserva', async ({
    page,
  }) => {
    const slots = await slotScreenings(env.databaseUrl);
    if (slots[3]?.screeningId !== 4) throw new Error('e2e: deterministic seed mismatch');
    const posted: PostedRequest[] = [];
    let dropNext = true;
    // Controlled interception: let the server PROCESS the POST (route.fetch),
    // then drop the response so the browser sees a network failure.
    await page.route('**/reservations', async (route) => {
      const request = route.request();
      if (request.method() === 'POST') {
        posted.push({
          key: request.headers()['idempotency-key'] ?? null,
          body: request.postDataJSON(),
        });
      }
      if (request.method() !== 'POST' || !dropNext) {
        await route.continue();
        return;
      }
      dropNext = false;
      await route.fetch();
      await route.abort('failed');
    });

    await openFlow(page, 4);
    await page.getByRole('button', { name: 'Reservar assentos' }).click();
    // Uncertain outcome — explicitly NOT a definitive failure.
    await expect(page.getByText(/pode ter sido concluída/)).toBeVisible();

    // Retry reuses exactly the same key and payload (adjustments 1-2).
    await page.getByRole('button', { name: 'Verificar estado' }).click();
    const heading = page.getByRole('heading', { name: /Reserva \d+/ });
    await expect(heading).toBeVisible();
    const reservationId = Number((await heading.textContent())?.match(/\d+/)?.[0]);

    expect(posted).toHaveLength(2);
    expect(posted[0]?.key).toBeTruthy();
    expect(posted[1]).toEqual(posted[0]);

    // PostgreSQL proves a single creation and the replay identity.
    const stored = await countByIdempotencyKey(env.databaseUrl, posted[0]?.key ?? '');
    expect(stored.count).toBe(1);
    expect(stored.id).toBe(reservationId);
  });

  test('duplo clique envia um unico POST', async ({ page }) => {
    let posts = 0;
    await page.route('**/reservations', async (route) => {
      if (route.request().method() === 'POST') {
        posts += 1;
        // Hold the first response so both clicks land mid-flight.
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      await route.continue();
    });
    await openFlow(page, 4);
    const button = page.getByRole('button', { name: 'Reservar assentos' });
    await Promise.all([button.click(), button.click()]);
    await expect(page.getByRole('heading', { name: /Reserva \d+/ })).toBeVisible();
    expect(posts).toBe(1);
  });

  test('nova selecao gera nova operacao logica (chave diferente)', async ({ page }) => {
    const keys: (string | null)[] = [];
    await page.route('**/reservations', async (route) => {
      if (route.request().method() === 'POST') {
        keys.push(route.request().headers()['idempotency-key'] ?? null);
      }
      await route.continue();
    });

    // First logical operation: hold, then cancel, then go back.
    await openFlow(page, 4);
    await page.getByRole('button', { name: 'Reservar assentos' }).click();
    await expect(page.getByRole('heading', { name: /Reserva \d+/ })).toBeVisible();
    await page.getByRole('button', { name: 'Cancelar reserva' }).click();
    await expect(page.getByText('Cancelada')).toBeVisible();
    await page.getByRole('button', { name: 'Voltar à seleção' }).click();

    // New selection (different seat) + Continuar = new mount = new key.
    await page.getByRole('button', { name: 'Fileira A, assento 2, disponível' }).click();
    await page.getByRole('button', { name: 'Continuar' }).click();
    await page.getByRole('button', { name: 'Reservar assentos' }).click();
    await expect(page.getByRole('heading', { name: /Reserva \d+/ })).toBeVisible();

    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBeTruthy();
    expect(keys[0]).not.toBe(keys[1]);
  });
});
