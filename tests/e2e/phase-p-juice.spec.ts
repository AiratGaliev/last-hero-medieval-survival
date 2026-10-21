import { expect, test } from '@playwright/test';

const startupTimeout = 60_000;

test('phase P: low-quality profile suppresses shakes and ordinary time effects', async ({ page }) => {
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });

  const result = await page.evaluate(async () => {
    const url = new URL('/src/game/systems/Juice.ts', location.origin).href;
    const juice = await import(/* @vite-ignore */ url) as {
      detectQualityLevel: (
        userAgent?: string,
        maxTouchPoints?: number,
        prefersReducedMotion?: boolean,
      ) => 'low' | 'high';
      JuicePolicy: new (qualityLevel?: 'low' | 'high', timeEffectCooldownMs?: number) => {
        qualityLevel: 'low' | 'high';
        canShake(): boolean;
        allowTimeEffect(activeTimeMs: number, essential?: boolean): boolean;
        resetBudget(): void;
      };
    };

    const mobileQuality = juice.detectQualityLevel(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
      5,
      false,
    );
    const reducedMotionQuality = juice.detectQualityLevel(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
      0,
      true,
    );

    const high = new juice.JuicePolicy('high');
    const highQuality = high.qualityLevel;
    const highCanShake = high.canShake();
    const budget = [
      high.allowTimeEffect(0),
      high.allowTimeEffect(2_999),
      high.allowTimeEffect(3_000),
      high.allowTimeEffect(3_500, true),
      high.allowTimeEffect(5_000),
      high.allowTimeEffect(6_500),
    ];

    const low = new juice.JuicePolicy('low');
    const lowCanShake = low.canShake();
    const lowNormalEffect = low.allowTimeEffect(0);
    const lowEssentialEffect = low.allowTimeEffect(0, true);
    const lowNormalAfterEssential = low.allowTimeEffect(1_000);
    low.resetBudget();
    const lowEssentialAfterReset = low.allowTimeEffect(1_000, true);

    return {
      mobileQuality, reducedMotionQuality,
      highQuality, highCanShake, budget,
      lowCanShake, lowNormalEffect, lowEssentialEffect,
      lowNormalAfterEssential, lowEssentialAfterReset,
    };
  });

  expect(result.mobileQuality).toBe('low');
  expect(result.reducedMotionQuality).toBe('low');
  expect(result.highQuality).toBe('high');
  expect(result.highCanShake).toBe(true);
  expect(result.budget).toEqual([true, false, true, true, false, true]);
  expect(result.lowCanShake).toBe(false);
  expect(result.lowNormalEffect).toBe(false);
  expect(result.lowEssentialEffect).toBe(true);
  expect(result.lowNormalAfterEssential).toBe(false);
  expect(result.lowEssentialAfterReset).toBe(true);
});



test('phase P: progressive disclosure reads thresholds from one gate table', async ({ page }) => {
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });

  const result = await page.evaluate(async () => {
    const dataUrl = new URL('/src/game/data.ts', location.origin).href;
    const metaUrl = new URL('/src/game/meta.ts', location.origin).href;
    const data = await import(/* @vite-ignore */ dataUrl) as {
      FTUE_MATCH_GATE: Record<string, number>;
    };
    const meta = await import(/* @vite-ignore */ metaUrl) as {
      DAILY_BONUS_AFTER_MATCHES: number;
      CHALLENGE_AFTER_MATCHES: number;
      CONTRACTS_AFTER_MATCHES: number;
      CODEX_AFTER_MATCHES: number;
      TREE_AFTER_MATCH: number;
      STOREFRONT_AFTER_MATCH: number;
      UKAZ_AFTER_MATCH: number;
    };
    return {
      gates: data.FTUE_MATCH_GATE,
      derived: [
        meta.DAILY_BONUS_AFTER_MATCHES,
        meta.CHALLENGE_AFTER_MATCHES,
        meta.CONTRACTS_AFTER_MATCHES,
        meta.CODEX_AFTER_MATCHES,
        meta.TREE_AFTER_MATCH,
        meta.STOREFRONT_AFTER_MATCH,
        meta.UKAZ_AFTER_MATCH,
      ],
    };
  });

  expect(result.gates).toEqual({
    howTo: 1,
    shop: 1,
    chronicle: 1,
    meta: 2,
    dailyBonus: 2,
    dailyChest: 2,
    challenge: 3,
    valleyChronicle: 3,
    contracts: 4,
    codex: 5,
    storefront: 5,
    seasonPass: 5,
    kingOrders: 10,
  });
  expect(result.derived).toEqual([2, 3, 4, 5, 3, 5, 10]);
});

