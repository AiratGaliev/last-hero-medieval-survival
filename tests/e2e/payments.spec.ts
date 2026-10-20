import { expect, test, type Page } from '@playwright/test';

// Холодный старт dev-сервера: Vite трансформирует весь граф модулей и ~570
// ассетов. На загруженном CI это занимает больше 30 сек — тест падал с
// «canvas не появился», хотя приложение стартует штатно.
const startupTimeout = 60_000;

type PaymentMode = 'missing' | 'reject' | 'success';
type CatalogMode = 'valid' | 'empty' | 'error' | 'malformed';
type PurchaseResponseMode = 'match' | 'mismatch' | 'missing-token';

async function bootWithYandexPayments(
  page: Page,
  mode: PaymentMode,
  consumeFails = false,
  catalogMode: CatalogMode = 'empty',
  pendingPurchases: Array<{ productID: string; purchaseToken?: string }> = [],
  purchaseResponse: PurchaseResponseMode = 'match',
): Promise<void> {
  await page.addInitScript(({ paymentMode, failConsume, catalogMode: configuredCatalogMode, pendingPurchases: configuredPendingPurchases, purchaseResponse: configuredPurchaseResponse }) => {
    const pendingReceipts = [...configuredPendingPurchases];
    if (!localStorage.getItem('tss-meta2')) {
      localStorage.setItem('tss-meta2', JSON.stringify({
        matchesPlayed: 5,
        crowns: 42,
        purchasedSkus: [],
      }));
    }

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
        const productID = configuredPurchaseResponse === 'mismatch' ? 'crowns_m' : id;
        const purchaseToken = configuredPurchaseResponse === 'missing-token'
          ? undefined : `qa-purchase-token-${probe.__paymentProbe.purchaseCalls}`;
        pendingReceipts.push({ productID, ...(purchaseToken ? { purchaseToken } : {}) });
        return { productID, ...(purchaseToken ? { purchaseToken } : {}) };
      },
      consumePurchase: async (token: string) => {
        probe.__paymentProbe.consumeCalls += 1;
        if (failConsume) throw new Error('QA consume failure');
        for (let i = pendingReceipts.length - 1; i >= 0; i -= 1) {
          if (pendingReceipts[i].purchaseToken === token) pendingReceipts.splice(i, 1);
        }
      },
      getPurchases: async () => [...pendingReceipts],
      getCatalog: async () => {
        if (configuredCatalogMode === 'error') throw new Error('QA catalog failure');
        if (configuredCatalogMode === 'empty') return [];
        const validProduct = {
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
        };
        const validSkin = {
          id: 'skin_hero_warrior_red',
          title: 'SDK Warrior Skin',
          description: 'A permanent cosmetic entitlement',
          imageURI: '/src/assets/game/gem-gold.png',
          price: '77 TST',
          priceValue: '77',
          priceCurrencyCode: 'TST',
          getPriceCurrencyImage: (size: 'small' | 'medium' | 'svg') => {
            probe.__catalogProbe.currencyImageSizes.push(size);
            return '/src/assets/game/gem-gold.png';
          },
        };
        if (configuredCatalogMode === 'malformed') {
          return [
            { id: 'crowns_m', title: 'Malformed price', priceValue: 123, priceCurrencyCode: 'TST' },
            validProduct,
            validSkin,
          ];
        }
        return [validProduct, validSkin];
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
  }, { paymentMode: mode, failConsume: consumeFails, catalogMode, pendingPurchases, purchaseResponse });

  await page.goto('/?lang=en');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });
}

