import { expect, test, type Page } from '@playwright/test';

const startupTimeout = 60_000;

async function openGame(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });
  await expect.poll(() => page.evaluate(() => (
    (window as Window & {
      __tss?: { scene: { isActive(key: string): boolean } };
    }).__tss?.scene.isActive('Menu') ?? false
  )), { timeout: startupTimeout }).toBe(true);
}

type OfferKind = 'starter' | 'monastery' | 'pass';

async function prepareEndScreen(page: Page, offer: OfferKind, sessionAlreadyUsed = false): Promise<void> {
  await page.evaluate(async ({ offer, sessionAlreadyUsed }) => {
    type PassState = { season: string; xp: number; premium: boolean; claimedFree: number; claimedPrem: number };
    type FixtureState = {
      matchesPlayed: number;
      firstWinAt: number;
      purchasedSkus: string[];
      pass: PassState;
    };
    const meta = await import('/src/game/meta.ts') as unknown as {
      rollMetaDay: () => FixtureState;
      saveMetaState: (state: FixtureState) => boolean;
    };
    const state = meta.rollMetaDay();
    state.matchesPlayed = 10;
    state.firstWinAt = Date.now();
    state.purchasedSkus = state.purchasedSkus.filter((sku) => sku !== 'starter_castellan');
    state.pass = { ...state.pass, xp: offer === 'pass' ? 3_000 : state.pass.xp, premium: false };
    if (!meta.saveMetaState(state)) throw new Error('failed to prepare store offer fixture');

    if (sessionAlreadyUsed) sessionStorage.setItem('tss-store-offer-shown', '1');

    const game = (window as Window & {
      __tss?: {
        scene: {
          getScene: (key: string) => {
            scene: { launch: (key: string, payload?: unknown) => void };
          };
        };
      };
    }).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const menu = game.scene.getScene('Menu');
    menu.scene.launch('GameOver', {
      stats: {
        victory: false,
        time: 899,
        kills: 30,
        level: 3,
        gold: 50,
        score: 1_000,
        meta: {
          glory: null,
          questsDone: 0,
          questsTotal: 0,
          questsCompletedNow: [],
          passLevels: 0,
          passRewards: [],
          chainUnlocks: [],
          endlessWave: 0,
          crownsEarned: 0,
          challenge: false,
          ukaz: null,
          endless: false,
          storeOffer: offer,
        },
      },
    });
  }, { offer, sessionAlreadyUsed });
  await expect.poll(() => page.evaluate(() => (
    (window as Window & {
      __tss?: { scene: { isActive(key: string): boolean } };
    }).__tss?.scene.isActive('GameOver') ?? false
  )), { timeout: startupTimeout }).toBe(true);
}

async function findTextAndViewport(page: Page, label: string): Promise<{
  bounds: { x: number; y: number; width: number; height: number } | null;
  gameWidth: number;
  gameHeight: number;
}> {
  return page.evaluate((target) => {
    const runtime = (window as Window & {
      __tss?: {
        scale: { width: number; height: number };
        scene: {
          getScene: (key: string) => { children: { list: unknown[] } };
        };
      };
    }).__tss;
    if (!runtime) throw new Error('Phaser runtime is unavailable');

    let bounds: { x: number; y: number; width: number; height: number } | null = null;
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object' || bounds) return;
      const object = value as {
        text?: unknown;
        list?: unknown[];
        getBounds?: () => { x: number; y: number; width: number; height: number };
      };
      if (object.text === target && typeof object.getBounds === 'function') {
        const rect = object.getBounds();
        bounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        return;
      }
      if (Array.isArray(object.list)) object.list.forEach(visit);
    };
    runtime.scene.getScene('GameOver').children.list.forEach(visit);
    return { bounds, gameWidth: runtime.scale.width, gameHeight: runtime.scale.height };
  }, label);
}

async function clickGameObjectText(page: Page, label: string): Promise<void> {
  const target = await findTextAndViewport(page, label);
  expect(target.bounds, `expected visible Phaser text: ${label}`).not.toBeNull();
  const canvas = await page.locator('#game canvas').boundingBox();
  expect(canvas).not.toBeNull();
  const rect = target.bounds!;
  const canvasRect = canvas!;
  await page.mouse.click(
    canvasRect.x + ((rect.x + rect.width / 2) / target.gameWidth) * canvasRect.width,
    canvasRect.y + ((rect.y + rect.height / 2) / target.gameHeight) * canvasRect.height,
  );
}

test('contextual starter offer CTA opens the crowns tab from Game Over', async ({ page }) => {
  await openGame(page);
  await prepareEndScreen(page, 'starter');
  await clickGameObjectText(page, 'VIEW OFFER');

  await expect.poll(() => page.evaluate(() => {
    const game = (window as Window & {
      __tss?: {
        scene: {
          isActive: (key: string) => boolean;
          getScene: (key: string) => { tab?: string };
        };
      };
    }).__tss;
    return game?.scene.isActive('Shop') ? game.scene.getScene('Shop').tab ?? null : null;
  }), { timeout: startupTimeout }).toBe('crowns');
});

test('level-30 Chronicle offer CTA opens the premium pass tab', async ({ page }) => {
  await openGame(page);
  await prepareEndScreen(page, 'pass');
  await clickGameObjectText(page, 'VIEW OFFER');

  await expect.poll(() => page.evaluate(() => {
    const game = (window as Window & {
      __tss?: {
        scene: {
          isActive: (key: string) => boolean;
          getScene: (key: string) => { tab?: string };
        };
      };
    }).__tss;
    return game?.scene.isActive('Shop') ? game.scene.getScene('Shop').tab ?? null : null;
  }), { timeout: startupTimeout }).toBe('pass');
});

test('contextual offer is hidden if this browser session already showed one', async ({ page }) => {
  await openGame(page);
  await prepareEndScreen(page, 'starter', true);
  await expect.poll(async () => (await findTextAndViewport(page, 'VIEW OFFER')).bounds, {
    timeout: 5_000,
  }).toBeNull();
});
