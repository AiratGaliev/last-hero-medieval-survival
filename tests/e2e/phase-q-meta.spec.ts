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
    const today = new Date().toISOString().slice(0, 10);
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
        dailyProgressionRng: { frac: () => number } | null;
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
      // Доступные карточки должны зависеть от даты и состояния рана, но не от числа боевых бросков.
      const choices = scene.generateChoices().map(({ kind, id, title }) => ({
        kind,
        id: id ?? null,
        title,
      }));
      const progressionSeeded = scene.dailyProgressionRng !== null;
      const spawnPositions = Array.from({ length: 6 }, () => ({
        x: Math.round(scene.spawner.ctx.randomSpawnX() * 100) / 100,
        y: Math.round(scene.spawner.ctx.randomSpawnY() * 100) / 100,
      }));
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
        waveRandom: Array.from({ length: 8 }, () => scene.spawner.o.random?.() ?? -1),
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
    expect(repeat.waveRandom).toEqual(first.waveRandom);
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
