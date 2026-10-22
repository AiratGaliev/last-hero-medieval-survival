import { expect, test, type Page } from '@playwright/test';

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
      dailyBonusPreviewIndex: () => number;
    };
    const previewIndex = meta.dailyBonusPreviewIndex();
    const result = meta.claimDailyBonus();
    const raw = localStorage.getItem('tss-meta2');
    const stored = raw
      ? JSON.parse(raw) as { dailyBonus?: { streak?: number; last?: string } }
      : null;

    return {
      result,
      previewIndex,
      storedStreak: stored?.dailyBonus?.streak,
      storedLast: stored?.dailyBonus?.last,
    };
  });

  expect(outcome.result.ok).toBe(true);
  // Preview должен совпасть с фактической выдачей после отката стрика: 5 -> 4.
  expect(outcome.previewIndex).toBe(outcome.result.day);
  expect(outcome.previewIndex).toBe(4);
  // За сегодняшний вход начисляется следующий шаг цикла, стрик остаётся 5.
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


test('daily bonus cannot be claimed twice across a Moscow date boundary', async ({ page }) => {
  await page.addInitScript(() => {
    const now = Date.UTC(2026, 9, 21, 21, 30, 0); // 00:30 МСК 22 октября
    Date.now = () => now;
    const yesterday = '2026-10-21';
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


test('daily meta uses Moscow time while the deterministic challenge seed stays on UTC date', async ({ browser }) => {
  const context = await browser.newContext({
    baseURL: 'http://127.0.0.1:3000',
    timezoneId: 'Pacific/Kiritimati',
  });
  const page = await context.newPage();

  try {
    await page.addInitScript(() => {
      // 21:30 UTC — 00:30 понедельника в Москве; в UTC ещё воскресенье.
      Date.now = () => Date.UTC(2026, 9, 18, 21, 30, 0);
    });
    await page.goto('/?lang=en&ysdk=mock');
    await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
    await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });

    const keys = await page.evaluate(async () => {
      const moduleUrl = new URL('/src/game/meta.ts', window.location.origin).href;
      const meta = await import(/* @vite-ignore */ moduleUrl) as {
        rollMetaDay: () => { quests: { date: string } };
        currentWeekKey: () => string;
        challengeForToday: () => { mods: string[]; seed: string };
      };
      const state = meta.rollMetaDay();
      const challenge = meta.challengeForToday();
      const now = new Date(Date.now());
      const browserDate = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0'),
      ].join('-');
      return {
        utcDate: now.toISOString().slice(0, 10),
        browserDate,
        questDate: state.quests.date,
        week: meta.currentWeekKey(),
        challengeSeed: challenge.seed,
        challengeMods: challenge.mods,
      };
    });

    expect(keys.utcDate).toBe('2026-10-18');
    expect(keys.browserDate).toBe('2026-10-19');
    expect(keys.questDate).toBe('2026-10-19');
    expect(keys.week).toBe('2026-10-19');
    expect(keys.challengeSeed).toBe('2026-10-18');
    expect(keys.challengeMods).toHaveLength(2);
  } finally {
    await context.close();
  }
});


test('contract score applies the registered multiplier without replacing the base score', async ({ page }) => {
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });

  const result = await page.evaluate(async () => {
    const moduleUrl = new URL('/src/game/meta.ts', window.location.origin).href;
    const meta = await import(/* @vite-ignore */ moduleUrl) as {
      contractScoreForRun: (
        score: number,
        contractId: string | null,
      ) => {
        contract: string | null;
        baseScore: number;
        multiplier: number;
        adjustedScore: number;
      };
    };
    const ids = [
      'c_no_repair', 'c_quiet', 'c_hunger', 'c_lone_hero',
      'c_black_market', 'c_pacifist', 'c_siege_state', 'c_night',
    ];
    return {
      withoutContract: meta.contractScoreForRun(1_251, null),
      byContract: ids.map((id) => ({ id, ...meta.contractScoreForRun(1_251, id) })),
      invalid: meta.contractScoreForRun(1_251, 'unknown-contract'),
      negative: meta.contractScoreForRun(-50, 'c_hunger'),
    };
  });

  expect(result.withoutContract).toEqual({
    contract: null, baseScore: 1251, multiplier: 1, adjustedScore: 1251,
  });
  expect(result.byContract.map((item) => [item.id, item.multiplier, item.adjustedScore])).toEqual([
    ['c_no_repair', 1.2, 1501],
    ['c_quiet', 1.25, 1564],
    ['c_hunger', 1.15, 1439],
    ['c_lone_hero', 1.3, 1626],
    ['c_black_market', 1.15, 1439],
    ['c_pacifist', 1.1, 1376],
    ['c_siege_state', 1.4, 1751],
    ['c_night', 1.25, 1564],
  ]);
  expect(result.byContract.every((item) => item.baseScore === 1251 && item.contract === item.id)).toBe(true);
  expect(result.invalid).toEqual({
    contract: null, baseScore: 1251, multiplier: 1, adjustedScore: 1251,
  });
  expect(result.negative).toEqual({
    contract: 'c_hunger', baseScore: 0, multiplier: 1.15, adjustedScore: 0,
  });
});


test('main menu exposes daily quest completion ratio', async ({ page }) => {
  await page.addInitScript(() => {
    const dateParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const today = [
      dateParts.find((part) => part.type === 'year')?.value,
      dateParts.find((part) => part.type === 'month')?.value,
      dateParts.find((part) => part.type === 'day')?.value,
    ].join('-');
    localStorage.clear();
    localStorage.setItem('tss-meta2', JSON.stringify({
      v: 2,
      savedAt: Date.now(),
      matchesPlayed: 10,
      quests: {
        date: today,
        ids: ['q_new_house', 'q_score_10k', 'q_gold_800'],
        progress: { q_new_house: 3, q_score_10k: 10000 },
        done: ['q_new_house', 'q_score_10k'],
        rerolls: 0,
      },
      dailyBonus: { last: '', lastAt: 0, streak: 0 },
    }));
  });

  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });

  const labels = await page.evaluate(() => {
    const game = (window as unknown as {
      __tss?: {
        scene: {
          getScene: (key: string) => { children: { list: unknown[] } };
        };
      };
    }).__tss;
    const menu = game?.scene.getScene('Menu');
    return (menu?.children.list ?? [])
      .map((item) => (item as { text?: unknown }).text)
      .filter((value): value is string => typeof value === 'string');
  });

  expect(labels.some((label) => label.includes('CHRONICLE') && label.includes('Quests 2/3'))).toBe(true);
});


test('game over always shows daily quest progress even when this run completes none', async ({ page }) => {
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });

  await page.evaluate(() => {
    const game = (window as unknown as {
      __tss?: { scene: { launch: (key: string, payload?: unknown) => void } };
    }).__tss;
    game?.scene.launch('GameOver', {
      stats: {
        victory: false,
        time: 120,
        kills: 30,
        level: 3,
        gold: 50,
        score: 1000,
        meta: {
          glory: null,
          questsDone: 2,
          questsTotal: 3,
          questsCompletedNow: [],
          passLevels: 0,
          passRewards: [],
          chainUnlocks: [],
          endlessWave: 0,
          crownsEarned: 0,
          challenge: false,
          ukaz: null,
          endless: false,
        },
      },
    });
  });

  await expect.poll(async () => page.evaluate(() => {
    const game = (window as unknown as {
      __tss?: { scene: { getScene: (key: string) => { children: { list: unknown[] } } } };
    }).__tss;
    const scene = game?.scene.getScene('GameOver');
    const labels: string[] = [];
    const visit = (object: unknown): void => {
      if (!object || typeof object !== 'object') return;
      const item = object as { text?: unknown; list?: unknown[] };
      if (typeof item.text === 'string') labels.push(item.text);
      if (Array.isArray(item.list)) item.list.forEach(visit);
    };
    scene?.children.list.forEach(visit);
    return labels;
  })).toContain('Daily quests: 2/3');
});


test('king order Horde compounds with difficulty without double-stacking the challenge modifier', async ({ page }) => {
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });
  await expect.poll(() => page.evaluate(() => {
    const runtime = (window as Window & {
      __tss?: { scene: { isActive: (key: string) => boolean } };
    }).__tss;
    return runtime?.scene.isActive('Menu') ?? false;
  }), { timeout: startupTimeout }).toBe(true);

  await page.evaluate(async () => {
    const meta = await import('/src/game/meta.ts') as {
      saveRunConfig: (config: {
        contract: null;
        ukaz: 'ukaz_horde';
        challenge: null;
        blessing: null;
        consumables: [];
        endless: false;
        weeklyChallenge: false;
      }) => void;
    };
    const runtime = (window as Window & {
      __tss?: {
        scene: {
          getScene: (key: string) => unknown;
        };
      };
    }).__tss;
    if (!runtime) throw new Error('Phaser runtime is unavailable');
    const menu = runtime.scene.getScene('Menu') as {
      selectedHero?: string;
      selectedDiff?: string;
      scene: {
        start: (key: string, data: { hero: string; diff: string }) => void;
      };
    };
    meta.saveRunConfig({
      contract: null,
      ukaz: 'ukaz_horde',
      challenge: null,
      blessing: null,
      consumables: [],
      endless: false,
      weeklyChallenge: false,
    });
    menu.scene.start('Game', {
      hero: menu.selectedHero ?? 'warrior',
      diff: menu.selectedDiff ?? 'normal',
    });
  });

  await expect.poll(() => page.evaluate(() => {
    const runtime = (window as Window & {
      __tss?: { scene: { isActive: (key: string) => boolean } };
    }).__tss;
    return runtime?.scene.isActive('Game') ?? false;
  }), { timeout: startupTimeout }).toBe(true);

  const report = await page.evaluate(async () => {
    const spawnerModule = await import('/src/game/systems/Spawner.ts') as unknown as {
      resolveSpawnRateFactor: (ukaz: string | null, challengeHorde: boolean) => number;
      Spawner: new (
        scene: unknown,
        ctx: unknown,
        difficulty: 'normal' | 'nightmare',
        opts: { rateMultFactor?: number },
      ) => unknown;
    };
    const runtime = (window as Window & {
      __tss?: { scene: { getScene: (key: string) => unknown } };
    }).__tss;
    if (!runtime) throw new Error('Phaser runtime is unavailable');
    const scene = runtime.scene.getScene('Game') as {
      spawner: unknown;
      diffDef: { rateMult: number; scoreMult: number };
    };
    const spawner = scene.spawner as {
      o: { rateMultFactor?: number };
      interval: number;
      timer: number;
    };
    const nightmareSpawner = new spawnerModule.Spawner(
      { registry: { get: () => 0 }, events: { emit: () => undefined } },
      {},
      'nightmare',
      { rateMultFactor: spawnerModule.resolveSpawnRateFactor('ukaz_horde', false) },
    ) as { interval: number; timer: number; update: (dtSec: number) => void };
    nightmareSpawner.update(0);
    return {
      rateMultFactor: spawner.o.rateMultFactor ?? 1,
      initialIntervalMs: spawner.interval,
      initialTimerMs: spawner.timer,
      difficultyRateMult: scene.diffDef.rateMult,
      difficultyScoreMult: scene.diffDef.scoreMult,
      nightmareIntervalAfterRateEventMs: nightmareSpawner.interval,
      nightmareTimerMs: nightmareSpawner.timer,
      noOrder: spawnerModule.resolveSpawnRateFactor(null, false),
      anotherOrder: spawnerModule.resolveSpawnRateFactor('ukaz_drought', false),
      ukazHorde: spawnerModule.resolveSpawnRateFactor('ukaz_horde', false),
      challengeHorde: spawnerModule.resolveSpawnRateFactor(null, true),
      bothHordes: spawnerModule.resolveSpawnRateFactor('ukaz_horde', true),
    };
  });

  expect(report.rateMultFactor).toBe(0.85);
  expect(report.initialIntervalMs).toBeCloseTo(850 * 1 * 0.85);
  expect(report.initialTimerMs).toBeCloseTo(1200 * 1 * 0.85);
  expect(report.difficultyRateMult).toBe(1);
  expect(report.difficultyScoreMult).toBe(1);
  expect(report.nightmareIntervalAfterRateEventMs).toBeCloseTo(850 * 0.85 * 0.85);
  expect(report.nightmareTimerMs).toBeCloseTo(1200 * 0.85 * 0.85);
  expect(report.noOrder).toBe(1);
  expect(report.anotherOrder).toBe(1);
  expect(report.ukazHorde).toBe(0.85);
  expect(report.challengeHorde).toBe(0.85);
  expect(report.bothHordes).toBe(0.85);
});