async function metaSnapshot(page: Page): Promise<{
  crowns: number;
  speedupTokens: number;
  ownedSkins: string[];
  purchasedSkus: string[];
  processedIapTokens: string[];
  probe: { purchaseCalls: number; consumeCalls: number };
}> {
  return page.evaluate(async () => {
    const metaUrl = new URL('/src/game/meta.ts', window.location.origin).href;
    const meta = await import(/* @vite-ignore */ metaUrl) as {
      loadMetaState: () => {
        crowns: number;
        speedupTokens: number;
        skins: { owned: string[] };
        purchasedSkus: string[];
        processedIapTokens: string[];
      };
    };
    const state = meta.loadMetaState();
    const probe = (window as unknown as {
      __paymentProbe?: { purchaseCalls: number; consumeCalls: number };
    }).__paymentProbe ?? { purchaseCalls: 0, consumeCalls: 0 };
    return {
      crowns: state.crowns,
      speedupTokens: state.speedupTokens,
      ownedSkins: [...state.skins.owned],
      purchasedSkus: [...state.purchasedSkus],
      processedIapTokens: [...state.processedIapTokens],
      probe,
    };
  });
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

test('a confirmed consumable grants once even when consumePurchase reports an error', async ({ page }) => {
  await bootWithYandexPayments(page, 'success', true);

  const result = await attemptPurchase(page, 'crowns_s');

  expect(result.result).toEqual({ ok: true });
  expect(result.afterCrowns).toBeGreaterThan(result.beforeCrowns);
  expect(result.afterPurchased).toContain('crowns_s');
  expect(result.probe).toEqual({ purchaseCalls: 1, consumeCalls: 1 });
});

test('a pending consumable receipt is granted before consumption and cannot be double-credited', async ({ page }) => {
  await bootWithYandexPayments(page, 'success', false, 'empty', [
    { productID: 'crowns_s', purchaseToken: 'recovery-token' },
  ]);

  const recovered = await metaSnapshot(page);
  expect(recovered.crowns).toBe(222); // 42 + first-top-up bonus (90 × 2)
  expect(recovered.purchasedSkus).toContain('crowns_s');
  expect(recovered.processedIapTokens).toContain('recovery-token');
  expect(recovered.probe).toEqual({ purchaseCalls: 0, consumeCalls: 1 });

  const nextPurchase = await attemptPurchase(page, 'crowns_s');
  expect(nextPurchase.beforeCrowns).toBe(222);
  expect(nextPurchase.afterCrowns).toBe(312); // The second receipt grants 90, not the first-top-up bonus.
  expect(nextPurchase.probe).toEqual({ purchaseCalls: 1, consumeCalls: 2 });
});

test('pending non-consumable restores ownership without being consumed', async ({ page }) => {
  await bootWithYandexPayments(page, 'success', false, 'empty', [
    { productID: 'no_interstitial', purchaseToken: 'ownership-token' },
  ]);

  const state = await metaSnapshot(page);
  expect(state.purchasedSkus).toContain('no_interstitial');
  expect(state.processedIapTokens).toContain('ownership-token');
  expect(state.crowns).toBe(42);
  expect(state.probe).toEqual({ purchaseCalls: 0, consumeCalls: 0 });
});

test('pending one-time starter bundle restores its reward without consuming the entitlement', async ({ page }) => {
  await bootWithYandexPayments(page, 'success', false, 'empty', [
    { productID: 'starter_castellan', purchaseToken: 'starter-entitlement-token' },
  ]);

  await expect.poll(async () => (await metaSnapshot(page)).processedIapTokens)
    .toContain('starter-entitlement-token');
  const firstLoad = await metaSnapshot(page);
  expect(firstLoad.crowns).toBe(392);
  expect(firstLoad.speedupTokens).toBeGreaterThanOrEqual(3);
  expect(firstLoad.ownedSkins).toContain('skin_hero_warrior_red');
  expect(firstLoad.purchasedSkus).toContain('starter_castellan');
  expect(firstLoad.probe).toEqual({ purchaseCalls: 0, consumeCalls: 0 });

  // A relaunch still sees the permanent receipt, but its reward must not replay.
  await page.reload();
  await expect.poll(async () => (await metaSnapshot(page)).processedIapTokens)
    .toContain('starter-entitlement-token');
  const secondLoad = await metaSnapshot(page);
  expect(secondLoad.crowns).toBe(392);
  expect(secondLoad.probe).toEqual({ purchaseCalls: 0, consumeCalls: 0 });
});

test('purchase receipt remains unconsumed when durable reward persistence fails', async ({ page }) => {
  await bootWithYandexPayments(page, 'success');

  const result = await page.evaluate(async () => {
    const paymentsUrl = new URL('/src/platform/payments.ts', window.location.origin).href;
    const metaUrl = new URL('/src/game/meta.ts', window.location.origin).href;
    const [payments, meta] = await Promise.all([
      import(/* @vite-ignore */ paymentsUrl) as Promise<{
        purchaseSku: (sku: string) => Promise<{ ok: boolean; reason?: string }>;
      }>,
      import(/* @vite-ignore */ metaUrl) as Promise<{
        loadMetaState: () => { crowns: number; processedIapTokens: string[] };
      }>,
    ]);
    const beforeCrowns = meta.loadMetaState().crowns;
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string): void {
      if (key === 'tss-meta2') throw new Error('QA storage write failure');
      originalSetItem.call(this, key, value);
    };
    try {
      const purchase = await payments.purchaseSku('crowns_s');
      const after = meta.loadMetaState();
      const probe = (window as unknown as {
        __paymentProbe: { purchaseCalls: number; consumeCalls: number };
      }).__paymentProbe;
      return {
        result: purchase.reason ? { ok: purchase.ok, reason: purchase.reason } : { ok: purchase.ok },
        beforeCrowns,
        afterCrowns: after.crowns,
        tokenRetainedInMemory: after.processedIapTokens.some((token) => token.startsWith('qa-purchase-token-')),
        probe,
      };
    } finally {
      Storage.prototype.setItem = originalSetItem;
    }
  });

  expect(result.result).toEqual({ ok: false, reason: 'fail' });
  expect(result.afterCrowns).toBe(result.beforeCrowns);
  expect(result.tokenRetainedInMemory).toBe(false);
  expect(result.probe).toEqual({ purchaseCalls: 1, consumeCalls: 0 });
});

