import { expect, test } from '@playwright/test';

const startupTimeout = 60_000;

test('daily streak loses only one step after a long absence', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('tss-meta2', JSON.stringify({
      v: 2,
      matchesPlayed: 10,
      dailyBonus: { last: '2000-01-01', lastAt: Date.parse('2000-01-01T12:00:00.000Z'), streak: 5 },
    }));
  });

  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });

  const outcome = await page.evaluate(async () => {
    const moduleUrl = new URL('/src/game/meta.ts', window.location.origin).href;
    const meta = await import(/* @vite-ignore */ moduleUrl) as {
      claimDailyBonus: () => { ok: boolean; day: number; streak: number };
    };
    const result = meta.claimDailyBonus();
    const raw = localStorage.getItem('tss-meta2');
    const stored = raw
      ? JSON.parse(raw) as { dailyBonus?: { streak?: number; last?: string } }
      : null;

    return {
      result,
      storedStreak: stored?.dailyBonus?.streak,
      storedLast: stored?.dailyBonus?.last,
    };
  });

  expect(outcome.result.ok).toBe(true);
  // После пропуска нескольких дней снимается одна ступень: 5 -> 4, затем
  // за сегодняшний вход начисляется следующий шаг цикла (стрик остаётся 5).
  expect(outcome.result.streak).toBe(5);
  expect(outcome.storedStreak).toBe(5);
  expect(outcome.storedLast).not.toBe('2000-01-01');
});