test('weekly mini-board ignores ordinary runs even when an order is selected', async ({ page }) => {
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });

  const outcome = await page.evaluate(async () => {
    type RunSummary = {
      victory: boolean;
      ideal: boolean;
      endless: boolean;
      weeklyChallenge: boolean;
      wave: number;
      time: number;
      kills: number;
      level: number;
      gold: number;
      score: number;
      difficulty: string;
      buildingsBuilt: number;
      pawnsAlive: number;
      siegesDefended: number;
      siegesTotal: number;
      monasteryHealed: number;
      healHp: number;
      hires: number;
      successions: number;
      veterans: number;
      firstHouseMin: number;
      barracks: number;
      monastery: number;
      archery: number;
      bestCombo: number;
      bossKilled: boolean;
      killsByKind: Record<string, number>;
      cardsPicked: string[];
      contract: string | null;
      ukaz: string | null;
      challengeMods: string[];
      blessing: string | null;
      consumables: string[];
    };
    type TestMetaState = {
      weekly: { week: string };
      weeklyChallenge: { week: string; best: number };
    };
    const meta = await import('/src/game/meta.ts') as unknown as {
      rollMetaDay: () => TestMetaState;
      saveMetaState: (state: TestMetaState) => boolean;
      loadMetaState: () => TestMetaState;
      applyRunToMeta: (summary: RunSummary) => unknown;
    };

    const state = meta.rollMetaDay();
    state.weeklyChallenge = { week: state.weekly.week, best: 0 };
    meta.saveMetaState(state);

    const base: Omit<RunSummary, 'weeklyChallenge'> = {
      victory: false,
      ideal: false,
      endless: false,
      wave: 0,
      time: 120,
      kills: 50,
      level: 4,
      gold: 100,
      score: 5_000,
      difficulty: 'normal',
      buildingsBuilt: 2,
      pawnsAlive: 3,
      siegesDefended: 0,
      siegesTotal: 0,
      monasteryHealed: 0,
      healHp: 0,
      hires: 0,
      successions: 0,
      veterans: 0,
      firstHouseMin: 0,
      barracks: 0,
      monastery: 0,
      archery: 0,
      bestCombo: 3,
      bossKilled: false,
      killsByKind: {},
      cardsPicked: [],
      contract: null,
      ukaz: 'ukaz_horde',
      challengeMods: [],
      blessing: null,
      consumables: [],
    };

    meta.applyRunToMeta({ ...base, weeklyChallenge: false });
    const bestAfterOrdinaryRun = meta.loadMetaState().weeklyChallenge.best;
    meta.applyRunToMeta({ ...base, weeklyChallenge: true });
    const bestAfterWeeklyRun = meta.loadMetaState().weeklyChallenge.best;

    return { bestAfterOrdinaryRun, bestAfterWeeklyRun };
  });

  expect(outcome.bestAfterOrdinaryRun).toBe(0);
  expect(outcome.bestAfterWeeklyRun).toBe(5_000);
});

test('orders tab starts a weekly challenge with the selected king order', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('tss-meta2', JSON.stringify({
      v: 2,
      savedAt: Date.now(),
      matchesPlayed: 10,
      weeklyChallenge: { week: '', best: 0 },
    }));
    localStorage.setItem('tss-ukaz-pick', 'ukaz_horde');
  });

  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });
  await expect.poll(() => page.evaluate(() => {
    const runtime = (window as Window & {
      __tss?: { scene: { isActive: (key: string) => boolean } };
    }).__tss;
    return runtime?.scene.isActive('Menu') ?? false;
  }), { timeout: startupTimeout }).toBe(true);

  await page.evaluate(() => {
    const runtime = (window as Window & {
      __tss?: { scene: { launch: (key: string, payload?: unknown) => void } };
    }).__tss;
    runtime?.scene.launch('Meta', { tab: 'orders' });
  });
  await expect.poll(() => page.evaluate(() => {
    const runtime = (window as Window & {
      __tss?: { scene: { isActive: (key: string) => boolean } };
    }).__tss;
    return runtime?.scene.isActive('Meta') ?? false;
  }), { timeout: startupTimeout }).toBe(true);

  const labels = await page.evaluate(() => {
    const runtime = (window as Window & {
      __tss?: { scene: { getScene: (key: string) => { children: { list: unknown[] } } } };
    }).__tss;
    const scene = runtime?.scene.getScene('Meta');
    const found: string[] = [];
    const visit = (object: unknown): void => {
      if (!object || typeof object !== 'object') return;
      const item = object as { text?: unknown; list?: unknown[] };
      if (typeof item.text === 'string') found.push(item.text);
      if (Array.isArray(item.list)) item.list.forEach(visit);
    };
    scene?.children.list.forEach(visit);
    return found;
  });
  expect(labels).toContain('WEEKLY RUN');
  expect(labels).toContain('Best: 0');

  await page.evaluate(() => {
    const runtime = (window as Window & {
      __tss?: { scene: { getScene: (key: string) => unknown } };
    }).__tss;
    const menu = runtime?.scene.getScene('Menu') as {
      startWeeklyChallengeFromMeta: () => void;
    } | undefined;
    if (!menu) throw new Error('Menu scene is unavailable');
    menu.startWeeklyChallengeFromMeta();
  });

  await expect.poll(() => page.evaluate(() => {
    const runtime = (window as Window & {
      __tss?: { scene: { isActive: (key: string) => boolean } };
    }).__tss;
    return runtime?.scene.isActive('Game') ?? false;
  }), { timeout: startupTimeout }).toBe(true);

  const run = await page.evaluate(() => {
    const runtime = (window as Window & {
      __tss?: { scene: { getScene: (key: string) => unknown } };
    }).__tss;
    const scene = runtime?.scene.getScene('Game') as {
      mods: { weeklyChallenge: boolean; ukaz: string | null };
    } | undefined;
    return { weeklyChallenge: scene?.mods.weeklyChallenge, ukaz: scene?.mods.ukaz };
  });
  expect(run).toEqual({ weeklyChallenge: true, ukaz: 'ukaz_horde' });
});


