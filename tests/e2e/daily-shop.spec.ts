import { expect, test, type Page } from '@playwright/test';

const startupTimeout = 30_000;
const shopStorageKey = 'tss-shop-rotation-v1';
const adDayStorageKey = 'tss-ads-day';

type Rotation = { date: string; ids: string[]; refreshed: boolean };
type AdDay = { date: string; used: Record<string, number> };

type UiBounds = { centerX: number; centerY: number };
type UiObject = {
  type?: string;
  text?: string;
  list?: UiObject[];
  getBounds?: () => UiBounds;
};
type ScenePlugin = { launch: (key: string, data?: { tab: string }) => void };
type PhaserScene = {
  scene: ScenePlugin;
  sys?: { displayList: { list: UiObject[] } };
};
type GameForTest = {
  scene: {
    isActive: (key: string) => boolean;
    getScene: (key: string) => PhaserScene;
  };
  scale: { width: number; height: number };
  canvas: HTMLCanvasElement;
};
type TestWindow = Window & { __tss?: GameForTest };

interface ShopOptions {
  language?: 'ru' | 'en';
  matchesPlayed?: number;
  mockAds?: boolean;
  mockAdOutcome?: 'fail';
  rotation?: Rotation;
  adDay?: AdDay;
  viewport?: { width: number; height: number };
}

function dailyOffersLabel(language: 'ru' | 'en'): string {
  return language === 'en' ? 'DAILY OFFERS' : 'ПРЕДЛОЖЕНИЯ ДНЯ';
}

function refreshLabel(language: 'ru' | 'en', state: 'available' | 'done' | 'unavailable'): string {
  const labels = {
    ru: {
      available: 'ОБНОВИТЬ ЗА РОЛИК',
      done: 'ОБНОВЛЕНО СЕГОДНЯ',
      unavailable: 'РОЛИК НЕДОСТУПЕН',
    },
    en: {
      available: 'REFRESH FOR AD',
      done: 'REFRESHED TODAY',
      unavailable: 'AD UNAVAILABLE',
    },
  };
  return labels[language][state];
}

async function seedBrowser(page: Page, options: ShopOptions): Promise<void> {
  await page.addInitScript((seed: {
    matchesPlayed: number;
    rotation?: Rotation;
    adDay?: AdDay;
  }) => {
    // The seed runs on every navigation; preserve state on deliberate reloads.
    if (localStorage.getItem('__r8_playwright_seeded') === '1') return;
    localStorage.clear();
    localStorage.setItem('__r8_playwright_seeded', '1');
    localStorage.setItem('tss-meta2', JSON.stringify({ matchesPlayed: seed.matchesPlayed }));
    if (seed.rotation) {
      localStorage.setItem('tss-shop-rotation-v1', JSON.stringify(seed.rotation));
    }
    if (seed.adDay) {
      localStorage.setItem('tss-ads-day', JSON.stringify(seed.adDay));
    }
  }, {
    matchesPlayed: options.matchesPlayed ?? 5,
    rotation: options.rotation,
    adDay: options.adDay,
  });
}

async function waitForGame(page: Page): Promise<void> {
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });
  await expect.poll(() => page.evaluate(() => {
    const game = (window as unknown as TestWindow).__tss;
    return Boolean(game && game.scene.isActive('Menu'));
  }), { timeout: startupTimeout }).toBe(true);
}

async function launchSkinsShop(page: Page): Promise<void> {
  await page.evaluate(() => {
    const game = (window as unknown as TestWindow).__tss;
    if (!game) throw new Error('Phaser game is not available');
    // Scene operations belong to ScenePlugin, available on a scene instance;
    // Phaser.Game.scene is only the global SceneManager.
    const menu = game.scene.getScene('Menu');
    menu.scene.launch('Shop', { tab: 'skins' });
  });
  await expect.poll(() => page.evaluate(() => {
    const game = (window as unknown as TestWindow).__tss;
    return Boolean(game && game.scene.isActive('Shop'));
  }), { timeout: startupTimeout }).toBe(true);
}

async function openShop(page: Page, options: ShopOptions = {}): Promise<void> {
  if (options.viewport) await page.setViewportSize(options.viewport);
  await seedBrowser(page, options);
  const language = options.language ?? 'ru';
  const query = new URLSearchParams({ lang: language });
  if (options.mockAds !== false) query.set('ysdk', 'mock');
  if (options.mockAdOutcome === 'fail') query.set('mockAd', 'fail');
  await page.goto(`/?${query.toString()}`);
  await waitForGame(page);
  await launchSkinsShop(page);
}

