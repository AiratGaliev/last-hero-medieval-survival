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
    expect(bounds!.width).toBeGreaterThan(0);
    expect(bounds!.height).toBeGreaterThan(0);

    await expect.poll(() => pageErrors, {
      timeout: 2_000,
      message: 'the app should not throw uncaught browser exceptions during startup',
    }).toEqual([]);
  });
}