test('daily challenge date deterministically seeds the map, economy and wave director', async ({ page, browser }) => {
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });
  const appOrigin = await page.evaluate(() => window.location.origin);

  const capture = async (target: Page, date: string, perturbGameplayRng = false): Promise<{
    seed: number;
    challengeSeed: string | null;
    map: Array<{ kind: string; resource: string; x: number; y: number }>;
    spawnPositions: Array<{ x: number; y: number }>;
    economyRandom: number[];
    waveRandom: number[];
    waveRandomAfterGeometry: number[];
    weaponTargetRandom: number[];
    progressionSeeded: boolean;
    pawnRandom: number[];
    pawnRandomInt: number[];
    choices: Array<{ kind: string; id: string | null; title: string }>;
  }> => {
    if (target !== page) await target.goto(new URL('/?lang=en&ysdk=mock', appOrigin).toString());
    await expect(target.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
    await expect(target.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });
    await expect.poll(() => target.evaluate(() => {
      const runtime = (window as Window & {
        __tss?: { scene: { isActive: (key: string) => boolean } };
      }).__tss;
      return runtime?.scene.isActive('Menu') ?? false;
    }), { timeout: startupTimeout }).toBe(true);

    await target.evaluate(async (challengeDate) => {
      const meta = await import('/src/game/meta.ts') as {
        saveRunConfig: (config: {
          contract: null;
          ukaz: null;
          challenge: { mods: ['cm_gold_rush', 'cm_winter']; rerolled: false };
          challengeSeed: string;
          blessing: null;
          consumables: [];
          endless: false;
          weeklyChallenge: false;
        }) => void;
      };
      const runtime = (window as Window & {
        __tss?: { scene: { getScene: (key: string) => unknown } };
      }).__tss;
      if (!runtime) throw new Error('Phaser runtime is unavailable');
      const menu = runtime.scene.getScene('Menu') as {
        selectedHero?: string;
        selectedDiff?: string;
        scene: { start: (key: string, data: { hero: string; diff: string }) => void };
      };
      meta.saveRunConfig({
        contract: null,
        ukaz: null,
        challenge: { mods: ['cm_gold_rush', 'cm_winter'], rerolled: false },
        challengeSeed: challengeDate,
        blessing: null,
        consumables: [],
        endless: false,
        weeklyChallenge: false,
      });
      menu.scene.start('Game', {
        hero: menu.selectedHero ?? 'warrior',
        diff: menu.selectedDiff ?? 'normal',
      });
    }, date);

    await expect.poll(() => target.evaluate(() => {
      const runtime = (window as Window & {
        __tss?: { scene: { isActive: (key: string) => boolean } };
      }).__tss;
      return runtime?.scene.isActive('Game') ?? false;
    }), { timeout: startupTimeout }).toBe(true);

    return target.evaluate(({ challengeDate, perturbGameplayRng }) => {
      const runtime = (window as Window & {
        __tss?: { scene: { getScene: (key: string) => unknown } };
      }).__tss;
      if (!runtime) throw new Error('Phaser runtime is unavailable');
      const scene = runtime.scene.getScene('Game') as {
        runSeed: number;
        mods: { challengeSeed?: string | null; challenge: { mods: string[] } | null };
        gameplayRandom: () => number;
        generateChoices: () => Array<{ kind: string; id?: string; title: string }>;
        dailySpawnerRng: { sow: (seeds: string[]) => unknown };
        dailySpawnPositionRng: { sow: (seeds: string[]) => unknown };
        dailyProgressionRng: { frac: () => number } | null;
        player: { hp: number; maxHp: number };
        spawner: {
          stopped: boolean;
          o: { random?: () => number };
          ctx: { randomSpawnX: () => number; randomSpawnY: () => number };
        };
        economy: {
          nodes: Array<{ kind: string; res: string; x: number; y: number }>;
          opts: { random?: () => number };
        };
        registry: { get: (key: string) => unknown };
        weapons: { ctx: { randomInt?: (min: number, max: number) => number } };
      };
      // Сбрасываем поток спавнера, чтобы время загрузки контекстов не влияло на сравнение.
      scene.spawner.stopped = true;
      scene.dailySpawnerRng.sow([`daily-spawner:${challengeDate}`]);
      scene.dailySpawnPositionRng.sow([`daily-spawn-position:${challengeDate}`]);
      // Эти потоки не должны изменяться после случайных боевых событий.
      const weaponTargetRandom = Array.from({ length: 8 }, () =>
        scene.weapons.ctx.randomInt?.(0, 100) ?? -1);
      const pawnAi = scene.registry.get('tss-pawnai-ctx') as {
        random?: () => number;
        randomInt?: (min: number, max: number) => number;
      };
      const pawnRandom = Array.from({ length: 8 }, () => pawnAi.random?.() ?? -1);
      const pawnRandomInt = Array.from({ length: 8 }, () => pawnAi.randomInt?.(0, 100) ?? -1);
      if (perturbGameplayRng) {
        for (let i = 0; i < 32; i++) scene.gameplayRandom();
      }
      // Фиксируем HP: набор добивающих карточек не должен зависеть от случайных стартовых кадров.
      scene.player.hp = scene.player.maxHp;
      // Доступные карточки должны зависеть от даты и состояния рана, но не от числа боевых бросков.
      const choices = scene.generateChoices().map(({ kind, id, title }) => ({
        kind,
        id: id ?? null,
        title,
      }));
      const progressionSeeded = scene.dailyProgressionRng !== null;
      // Снимаем базовую последовательность типов волн до дополнительных бросков.
      const waveRandom = Array.from({ length: 8 }, () => scene.spawner.o.random?.() ?? -1);
      if (perturbGameplayRng) {
        // Имитируем разное число решений спавнера: эти броски не должны менять координаты.
        for (let i = 0; i < 32; i++) scene.spawner.o.random?.();
      }
      const spawnPositions = Array.from({ length: 6 }, () => ({
        x: Math.round(scene.spawner.ctx.randomSpawnX() * 100) / 100,
        y: Math.round(scene.spawner.ctx.randomSpawnY() * 100) / 100,
      }));
      // Перезапускаем поток состава: эта часть проверяет влияние именно геометрии.
      scene.dailySpawnerRng.sow([`daily-spawner:${challengeDate}`]);
      if (perturbGameplayRng) {
        // Очередь отложенного спавна могла запросить ещё координаты, но состав волн не должен сдвинуться.
        for (let i = 0; i < 16; i++) {
          scene.spawner.ctx.randomSpawnX();
          scene.spawner.ctx.randomSpawnY();
        }
      }
      const waveRandomAfterGeometry = Array.from({ length: 8 }, () => scene.spawner.o.random?.() ?? -1);
      return {
        seed: scene.runSeed,
        challengeSeed: scene.mods.challengeSeed ?? null,
        spawnPositions,
        map: scene.economy.nodes.map((node) => ({
          kind: node.kind,
          resource: node.res,
          x: Math.round(node.x * 100) / 100,
          y: Math.round(node.y * 100) / 100,
        })),
        economyRandom: Array.from({ length: 8 }, () => scene.economy.opts.random?.() ?? -1),
        waveRandom,
        waveRandomAfterGeometry,
        weaponTargetRandom,
        progressionSeeded,
        pawnRandom,
        pawnRandomInt,
        choices,
      };
    }, { challengeDate: date, perturbGameplayRng });
  };

  const date = '2026-10-22';
  const first = await capture(page, date, true);
  const repeatContext = await browser.newContext();
  try {
    const repeatPage = await repeatContext.newPage();
    const repeat = await capture(repeatPage, date);
    expect(repeat.seed).toBe(first.seed);
    expect(repeat.challengeSeed).toBe(date);
    expect(first.challengeSeed).toBe(date);
    expect(repeat.map).toEqual(first.map);
    expect(repeat.spawnPositions).toEqual(first.spawnPositions);
    expect(repeat.economyRandom).toEqual(first.economyRandom);
    expect(first.waveRandom.every((value) => value >= 0)).toBe(true);
    expect(repeat.waveRandom).toEqual(first.waveRandom);
    expect(first.waveRandomAfterGeometry.every((value) => value >= 0)).toBe(true);
    expect(repeat.waveRandomAfterGeometry).toEqual(first.waveRandomAfterGeometry);
    expect(first.weaponTargetRandom.every((value) => value >= 0)).toBe(true);
    expect(repeat.weaponTargetRandom).toEqual(first.weaponTargetRandom);
    expect(first.progressionSeeded).toBe(true);
    expect(repeat.progressionSeeded).toBe(true);
    expect(first.pawnRandom.every((value) => value >= 0)).toBe(true);
    expect(first.pawnRandomInt.every((value) => value >= 0)).toBe(true);
    expect(repeat.pawnRandom).toEqual(first.pawnRandom);
    expect(repeat.pawnRandomInt).toEqual(first.pawnRandomInt);
    expect(repeat.choices).toEqual(first.choices);

    const seeds = await page.evaluate(async (challengeDate) => {
      const meta = await import('/src/game/meta.ts') as {
        dailyChallengeSeedNumber: (value: string) => number;
      };
      return {
        current: meta.dailyChallengeSeedNumber(challengeDate),
        next: meta.dailyChallengeSeedNumber('2026-10-23'),
      };
    }, date);
    expect(first.seed).toBe(seeds.current);
    expect(seeds.next).not.toBe(seeds.current);
  } finally {
    await repeatContext.close();
  }
});


test('daily challenge config rejects impossible calendar dates', async ({ page }) => {
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });

  const seed = await page.evaluate(async () => {
    type Config = {
      contract: null; ukaz: null; challenge: null; blessing: null;
      consumables: []; endless: false; weeklyChallenge: false; challengeSeed: string;
    };
    const meta = await import('/src/game/meta.ts') as unknown as {
      saveRunConfig: (config: Config) => void;
      consumeRunConfig: () => { challengeSeed?: string | null };
    };
    meta.saveRunConfig({
      contract: null, ukaz: null, challenge: null, blessing: null,
      consumables: [], endless: false, weeklyChallenge: false,
      challengeSeed: '2026-02-31',
    });
    return meta.consumeRunConfig().challengeSeed;
  });

  expect(seed).toBeNull();
});

test('endless wave milestone rewards are granted once when a new record passes each threshold', async ({ page }) => {
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });

  const outcome = await page.evaluate(async () => {
    type RunSummary = {
      victory: boolean; ideal: boolean; endless: boolean; weeklyChallenge: boolean;
      wave: number; time: number; kills: number; level: number; gold: number; score: number;
      difficulty: string; buildingsBuilt: number; pawnsAlive: number;
      siegesDefended: number; siegesTotal: number; monasteryHealed: number; healHp: number;
      hires: number; successions: number; veterans: number; firstHouseMin: number;
      barracks: number; monastery: number; archery: number; bestCombo: number;
      bossKilled: boolean; killsByKind: Record<string, number>; cardsPicked: string[];
      contract: string | null; ukaz: string | null; challengeMods: string[];
      blessing: string | null; consumables: string[];
    };
    type TestMetaState = {
      endlessBestWave: number;
      crowns: number;
      quests: { date: string; ids: string[]; progress: Record<string, number>; done: string[]; rerolls: number };
      weekly: { week: string; progress: number; stage: number; claimed: boolean };
      chains: { counters: Record<string, number>; claimed: string[] };
      pass: { season: string; xp: number; premium: boolean; claimedFree: number; claimedPrem: number };
    };
    const meta = await import('/src/game/meta.ts') as unknown as {
      rollMetaDay: () => TestMetaState;
      saveMetaState: (state: TestMetaState) => boolean;
      loadMetaState: () => TestMetaState;
      applyRunToMeta: (summary: RunSummary) => { endlessWaveCrowns: number };
    };
    const state = meta.rollMetaDay();
    state.endlessBestWave = 9;
    state.crowns = 7;
    state.quests.ids = [];
    state.quests.progress = {};
    state.quests.done = [];
    state.chains.counters = {};
    state.chains.claimed = [];
    // Prevent unrelated season-pass level rewards from changing the crown balance under test.
    state.pass.xp = 5_000;
    state.pass.premium = false;
    meta.saveMetaState(state);

    const base: RunSummary = {
      victory: false, ideal: false, endless: true, weeklyChallenge: false,
      wave: 0, time: 120, kills: 0, level: 1, gold: 0, score: 0, difficulty: 'normal',
      buildingsBuilt: 0, pawnsAlive: 0, siegesDefended: 0, siegesTotal: 0,
      monasteryHealed: 0, healHp: 0, hires: 0, successions: 0, veterans: 0,
      firstHouseMin: 0, barracks: 0, monastery: 0, archery: 0, bestCombo: 0,
      bossKilled: false, killsByKind: {}, cardsPicked: [], contract: null, ukaz: null,
      challengeMods: [], blessing: null, consumables: [],
    };

    const first = meta.applyRunToMeta({ ...base, wave: 10 });
    const afterFirst = meta.loadMetaState();
    const second = meta.applyRunToMeta({ ...base, wave: 20 });
    const afterSecond = meta.loadMetaState();
    const third = meta.applyRunToMeta({ ...base, wave: 30 });
    const afterThird = meta.loadMetaState();
    const repeat = meta.applyRunToMeta({ ...base, wave: 30 });
    const afterRepeat = meta.loadMetaState();

    return {
      awards: [first.endlessWaveCrowns, second.endlessWaveCrowns, third.endlessWaveCrowns, repeat.endlessWaveCrowns],
      balances: [afterFirst.crowns, afterSecond.crowns, afterThird.crowns, afterRepeat.crowns],
      bestWave: afterRepeat.endlessBestWave,
    };
  });

  expect(outcome.awards).toEqual([5, 10, 20, 0]);
  expect(outcome.balances).toEqual([12, 22, 42, 42]);
  expect(outcome.bestWave).toBe(30);
});