test('phase P: the first tutorial overlay auto-resumes after three seconds', async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('tss-hints'));
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });

  await page.evaluate(() => {
    const game = (window as unknown as {
      __tss?: { scene: { getScene(key: string): unknown } };
    }).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const menu = game.scene.getScene('Menu') as {
      selectedDiff?: string;
      scene: { start(key: string, data?: unknown): void };
    };
    menu.scene.start('Game', { hero: 'warrior', diff: menu.selectedDiff ?? 'normal' });
  });

  const overlayPaused = () => page.evaluate(() => {
    const game = (window as unknown as {
      __tss?: { scene: { getScene(key: string): unknown } };
    }).__tss;
    if (!game) return false;
    return (game.scene.getScene('Game') as { hintOverlayPaused?: boolean }).hintOverlayPaused === true;
  });

  await expect.poll(overlayPaused, { timeout: startupTimeout }).toBe(true);
  await expect.poll(overlayPaused, { timeout: 6_000 }).toBe(false);

  const activeTime = await page.evaluate(() => {
    const game = (window as unknown as {
      __tss?: { scene: { getScene(key: string): unknown } };
    }).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    return (game.scene.getScene('Game') as { activeTimeMs: number }).activeTimeMs;
  });
  expect(activeTime).toBeGreaterThan(0);
});

test('phase P: anchor arrows stay attached to banner edges and inside the viewport', async ({ page }) => {
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });

  const geometry = await page.evaluate(async () => {
    const url = new URL('/src/game/systems/Hints.ts', location.origin).href;
    const hints = await import(/* @vite-ignore */ url) as {
      HINTS: readonly { id: string; ui: 'banner' | 'overlay'; urgent?: boolean; ttl: number }[];
      hintsStorageKeyForScope: (scope: string | null) => string;
      getHintArrowGeometry: (
        panel: { x: number; y: number; width: number; height: number },
        target: { x: number; y: number },
        viewport: { width: number; height: number },
      ) => {
        startX: number; startY: number; targetX: number; targetY: number;
        leftX: number; leftY: number; rightX: number; rightY: number;
      } | null;
    };
    const panel = { x: 200, y: 90, width: 180, height: 50 };
    const siegeHint = hints.HINTS.find((hint) => hint.id === 'siege');
    const moveHint = hints.HINTS.find((hint) => hint.id === 'move');
    const monasteryBuiltHint = hints.HINTS.find((hint) => hint.id === 'monasteryBuilt');
    const monasteryLossHint = hints.HINTS.find((hint) => hint.id === 'monasteryLoss');
    const overlayHints = hints.HINTS.filter((hint) => hint.ui === 'overlay').map((hint) => hint.id);
    return {
      outward: hints.getHintArrowGeometry(panel, { x: -100, y: 450 }, { width: 400, height: 300 }),
      inside: hints.getHintArrowGeometry(panel, { x: 200, y: 100 }, { width: 400, height: 300 }),
      siegeUi: siegeHint?.ui,
      siegeUrgent: siegeHint?.urgent,
      moveTtl: moveHint?.ttl,
      siegeTtl: siegeHint?.ttl,
      accountAKey: hints.hintsStorageKeyForScope('profile-A'),
      accountBKey: hints.hintsStorageKeyForScope('profile-B'),
      guestKey: hints.hintsStorageKeyForScope(null),
      monasteryBuiltUi: monasteryBuiltHint?.ui,
      monasteryLossUi: monasteryLossHint?.ui,
      overlayHints,
    };
  });

  expect(geometry.siegeUi).toBe('overlay');
  expect(geometry.siegeUrgent).toBe(true);
  expect(geometry.moveTtl).toBe(3_000);
  expect(geometry.siegeTtl).toBe(2_000);
  expect(geometry.accountAKey).toBe('hints@profile-A');
  expect(geometry.accountBKey).toBe('hints@profile-B');
  expect(geometry.accountAKey).not.toBe(geometry.accountBKey);
  expect(geometry.guestKey).toBe('hints');
  expect(geometry.monasteryBuiltUi).toBe('banner');
  expect(geometry.monasteryLossUi).toBe('banner');
  expect(geometry.overlayHints).toEqual(['move', 'siege']);
  expect(geometry.outward).not.toBeNull();
  expect(geometry.outward?.targetX).toBe(10);
  expect(geometry.outward?.targetY).toBe(290);
  expect(geometry.outward?.startY).toBeCloseTo(123, 0);
  for (const coordinate of [
    geometry.outward?.startX, geometry.outward?.startY,
    geometry.outward?.targetX, geometry.outward?.targetY,
    geometry.outward?.leftX, geometry.outward?.leftY,
    geometry.outward?.rightX, geometry.outward?.rightY,
  ]) {
    expect(Number.isFinite(coordinate)).toBe(true);
  }
  expect(geometry.inside).toBeNull();
});