test('meta progress restores newer Player Data state and flushes subsequent mutations', async ({ page }) => {
  await page.addInitScript(() => {
    const cloudKey = '__phase_q_player_data_v1';
    const cloudSavedAt = Date.now() + 60_000;
    const playerData: Record<string, unknown> = {
      'tss-meta-state-v1': {
        version: 1,
        savedAt: cloudSavedAt,
        state: {
          v: 2,
          savedAt: cloudSavedAt,
          matchesPlayed: 11,
          glory: 777,
          nodes: [],
          quests: { date: '', ids: [], progress: {}, done: [], rerolls: 0 },
          dailyBonus: { last: '2000-01-01', lastAt: Date.parse('2000-01-01T12:00:00.000Z'), streak: 6 },
        },
        shop: { balance: 500, upgrades: { might: 2, vitality: 1, speed: 0, magnet: 0, luck: 0 } },
        preferences: { contract: 'c_hunger', ukaz: 'ukaz_fragile' },
      },
    };
    sessionStorage.setItem(cloudKey, JSON.stringify(playerData));
    localStorage.clear();
    localStorage.setItem('tss-meta2', JSON.stringify({
      v: 2,
      savedAt: Date.now() - 60_000,
      matchesPlayed: 2,
      glory: 100,
      dailyBonus: { last: '2000-01-01', lastAt: 0, streak: 2 },
    }));
    localStorage.setItem('tss-shop', JSON.stringify({
      balance: 15,
      upgrades: { might: 0, vitality: 0, speed: 0, magnet: 0, luck: 0 },
    }));
    localStorage.setItem('tss-contract-pick', 'c_no_repair');
    localStorage.setItem('tss-ukaz-pick', 'ukaz_double_siege');

    const player = {
      isAuthorized: () => true,
      getUniqueID: () => 'phase-q-cloud-test-profile',
      getName: () => 'Cloud QA',
      getPhoto: () => undefined,
      getData: async (keys?: string[]) => {
        const current = JSON.parse(sessionStorage.getItem(cloudKey) ?? '{}') as Record<string, unknown>;
        if (!keys) return current;
        return Object.fromEntries(keys.filter((key) => Object.prototype.hasOwnProperty.call(current, key))
          .map((key) => [key, current[key]]));
      },
      setData: async (data: Record<string, unknown>) => {
        const current = JSON.parse(sessionStorage.getItem(cloudKey) ?? '{}') as Record<string, unknown>;
        Object.assign(current, data);
        sessionStorage.setItem(cloudKey, JSON.stringify(current));
      },
    };

    const target = window as unknown as {
      YaGames?: { init: () => Promise<unknown> };
    };
    target.YaGames = {
      init: async () => ({
        environment: { i18n: { lang: 'en', tld: 'com' } },
        features: {
          LoadingAPI: { ready: () => undefined },
          GameplayAPI: { start: () => undefined, stop: () => undefined },
        },
        adv: {
          showFullscreenAdv: (options?: { callbacks?: { onClose?: (shown: boolean) => void } }) => {
            options?.callbacks?.onClose?.(false);
          },
          showRewardedVideo: (options?: { callbacks?: {
            onOpen?: () => void; onRewarded?: () => void; onClose?: (shown: boolean) => void;
          } }) => {
            options?.callbacks?.onOpen?.();
            options?.callbacks?.onRewarded?.();
            options?.callbacks?.onClose?.(true);
          },
        },
        auth: { openAuthDialog: async () => undefined },
        leaderboards: {
          getDescription: async () => ({ decimalOffset: 0 }),
          setScore: async () => undefined,
          getPlayerEntry: async () => ({}),
          getEntries: async () => ({ entries: [], userRank: -1 }),
        },
        isAvailableMethod: async () => true,
        getPlayer: async () => player,
        serverTime: () => Date.now(),
        on: () => undefined,
        off: () => undefined,
      }),
    };
  });

  await page.goto('/?lang=en');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });

  const report = await page.evaluate(async () => {
    const moduleUrl = new URL('/src/game/meta.ts', window.location.origin).href;
    const meta = await import(/* @vite-ignore */ moduleUrl) as {
      loadMetaState: () => { matchesPlayed: number; glory: number; dailyBonus: { streak: number } };
      loadMetaPreferences: () => { contract: string | null; ukaz: string | null };
      saveMetaPreferences: (preferences: { contract: 'c_no_repair' | 'c_hunger' | 'c_pacifist' | null; ukaz: 'ukaz_double_siege' | 'ukaz_fragile' | 'ukaz_horde' | null }) => void;
      addGlory: (amount: number) => void;
      flushMetaStateToPlayerData: () => Promise<boolean>;
    };
    const shopUrl = new URL('/src/game/shop.ts', window.location.origin).href;
    const shopModule = await import(/* @vite-ignore */ shopUrl) as {
      loadShop: () => { balance: number; upgrades: { might: number } };
      depositGold: (amount: number) => void;
    };
    const restored = meta.loadMetaState();
    const restoredPreferences = meta.loadMetaPreferences();
    const restoredSnapshot = {
      matchesPlayed: restored.matchesPlayed,
      glory: restored.glory,
      streak: restored.dailyBonus.streak,
      wallet: shopModule.loadShop().balance,
      mightUpgrade: shopModule.loadShop().upgrades.might,
      contract: restoredPreferences.contract,
      ukaz: restoredPreferences.ukaz,
    };

    meta.saveMetaPreferences({ contract: 'c_pacifist', ukaz: 'ukaz_horde' });
    meta.addGlory(17);
    shopModule.depositGold(23);
    const flushed = await meta.flushMetaStateToPlayerData();
    const playerData = JSON.parse(sessionStorage.getItem('__phase_q_player_data_v1') ?? '{}') as {
      'tss-meta-state-v1'?: {
        version?: number;
        state?: { glory?: number; matchesPlayed?: number };
        shop?: { balance?: number; upgrades?: { might?: number } };
        preferences?: { contract?: string | null; ukaz?: string | null };
      };
    };
    const cloud = playerData['tss-meta-state-v1'];

    return {
      restoredSnapshot,
      flushed,
      cloudVersion: cloud?.version,
      cloudGlory: cloud?.state?.glory,
      cloudMatches: cloud?.state?.matchesPlayed,
      cloudWallet: cloud?.shop?.balance,
      cloudMightUpgrade: cloud?.shop?.upgrades?.might,
      cloudContract: cloud?.preferences?.contract,
      cloudUkaz: cloud?.preferences?.ukaz,
    };
  });

  expect(report.restoredSnapshot).toEqual({
    matchesPlayed: 11, glory: 777, streak: 6, wallet: 500, mightUpgrade: 2,
    contract: 'c_hunger', ukaz: 'ukaz_fragile',
  });
  expect(report.flushed).toBe(true);
  expect(report.cloudVersion).toBe(1);
  expect(report.cloudGlory).toBe(794);
  expect(report.cloudMatches).toBe(11);
  expect(report.cloudWallet).toBe(523);
  expect(report.cloudMightUpgrade).toBe(2);
  expect(report.cloudContract).toBe('c_pacifist');
  expect(report.cloudUkaz).toBe('ukaz_horde');
});