test('weekly chronicle counts a completed run once when it unlocks an achievement-chain tier', async ({ page }) => {
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });

  const outcome = await page.evaluate(async () => {
    type RunSummary = {
      victory: boolean; ideal: boolean; endless: boolean; weeklyChallenge: boolean;
      wave: number; time: number; kills: number; level: number; gold: number; score: number;
      difficulty: string; buildingsBuilt: number; pawnsAlive: number;
      siegesDefended: number; siegesTotal: number; monasteryHealed: number; healHp: number;
      hires: number; successions: number; veterans: number; firstHouseMin: number;
      barracks: number; monastery: number; archery: number; bestCombo: number;
      bossKilled: boolean; killsByKind: Record<string, number>; cardsPicked: string[];
      contract: string | null; ukaz: string | null; challengeMods: string[];
      blessing: string | null; consumables: string[];
    };
    type TestMetaState = {
      quests: { date: string; ids: string[]; progress: Record<string, number>; done: string[]; rerolls: number };
      weekly: { week: string; progress: number; stage: number; claimed: boolean };
      chains: { counters: Record<string, number>; claimed: string[] };
    };
    const meta = await import('/src/game/meta.ts') as unknown as {
      rollMetaDay: () => TestMetaState;
      saveMetaState: (state: TestMetaState) => boolean;
      loadMetaState: () => TestMetaState;
      applyRunToMeta: (summary: RunSummary) => { chainUnlocked: Array<{ id: string; tier: number }> };
    };
    const state = meta.rollMetaDay();
    state.quests.ids = [];
    state.quests.progress = {};
    state.quests.done = [];
    state.weekly.progress = 0;
    state.weekly.stage = 0;
    state.weekly.claimed = false;
    state.chains.counters = {};
    state.chains.claimed = [];
    meta.saveMetaState(state);

    const result = meta.applyRunToMeta({
      victory: false, ideal: false, endless: false, weeklyChallenge: false,
      wave: 0, time: 120, kills: 0, level: 1, gold: 0, score: 0, difficulty: 'normal',
      buildingsBuilt: 0, pawnsAlive: 0, siegesDefended: 1, siegesTotal: 1,
      monasteryHealed: 0, healHp: 0, hires: 0, successions: 0, veterans: 0,
      firstHouseMin: 0, barracks: 0, monastery: 0, archery: 0, bestCombo: 0,
      bossKilled: false, killsByKind: {}, cardsPicked: [], contract: null, ukaz: null,
      challengeMods: [], blessing: null, consumables: [],
    });
    const saved = meta.loadMetaState();
    return {
      progress: saved.weekly.progress,
      stage: saved.weekly.stage,
      unlocked: result.chainUnlocked.some((item) => item.id === 'ch_siege' && item.tier === 0),
    };
  });

  expect(outcome.unlocked).toBe(true);
  expect(outcome.progress).toBe(1);
  expect(outcome.stage).toBe(0);
});

test('architect chain checks per-run construction, 10/10 base occupancy and lifetime total separately', async ({ page }) => {
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });

  const outcome = await page.evaluate(async () => {
    type RunSummary = {
      victory: boolean; ideal: boolean; endless: boolean; weeklyChallenge: boolean;
      wave: number; time: number; kills: number; level: number; gold: number; score: number;
      difficulty: string; buildingsBuilt: number; occupiedBaseBuildSpots?: number; pawnsAlive: number;
      siegesDefended: number; siegesTotal: number; monasteryHealed: number; healHp: number;
      hires: number; successions: number; veterans: number; firstHouseMin: number;
      barracks: number; monastery: number; archery: number; bestCombo: number;
      bossKilled: boolean; killsByKind: Record<string, number>; cardsPicked: string[];
      contract: string | null; ukaz: string | null; challengeMods: string[];
      blessing: string | null; consumables: string[];
    };
    type TestMetaState = {
      quests: { date: string; ids: string[]; progress: Record<string, number>; done: string[]; rerolls: number };
      weekly: { week: string; progress: number; stage: number; claimed: boolean };
      chains: { counters: Record<string, number>; claimed: string[] };
      pass: { season: string; xp: number; premium: boolean; claimedFree: number; claimedPrem: number };
    };
    const meta = await import('/src/game/meta.ts') as unknown as {
      rollMetaDay: () => TestMetaState;
      saveMetaState: (state: TestMetaState) => boolean;
      loadMetaState: () => TestMetaState;
      applyRunToMeta: (summary: RunSummary) => { chainUnlocked: Array<{ id: string; tier: number }> };
      claimChainReward: (id: string, tier: number) => { ok: boolean };
    };

    const state = meta.rollMetaDay();
    state.quests.ids = [];
    state.quests.progress = {};
    state.quests.done = [];
    state.weekly.progress = 0;
    state.weekly.stage = 0;
    state.weekly.claimed = false;
    state.chains.counters = {};
    state.chains.claimed = [];
    // Максимальный уровень пропуска исключает побочные награды в тесте критериев цепочки.
    state.pass.xp = 5_000;
    state.pass.premium = false;
    meta.saveMetaState(state);

    const base: RunSummary = {
      victory: false, ideal: false, endless: false, weeklyChallenge: false,
      wave: 0, time: 120, kills: 0, level: 1, gold: 0, score: 0, difficulty: 'normal',
      buildingsBuilt: 0, occupiedBaseBuildSpots: 0, pawnsAlive: 0,
      siegesDefended: 0, siegesTotal: 0, monasteryHealed: 0, healHp: 0,
      hires: 0, successions: 0, veterans: 0, firstHouseMin: 0,
      barracks: 0, monastery: 0, archery: 0, bestCombo: 0,
      bossKilled: false, killsByKind: {}, cardsPicked: [], contract: null, ukaz: null,
      challengeMods: [], blessing: null, consumables: [],
    };
    const run = (buildingsBuilt: number, occupiedBaseBuildSpots = 0) =>
      meta.applyRunToMeta({ ...base, buildingsBuilt, occupiedBaseBuildSpots });

    run(4);
    run(3);
    const bronzeBlockedByCumulativeOnly = meta.claimChainReward('ch_architect', 0).ok;

    const bronzeUnlock = run(7);
    const bronzeUnlockedOnSingleRun = bronzeUnlock.chainUnlocked.some(
      (item) => item.id === 'ch_architect' && item.tier === 0,
    );
    const bronzeClaim = meta.claimChainReward('ch_architect', 0).ok;
    const silverBlockedBeforeAllPlots = meta.claimChainReward('ch_architect', 1).ok;

    const silverUnlock = run(10, 10);
    const silverUnlockedWhenAllPlotsOccupied = silverUnlock.chainUnlocked.some(
      (item) => item.id === 'ch_architect' && item.tier === 1,
    );
    const silverClaim = meta.claimChainReward('ch_architect', 1).ok;

    for (let i = 0; i < 7; i++) run(10, 10);
    const goldBlockedAt94 = meta.claimChainReward('ch_architect', 2).ok;
    const goldUnlock = run(6, 0);
    const goldUnlockedAt100Total = goldUnlock.chainUnlocked.some(
      (item) => item.id === 'ch_architect' && item.tier === 2,
    );
    const goldClaim = meta.claimChainReward('ch_architect', 2).ok;

    return {
      bronzeBlockedByCumulativeOnly, bronzeUnlockedOnSingleRun, bronzeClaim,
      silverBlockedBeforeAllPlots, silverUnlockedWhenAllPlotsOccupied, silverClaim,
      goldBlockedAt94, goldUnlockedAt100Total, goldClaim,
    };
  });

  expect(outcome).toEqual({
    bronzeBlockedByCumulativeOnly: false,
    bronzeUnlockedOnSingleRun: true,
    bronzeClaim: true,
    silverBlockedBeforeAllPlots: false,
    silverUnlockedWhenAllPlotsOccupied: true,
    silverClaim: true,
    goldBlockedAt94: false,
    goldUnlockedAt100Total: true,
    goldClaim: true,
  });
});

test('veteran chain counts pawns that reached 3 stars even if they die before the run ends', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });

  await page.evaluate(() => {
    const runtime = (window as unknown as {
      __tss?: { scene: { getScene(key: string): unknown } };
    }).__tss;
    if (!runtime) throw new Error('Phaser runtime is unavailable');
    const menu = runtime.scene.getScene('Menu') as {
      selectedHero?: string;
      selectedDiff?: string;
      scene: { start(key: string, data: { hero: string; diff: string }): void };
    };
    menu.scene.start('Game', {
      hero: menu.selectedHero ?? 'warrior',
      diff: menu.selectedDiff ?? 'normal',
    });
  });
  await expect.poll(() => page.evaluate(() => (
    (window as unknown as { __tss?: { scene: { isActive(key: string): boolean } } }).__tss
      ?.scene.isActive('Game') ?? false
  )), { timeout: startupTimeout }).toBe(true);

  const outcome = await page.evaluate(async () => {
    type VeteranPawn = {
      dead: boolean;
      active: boolean;
      state: string;
      veteranStars: number;
      siegesSurvived: number;
    };
    type RunMetaResult = {
      chainUnlocks: Array<{ nameKey: string; tier: number }>;
    };
    type GameRuntime = {
      economy: { pawns: VeteranPawn[] };
      settlement: { endSiege(outcome: 'defended' | 'partial' | 'ignored'): void };
      effects: { popup: (...args: unknown[]) => void };
      hints: { show: (...args: unknown[]) => void };
      addXp(value: number): void;
      onSiegeScore(outcome: string, index: number): void;
      applyRunMeta(victory: boolean, score: number, ideal: boolean): RunMetaResult | undefined;
      veteransEarnedThisRun: number;
      metaApplied: boolean;
      weapons: { ownedIds(): string[]; isEvolved(id: string): boolean };
      weaponStats: Map<string, { dmg: number; kills: number }>;
    };
    type TestMetaState = {
      codex: Record<string, number>;
      codexSeen: Record<string, boolean>;
      chains: { counters: Record<string, number>; claimed: string[] };
    };
    const runtime = (window as unknown as {
      __tss?: { scene: { getScene(key: string): unknown } };
    }).__tss;
    if (!runtime) throw new Error('Phaser runtime is unavailable');
    const scene = runtime.scene.getScene('Game') as GameRuntime;
    const meta = await import('/src/game/meta.ts') as unknown as {
      rollMetaDay: () => TestMetaState;
      saveMetaState: (state: TestMetaState) => boolean;
      loadMetaState: () => TestMetaState;
      codexCount: (id: string) => number;
    };

    const state = meta.rollMetaDay();
    state.codex = {};
    state.chains.counters = {};
    state.chains.claimed = [];
    meta.saveMetaState(state);

    scene.weapons.ownedIds = () => ['sword', 'bow'];
    scene.weapons.isEvolved = () => false;
    // Оружие sword реально нанесло урон; bow только получен и не участвовал в бою.
    scene.weaponStats = new Map([['sword', { dmg: 12, kills: 1 }]]);
    const target = scene.economy.pawns.find((pawn) => (
      pawn.active && !pawn.dead && pawn.state !== 'wounded' && pawn.state !== 'bleeding'
    ));
    if (!target) throw new Error('No eligible pawn available for veteran test');
    for (const pawn of scene.economy.pawns) {
      pawn.siegesSurvived = 0;
      pawn.veteranStars = 0;
    }
    target.siegesSurvived = 2;
    target.veteranStars = 2;

    // Изолируем механику ветерана от наград за осаду и переходов уровня в тестовой сцене.
    scene.addXp = () => undefined;
    scene.onSiegeScore = () => undefined;
    scene.effects.popup = () => undefined;
    scene.hints.show = () => undefined;
    scene.settlement.endSiege('partial');

    const earnedDuringRun = scene.veteransEarnedThisRun;
    target.dead = true;
    target.active = false;
    scene.economy.pawns.splice(scene.economy.pawns.indexOf(target), 1);
    scene.metaApplied = false;
    const runResult = scene.applyRunMeta(false, 0, false);
    const codexCountAfterFirstApply = meta.codexCount('w_sword');
    const unusedWeaponCountAfterFirstApply = meta.codexCount('w_bow');
    const repeatedResult = scene.applyRunMeta(false, 0, false);
    const codexCountAfterRepeatedApply = meta.codexCount('w_sword');
    const unusedWeaponCountAfterRepeatedApply = meta.codexCount('w_bow');
    const saved = meta.loadMetaState();

    return {
      earnedDuringRun,
      survivingVeterans: scene.economy.pawns.filter((pawn) => pawn.veteranStars >= 3).length,
      lifetimeVeterans: saved.chains.counters.veterans ?? 0,
      codexCountAfterFirstApply,
      codexCountAfterRepeatedApply,
      unusedWeaponCountAfterFirstApply,
      unusedWeaponCountAfterRepeatedApply,
      repeatedApplySkipped: repeatedResult === undefined,
      bronzeUnlocked: runResult?.chainUnlocks.some((item) => (
        item.nameKey === 'chain.veteran' && item.tier === 0
      )) ?? false,
    };
  });

  expect(outcome).toEqual({
    earnedDuringRun: 1,
    survivingVeterans: 0,
    lifetimeVeterans: 1,
    codexCountAfterFirstApply: 1,
    codexCountAfterRepeatedApply: 1,
    unusedWeaponCountAfterFirstApply: 0,
    unusedWeaponCountAfterRepeatedApply: 0,
    repeatedApplySkipped: true,
    bronzeUnlocked: true,
  });
});