test('unregistered SKU is rejected before opening the platform checkout', async ({ page }) => {
  await bootWithYandexPayments(page, 'success');

  const result = await attemptPurchase(page, 'skin_admin_override');

  expect(result.result).toEqual({ ok: false, reason: 'fail' });
  expect(result.afterCrowns).toBe(result.beforeCrowns);
  expect(result.afterPurchased).toEqual(result.beforePurchased);
  expect(result.probe.purchaseCalls).toBe(0);
});

test('an already owned cosmetic cannot be purchased again through IAP', async ({ page }) => {
  await bootWithYandexPayments(page, 'success');
  await page.evaluate(async () => {
    const metaUrl = new URL('/src/game/meta.ts', window.location.origin).href;
    const meta = await import(/* @vite-ignore */ metaUrl) as {
      loadMetaState: () => { skins: { owned: string[] } };
      saveMetaState: (state: { skins: { owned: string[] } }) => boolean;
    };
    const state = meta.loadMetaState();
    state.skins.owned.push('skin_hero_warrior_red');
    meta.saveMetaState(state);
  });

  const result = await attemptPurchase(page, 'skin_hero_warrior_red');

  expect(result.result).toEqual({ ok: false, reason: 'duplicate' });
  expect(result.probe.purchaseCalls).toBe(0);
});

test('mismatched product ID in a resolved receipt does not grant the requested SKU', async ({ page }) => {
  await bootWithYandexPayments(page, 'success', false, 'empty', [], 'mismatch');

  const result = await attemptPurchase(page, 'crowns_s');

  expect(result.result).toEqual({ ok: false, reason: 'fail' });
  expect(result.afterCrowns).toBe(result.beforeCrowns);
  expect(result.afterPurchased).toEqual(result.beforePurchased);
  expect(result.probe).toEqual({ purchaseCalls: 1, consumeCalls: 0 });
});

