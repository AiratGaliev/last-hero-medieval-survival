import { expect, test, type Page } from '@playwright/test';

const startupTimeout = 60_000;

async function openGame(page: Page): Promise<void> {
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });
}

test('premium pass purchased with crowns catches up and pass banner unlocks at level 50', async ({ page }) => {
  await openGame(page);

  const initial = await page.evaluate(async () => {
    type PassState = { season: string; xp: number; premium: boolean; claimedFree: number; claimedPrem: number };
    type TestState = { matchesPlayed: number; crowns: number; pass: PassState; banners: string[]; skins: { owned: string[] }; passTitles: string[]; profileFrames: string[] };
    const meta = await import('/src/game/meta.ts') as unknown as {
      rollMetaDay: () => TestState;
      saveMetaState: (state: TestState) => boolean;
      buyPassWithCrowns: () => { ok: boolean; reason?: string };
      ownedBanners: () => string[];
    };
    const state = meta.rollMetaDay();
    state.matchesPlayed = 20;
    state.crowns = 290;
    state.pass = { ...state.pass, xp: 4_500, premium: false };
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
      passTitles: after.passTitles,
      profileFrames: after.profileFrames,
      beforeLevel50HasPassBanner: meta.ownedBanners().includes('banner_pass'),
    };
  });

  expect(initial.beforeHasPassBanner).toBe(false);
  expect(initial.purchase).toEqual({ ok: true });
  expect(initial.crowns).toBe(210);
  expect(initial.premium).toBe(true);
  expect(initial.retroSkinGranted).toBe(true);
  expect(initial.passTitles).toEqual(['title_20', 'title_40']);
  expect(initial.profileFrames).toEqual(['frame_chronicle']);
  expect(initial.beforeLevel50HasPassBanner).toBe(false);

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
      rollMetaDay: () => { banners: string[]; passTitles: string[]; profileFrames: string[] };
    };
    const state = meta.rollMetaDay();
    return {
      owned: meta.ownedBanners().includes('banner_pass'),
      persisted: state.banners.includes('banner_pass'),
      passTitles: state.passTitles,
      profileFrames: state.profileFrames,
    };
  });
  expect(afterReload).toEqual({
    owned: true,
    persisted: true,
    passTitles: ['title_20', 'title_40'],
    profileFrames: ['frame_chronicle'],
  });
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

test('weekly crown reward does not unlock the permanent weekly banner', async ({ page }) => {
  await openGame(page);

  const result = await page.evaluate(async () => {
    type WeekState = {
      weekly: { week: string; progress: number; stage: number; claimed: boolean };
      banners: string[];
    };
    const meta = await import('/src/game/meta.ts') as unknown as {
      rollMetaDay: () => WeekState;
      saveMetaState: (state: WeekState) => boolean;
      weeklyFinalReward: (week: string) => 'crowns' | 'banner';
      ownedBanners: () => string[];
    };

    // 26 октября 2026 года — неделя с наградой в кронах; часы восстанавливаем даже при ошибке.
    const originalNow = Date.now;
    Date.now = () => Date.parse('2026-10-26T12:00:00.000Z');
    try {
      const state = meta.rollMetaDay();
      const reward = meta.weeklyFinalReward(state.weekly.week);
      const rewardSequence = ['2026-10-19', '2026-10-26', '2026-11-02']
        .map((week) => meta.weeklyFinalReward(week));
      if (reward !== 'crowns') throw new Error('test week must award crowns');

      state.weekly.progress = 20;
      state.weekly.stage = 5;
      state.weekly.claimed = true;
      state.banners = state.banners.filter((id) => id !== 'banner_weekly');
      if (!meta.saveMetaState(state)) throw new Error('failed to prepare weekly reward state');

      const owned = meta.ownedBanners();
      return {
        reward,
        rewardSequence,
        ownsBanner: owned.includes('banner_weekly'),
        persisted: meta.rollMetaDay().banners.includes('banner_weekly'),
      };
    } finally {
      Date.now = originalNow;
    }
  });

  expect(result).toEqual({
    reward: 'crowns',
    rewardSequence: ['banner', 'crowns', 'banner'],
    ownsBanner: false,
    persisted: false,
  });
});
test('legacy banner stored in the skin collection migrates to permanent ownership', async ({ page }) => {
  await openGame(page);

  await page.evaluate(() => {
    const raw = localStorage.getItem('tss-meta2');
    if (!raw) throw new Error('missing metadata state for migration test');
    const state = JSON.parse(raw) as {
      weekly: { claimed: boolean };
      banners: string[];
      skins: { owned: string[] };
    };
    state.weekly.claimed = false;
    state.banners = [];
    state.skins.owned = [...state.skins.owned, 'banner_weekly'];
    localStorage.setItem('tss-meta2', JSON.stringify(state));
  });

  await page.reload();
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });

  const result = await page.evaluate(async () => {
    const meta = await import('/src/game/meta.ts') as unknown as {
      loadMetaState: () => { banners: string[]; skins: { owned: string[] } };
    };
    const state = meta.loadMetaState();
    return {
      migrated: state.banners.includes('banner_weekly'),
      keptAsSkin: state.skins.owned.includes('banner_weekly'),
    };
  });

  expect(result).toEqual({ migrated: true, keptAsSkin: false });
});