test('daily quest reroll rejects completed tasks and invalid slots without consuming rerolls', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });

  const outcome = await page.evaluate(async () => {
    type QuestState = {
      date: string;
      ids: string[];
      progress: Record<string, number>;
      done: string[];
      rerolls: number;
    };
    type TestMetaState = { quests: QuestState };
    const meta = await import('/src/game/meta.ts') as unknown as {
      rollMetaDay: () => TestMetaState;
      saveMetaState: (state: TestMetaState) => boolean;
      loadMetaState: () => TestMetaState;
      rerollQuestSlot: (slot: number) => { ok: boolean; reason?: string };
    };
    const state = meta.rollMetaDay();
    state.quests.ids = ['q_new_house', 'q_shield_wall', 'q_mercy'];
    state.quests.progress = { q_new_house: 3, q_shield_wall: 1 };
    state.quests.done = ['q_new_house'];
    state.quests.rerolls = 0;
    meta.saveMetaState(state);

    const completed = meta.rerollQuestSlot(0);
    const afterCompleted = meta.loadMetaState();
    const fractional = meta.rerollQuestSlot(1.5);
    const afterFractional = meta.loadMetaState();
    const valid = meta.rerollQuestSlot(1);
    const afterValid = meta.loadMetaState();

    return {
      completedReason: completed.reason,
      completedSlotStable: afterCompleted.quests.ids[0] === 'q_new_house',
      rerollsAfterCompleted: afterCompleted.quests.rerolls,
      fractionalReason: fractional.reason,
      rerollsAfterFractional: afterFractional.quests.rerolls,
      validRerollApplied: valid.ok && afterValid.quests.ids[1] !== 'q_shield_wall',
      rerollsAfterValid: afterValid.quests.rerolls,
      completedRewardHistoryRetained: afterValid.quests.done.includes('q_new_house'),
    };
  });

  expect(outcome).toEqual({
    completedReason: 'completed',
    completedSlotStable: true,
    rerollsAfterCompleted: 0,
    fractionalReason: 'bad-slot',
    rerollsAfterFractional: 0,
    validRerollApplied: true,
    rerollsAfterValid: 1,
    completedRewardHistoryRetained: true,
  });
});

test('first-house daily quest requires a build strictly before 2:00', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });

  const outcome = await page.evaluate(async () => {
    type RunSummary = {
      victory: boolean; ideal: boolean; endless: boolean; weeklyChallenge: boolean;
      wave: number; time: number; kills: number; level: number; gold: number; score: number;
      difficulty: string; buildingsBuilt: number; pawnsAlive: number;
      siegesDefended: number; siegesTotal: number; monasteryHealed: number; healHp: number;
      hires: number; successions: number; veterans: number; firstHouseMin: number;
      barracks: number; monastery: number; archery: number; bestCombo: number;
      bossKilled: boolean; killsByKind: Record<string, number>; cardsPicked: string[];
      contract: string | null; ukaz: string | null; challengeMods: string[];
      blessing: string | null; consumables: string[];
    };
    type TestMetaState = {
      glory: number;
      quests: { date: string; ids: string[]; progress: Record<string, number>; done: string[]; rerolls: number };
      pass: { season: string; xp: number; premium: boolean; claimedFree: number; claimedPrem: number };
    };
    const meta = await import('/src/game/meta.ts') as unknown as {
      rollMetaDay: () => TestMetaState;
      saveMetaState: (state: TestMetaState) => boolean;
      loadMetaState: () => TestMetaState;
      applyRunToMeta: (summary: RunSummary) => unknown;
    };
    const state = meta.rollMetaDay();
    state.quests.ids = ['q_first_house'];
    state.quests.progress = {};
    state.quests.done = [];
    state.quests.rerolls = 0;
    state.pass.xp = 5_000;
    state.pass.premium = false;
    meta.saveMetaState(state);
    const initialGlory = state.glory;

    const base: RunSummary = {
      victory: false, ideal: false, endless: false, weeklyChallenge: false,
      wave: 0, time: 120, kills: 0, level: 1, gold: 0, score: 0, difficulty: 'normal',
      buildingsBuilt: 0, pawnsAlive: 0, siegesDefended: 0, siegesTotal: 0,
      monasteryHealed: 0, healHp: 0, hires: 0, successions: 0, veterans: 0,
      firstHouseMin: 0, barracks: 0, monastery: 0, archery: 0, bestCombo: 0,
      bossKilled: false, killsByKind: {}, cardsPicked: [], contract: null, ukaz: null,
      challengeMods: [], blessing: null, consumables: [],
    };
    const run = (firstHouseMin: number) =>
      meta.applyRunToMeta({ ...base, firstHouseMin });

    run(2.99);
    const after259 = meta.loadMetaState();
    run(2.0);
    const after200 = meta.loadMetaState();
    run(1.99);
    const after159 = meta.loadMetaState();

    return {
      doneAt259: after259.quests.done.includes('q_first_house'),
      progressAt259: after259.quests.progress.q_first_house,
      doneAt200: after200.quests.done.includes('q_first_house'),
      progressAt200: after200.quests.progress.q_first_house,
      doneAt159: after159.quests.done.includes('q_first_house'),
      progressAt159: after159.quests.progress.q_first_house,
      rewardAppliedOnce: after159.glory === initialGlory + 35,
    };
  });

  expect(outcome).toEqual({
    doneAt259: false,
    progressAt259: 2.99,
    doneAt200: false,
    progressAt200: 2.0,
    doneAt159: true,
    progressAt159: 1.99,
    rewardAppliedOnce: true,
  });
});

test('daily meta, weekly progress and rewarded day limits share the Moscow calendar boundary', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });

  const calendar = await page.evaluate(async () => {
    const calendarUrl = new URL('/src/platform/calendar.ts', window.location.origin).href;
    const calendar = await import(/* @vite-ignore */ calendarUrl) as {
      mskDayKey: (epochMs: number) => string;
      mskWeekKey: (epochMs: number) => string;
    };
    const adsUrl = new URL('/src/platform/ads.ts', window.location.origin).href;
    const ads = await import(/* @vite-ignore */ adsUrl) as {
      placementAvailable: (placement: 'shop-refresh') => boolean;
    };

    // Плейсмент исчерпан 23:59:59.999 МСК, но снова доступен в 00:00:00.000 МСК.
    localStorage.setItem('tss-ads-day', JSON.stringify({
      date: '2026-10-21',
      used: { 'shop-refresh': 1 },
    }));
    Date.now = () => Date.UTC(2026, 9, 21, 20, 59, 59, 999);
    const adAvailableBeforeMidnight = ads.placementAvailable('shop-refresh');
    Date.now = () => Date.UTC(2026, 9, 21, 21, 0, 0, 0);
    const adAvailableAtMidnight = ads.placementAvailable('shop-refresh');

    return {
      dayBeforeMidnight: calendar.mskDayKey(Date.UTC(2026, 9, 21, 20, 59, 59, 999)),
      dayAtMidnight: calendar.mskDayKey(Date.UTC(2026, 9, 21, 21, 0, 0, 0)),
      weekBeforeMonday: calendar.mskWeekKey(Date.UTC(2026, 9, 25, 20, 59, 59, 999)),
      weekAtMonday: calendar.mskWeekKey(Date.UTC(2026, 9, 25, 21, 0, 0, 0)),
      adAvailableBeforeMidnight,
      adAvailableAtMidnight,
    };
  });
  expect(calendar).toEqual({
    dayBeforeMidnight: '2026-10-21',
    dayAtMidnight: '2026-10-22',
    weekBeforeMonday: '2026-10-19',
    weekAtMonday: '2026-10-26',
    adAvailableBeforeMidnight: false,
    adAvailableAtMidnight: true,
  });
});

test('codex records each completed building under the exact entry ID', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });

  const outcome = await page.evaluate(async () => {
    type RunSummary = {
      victory: boolean; ideal: boolean; endless: boolean; weeklyChallenge: boolean;
      wave: number; time: number; kills: number; level: number; gold: number; score: number;
      difficulty: string; buildingsBuilt: number;
      buildingKindsBuilt?: Partial<Record<'house' | 'barracks' | 'tower' | 'archery' | 'monastery', number>>;
      occupiedBaseBuildSpots?: number; pawnsAlive: number; siegesDefended: number; siegesTotal: number;
      monasteryHealed: number; healHp: number; hires: number; successions: number; veterans: number;
      firstHouseMin: number; barracks: number; monastery: number; archery: number; bestCombo: number;
      bossKilled: boolean; killsByKind: Record<string, number>; cardsPicked: string[];
      contract: string | null; ukaz: string | null; challengeMods: string[];
      blessing: string | null; consumables: string[];
    };
    type TestMetaState = {
      glory: number;
      codex: Record<string, number>;
      quests: { date: string; ids: string[]; progress: Record<string, number>; done: string[]; rerolls: number };
      chains: { counters: Record<string, number>; claimed: string[] };
      pass: { season: string; xp: number; premium: boolean; claimedFree: number; claimedPrem: number };
      weekly: { week: string; progress: number; stage: number; claimed: boolean };
    };
    const meta = await import('/src/game/meta.ts') as unknown as {
      rollMetaDay: () => TestMetaState;
      saveMetaState: (state: TestMetaState) => boolean;
      loadMetaState: () => TestMetaState;
      applyRunToMeta: (summary: RunSummary) => unknown;
      codexCount: (id: string) => number;
      codexProgress: () => { seen: number; total: number; ratio: number };
    };

    const state = meta.rollMetaDay();
    state.codexSeen = {};
    state.codex = {
      // Старые корректные алиасы должны мигрировать; b_house намеренно не считается домом.
      b_barracks: 1, b_monastery: 1, b_archery: 1, b_house: 99,
    };
    state.quests.ids = [];
    state.quests.progress = {};
    state.quests.done = [];
    state.chains.counters = {};
    state.chains.claimed = [];
    state.pass.xp = 5_000;
    state.pass.premium = false;
    meta.saveMetaState(state);

    const base: RunSummary = {
      victory: false, ideal: false, endless: false, weeklyChallenge: false,
      wave: 0, time: 120, kills: 0, level: 1, gold: 0, score: 0, difficulty: 'normal',
      buildingsBuilt: 5,
      buildingKindsBuilt: { house: 2, barracks: 1, tower: 1, archery: 1, monastery: 1 },
      occupiedBaseBuildSpots: 0, pawnsAlive: 0, siegesDefended: 0, siegesTotal: 0,
      monasteryHealed: 0, healHp: 0, hires: 0, successions: 0, veterans: 0,
      firstHouseMin: 0, barracks: 0, monastery: 0, archery: 0, bestCombo: 0,
      bossKilled: false, killsByKind: {}, cardsPicked: [], contract: null, ukaz: null,
      challengeMods: [], blessing: null, consumables: [],
    };

    const before = meta.codexProgress(); // чтение кодекса также запускает legacy-миграцию
    meta.applyRunToMeta(base);
    const after = meta.codexProgress();

    return {
      counts: {
        house: meta.codexCount('house'),
        barracks: meta.codexCount('barracks'),
        tower: meta.codexCount('tower'),
        archery: meta.codexCount('archery'),
        monastery: meta.codexCount('monastery'),
        invalidLegacyHouse: meta.codexCount('b_house'),
      },
      seenBefore: before.seen,
      seenAfter: after.seen,
      seenDelta: after.seen - before.seen,
      total: after.total,
    };
  });

  expect(outcome.counts).toEqual({
    house: 2,
    barracks: 2,
    tower: 1,
    archery: 2,
    monastery: 2,
    invalidLegacyHouse: 99,
  });
  expect(outcome.seenBefore).toBe(3); // мигрированные legacy-записи
  expect(outcome.seenAfter).toBe(5);  // + дом и башня, впервые учтённые по типу
  expect(outcome.seenDelta).toBe(2);
  expect(outcome.total).toBeGreaterThanOrEqual(5);
});

