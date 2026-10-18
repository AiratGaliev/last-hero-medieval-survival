import { expect, test, type Page } from '@playwright/test';

type FormationModule = {
  calculateSiegeSpawnAngles: (
    profileName: string,
    unitCount: number,
    baseAngle: number,
  ) => number[];
};

const startupTimeout = 30_000;

async function openGame(page: Page): Promise<void> {
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });
}

async function calculateAngles(
  page: Page,
  profileName: string,
  unitCount: number,
  baseAngle: number,
): Promise<number[]> {
  const moduleUrl = new URL('/src/game/systems/SiegeFormation.ts', page.url()).href;
  return page.evaluate(async ({ url, name, count, angle }) => {
    const formation = await import(/* @vite-ignore */ url) as FormationModule;
    return formation.calculateSiegeSpawnAngles(name, count, angle);
  }, { url: moduleUrl, name: profileName, count: unitCount, angle: baseAngle });
}

test('pincer siege distributes a balanced squad across opposite flanks', async ({ page }) => {
  await openGame(page);
  const baseAngle = 0.73;
  const angles = await calculateAngles(page, 'siege.profile.pincer', 10, baseAngle);

  expect(angles).toHaveLength(10);
  for (let index = 0; index < angles.length; index += 2) {
    const difference = Math.atan2(
      Math.sin(angles[index + 1] - angles[index]),
      Math.cos(angles[index + 1] - angles[index]),
    );
    expect(Math.abs(Math.abs(difference) - Math.PI)).toBeLessThan(1e-9);
  }
});

test('non-pincer siege profiles preserve the existing single-flank formation', async ({ page }) => {
  await openGame(page);
  const baseAngle = 1.17;
  const angles = await calculateAngles(page, 'siege.profile.scout', 3, baseAngle);

  expect(angles).toEqual([
    baseAngle,
    baseAngle + 0.28,
    baseAngle + 0.56,
  ]);
});