async function sceneObjects(page: Page): Promise<UiObject[]> {
  return page.evaluate(() => {
    const game = (window as unknown as TestWindow).__tss;
    if (!game || !game.scene.isActive('Shop')) return [];
    const scene = game.scene.getScene('Shop');
    if (!scene.sys) return [];
    const all: UiObject[] = [];
    const visit = (objects: UiObject[]): void => {
      for (const object of objects) {
        all.push(object);
        if (Array.isArray(object.list)) visit(object.list);
      }
    };
    visit(scene.sys.displayList.list);
    // Never return Phaser instances across the Playwright boundary: they keep
    // references to the Scene/Game and form circular structures.
    return all.map((object) => ({
      type: object.type,
      text: typeof object.text === 'string' ? object.text : undefined,
    }));
  });
}

async function sceneTexts(page: Page): Promise<string[]> {
  return (await sceneObjects(page))
    .filter((object) => object.type === 'Text' && typeof object.text === 'string')
    .map((object) => object.text as string);
}

async function clickSceneText(page: Page, label: string): Promise<void> {
  const point = await page.evaluate((target) => {
    const game = (window as unknown as TestWindow).__tss;
    if (!game || !game.scene.isActive('Shop')) return null;
    const scene = game.scene.getScene('Shop');
    if (!scene.sys) return null;
    const all: UiObject[] = [];
    const visit = (objects: UiObject[]): void => {
      for (const object of objects) {
        all.push(object);
        if (Array.isArray(object.list)) visit(object.list);
      }
    };
    visit(scene.sys.displayList.list);
    const text = all.find((object) => object.type === 'Text' && object.text === target);
    const bounds = text?.getBounds?.();
    if (!bounds) return null;

    // Use Phaser's own canvas element and calculate CSS-pixel coordinates
    // in the same page evaluation as the Phaser object lookup. This avoids a
    // detached/ambiguous "#game canvas" locator between the two operations.
    const canvas = game.canvas;
    if (!canvas.isConnected) throw new Error('Phaser canvas is detached from the document');
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      throw new Error('Phaser canvas has no visible layout bounds');
    }
    return {
      x: rect.left + (bounds.centerX / game.scale.width) * rect.width,
      y: rect.top + (bounds.centerY / game.scale.height) * rect.height,
    };
  }, label);

  expect(point, `Could not find visible Phaser text/button "${label}"`).not.toBeNull();
  if (!point) throw new Error(`Could not find Phaser text/button "${label}"`);
  await page.mouse.click(point.x, point.y);
}

async function readRotation(page: Page): Promise<Rotation | null> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as Rotation : null;
  }, shopStorageKey);
}

async function readAdDay(page: Page): Promise<AdDay | null> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as AdDay : null;
  }, adDayStorageKey);
}

async function browserToday(page: Page): Promise<string> {
  return page.evaluate(() => {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  });
}

async function eligibleSkinIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const moduleUrl = new URL('/src/game/meta.ts', window.location.origin).href;
    const meta = await import(/* @vite-ignore */ moduleUrl) as {
      SKINS: Array<{ id: string; price: number; kind: string }>;
    };
    return meta.SKINS
      .filter((skin) => skin.price > 0 && ['hero', 'building', 'trail'].includes(skin.kind))
      .map((skin) => skin.id);
  });
}

async function labelsForOffers(page: Page, ids: string[]): Promise<string[]> {
  return page.evaluate(async (offerIds) => {
    const metaUrl = new URL('/src/game/meta.ts', window.location.origin).href;
    const i18nUrl = new URL('/src/i18n/index.ts', window.location.origin).href;
    const [meta, i18n] = await Promise.all([
      import(/* @vite-ignore */ metaUrl) as Promise<{
        SKINS: Array<{ id: string; nameKey: string }>;
      }>,
      import(/* @vite-ignore */ i18nUrl) as Promise<{ t: (key: string) => string }>,
    ]);
    return offerIds.map((id) => {
      const skin = meta.SKINS.find((item) => item.id === id);
      if (!skin) throw new Error(`Unknown daily offer id: ${id}`);
      return `★ ${i18n.t(skin.nameKey)}`;
    });
  }, ids);
}