test('daily bonus cannot be claimed twice across a UTC date boundary', async ({ page }) => {
  await page.addInitScript(() => {
    const now = Date.now();
    const yesterday = new Date(now - 86_400_000).toISOString().slice(0, 10);
    localStorage.clear();
    localStorage.setItem('tss-meta2', JSON.stringify({
      v: 2,
      savedAt: now - 5_000,
      matchesPlayed: 10,
      dailyBonus: { last: yesterday, lastAt: now - 60 * 60 * 1000, streak: 4 },
    }));
  });

  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });

  const outcome = await page.evaluate(async () => {
    const moduleUrl = new URL('/src/game/meta.ts', window.location.origin).href;
    const meta = await import(/* @vite-ignore */ moduleUrl) as {
      claimDailyBonus: () => { ok: boolean; streak: number };
      bonusAvailable: () => boolean;
    };
    const result = meta.claimDailyBonus();
    const raw = localStorage.getItem('tss-meta2');
    const stored = raw
      ? JSON.parse(raw) as { dailyBonus?: { streak?: number; lastAt?: number } }
      : null;
    return {
      result,
      available: meta.bonusAvailable(),
      streak: stored?.dailyBonus?.streak,
      lastAt: stored?.dailyBonus?.lastAt,
    };
  });

  expect(outcome.result.ok).toBe(false);
  expect(outcome.available).toBe(false);
  expect(outcome.streak).toBe(4);
  expect(outcome.lastAt).toBeGreaterThan(0);
});


test('daily quest and weekly keys use UTC rather than the browser timezone', async ({ browser }) => {
  const context = await browser.newContext({
    baseURL: 'http://127.0.0.1:3000',
    timezoneId: 'Pacific/Kiritimati',
  });
  const page = await context.newPage();

  try {
    await page.addInitScript(() => {
      // 23:30 UTC воскресенья уже является понедельником в часовом поясе теста.
      Date.now = () => Date.UTC(2026, 9, 18, 23, 30, 0);
    });
    await page.goto('/?lang=en&ysdk=mock');
    await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
    await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });

    const keys = await page.evaluate(async () => {
      const moduleUrl = new URL('/src/game/meta.ts', window.location.origin).href;
      const meta = await import(/* @vite-ignore */ moduleUrl) as {
        rollMetaDay: () => { quests: { date: string } };
        currentWeekKey: () => string;
      };
      const state = meta.rollMetaDay();
      return {
        localDate: new Date(Date.now()).toISOString().slice(0, 10),
        localDay: new Date(Date.now()).getDate(),
        questDate: state.quests.date,
        week: meta.currentWeekKey(),
      };
    });

    expect(keys.localDate).toBe('2026-10-18');
    expect(keys.localDay).toBe(19);
    expect(keys.questDate).toBe('2026-10-18');
    expect(keys.week).toBe('2026-10-12');
  } finally {
    await context.close();
  }
});