test('codex completion rewards are granted in the same run that fills the final entry', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });

  const outcome = await page.evaluate(async () => {
    type RunSummary = {
      victory: boolean; ideal: boolean; endless: boolean; weeklyChallenge: boolean;
      wave: number; time: number; kills: number; level: number; gold: number; score: number;
      difficulty: string; buildingsBuilt: number;
      buildingKindsBuilt?: Partial<Record<'house' | 'barracks' | 'tower' | 'archery' | 'monastery', number>>;
      occupiedBaseBuildSpots?: number; pawnsAlive: number; siegesDefended: number; siegesTotal: number;
      monasteryHealed: number; healHp: number; hires: number; successions: number; veterans: number;
      firstHouseMin: number; barracks: number; monastery: number; archery: number; bestCombo: number;
      bossKilled: boolean; killsByKind: Record<string, number>; cardsPicked: string[];
      contract: string | null; ukaz: string | null; challengeMods: string[];
      blessing: string | null; consumables: string[];
    };
    type TestMetaState = {
      codex: Record<string, number>;
      chains: { counters: Record<string, number>; claimed: string[] };
      skins: { owned: string[] };
      quests: { date: string; ids: string[]; progress: Record<string, number>; done: string[]; rerolls: number };
      pass: { season: string; xp: number; premium: boolean; claimedFree: number; claimedPrem: number };
    };
    const meta = await import('/src/game/meta.ts') as unknown as {
      CODEX_SECTIONS: Array<{ entries: Array<{ id: string }> }>;
      rollMetaDay: () => TestMetaState;
      saveMetaState: (state: TestMetaState) => boolean;
      loadMetaState: () => TestMetaState;
      applyRunToMeta: (summary: RunSummary) => unknown;
      codexProgress: () => { seen: number; total: number; ratio: number };
    };
    const state = meta.rollMetaDay();
    state.codex = {};
    state.codexSeen = {};
    for (const section of meta.CODEX_SECTIONS) {
      for (const entry of section.entries) {
        if (entry.id !== 'house') state.codex[entry.id] = 1;
      }
    }
    state.chains.claimed = state.chains.claimed.filter((id) => !id.startsWith('codex:'));
    state.skins.owned = state.skins.owned.filter((id) => id !== 'golden_goblin');
    state.quests.ids = [];
    state.quests.progress = {};
    state.quests.done = [];
    state.pass.xp = 5_000;
    state.pass.premium = false;
    meta.saveMetaState(state);
    const before = meta.codexProgress();

    const run: RunSummary = {
      victory: false, ideal: false, endless: false, weeklyChallenge: false,
      wave: 0, time: 120, kills: 0, level: 1, gold: 0, score: 0, difficulty: 'normal',
      buildingsBuilt: 1, buildingKindsBuilt: { house: 1 }, occupiedBaseBuildSpots: 0,
      pawnsAlive: 0, siegesDefended: 0, siegesTotal: 0, monasteryHealed: 0, healHp: 0,
      hires: 0, successions: 0, veterans: 0, firstHouseMin: 0, barracks: 0, monastery: 0,
      archery: 0, bestCombo: 0, bossKilled: false, killsByKind: {}, cardsPicked: [],
      contract: null, ukaz: null, challengeMods: [], blessing: null, consumables: [],
    };
    meta.applyRunToMeta(run);
    const saved = meta.loadMetaState();
    const after = meta.codexProgress();
    return {
      beforeRatio: before.ratio,
      afterRatio: after.ratio,
      milestoneClaims: saved.chains.claimed.filter((id) => id.startsWith('codex:')).sort(),
      goldenGoblinGranted: saved.skins.owned.includes('golden_goblin'),
    };
  });

  expect(outcome.beforeRatio).toBeLessThan(1);
  expect(outcome.afterRatio).toBe(1);
  expect(outcome.milestoneClaims).toEqual(['codex:100', 'codex:50', 'codex:75']);
  expect(outcome.goldenGoblinGranted).toBe(true);
});


test('enemy codex unlocks on encounter while mastery remains based on kills', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });

  await page.evaluate(() => {
    const runtime = (window as unknown as { __tss?: { scene: { getScene(key: string): unknown } } }).__tss;
    if (!runtime) throw new Error('Phaser runtime is unavailable');
    const menu = runtime.scene.getScene('Menu') as {
      selectedHero?: string; selectedDiff?: string;
      scene: { start(key: string, data: { hero: string; diff: string }): void };
    };
    menu.scene.start('Game', { hero: menu.selectedHero ?? 'warrior', diff: menu.selectedDiff ?? 'normal' });
  });
  await expect.poll(() => page.evaluate(() => (
    (window as unknown as { __tss?: { scene: { isActive(key: string): boolean } } }).__tss?.scene.isActive('Game') ?? false
  )), { timeout: startupTimeout }).toBe(true);

  const outcome = await page.evaluate(async () => {
    type TestMetaState = { codex: Record<string, number>; codexSeen: Record<string, boolean> };
    type EnemyScene = { player: { x: number; y: number }; spawnEnemy(kind: string, x: number, y: number): boolean };
    const runtime = (window as unknown as { __tss?: { scene: { getScene(key: string): unknown } } }).__tss;
    if (!runtime) throw new Error('Phaser runtime is unavailable');
    const scene = runtime.scene.getScene('Game') as EnemyScene;
    const meta = await import('/src/game/meta.ts') as unknown as {
      rollMetaDay: () => TestMetaState;
      saveMetaState: (state: TestMetaState) => boolean;
      codexCount: (id: string) => number;
      codexEntrySeen: (id: string) => boolean;
      codexProgress: () => { seen: number; total: number; ratio: number };
      CODEX_SECTIONS: Array<{ entries: Array<{ id: string; masterAt?: number }> }>;
    };
    const state = meta.rollMetaDay();
    state.codex.goblin = 0;
    delete state.codexSeen.goblin;
    meta.saveMetaState(state);
    const before = meta.codexProgress();
    const spawned = scene.spawnEnemy('goblin', scene.player.x + 500, scene.player.y + 500);
    const after = meta.codexProgress();
    const entry = meta.CODEX_SECTIONS.flatMap((section) => section.entries).find((item) => item.id === 'goblin');
    return {
      spawned,
      seen: meta.codexEntrySeen('goblin'),
      killCount: meta.codexCount('goblin'),
      seenDelta: after.seen - before.seen,
      masteryGoal: entry?.masterAt ?? null,
    };
  });

  expect(outcome.spawned).toBe(true);
  expect(outcome.seen).toBe(true);
  expect(outcome.killCount).toBe(0);
  expect(outcome.seenDelta).toBe(1);
  expect(outcome.masteryGoal).toBe(30);
});

test('blessing token changes roll back when storage rejects a write', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });

  const outcome = await page.evaluate(async () => {
    type TestMetaState = {
      blessingTokens: number;
      quests: { date: string; ids: string[]; progress: Record<string, number>; done: string[]; rerolls: number };
    };
    const meta = await import('/src/game/meta.ts') as unknown as {
      rollMetaDay: () => TestMetaState;
      saveMetaState: (state: TestMetaState) => boolean;
      loadMetaState: () => TestMetaState;
      spendBlessingToken: () => Promise<boolean>;
      grantBlessingToken: () => Promise<boolean>;
    };
    const state = meta.rollMetaDay();
    state.blessingTokens = 1;
    meta.saveMetaState(state);

    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string): void {
      if (key === 'tss-meta2') throw new DOMException('storage disabled', 'QuotaExceededError');
      originalSetItem.call(this, key, value);
    };
    const spendSaved = await meta.spendBlessingToken();
    const tokensAfterFailedSpend = meta.loadMetaState().blessingTokens;
    Storage.prototype.setItem = originalSetItem;

    const beforeGrant = meta.loadMetaState();
    beforeGrant.blessingTokens = 0;
    meta.saveMetaState(beforeGrant);
    Storage.prototype.setItem = function (key: string, value: string): void {
      if (key === 'tss-meta2') throw new DOMException('storage disabled', 'QuotaExceededError');
      originalSetItem.call(this, key, value);
    };
    const grantSaved = await meta.grantBlessingToken();
    const tokensAfterFailedGrant = meta.loadMetaState().blessingTokens;
    Storage.prototype.setItem = originalSetItem;

    return { spendSaved, tokensAfterFailedSpend, grantSaved, tokensAfterFailedGrant };
  });

  expect(outcome).toEqual({
    spendSaved: false,
    tokensAfterFailedSpend: 1,
    grantSaved: false,
    tokensAfterFailedGrant: 0,
  });
});


