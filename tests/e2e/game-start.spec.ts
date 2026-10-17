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



test('Yandex callback ads resolve after completion and throttle only shown interstitials', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('tss-meta2', JSON.stringify({ matchesPlayed: 5 }));

    const probe = window as unknown as {
      __interstitialCalls: number;
      __rewardedCalls: number;
      YaGames: { init: () => Promise<unknown> };
    };
    probe.__interstitialCalls = 0;
    probe.__rewardedCalls = 0;

    const sdk = {
      environment: { i18n: { lang: 'en', tld: 'com' } },
      features: {
        LoadingAPI: { ready: () => {} },
        GameplayAPI: { start: () => {}, stop: () => {} },
      },
      adv: {
        showFullscreenAdv: (options?: {
          callbacks?: { onClose?: (wasShown: boolean) => void; onError?: (error: object) => void };
        }) => {
          probe.__interstitialCalls += 1;
          const shown = probe.__interstitialCalls > 1;
          queueMicrotask(() => options?.callbacks?.onClose?.(shown));
        },
        showRewardedVideo: (options?: {
          callbacks?: {
            onOpen?: () => void;
            onRewarded?: () => void;
            onClose?: (wasShown: boolean) => void;
            onError?: (error: object) => void;
          };
        }) => {
          probe.__rewardedCalls += 1;
          queueMicrotask(() => {
            options?.callbacks?.onOpen?.();
            options?.callbacks?.onRewarded?.();
            options?.callbacks?.onClose?.(true);
          });
        },
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
      showInterstitial: (hooks: { pause: () => void; resume: () => void }) => Promise<boolean>;
      showRewarded: (hooks: { pause: () => void; resume: () => void }) => Promise<{ rewarded: boolean; available: boolean }>;
    };
    let pauses = 0;
    let resumes = 0;
    const hooks = { pause: () => { pauses += 1; }, resume: () => { resumes += 1; } };

    const first = await ads.showInterstitial(hooks);
    const second = await ads.showInterstitial(hooks);
    const third = await ads.showInterstitial(hooks);
    const rewarded = await ads.showRewarded(hooks);
    const probe = window as unknown as { __interstitialCalls: number; __rewardedCalls: number };
    return {
      first, second, third, rewarded,
      interstitialCalls: probe.__interstitialCalls,
      rewardedCalls: probe.__rewardedCalls,
      pauses, resumes,
    };
  });

  expect(result).toEqual({
    first: false,
    second: true,
    third: false,
    rewarded: { rewarded: true, available: true },
    interstitialCalls: 2,
    rewardedCalls: 1,
    pauses: 3,
    resumes: 3,
  });
});