test('phase P: the pause menu can disable and re-enable FTUE hints', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.removeItem('tss-hints');
  });
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });

  await page.evaluate(() => {
    const game = (window as unknown as { __tss?: {
      scene: {
        getScene(key: string): unknown;
        start(key: string, data?: unknown): void;
      };
    } }).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const menu = game.scene.getScene('Menu') as {
      selectedDiff?: string;
      scene: { start(key: string, data?: unknown): void };
    };
    menu.scene.start('Game', { hero: 'warrior', diff: menu.selectedDiff ?? 'normal' });
  });

  await expect.poll(
    () => page.evaluate(() => (window as unknown as { __tss?: { scene: { isActive(key: string): boolean } } }).__tss?.scene.isActive('Game') ?? false),
    { timeout: startupTimeout },
  ).toBe(true);

  const canvas = page.locator('#game canvas');
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('Phaser canvas has no layout bounds');
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await expect.poll(
    () => page.evaluate(() => {
      const game = (window as unknown as { __tss?: { scene: { getScene(key: string): unknown; isActive(key: string): boolean } } }).__tss;
      if (!game?.scene.isActive('Game')) return false;
      return !(game.scene.getScene('Game') as { overlayOpen: boolean }).overlayOpen;
    }),
    { timeout: 10_000 },
  ).toBe(true);

  await page.evaluate(() => {
    const game = (window as unknown as { __tss?: { scene: { getScene(key: string): unknown; isActive(key: string): boolean } } }).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const scene = game.scene.getScene('Game') as { openPause(): void };
    scene.openPause();
  });
  await expect.poll(
    () => page.evaluate(() => (window as unknown as { __tss?: { scene: { isActive(key: string): boolean } } }).__tss?.scene.isActive('Pause') ?? false),
    { timeout: 5_000 },
  ).toBe(true);

  const getToggle = () => page.evaluate(() => {
    const game = (window as unknown as { __tss?: { scene: { getScene(key: string): unknown } } }).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const pause = game.scene.getScene('Pause') as {
      hintsBtn: {
        txt: { text: string };
        hit: { x: number; y: number };
      };
    };
    const scene = game.scene.getScene('Pause') as {
      scale: { width: number; height: number };
    };
    return {
      label: pause.hintsBtn.txt.text,
      x: pause.hintsBtn.hit.x,
      y: pause.hintsBtn.hit.y,
      width: scene.scale.width,
      height: scene.scale.height,
      enabled: JSON.parse(localStorage.getItem('tss-hints') ?? '{}').enabled,
    };
  });

  const before = await getToggle();
  expect(before.label).toBe('TUTORIAL: ON');
  expect(before.enabled).toBe(true);

  await page.mouse.click(
    bounds.x + before.x * bounds.width / before.width,
    bounds.y + before.y * bounds.height / before.height,
  );
  await expect.poll(async () => (await getToggle()).label).toBe('TUTORIAL: OFF');
  expect((await getToggle()).enabled).toBe(false);

  const afterDisable = await getToggle();
  await page.mouse.click(
    bounds.x + afterDisable.x * bounds.width / afterDisable.width,
    bounds.y + afterDisable.y * bounds.height / afterDisable.height,
  );
  await expect.poll(async () => (await getToggle()).label).toBe('TUTORIAL: ON');
  expect((await getToggle()).enabled).toBe(true);
});


