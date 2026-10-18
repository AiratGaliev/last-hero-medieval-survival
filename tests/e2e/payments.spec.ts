import { expect, test, type Page } from '@playwright/test';

const startupTimeout = 30_000;

type PaymentMode = 'missing' | 'reject' | 'success';
type CatalogMode = 'valid' | 'empty' | 'error';

async function bootWithYandexPayments(
  page: Page,
  mode: PaymentMode,
  consumeFails = false,
  catalogMode: CatalogMode = 'empty',
): Promise<void> {
  await page.addInitScript(({ paymentMode, failConsume, catalogMode: configuredCatalogMode }) => {
    localStorage.setItem('tss-meta2', JSON.stringify({
      matchesPlayed: 5,
      crowns: 42,
      purchasedSkus: [],
    }));

    const probe = window as unknown as {
      __paymentProbe: { purchaseCalls: number; consumeCalls: number };
      __catalogProbe: { currencyImageSizes: string[] };
      YaGames: { init: () => Promise<unknown> };
    };
    probe.__paymentProbe = { purchaseCalls: 0, consumeCalls: 0 };
    probe.__catalogProbe = { currencyImageSizes: [] };

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
      getCatalog: async () => {
        if (configuredCatalogMode === 'error') throw new Error('QA catalog failure');
        if (configuredCatalogMode !== 'valid') return [];
        return [{
          id: 'crowns_s',
          title: 'SDK Crown Pack',
          description: 'Description supplied by the platform catalog',
          imageURI: '/src/assets/game/gem-gold.png',
          price: '123 TST',
          priceValue: '123',
          priceCurrencyCode: 'TST',
          getPriceCurrencyImage: (size: 'small' | 'medium' | 'svg') => {
            probe.__catalogProbe.currencyImageSizes.push(size);
            return '/src/assets/game/gem-gold.png';
          },
        }];
      },
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
  }, { paymentMode: mode, failConsume: consumeFails, catalogMode });

  await page.goto('/?lang=en');
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
      result: result.reason ? { ok: result.ok, reason: result.reason } : { ok: result.ok },
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


type ShopSceneForTest = {
  scene: { launch: (key: string, data?: { tab: string }) => void };
  sys?: { displayList: { list: Array<ShopDisplayObject> } };
};
type ShopDisplayObject = {
  type?: string;
  text?: string;
  list?: ShopDisplayObject[];
  texture?: { key?: string };
};
type GameWithShop = {
  scene: {
    isActive: (key: string) => boolean;
    getScene: (key: string) => ShopSceneForTest;
  };
};

async function openCrownsTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    const game = (window as unknown as { __tss?: GameWithShop }).__tss;
    if (!game) throw new Error('Phaser game is not available');
    game.scene.getScene('Menu').scene.launch('Shop', { tab: 'crowns' });
  });
  await expect.poll(() => page.evaluate(() => {
    const game = (window as unknown as { __tss?: GameWithShop }).__tss;
    return Boolean(game && game.scene.isActive('Shop'));
  }), { timeout: startupTimeout }).toBe(true);
}

async function shopSnapshot(page: Page): Promise<{ texts: string[]; catalogTextures: string[] }> {
  return page.evaluate(() => {
    const game = (window as unknown as { __tss?: GameWithShop }).__tss;
    if (!game || !game.scene.isActive('Shop')) return { texts: [], catalogTextures: [] };
    const scene = game.scene.getScene('Shop');
    if (!scene.sys) return { texts: [], catalogTextures: [] };
    const objects: ShopDisplayObject[] = [];
    const visit = (items: ShopDisplayObject[]): void => {
      for (const item of items) {
        objects.push(item);
        if (Array.isArray(item.list)) visit(item.list);
      }
    };
    visit(scene.sys.displayList.list);
    return {
      texts: objects.filter((item) => item.type === 'Text' && typeof item.text === 'string')
        .map((item) => item.text as string),
      catalogTextures: objects.filter((item) => item.type === 'Image' && item.texture?.key?.startsWith('catalog-'))
        .map((item) => item.texture?.key as string),
    };
  });
}

test('shop displays product details and currency artwork from the SDK catalog', async ({ page }) => {
  await bootWithYandexPayments(page, 'success', false, 'valid');
  await openCrownsTab(page);

  await expect.poll(async () => (await shopSnapshot(page)).texts).toContain('SDK Crown Pack');
  const snapshot = await shopSnapshot(page);
  expect(snapshot.texts).toContain('Description supplied by the platform catalog');
  expect(snapshot.texts).toContain('123 TST');
  expect(snapshot.texts).toContain('BUY');
  expect(snapshot.catalogTextures.length).toBeGreaterThanOrEqual(2);

  const currencyImageSizes = await page.evaluate(() => (
    (window as unknown as { __catalogProbe: { currencyImageSizes: string[] } }).__catalogProbe.currencyImageSizes
  ));
  expect(currencyImageSizes).toEqual(['small']);
});

test('an empty platform catalog never falls back to fictional local SKU prices', async ({ page }) => {
  await bootWithYandexPayments(page, 'success', false, 'empty');
  await openCrownsTab(page);

  await expect.poll(async () => (await shopSnapshot(page)).texts)
    .toContain('Purchases are temporarily unavailable. Please try again later.');
  const texts = (await shopSnapshot(page)).texts;
  expect(texts).not.toContain('~49');
  expect(texts).not.toContain('90 crowns');
  expect(texts).not.toContain('SDK Crown Pack');
});

test('a failed platform catalog request keeps IAP items unavailable without crashing the scene', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await bootWithYandexPayments(page, 'success', false, 'error');
  await openCrownsTab(page);

  await expect.poll(async () => (await shopSnapshot(page)).texts)
    .toContain('Purchases are temporarily unavailable. Please try again later.');
  expect(pageErrors).toEqual([]);
});