async function labelsForBanners(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const metaUrl = new URL('/src/game/meta.ts', window.location.origin).href;
    const i18nUrl = new URL('/src/i18n/index.ts', window.location.origin).href;
    const [meta, i18n] = await Promise.all([
      import(/* @vite-ignore */ metaUrl) as Promise<{
        BANNERS: Array<{ id: string; nameKey: string }>;
      }>,
      import(/* @vite-ignore */ i18nUrl) as Promise<{ t: (key: string) => string }>,
    ]);
    return meta.BANNERS.map((banner) => i18n.t(banner.nameKey));
  });
}

test('daily shop offers are valid, visible, marked in the catalogue, and paginated catalogue remains accessible', async ({ page }) => {
  await openShop(page);
  const rotation = await readRotation(page);
  expect(rotation).not.toBeNull();
  if (!rotation) throw new Error('Daily rotation was not persisted');

  expect(rotation.date).toBe(await browserToday(page));
  expect(rotation.refreshed).toBe(false);
  expect(rotation.ids).toHaveLength(3);
  expect(new Set(rotation.ids).size).toBe(3);

  const eligible = await eligibleSkinIds(page);
  expect(eligible.length).toBeGreaterThanOrEqual(6);
  for (const id of rotation.ids) expect(eligible).toContain(id);

  let texts = await sceneTexts(page);
  expect(texts).toContain(dailyOffersLabel('ru'));
  for (const label of await labelsForOffers(page, rotation.ids)) {
    expect(texts).toContain(label);
  }

  const heroSection = await page.evaluate(async () => {
    const url = new URL('/src/i18n/index.ts', window.location.origin).href;
    const i18n = await import(/* @vite-ignore */ url) as { t: (key: string) => string };
    return i18n.t('skins.hero').toUpperCase();
  });
  expect(texts).toContain(heroSection);

  const firstPage = texts.find((text) => /^\d+\s*\/\s*\d+$/.test(text));
  expect(firstPage).toMatch(/^1\s*\/\s*\d+$/);
  const totalPages = Number(firstPage?.split('/')[1]?.trim());
  expect(totalPages).toBeGreaterThan(1);

  const offersMarkedInCatalogue = new Set<string>();
  const bannersVisibleInCatalogue = new Set<string>();
  const offerLabels = await labelsForOffers(page, rotation.ids);
  const bannerLabels = await labelsForBanners(page);
  for (let currentPage = 1; currentPage <= totalPages; currentPage++) {
    texts = await sceneTexts(page);
    for (const label of offerLabels) {
      if (texts.filter((text) => text === label).length >= 2) {
        offersMarkedInCatalogue.add(label);
      }
    }
    for (const label of bannerLabels) {
      if (texts.includes(label)) bannersVisibleInCatalogue.add(label);
    }
    if (currentPage < totalPages) {
      await clickSceneText(page, '›');
      await expect.poll(async () => (
        (await sceneTexts(page)).find((text) => /^\d+\s*\/\s*\d+$/.test(text)) ?? ''
      )).toBe(String(currentPage + 1) + ' / ' + String(totalPages));
    }
  }
  expect([...offersMarkedInCatalogue]).toEqual(expect.arrayContaining(offerLabels));
  expect([...bannersVisibleInCatalogue]).toEqual(expect.arrayContaining(bannerLabels));
  texts = await sceneTexts(page);
  expect(texts).toContain(dailyOffersLabel('ru'));
});

test('daily offers and refresh state persist after reload', async ({ page }) => {
  await openShop(page, { language: 'en' });
  const first = await readRotation(page);
  expect(first).not.toBeNull();
  if (!first) throw new Error('Daily rotation was not persisted');

  await expect.poll(async () => sceneTexts(page)).toContain('DAILY OFFERS');
  await page.reload();
  await waitForGame(page);
  await launchSkinsShop(page);

  expect(await readRotation(page)).toEqual(first);
  expect(await sceneTexts(page)).toContain('DAILY OFFERS');
  expect(await sceneTexts(page)).toContain(refreshLabel('en', 'available'));
});