test('meta purchases and daily rewards roll back when storage rejects a write', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });

  const outcome = await page.evaluate(async () => {
    type TestMetaState = {
      matchesPlayed: number;
      glory: number;
      nodes: string[];
      crowns: number;
      crownConvert: { date: string; count: number };
      dailyBonus: { last: string; lastAt: number; streak: number };
      pass: { xp: number; premium: boolean };
      purchasedSkus: string[];
      processedIapTokens: string[];
      consumables: Record<string, number>;
    };
    const meta = await import('/src/game/meta.ts') as unknown as {
      rollMetaDay: () => TestMetaState;
      saveMetaState: (state: TestMetaState) => boolean;
      loadMetaState: () => TestMetaState;
      TREE_NODES: Array<{ id: string; cost: number }>;
      buyNode: (id: string) => { ok: boolean; reason?: string };
      claimDailyBonus: () => { ok: boolean; reason?: string; streak: number; day: number };
      convertCrownsToGold: () => { ok: boolean; reason?: string };
      grantSkuForPurchase: (sku: string, token: string) => {
        supported: boolean; duplicate: boolean; persisted: boolean; granted: { crowns: number };
      };
      takeConsumables: (ids: string[]) => boolean;
      addGlory: (amount: number) => boolean;
    };
    const state = meta.rollMetaDay();
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric',
    }).formatToParts(new Date());
    const part = (type: string): string => parts.find((item) => item.type === type)?.value ?? '';
    const today = `${part('year')}-${part('month')}-${part('day')}`;
    state.matchesPlayed = 3;
    state.glory = 5000;
    state.consumables.cs_horseshoe = 1;
    state.nodes = [];
    state.crowns = 250;
    state.crownConvert = { date: today, count: 0 };
    state.dailyBonus = {
      last: '2000-01-01',
      lastAt: Date.parse('2000-01-01T12:00:00.000Z'),
      streak: 4,
    };
    meta.saveMetaState(state);

    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string): void {
      if (key === 'tss-meta2') throw new DOMException('storage disabled', 'QuotaExceededError');
      originalSetItem.call(this, key, value);
    };

    const node = meta.buyNode(meta.TREE_NODES[0]!.id);
    const afterNode = meta.loadMetaState();
    const glorySaved = meta.addGlory(25);
    const afterGlory = meta.loadMetaState();
    const consumablesSaved = meta.takeConsumables(['cs_horseshoe']);
    const afterConsumables = meta.loadMetaState();
    const bonus = meta.claimDailyBonus();
    const afterBonus = meta.loadMetaState();
    const conversion = meta.convertCrownsToGold();
    const finalState = meta.loadMetaState();
    Storage.prototype.setItem = originalSetItem;

    // Метаснимок записывается, но начисление отдельного кошелька может завершиться ошибкой.
    // Ежедневная награда золота должна откатить и сам факт забора.
    const walletState = meta.loadMetaState();
    walletState.matchesPlayed = 3;
    walletState.dailyBonus = { last: '2000-01-01', lastAt: 0, streak: 0 };
    meta.saveMetaState(walletState);
    const shop = await import('/src/game/shop.ts') as unknown as {
      loadShop: () => { balance: number };
    };
    const walletBefore = shop.loadShop().balance;
    Storage.prototype.setItem = function (key: string, value: string): void {
      if (key === 'tss-shop') throw new DOMException('wallet storage disabled', 'QuotaExceededError');
      originalSetItem.call(this, key, value);
    };
    const walletBonus = meta.claimDailyBonus();
    const afterWalletBonus = meta.loadMetaState();
    const walletAfter = shop.loadShop().balance;
    Storage.prototype.setItem = originalSetItem;

    const passState = meta.loadMetaState();
    passState.pass.xp = 2500;
    passState.pass.premium = false;
    passState.purchasedSkus = [];
    passState.processedIapTokens = [];
    meta.saveMetaState(passState);
    const passWalletBefore = shop.loadShop().balance;
    Storage.prototype.setItem = function (key: string, value: string): void {
      if (key === 'tss-shop') throw new DOMException('wallet storage disabled', 'QuotaExceededError');
      originalSetItem.call(this, key, value);
    };
    const passPurchase = meta.grantSkuForPurchase('pass_chronicle', 'phase-q-pass-wallet-failure');
    const afterPassPurchase = meta.loadMetaState();
    const passWalletAfter = shop.loadShop().balance;
    Storage.prototype.setItem = originalSetItem;

    return {
      node: { ok: node.ok, reason: node.reason, glory: afterNode.glory, owned: afterNode.nodes.length > 0 },
      glory: { ok: glorySaved, balance: afterGlory.glory },
      consumables: { ok: consumablesSaved, horseshoe: afterConsumables.consumables.cs_horseshoe },
      bonus: { ok: bonus.ok, streak: afterBonus.dailyBonus.streak, last: afterBonus.dailyBonus.last },
      conversion: {
        ok: conversion.ok,
        reason: conversion.reason,
        crowns: finalState.crowns,
        count: finalState.crownConvert.count,
      },
      walletBonus: {
        ok: walletBonus.ok,
        reason: walletBonus.reason,
        streak: afterWalletBonus.dailyBonus.streak,
        last: afterWalletBonus.dailyBonus.last,
        balanceUnchanged: walletAfter === walletBefore,
      },
      passPurchase: {
        persisted: passPurchase.persisted,
        premium: afterPassPurchase.pass.premium,
        tokenRecorded: afterPassPurchase.processedIapTokens.includes('phase-q-pass-wallet-failure'),
        balanceUnchanged: passWalletAfter === passWalletBefore,
      },
    };
  });

  expect(outcome).toEqual({
    node: { ok: false, reason: 'storage', glory: 5000, owned: false },
    glory: { ok: false, balance: 5000 },
    consumables: { ok: false, horseshoe: 1 },
    bonus: { ok: false, streak: 4, last: '2000-01-01' },
    conversion: { ok: false, reason: 'storage', crowns: 250, count: 0 },
    walletBonus: {
      ok: false,
      reason: 'storage',
      streak: 0,
      last: '2000-01-01',
      balanceUnchanged: true,
    },
    passPurchase: {
      persisted: false,
      premium: false,
      tokenRecorded: false,
      balanceUnchanged: true,
    },
  });
});


test('daily challenge reward resets on UTC rollover while the Moscow day is unchanged', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });

  const outcome = await page.evaluate(async () => {
    type TestMetaState = {
      matchesPlayed: number;
      crowns: number;
      challengeWinDate: string;
    };
    const meta = await import('/src/game/meta.ts') as unknown as {
      rollMetaDay: () => TestMetaState;
      saveMetaState: (state: TestMetaState) => boolean;
      loadMetaState: () => TestMetaState;
      challengeForToday: () => { seed: string };
      markChallengeVictory: () => boolean;
      challengeVictoryToday: () => boolean;
    };
    const calendar = await import('/src/platform/calendar.ts') as {
      mskDayKey: (epochMs: number) => string;
    };
    const originalNow = Date.now;

    try {
      Date.now = () => Date.UTC(2026, 9, 21, 23, 59, 59, 999);
      const initial = meta.rollMetaDay();
      initial.matchesPlayed = 3;
      initial.crowns = 0;
      initial.challengeWinDate = '';
      meta.saveMetaState(initial);

      const seedBefore = meta.challengeForToday().seed;
      const moscowBefore = calendar.mskDayKey(Date.now());
      const firstClaim = meta.markChallengeVictory();

      Date.now = () => Date.UTC(2026, 9, 22, 0, 0, 0, 0);
      const seedAfter = meta.challengeForToday().seed;
      const moscowAfter = calendar.mskDayKey(Date.now());
      const secondClaim = meta.markChallengeVictory();
      const duplicateClaim = meta.markChallengeVictory();
      const state = meta.loadMetaState();

      return {
        seedBefore, seedAfter, moscowBefore, moscowAfter,
        firstClaim, secondClaim, duplicateClaim,
        crowns: state.crowns,
        challengeWinDate: state.challengeWinDate,
        claimedForCurrentSeed: meta.challengeVictoryToday(),
      };
    } finally {
      Date.now = originalNow;
    }
  });

  expect(outcome).toEqual({
    seedBefore: '2026-10-21',
    seedAfter: '2026-10-22',
    moscowBefore: '2026-10-22',
    moscowAfter: '2026-10-22',
    firstClaim: true,
    secondClaim: true,
    duplicateClaim: false,
    crowns: 6,
    challengeWinDate: '2026-10-22',
    claimedForCurrentSeed: true,
  });
});

test('achievement chain rejects fractional reward tiers without granting crowns', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });

  const outcome = await page.evaluate(async () => {
    type TestMetaState = {
      matchesPlayed: number;
      crowns: number;
      chains: { counters: Record<string, number>; claimed: string[] };
    };
    const meta = await import('/src/game/meta.ts') as unknown as {
      rollMetaDay: () => TestMetaState;
      saveMetaState: (state: TestMetaState) => boolean;
      loadMetaState: () => TestMetaState;
      claimChainReward: (chainId: string, tier: number) => { ok: boolean };
    };
    const state = meta.rollMetaDay();
    state.matchesPlayed = 3;
    state.crowns = 11;
    state.chains.counters = { idealWins: 15 };
    state.chains.claimed = [];
    meta.saveMetaState(state);

    const result = meta.claimChainReward('ch_keeper', 1.5);
    const after = meta.loadMetaState();
    return { result, crowns: after.crowns, claimed: after.chains.claimed };
  });

  expect(outcome).toEqual({ result: { ok: false }, crowns: 11, claimed: [] });
});


test('run meta progress rolls back when a pass gold reward cannot reach the shop wallet', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });

  const outcome = await page.evaluate(async () => {
    type RunSummary = {
      victory: boolean; ideal: boolean; endless: boolean; weeklyChallenge: boolean;
      wave: number; time: number; kills: number; level: number; gold: number; score: number;
      difficulty: string; buildingsBuilt: number; pawnsAlive: number;
      siegesDefended: number; siegesTotal: number; monasteryHealed: number; healHp: number;
      hires: number; successions: number; veterans: number; firstHouseMin: number;
      barracks: number; monastery: number; archery: number; bestCombo: number;
      bossKilled: boolean; killsByKind: Record<string, number>; cardsPicked: string[];
      contract: string | null; ukaz: string | null; challengeMods: string[];
      blessing: string | null; consumables: string[];
    };
    type TestMetaState = {
      matchesPlayed: number;
      pass: { xp: number; premium: boolean };
      quests: { ids: string[]; progress: Record<string, number>; done: string[] };
      chains: { counters: Record<string, number>; claimed: string[] };
    };
    const meta = await import('/src/game/meta.ts') as unknown as {
      rollMetaDay: () => TestMetaState;
      saveMetaState: (state: TestMetaState) => boolean;
      loadMetaState: () => TestMetaState;
      applyRunToMeta: (summary: RunSummary) => { persisted: boolean; newMatchesPlayed: number };
    };
    const shop = await import('/src/game/shop.ts') as unknown as {
      loadShop: () => { balance: number };
    };
    const state = meta.rollMetaDay();
    state.matchesPlayed = 6;
    state.pass.xp = 99; // Завершение рана должно открыть первый уровень и начислить 104 золота.
    state.pass.premium = false;
    state.quests.ids = [];
    state.quests.progress = {};
    state.quests.done = [];
    state.chains.counters = {};
    state.chains.claimed = [];
    meta.saveMetaState(state);
    const before = meta.loadMetaState();
    const walletBefore = shop.loadShop().balance;

    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string): void {
      if (key === 'tss-shop') throw new DOMException('wallet storage disabled', 'QuotaExceededError');
      originalSetItem.call(this, key, value);
    };
    const result = meta.applyRunToMeta({
      victory: false, ideal: false, endless: false, weeklyChallenge: false,
      wave: 0, time: 25, kills: 0, level: 1, gold: 0, score: 0, difficulty: 'normal',
      buildingsBuilt: 0, pawnsAlive: 0, siegesDefended: 0, siegesTotal: 0,
      monasteryHealed: 0, healHp: 0, hires: 0, successions: 0, veterans: 0,
      firstHouseMin: 0, barracks: 0, monastery: 0, archery: 0, bestCombo: 0,
      bossKilled: false, killsByKind: {}, cardsPicked: [], contract: null, ukaz: null,
      challengeMods: [], blessing: null, consumables: [],
    });
    const after = meta.loadMetaState();
    const walletAfter = shop.loadShop().balance;
    Storage.prototype.setItem = originalSetItem;

    return {
      persisted: result.persisted,
      resultMatchesPlayed: result.newMatchesPlayed,
      matchesPlayed: after.matchesPlayed,
      passXpBefore: before.pass.xp,
      passXpAfter: after.pass.xp,
      passPremiumAfter: after.pass.premium,
      walletUnchanged: walletAfter === walletBefore,
    };
  });

  expect(outcome).toEqual({
    persisted: false,
    resultMatchesPlayed: 6,
    matchesPlayed: 6,
    passXpBefore: 99,
    passXpAfter: 99,
    passPremiumAfter: false,
    walletUnchanged: true,
  });
});