test('phase P: slow-motion restores Phaser time scales and siege warning arms the red vignette', async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('tss-hints'));
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });

  await page.evaluate(() => {
    const game = (window as unknown as { __tss?: { scene: { getScene(key: string): unknown } } }).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const menu = game.scene.getScene('Menu') as {
      selectedDiff?: string;
      scene: { start(key: string, data?: unknown): void };
    };
    menu.scene.start('Game', { hero: 'warrior', diff: menu.selectedDiff ?? 'normal' });
  });
  await expect.poll(
    () => page.evaluate(() => (window as unknown as { __tss?: { scene: { isActive(key: string): boolean } } }).__tss?.scene.isActive('Game') ?? false),
    { timeout: startupTimeout },
  ).toBe(true);

  const canvas = page.locator('#game canvas');
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('Phaser canvas has no layout bounds');
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await expect.poll(
    () => page.evaluate(() => {
      const game = (window as unknown as { __tss?: { scene: { getScene(key: string): unknown; isActive(key: string): boolean } } }).__tss;
      if (!game?.scene.isActive('Game')) return false;
      const scene = game.scene.getScene('Game') as { hintOverlayPaused: boolean };
      return !scene.hintOverlayPaused;
    }),
    { timeout: 10_000 },
  ).toBe(true);

  const before = await page.evaluate(() => {
    const game = (window as unknown as { __tss?: { scene: { getScene(key: string): unknown } } }).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const scene = game.scene.getScene('Game') as {
      physics: { world: { timeScale: number } };
      time: { timeScale: number; now: number };
      tweens: { timeScale: number };
      activeTimeMs: number;
      hud: { showSiegeVignette(durationMs?: number): void; siegeVignetteUntil: number };
      applyJuiceSlowMotion(durationMs: number, factor: number): void;
    };
    const scales = {
      physics: scene.physics.world.timeScale,
      clock: scene.time.timeScale,
      tweens: scene.tweens.timeScale,
    };
    scene.hud.showSiegeVignette(2_000);
    const vignetteUntil = scene.hud.siegeVignetteUntil;
    scene.applyJuiceSlowMotion(300, 0.5);
    return {
      scales,
      changed: {
        physics: scene.physics.world.timeScale,
        clock: scene.time.timeScale,
        tweens: scene.tweens.timeScale,
      },
      factor: (scene as unknown as { juiceSlowFactor: number }).juiceSlowFactor,
      activeTimeMs: scene.activeTimeMs,
      vignetteUntil,
      sceneNow: scene.time.now,
    };
  });

  expect(before.vignetteUntil).toBeGreaterThan(before.sceneNow);
  expect(before.factor).toBe(0.5);
  expect(before.changed.physics).toBeCloseTo(before.scales.physics / 0.5, 4);
  expect(before.changed.clock).toBeCloseTo(before.scales.clock * 0.5, 4);
  expect(before.changed.tweens).toBeCloseTo(before.scales.tweens * 0.5, 4);

  await page.waitForTimeout(100);
  const stillSlowed = await page.evaluate(() => {
    const game = (window as unknown as { __tss?: { scene: { getScene(key: string): unknown } } }).__tss;
    if (!game) return null;
    return (game.scene.getScene('Game') as { juiceSlowFactor: number }).juiceSlowFactor;
  });
  expect(stillSlowed).toBe(0.5);

  await expect.poll(
    () => page.evaluate(() => {
      const game = (window as unknown as { __tss?: { scene: { getScene(key: string): unknown } } }).__tss;
      if (!game) return null;
      const scene = game.scene.getScene('Game') as {
        physics: { world: { timeScale: number } };
        time: { timeScale: number };
        tweens: { timeScale: number };
        juiceSlowFactor: number;
      };
      return {
        physics: scene.physics.world.timeScale,
        clock: scene.time.timeScale,
        tweens: scene.tweens.timeScale,
        factor: scene.juiceSlowFactor,
      };
    }),
    { timeout: 3_000 },
  ).toEqual({
    physics: before.scales.physics,
    clock: before.scales.clock,
    tweens: before.scales.tweens,
    factor: 1,
  });
});


