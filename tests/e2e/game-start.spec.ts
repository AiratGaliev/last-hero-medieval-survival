import { expect, test } from '@playwright/test';

const startupTimeout = 30_000;

for (const language of ['ru', 'en'] as const) {
  test(`game starts in ${language.toUpperCase()} mode`, async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.goto(`/?lang=${language}&ysdk=mock`);

    // The boot screen is removed only after Phaser reports that it is ready.
    await expect(page.locator('#game canvas')).toBeVisible({
      timeout: startupTimeout,
    });
    await expect(page.locator('#boot')).toHaveCount(0, {
      timeout: startupTimeout,
    });

    const canvas = page.locator('#game canvas');
    const bounds = await canvas.boundingBox();
    expect(bounds).not.toBeNull();
    if (!bounds) throw new Error('Phaser canvas has no layout bounds');
    expect(bounds.width).toBeGreaterThan(0);
    expect(bounds.height).toBeGreaterThan(0);

    await expect.poll(() => pageErrors, {
      timeout: 2_000,
      message: 'the app should not throw uncaught browser exceptions during startup',
    }).toEqual([]);
  });
}


test('a skipped interstitial does not start the cooldown, but a shown ad does', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('tss-meta2', JSON.stringify({ matchesPlayed: 5 }));

    const probe = window as unknown as {
      __interstitialCalls: number;
      YaGames: { init: () => Promise<unknown> };
    };
    probe.__interstitialCalls = 0;

    const sdk = {
      environment: { i18n: { lang: 'en', tld: 'com' } },
      features: {
        LoadingAPI: { ready: () => {} },
        GameplayAPI: { start: () => {}, stop: () => {} },
      },
      adv: {
        showFullscreenAdv: async () => {
          probe.__interstitialCalls += 1;
          return probe.__interstitialCalls > 1;
        },
        showRewardedVideo: async () => ({ rewarded: true }),
      },
      auth: { openAuthDialog: async () => {} },
      leaderboards: {
        getDescription: async () => ({}),
        setScore: async () => {},
        getPlayerEntry: async () => ({ rank: 0, score: 0, extraData: '', player: { publicName: 'QA', uniqueID: 'qa' } }),
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
    probe.YaGames = { init: async () => sdk };
  });

  await page.goto('/');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });

  const result = await page.evaluate(async () => {
    const moduleUrl = new URL('/src/platform/ads.ts', window.location.origin).href;
    const ads = await import(/* @vite-ignore */ moduleUrl) as {
      showInterstitial: () => Promise<boolean>;
    };
    const first = await ads.showInterstitial();
    const second = await ads.showInterstitial();
    const third = await ads.showInterstitial();
    const probe = window as unknown as { __interstitialCalls: number };
    return { first, second, third, calls: probe.__interstitialCalls };
  });

  expect(result).toEqual({ first: false, second: true, third: false, calls: 2 });
});