test('a completed rewarded ad refreshes offers once and persists the daily limit', async ({ page }) => {
  const analytics: string[] = [];
  page.on('console', (message) => analytics.push(message.text()));
  await openShop(page);

  const before = await readRotation(page);
  expect(before).not.toBeNull();
  if (!before) throw new Error('Daily rotation was not persisted');

  await clickSceneText(page, refreshLabel('ru', 'available'));
  await expect.poll(async () => (await readRotation(page))?.refreshed ?? false).toBe(true);

  const after = await readRotation(page);
  expect(after).not.toBeNull();
  if (!after) throw new Error('Refreshed rotation was not persisted');
  expect(after.date).toBe(before.date);
  expect(after.ids).toHaveLength(3);
  expect(new Set(after.ids).size).toBe(3);
  expect(after.ids.some((id) => before.ids.includes(id))).toBe(false);

  const adDay = await readAdDay(page);
  expect(adDay?.date).toBe(before.date);
  expect(adDay?.used['shop-refresh']).toBe(1);
  await expect.poll(async () => sceneTexts(page)).toContain(refreshLabel('ru', 'done'));
  expect(analytics.some((line) => line.includes('shop_refreshed'))).toBe(true);

  await clickSceneText(page, refreshLabel('ru', 'done'));
  expect(await readRotation(page)).toEqual(after);
  expect((await readAdDay(page))?.used['shop-refresh']).toBe(1);

  await page.reload();
  await waitForGame(page);
  await launchSkinsShop(page);
  expect(await readRotation(page)).toEqual(after);
  expect((await readAdDay(page))?.used['shop-refresh']).toBe(1);
  expect(await sceneTexts(page)).toContain(refreshLabel('ru', 'done'));
});

test('an incomplete rewarded ad does not change offers or consume the daily limit', async ({ page }) => {
  const analytics: string[] = [];
  page.on('console', (message) => analytics.push(message.text()));
  await openShop(page, { mockAdOutcome: 'fail' });

  const before = await readRotation(page);
  expect(before).not.toBeNull();
  if (!before) throw new Error('Daily rotation was not persisted');

  await clickSceneText(page, refreshLabel('ru', 'available'));
  await page.waitForTimeout(150);
  expect(await readRotation(page)).toEqual(before);
  expect(await readAdDay(page)).toBeNull();
  expect(await sceneTexts(page)).toContain(refreshLabel('ru', 'available'));
  expect(analytics.some((line) => line.includes('shop_refreshed'))).toBe(false);
});

test('daily refresh is unavailable outside the platform and does not mutate the rotation', async ({ page }) => {
  await openShop(page, { mockAds: false });
  const before = await readRotation(page);
  expect(before).not.toBeNull();

  await expect.poll(async () => sceneTexts(page)).toContain(refreshLabel('ru', 'unavailable'));
  await clickSceneText(page, refreshLabel('ru', 'unavailable'));
  expect(await readRotation(page)).toEqual(before);
  expect(await readAdDay(page)).toBeNull();
});

test('expired rotation rolls over to today and resets the refresh flag', async ({ page }) => {
  await openShop(page, {
    language: 'en',
    rotation: {
      date: '2000-01-01',
      ids: ['skin_hero_warrior_red', 'skin_hero_archer_red', 'skin_hero_lancer_red'],
      refreshed: true,
    },
  });

  const rotation = await readRotation(page);
  expect(rotation).not.toBeNull();
  if (!rotation) throw new Error('Daily rotation was not recreated');
  expect(rotation.date).toBe(await browserToday(page));
  expect(rotation.refreshed).toBe(false);
  expect(rotation.ids).toHaveLength(3);
  expect(new Set(rotation.ids).size).toBe(3);
  expect(await sceneTexts(page)).toContain(refreshLabel('en', 'available'));
});

test('daily shop is hidden before the fifth match while the skin catalogue remains available', async ({ page }) => {
  await openShop(page, { matchesPlayed: 4 });

  expect(await readRotation(page)).toBeNull();
  const texts = await sceneTexts(page);
  expect(texts).not.toContain(dailyOffersLabel('ru'));

  const heroSection = await page.evaluate(async () => {
    const url = new URL('/src/i18n/index.ts', window.location.origin).href;
    const i18n = await import(/* @vite-ignore */ url) as { t: (key: string) => string };
    return i18n.t('skins.hero').toUpperCase();
  });
  expect(texts).toContain(heroSection);
});

test('daily offers render correctly in the compact landscape layout', async ({ page }) => {
  await openShop(page, { viewport: { width: 844, height: 390 } });

  const texts = await sceneTexts(page);
  expect(texts).toContain(dailyOffersLabel('ru'));
  expect(texts).toContain(refreshLabel('ru', 'available'));

  const rotation = await readRotation(page);
  expect(rotation?.ids).toHaveLength(3);
  const labels = await labelsForOffers(page, rotation?.ids ?? []);
  expect(texts.some((text) => labels.every((label) => text.includes(label.replace(/^★ /, ''))))).toBe(true);
});