test('phase P: victory announcement reveals letters and completes the full localized text', async ({ page }) => {
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });

  await page.evaluate(() => {
    const game = (window as unknown as { __tss?: { scene: { getScene(key: string): unknown } } }).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const menu = game.scene.getScene('Menu') as {
      selectedDiff?: string;
      scene: { start(key: string, data?: unknown): void };
    };
    menu.scene.start('Game', { hero: 'warrior', diff: menu.selectedDiff ?? 'normal' });
  });
  await expect.poll(
    () => page.evaluate(() => (window as unknown as { __tss?: { scene: { isActive(key: string): boolean } } }).__tss?.scene.isActive('Game') ?? false),
    { timeout: startupTimeout },
  ).toBe(true);

  const canvas = page.locator('#game canvas');
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('Phaser canvas has no layout bounds');
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await expect.poll(
    () => page.evaluate(() => {
      const game = (window as unknown as { __tss?: { scene: { getScene(key: string): unknown; isActive(key: string): boolean } } }).__tss;
      if (!game?.scene.isActive('Game')) return false;
      return !(game.scene.getScene('Game') as { hintOverlayPaused: boolean }).hintOverlayPaused;
    }),
    { timeout: 10_000 },
  ).toBe(true);

  await page.evaluate(() => {
    const game = (window as unknown as { __tss?: { scene: { getScene(key: string): unknown } } }).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const scene = game.scene.getScene('Game') as {
      hud: {
        announceText: { text: string };
        announceTypewriter(text: string, color: string, intervalMs: number): void;
      };
    };
    scene.hud.announceTypewriter('VICTORY', '#ffd700', 60);
  });

  const visibleText = () => page.evaluate(() => {
    const game = (window as unknown as { __tss?: { scene: { getScene(key: string): unknown } } }).__tss;
    if (!game) return '';
    return (game.scene.getScene('Game') as { hud: { announceText: { text: string } } }).hud.announceText.text;
  });
  await page.waitForTimeout(100);
  const partial = await visibleText();
  expect(partial.length).toBeGreaterThan(0);
  expect(partial.length).toBeLessThan('VICTORY'.length);

  await expect.poll(visibleText, { timeout: 1_000 }).toBe('VICTORY');
});


test('phase P: first end screen teaches the chronicle once and persists the marker', async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('tss-hints'));
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });

  await page.evaluate(() => {
    const game = (window as unknown as { __tss?: {
      scene: { getScene(key: string): unknown; isActive(key: string): boolean };
    } }).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const menu = game.scene.getScene('Menu') as {
      selectedDiff?: string;
      scene: { start(key: string, data?: unknown): void };
    };
    menu.scene.start('Game', { hero: 'warrior', diff: menu.selectedDiff ?? 'normal' });
  });

  await expect.poll(
    () => page.evaluate(() =>
      (window as unknown as { __tss?: { scene: { isActive(key: string): boolean } } }).__tss?.scene.isActive('Game') ?? false,
    ),
    { timeout: startupTimeout },
  ).toBe(true);

  // Завершаем живой ран штатным путём: GameScene сама передаёт tutorial flag
  // в GameOverScene, а callback должен записать marker через Hints/Player Data.
  await page.evaluate(() => {
    const game = (window as unknown as { __tss?: { scene: { getScene(key: string): unknown } } }).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    (game.scene.getScene('Game') as { gameOver(victory: boolean): void }).gameOver(false);
  });

  await expect.poll(
    () => page.evaluate(() =>
      (window as unknown as { __tss?: { scene: { isActive(key: string): boolean } } }).__tss?.scene.isActive('GameOver') ?? false,
    ),
    { timeout: 10_000 },
  ).toBe(true);

  const result = await page.evaluate(() => {
    const game = (window as unknown as { __tss?: { scene: { getScene(key: string): unknown } } }).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const scene = game.scene.getScene('GameOver') as {
      payload: { showChronicleTutorial?: boolean };
      children: { list: unknown[] };
    };
    const collectTexts = (objects: unknown[]): string[] => objects.flatMap((item) => {
      const object = item as { type?: string; text?: string; list?: unknown[] };
      const own = object.type === 'Text' && typeof object.text === 'string' ? [object.text] : [];
      return own.concat(Array.isArray(object.list) ? collectTexts(object.list) : []);
    });
    const state = JSON.parse(localStorage.getItem('tss-hints') ?? '{}') as {
      markers?: string[];
    };
    const texts = collectTexts(scene.children.list);
    return {
      markerSaved: state.markers?.includes('chronicle') ?? false,
      tutorialTextVisible: texts.some((text) =>
        text.includes("This is your settlement's story. Every run tells a new one."),
      ),
      tutorialConsumed: scene.payload.showChronicleTutorial === false,
    };
  });

  expect(result.markerSaved).toBe(true);
  expect(result.tutorialTextVisible).toBe(true);
  expect(result.tutorialConsumed).toBe(true);
});
