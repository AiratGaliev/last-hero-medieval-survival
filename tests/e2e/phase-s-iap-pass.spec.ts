import { expect, test, type Page } from '@playwright/test';

const startupTimeout = 60_000;

async function openGame(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });
}

test('premium pass purchased with crowns catches up and pass banner unlocks at level 50', async ({ page }) => {
  await openGame(page);

  const initial = await page.evaluate(async () => {
    type PassState = { season: string; xp: number; premium: boolean; claimedFree: number; claimedPrem: number };
    type TestState = { matchesPlayed: number; crowns: number; pass: PassState; banners: string[] };
    const meta = await import('/src/game/meta.ts') as unknown as {
      rollMetaDay: () => TestState;
      saveMetaState: (state: TestState) => boolean;
      buyPassWithCrowns: () => { ok: boolean; reason?: string };
      ownedBanners: () => string[];
    };
    const state = meta.rollMetaDay();
    state.matchesPlayed = 20;
    state.crowns = 290;
    state.pass = { ...state.pass, xp: 2_000, premium: false };
    state.banners = [];
    if (!meta.saveMetaState(state)) throw new Error('failed to prepare pass test state');
    const before = meta.ownedBanners();
    const purchase = meta.buyPassWithCrowns();
    const after = meta.rollMetaDay();
    return {
      beforeHasPassBanner: before.includes('banner_pass'),
      purchase,
      crowns: after.crowns,
      premium: after.pass.premium,
      retroSkinGranted: after.skins?.owned?.includes('skin_prem_10') ?? false,
      atLevel20HasPassBanner: meta.ownedBanners().includes('banner_pass'),
    };
  });

  expect(initial.beforeHasPassBanner).toBe(false);
  expect(initial.purchase).toEqual({ ok: true });
  expect(initial.crowns).toBe(80);
  expect(initial.premium).toBe(true);
  expect(initial.retroSkinGranted).toBe(true);
  expect(initial.atLevel20HasPassBanner).toBe(false);

  const level50 = await page.evaluate(async () => {
    type TestState = { pass: { xp: number }; banners: string[] };
    const meta = await import('/src/game/meta.ts') as unknown as {
      rollMetaDay: () => TestState;
      saveMetaState: (state: TestState) => boolean;
      ownedBanners: () => string[];
    };
    const state = meta.rollMetaDay();
    state.pass.xp = 5_000;
    if (!meta.saveMetaState(state)) throw new Error('failed to prepare level-50 state');
    const owned = meta.ownedBanners();
    return { owned: owned.includes('banner_pass'), persisted: meta.rollMetaDay().banners.includes('banner_pass') };
  });
  expect(level50).toEqual({ owned: true, persisted: true });

  await page.reload();
  const afterReload = await page.evaluate(async () => {
    const meta = await import('/src/game/meta.ts') as unknown as {
      ownedBanners: () => string[];
      rollMetaDay: () => { banners: string[] };
    };
    return {
      owned: meta.ownedBanners().includes('banner_pass'),
      persisted: meta.rollMetaDay().banners.includes('banner_pass'),
    };
  });
  expect(afterReload).toEqual({ owned: true, persisted: true });
});

test('premium pass crown purchase rolls back when metadata persistence fails', async ({ page }) => {
  await openGame(page);

  const result = await page.evaluate(async () => {
    type PassState = { season: string; xp: number; premium: boolean; claimedFree: number; claimedPrem: number };
    type TestState = { matchesPlayed: number; crowns: number; pass: PassState; banners: string[] };
    const meta = await import('/src/game/meta.ts') as unknown as {
      rollMetaDay: () => TestState;
      saveMetaState: (state: TestState) => boolean;
      loadMetaState: () => TestState;
      buyPassWithCrowns: () => { ok: boolean; reason?: string };
    };
    const state = meta.rollMetaDay();
    state.matchesPlayed = 20;
    state.crowns = 290;
    state.pass = { ...state.pass, xp: 2_000, premium: false };
    if (!meta.saveMetaState(state)) throw new Error('failed to prepare storage-failure state');

    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string): void {
      if (key === 'tss-meta2') throw new Error('QA metadata write failure');
      originalSetItem.call(this, key, value);
    };
    try {
      const purchase = meta.buyPassWithCrowns();
      const after = meta.loadMetaState();
      return { purchase, crowns: after.crowns, premium: after.pass.premium };
    } finally {
      Storage.prototype.setItem = originalSetItem;
    }
  });

  expect(result).toEqual({
    purchase: { ok: false, reason: 'storage' },
    crowns: 290,
    premium: false,
  });
});