test('daily rewarded placement is not granted when its quota cannot be persisted', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });

  const outcome = await page.evaluate(async () => {
    const ads = await import('/src/platform/ads.ts') as unknown as {
      showPlacementRewarded: (placement: 'daily-chest') => Promise<{ rewarded: boolean; available: boolean }>;
    };
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string): void {
      if (key === 'tss-ads-day') throw new DOMException('quota storage disabled', 'QuotaExceededError');
      originalSetItem.call(this, key, value);
    };

    try {
      const result = await ads.showPlacementRewarded('daily-chest');
      return { result, storedQuota: localStorage.getItem('tss-ads-day') };
    } finally {
      Storage.prototype.setItem = originalSetItem;
    }
  });

  expect(outcome).toEqual({
    result: { rewarded: false, available: false },
    storedQuota: null,
  });
});


test('chronicle pass progresses for 30 days independently from 14-day world seasons', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });

  const outcome = await page.evaluate(async () => {
    const meta = await import('/src/game/meta.ts') as unknown as {
      passSeasonIndexFor: (now?: number) => number;
      seasonIndexFor: (now?: number) => number;
      rollMetaDay: () => {
        pass: { season: string; xp: number; premium: boolean; claimedFree: number; claimedPrem: number };
      };
      saveMetaState: (state: unknown) => boolean;
    };
    const originalNow = Date.now;
    const dayMs = 86_400_000;
    const basePassStart = Math.floor(originalNow() / (30 * dayMs)) * 30 * dayMs;
    const nextThemeBoundary = (Math.floor(basePassStart / (14 * dayMs)) + 1) * 14 * dayMs;
    const beforeThemeBoundary = nextThemeBoundary - 1_000;
    const afterThemeBoundary = nextThemeBoundary + 1_000;

    try {
      Date.now = () => beforeThemeBoundary;
      const state = meta.rollMetaDay();
      state.pass = {
        season: `s${meta.seasonIndexFor(beforeThemeBoundary)}`,
        xp: 777,
        premium: true,
        claimedFree: 7,
        claimedPrem: 7,
      };
      meta.saveMetaState(state);

      const migrated = meta.rollMetaDay();
      const afterTheme = (() => {
        Date.now = () => afterThemeBoundary;
        return meta.rollMetaDay();
      })();
      const atNextPassBoundary = (() => {
        Date.now = () => basePassStart + 30 * dayMs + 1_000;
        return meta.rollMetaDay();
      })();

      return {
        themeChanged: meta.seasonIndexFor(beforeThemeBoundary) !== meta.seasonIndexFor(afterThemeBoundary),
        migratedSeason: migrated.pass.season,
        expectedPassSeason: `p${meta.passSeasonIndexFor(beforeThemeBoundary)}`,
        migratedXp: migrated.pass.xp,
        migratedPremium: migrated.pass.premium,
        passSurvivedThemeChange: afterTheme.pass.xp === 777 && afterTheme.pass.premium,
        newPassSeason: atNextPassBoundary.pass.season,
        expectedNextPassSeason: `p${meta.passSeasonIndexFor(basePassStart + 30 * dayMs + 1_000)}`,
        passXpAfterThirtyDays: atNextPassBoundary.pass.xp,
        premiumAfterThirtyDays: atNextPassBoundary.pass.premium,
      };
    } finally {
      Date.now = originalNow;
    }
  });

  expect(outcome).toEqual({
    themeChanged: true,
    migratedSeason: outcome.expectedPassSeason,
    expectedPassSeason: outcome.expectedPassSeason,
    migratedXp: 777,
    migratedPremium: true,
    passSurvivedThemeChange: true,
    newPassSeason: outcome.expectedNextPassSeason,
    expectedNextPassSeason: outcome.expectedNextPassSeason,
    passXpAfterThirtyDays: 0,
    premiumAfterThirtyDays: false,
  });
});


test('gold rush season increases vein output and every ore expenditure', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
    const nativeNow = Date.now.bind(Date);
    const targetNow = 29 * 86_400_000 + 60_000; // сезон 2: «Золотая лихорадка»
    const offset = targetNow - nativeNow();
    Date.now = () => nativeNow() + offset;
  });
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });
  await expect.poll(() => page.evaluate(() =>
    ((window as Window & { __tss?: { scene: { isActive(key: string): boolean } } }).__tss?.scene.isActive('Menu')) ?? false,
  ), { timeout: startupTimeout }).toBe(true);
  await page.evaluate(() => {
    const game = (window as Window & {
      __tss?: { scene: { getScene(key: string): unknown } };
    }).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const menu = game.scene.getScene('Menu') as {
      selectedHero?: string; selectedDiff?: string;
      scene: { start(key: string, data: { hero: string; diff: string }): void };
    };
    menu.scene.start('Game', { hero: menu.selectedHero ?? 'warrior', diff: menu.selectedDiff ?? 'normal' });
  });
  await expect.poll(() => page.evaluate(() =>
    ((window as Window & { __tss?: { scene: { isActive(key: string): boolean } } }).__tss?.scene.isActive('Game')) ?? false,
  ), { timeout: startupTimeout }).toBe(true);

  const result = await page.evaluate(async () => {
    const game = (window as Window & { __tss?: { scene: { getScene(key: string): unknown } } }).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const scene = game.scene.getScene('Game') as {
      seasonMod: string | null;
      economy: {
        resources: { wood: number; ore: number; meat: number };
        buildingCost(kind: string): { wood?: number; ore?: number; meat?: number };
        hireCost(weapon: string): { wood?: number; ore?: number; meat?: number };
        repair(building: unknown, pawn: null): boolean;
      };
    };
    const data = await import('/src/game/data.ts') as {
      BUILDING_PLANS: Record<string, { cost: { wood?: number; ore?: number; meat?: number } }>;
    };
    const constants = await import('/src/game/constants.ts') as {
      HIRE_COST: Record<string, { wood?: number; ore?: number; meat?: number }>;
      REPAIR: { REBUILD_BARRACKS_ORE: number };
    };
    const building = scene.economy.buildingCost('barracks');
    const hire = scene.economy.hireCost('lance');
    scene.economy.resources.wood = 10_000;
    scene.economy.resources.ore = 10_000;
    scene.economy.resources.meat = 10_000;
    const repairTarget = {
      kind: 'barracks', hp: 0, maxHp: 250, alive: true, underConstruction: false,
      plan: { noRepair: false }, scaleX: 1, setScale: () => {},
    };
    const repairOreBefore = scene.economy.resources.ore;
    const repairAccepted = scene.economy.repair(repairTarget, null);
    const repairOreSpent = repairOreBefore - scene.economy.resources.ore;
    return {
      season: scene.seasonMod,
      buildingOre: building.ore,
      expectedBuildingOre: Math.round((data.BUILDING_PLANS.barracks.cost.ore ?? 0) * 1.25),
      buildingWood: building.wood,
      baseBuildingWood: data.BUILDING_PLANS.barracks.cost.wood,
      hireOre: hire.ore,
      expectedHireOre: Math.round((constants.HIRE_COST.lance.ore ?? 0) * 1.25),
      hireWood: hire.wood,
      baseHireWood: constants.HIRE_COST.lance.wood,
      repairAccepted,
      repairOreSpent,
      expectedRepairOreSpent: Math.round(constants.REPAIR.REBUILD_BARRACKS_ORE * 1.25),
    };
  });

  expect(result.season).toBe('gold_rush_world');
  expect(result.buildingOre).toBe(result.expectedBuildingOre);
  expect(result.buildingOre).toBe(19);
  expect(result.buildingWood).toBe(result.baseBuildingWood);
  expect(result.hireOre).toBe(result.expectedHireOre);
  expect(result.hireOre).toBe(13);
  expect(result.hireWood).toBe(result.baseHireWood);
  expect(result.repairAccepted).toBe(true);
  expect(result.repairOreSpent).toBe(result.expectedRepairOreSpent);
  expect(result.repairOreSpent).toBe(19);
});

test('ogre return season increases only phase-two castle attack cadence', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
    const nativeNow = Date.now.bind(Date);
    const targetNow = 43 * 86_400_000 + 60_000; // сезон 3: «Возвращение Огра»
    const offset = targetNow - nativeNow();
    Date.now = () => nativeNow() + offset;
  });
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });
  await expect.poll(() => page.evaluate(() =>
    ((window as Window & { __tss?: { scene: { isActive(key: string): boolean } } }).__tss?.scene.isActive('Menu')) ?? false,
  ), { timeout: startupTimeout }).toBe(true);
  await page.evaluate(() => {
    const game = (window as Window & {
      __tss?: { scene: { getScene(key: string): unknown } };
    }).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const menu = game.scene.getScene('Menu') as {
      selectedHero?: string; selectedDiff?: string;
      scene: { start(key: string, data: { hero: string; diff: string }): void };
    };
    menu.scene.start('Game', { hero: menu.selectedHero ?? 'warrior', diff: menu.selectedDiff ?? 'normal' });
  });
  await expect.poll(() => page.evaluate(() =>
    ((window as Window & { __tss?: { scene: { isActive(key: string): boolean } } }).__tss?.scene.isActive('Game')) ?? false,
  ), { timeout: startupTimeout }).toBe(true);

  const result = await page.evaluate(() => {
    const game = (window as Window & { __tss?: { scene: { getScene(key: string): unknown } } }).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const scene = game.scene.getScene('Game') as {
      seasonMod: string | null;
      spawnBoss(): void;
      bossPhaseCheck(): void;
      boss: {
        hp: number; maxHp: number; siege: boolean; aiState: string;
        buildingAttackIntervalMs: number;
      } | null;
    };
    scene.spawnBoss();
    const boss = scene.boss;
    if (!boss) throw new Error('Boss was not created');
    const normalInterval = boss.buildingAttackIntervalMs;
    boss.hp = boss.maxHp * 0.49;
    scene.bossPhaseCheck();
    return {
      season: scene.seasonMod,
      normalInterval,
      phaseTwoInterval: boss.buildingAttackIntervalMs,
      phaseTwo: boss.aiState === 'bossPhase2' && boss.siege,
    };
  });

  expect(result.season).toBe('ogre_return');
  expect(result.normalInterval).toBe(535);
  expect(result.phaseTwo).toBe(true);
  expect(result.phaseTwoInterval).toBe(400);
});
