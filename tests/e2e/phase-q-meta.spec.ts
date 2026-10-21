import { expect, test } from '@playwright/test';

const startupTimeout = 60_000;

test('daily streak loses only one step after a long absence', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('tss-meta2', JSON.stringify({
      v: 2,
      matchesPlayed: 10,
      dailyBonus: { last: '2000-01-01', streak: 5 },
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
          dailyBonus: { last: '2000-01-01', streak: 6 },
        },
      },
    };
    sessionStorage.setItem(cloudKey, JSON.stringify(playerData));
    localStorage.clear();
    localStorage.setItem('tss-meta2', JSON.stringify({
      v: 2,
      savedAt: Date.now() - 60_000,
      matchesPlayed: 2,
      glory: 100,
      dailyBonus: { last: '2000-01-01', streak: 2 },
    }));

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
        getServerTime: async () => Date.now(),
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
      addGlory: (amount: number) => void;
      flushMetaStateToPlayerData: () => Promise<boolean>;
    };
    const restored = meta.loadMetaState();
    const restoredSnapshot = {
      matchesPlayed: restored.matchesPlayed,
      glory: restored.glory,
      streak: restored.dailyBonus.streak,
    };

    meta.addGlory(17);
    const flushed = await meta.flushMetaStateToPlayerData();
    const playerData = JSON.parse(sessionStorage.getItem('__phase_q_player_data_v1') ?? '{}') as {
      'tss-meta-state-v1'?: { version?: number; state?: { glory?: number; matchesPlayed?: number } };
    };
    const cloud = playerData['tss-meta-state-v1'];

    return {
      restoredSnapshot,
      flushed,
      cloudVersion: cloud?.version,
      cloudGlory: cloud?.state?.glory,
      cloudMatches: cloud?.state?.matchesPlayed,
    };
  });

  expect(report.restoredSnapshot).toEqual({ matchesPlayed: 11, glory: 777, streak: 6 });
  expect(report.flushed).toBe(true);
  expect(report.cloudVersion).toBe(1);
  expect(report.cloudGlory).toBe(794);
  expect(report.cloudMatches).toBe(11);
});