test('purchase response without a token does not grant or consume a reward', async ({ page }) => {
  await bootWithYandexPayments(page, 'success', false, 'empty', [], 'missing-token');

  const result = await attemptPurchase(page, 'crowns_s');

  expect(result.result).toEqual({ ok: false, reason: 'fail' });
  expect(result.afterCrowns).toBe(result.beforeCrowns);
  expect(result.afterPurchased).toEqual(result.beforePurchased);
  expect(result.probe).toEqual({ purchaseCalls: 1, consumeCalls: 0 });
});

test('an unresolved receipt is preserved and blocks a second checkout', async ({ page }) => {
  await bootWithYandexPayments(page, 'success', false, 'empty', [
    { productID: 'removed_legacy_sku', purchaseToken: 'legacy-token' },
  ]);

  const result = await attemptPurchase(page, 'crowns_s');

  expect(result.result).toEqual({ ok: false, reason: 'fail' });
  expect(result.afterCrowns).toBe(result.beforeCrowns);
  expect(result.afterPurchased).toEqual(result.beforePurchased);
  expect(result.probe).toEqual({ purchaseCalls: 0, consumeCalls: 0 });
});

test('malformed catalog item cannot hide valid products', async ({ page }) => {
  await bootWithYandexPayments(page, 'success', false, 'malformed');
  await openCrownsTab(page);

  await expect.poll(async () => (await shopSnapshot(page)).texts).toContain('SDK Crown Pack');
  const snapshot = await shopSnapshot(page);
  expect(snapshot.texts).toContain('123 TST');
  expect(snapshot.texts).not.toContain('Malformed price');
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

test('Chronicle pass is single-purchase within a season and purchasable again next season', async ({ page }) => {
  await bootWithYandexPayments(page, 'success');

  const first = await attemptPurchase(page, 'pass_chronicle');
  const sameSeason = await attemptPurchase(page, 'pass_chronicle');
  expect(first.result).toEqual({ ok: true });
  expect(sameSeason.result).toEqual({ ok: false, reason: 'duplicate' });
  expect(sameSeason.probe).toEqual({ purchaseCalls: 1, consumeCalls: 1 });

  const reset = await page.evaluate(async () => {
    const metaUrl = new URL('/src/game/meta.ts', window.location.origin).href;
    const meta = await import(/* @vite-ignore */ metaUrl) as {
      loadMetaState: () => { pass: { season: string; premium: boolean } };
      saveMetaState: (state: { pass: { season: string; premium: boolean } }) => boolean;
      rollMetaDay: () => { pass: { season: string; premium: boolean } };
    };
    const state = meta.loadMetaState();
    state.pass.season = 'expired-test-season';
    meta.saveMetaState(state);
    const current = meta.rollMetaDay();
    return { season: current.pass.season, premium: current.pass.premium };
  });
  expect(reset.season).not.toBe('expired-test-season');
  expect(reset.premium).toBe(false);

  const nextSeason = await attemptPurchase(page, 'pass_chronicle');
  expect(nextSeason.result).toEqual({ ok: true });
  expect(nextSeason.probe).toEqual({ purchaseCalls: 2, consumeCalls: 2 });
  expect(nextSeason.afterPurchased.filter((sku) => sku === 'pass_chronicle')).toHaveLength(1);
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
  expect(snapshot.texts).toContain('SDK Warrior Skin');
  expect(snapshot.texts).toContain('77 TST');
  expect(snapshot.texts).toContain('BUY');
  expect(snapshot.catalogTextures.length).toBeGreaterThanOrEqual(4);

  const currencyImageSizes = await page.evaluate(() => (
    (window as unknown as { __catalogProbe: { currencyImageSizes: string[] } }).__catalogProbe.currencyImageSizes
  ));
  // Каталог может запрашиваться повторно при перестроении вкладки; проверяем
  // контракт размера каждого вызова, а не хрупкое количество обращений.
  expect(currencyImageSizes.length).toBeGreaterThanOrEqual(2);
  expect(currencyImageSizes.every((size) => size === 'small')).toBe(true);
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
