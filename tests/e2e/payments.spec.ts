import { expect, test, type Page } from '@playwright/test';

const startupTimeout = 30_000;

type PaymentMode = 'missing' | 'reject' | 'success';

async function bootWithYandexPayments(
  page: Page,
  mode: PaymentMode,
  consumeFails = false,
): Promise<void> {
  await page.addInitScript(({ paymentMode, failConsume }) => {
    localStorage.setItem('tss-meta2', JSON.stringify({
      matchesPlayed: 5,
      crowns: 42,
      purchasedSkus: [],
    }));

    const probe = window as unknown as {
      __paymentProbe: { purchaseCalls: number; consumeCalls: number };
      YaGames: { init: () => Promise<unknown> };
    };
    probe.__paymentProbe = { purchaseCalls: 0, consumeCalls: 0 };

    const payments = {
      purchase: async ({ id }: { id: string }) => {
        probe.__paymentProbe.purchaseCalls += 1;
        if (paymentMode === 'reject') throw new Error('QA purchase rejection');
        return { productID: id, purchaseToken: 'qa-purchase-token' };
      },
      consumePurchase: async (_token: string) => {
        probe.__paymentProbe.consumeCalls += 1;
        if (failConsume) throw new Error('QA consume failure');
      },
      getPurchases: async () => [],
      getCatalog: async () => [],
    };

    const sdk: Record<string, unknown> = {
      environment: { i18n: { lang: 'en', tld: 'com' } },
      features: {
        LoadingAPI: { ready: () => {} },
        GameplayAPI: { start: () => {}, stop: () => {} },
      },
      adv: {
        showFullscreenAdv: (options?: {
          callbacks?: { onClose?: (wasShown: boolean) => void };
        }) => queueMicrotask(() => options?.callbacks?.onClose?.(false)),
        showRewardedVideo: (options?: {
          callbacks?: {
            onOpen?: () => void;
            onRewarded?: () => void;
            onClose?: (wasShown: boolean) => void;
          };
        }) => queueMicrotask(() => {
          options?.callbacks?.onOpen?.();
          options?.callbacks?.onClose?.(false);
        }),
      },
      auth: { openAuthDialog: async () => {} },
      leaderboards: {
        getDescription: async () => ({}),
        setScore: async () => {},
        getPlayerEntry: async () => ({
          rank: 0, score: 0, extraData: '',
          player: { publicName: 'QA', uniqueID: 'qa-player' },
        }),
        getEntries: async () => ({ entries: [], userRank: 0 }),
      },
      isAvailableMethod: async () => false,
      getPlayer: async () => ({
        isAuthorized: () => false,
        getUniqueID: () => 'qa-player',
        getName: () => 'QA player',
        getPhoto: () => undefined,
      }),
      getServerTime: async () => Date.now(),
      on: () => {},
      off: () => {},
    };

    // Deliberately omit getPayments for the unavailable-SDK scenario.
    if (paymentMode !== 'missing') {
      sdk.getPayments = async () => payments;
    }
    probe.YaGames = { init: async () => sdk };
  }, { paymentMode: mode, failConsume: consumeFails });

  await page.goto('/');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });
}

async function attemptPurchase(page: Page, sku: string): Promise<{
  result: { ok: boolean; reason?: string };
  beforeCrowns: number;
  afterCrowns: number;
  beforePurchased: string[];
  afterPurchased: string[];
  probe: { purchaseCalls: number; consumeCalls: number };
}> {
  return page.evaluate(async (productId) => {
    const paymentsUrl = new URL('/src/platform/payments.ts', window.location.origin).href;
    const metaUrl = new URL('/src/game/meta.ts', window.location.origin).href;
    const [paymentModule, meta] = await Promise.all([
      import(/* @vite-ignore */ paymentsUrl) as Promise<{
        purchaseSku: (id: string) => Promise<{ ok: boolean; reason?: string }>;
      }>,
      import(/* @vite-ignore */ metaUrl) as Promise<{
        loadMetaState: () => { crowns: number; purchasedSkus: string[] };
      }>,
    ]);

    const before = meta.loadMetaState();
    const beforeCrowns = before.crowns;
    const beforePurchased = [...before.purchasedSkus];
    const result = await paymentModule.purchaseSku(productId);
    const after = meta.loadMetaState();
    const probe = (window as unknown as {
      __paymentProbe?: { purchaseCalls: number; consumeCalls: number };
    }).__paymentProbe ?? { purchaseCalls: 0, consumeCalls: 0 };

    return {
      result: { ok: result.ok, reason: result.reason },
      beforeCrowns,
      afterCrowns: after.crowns,
      beforePurchased,
      afterPurchased: [...after.purchasedSkus],
      probe,
    };
  }, sku);
}

test('missing Yandex Payment SDK fails closed without granting the SKU', async ({ page }) => {
  await bootWithYandexPayments(page, 'missing');

  const result = await attemptPurchase(page, 'crowns_s');

  expect(result.result).toEqual({ ok: false, reason: 'fail' });
  expect(result.afterCrowns).toBe(result.beforeCrowns);
  expect(result.afterPurchased).toEqual(result.beforePurchased);
  expect(result.probe.purchaseCalls).toBe(0);
});

test('a rejected platform purchase does not grant the SKU', async ({ page }) => {
  await bootWithYandexPayments(page, 'reject');

  const result = await attemptPurchase(page, 'crowns_s');

  expect(result.result).toEqual({ ok: false, reason: 'fail' });
  expect(result.afterCrowns).toBe(result.beforeCrowns);
  expect(result.afterPurchased).toEqual(result.beforePurchased);
  expect(result.probe.purchaseCalls).toBe(1);
});

test('a confirmed purchase grants once even when consumePurchase reports an error', async ({ page }) => {
  await bootWithYandexPayments(page, 'success', true);

  const result = await attemptPurchase(page, 'crowns_s');

  expect(result.result).toEqual({ ok: true });
  expect(result.afterCrowns).toBeGreaterThan(result.beforeCrowns);
  expect(result.afterPurchased).toContain('crowns_s');
  expect(result.probe).toEqual({ purchaseCalls: 1, consumeCalls: 1 });
});

test('a one-shot SKU cannot be purchased twice in the same browser profile', async ({ page }) => {
  await bootWithYandexPayments(page, 'success');

  const first = await attemptPurchase(page, 'no_interstitial');
  const second = await attemptPurchase(page, 'no_interstitial');

  expect(first.result).toEqual({ ok: true });
  expect(second.result).toEqual({ ok: false, reason: 'duplicate' });
  expect(second.afterPurchased.filter((sku) => sku === 'no_interstitial')).toHaveLength(1);
  expect(second.probe.purchaseCalls).toBe(1);
});

test('the explicit Yandex mock mode grants locally only in the dev build', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('tss-meta2', JSON.stringify({
      matchesPlayed: 5,
      crowns: 42,
      purchasedSkus: [],
    }));
  });
  await page.goto('/?ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });

  const result = await attemptPurchase(page, 'crowns_s');

  expect(result.result).toEqual({ ok: true });
  expect(result.afterCrowns).toBeGreaterThan(result.beforeCrowns);
  expect(result.afterPurchased).toContain('crowns_s');
});
