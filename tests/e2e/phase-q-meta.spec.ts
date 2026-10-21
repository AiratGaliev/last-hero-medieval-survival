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
