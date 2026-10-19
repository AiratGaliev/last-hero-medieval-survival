import { expect, test, type Page } from '@playwright/test';

type Point = { x: number; y: number };
type Bounds = { x: number; y: number; width: number; height: number };
type PawnRuntime = {
  kind: string;
  x: number;
  y: number;
  state: string;
  order: string | null;
  orderTarget: { x: number; y: number } | null;
  carrying: string | null;
  carriedAmount: number;
  cooldown: number;
  arrivalMs: number;
  workNode: unknown;
  setPosition(x: number, y: number): unknown;
  setVelocity(x: number, y: number): unknown;
  body: { velocity: { x: number; y: number } };
};
type BuildSpot = { kind: string; x: number; y: number };
type EconomyRuntime = {
  pawns: PawnRuntime[];
  resources: { wood: number; ore: number; meat: number };
  castleX: number;
  castleY: number;
  buildJobs: Array<{ pawn: PawnRuntime; spot: BuildSpot }>;
  freeSpots(): BuildSpot[];
  pawnAI: {
    updateCivilian(pawn: PawnRuntime, dtMs: number, now: number): void;
    enemyNear(x: number, y: number, radius: number): boolean;
  };
  deposit(kind: 'wood' | 'meat' | 'ore', amount: number): void;
  tick(dtMs: number, now: number): void;
  emit(event: string, ...args: unknown[]): boolean;
};
type OrderEntry = { key: string; label: string; disabled?: boolean };
type HUDRuntime = {
  resGroup: { visible: boolean; getBounds(): Bounds };
  resLabels: Record<string, { text: string }>;
  resTexts: Record<string, { text: string }>;
  goldText: { getBounds(): Bounds };
  weaponIcons: { values(): Iterable<{ getBounds(): Bounds }> };
};
type GameSceneRuntime = {
  economy: EconomyRuntime;
  hud: HUDRuntime;
  orderMenu: {
    isOpen: boolean;
    ringing: boolean;
    openPawn: PawnRuntime | null;
    entriesFor(pawn: PawnRuntime): OrderEntry[];
  };
  ordersUnlocked(): boolean;
  time: { now: number };
  scale: { width: number; height: number };
  textures: { exists(key: string): boolean };
  cameras: { main: {
    x: number; y: number; zoom: number;
    worldView: { x: number; y: number; width: number; height: number };
    stopFollow(): unknown;
    centerOn(x: number, y: number): unknown;
    preRender(): unknown;
    getWorldPoint(x: number, y: number): { x: number; y: number };
  } };
  player: { x: number; y: number };
  hintOverlayPaused: boolean;
};
type PhaserRuntime = { scene: { getScene(key: string): unknown; isActive(key: string): boolean } };
type RuntimeWindow = Window & { __tss?: PhaserRuntime };

const startupTimeout = 30_000;

async function startRun(page: Page, width = 1280, height = 720): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });
  await expect.poll(
    () => page.evaluate(() => (window as RuntimeWindow).__tss?.scene.isActive('Menu') ?? false),
    { timeout: startupTimeout },
  ).toBe(true);
  await page.evaluate(() => {
    localStorage.removeItem('tss-meta2');
    localStorage.removeItem('tss-hints');
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const menu = game.scene.getScene('Menu') as {
      selectedHero?: string;
      selectedDiff?: string;
      scene: { start(key: string, data: { hero: string; diff: string }): void };
    };
    menu.scene.start('Game', { hero: menu.selectedHero ?? 'warrior', diff: menu.selectedDiff ?? 'normal' });
  });
  await expect.poll(
    () => page.evaluate(() => (window as RuntimeWindow).__tss?.scene.isActive('Game') ?? false),
    { timeout: startupTimeout },
  ).toBe(true);
  const bounds = await page.locator('#game canvas').boundingBox();
  if (!bounds) throw new Error('Game canvas has no layout bounds');
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await expect.poll(() => page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game?.scene.isActive('Game')) return true;
    return !(game.scene.getScene('Game') as GameSceneRuntime).hintOverlayPaused;
  }), { timeout: 10_000 }).toBe(true);

  // Камера следует за героем с lerp; дождаться её фактической стабилизации,
  // прежде чем считать экранные координаты NPC для последующих кликов/touch.
  await expect.poll(() => page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game?.scene.isActive('Game')) return false;
    const scene = game.scene.getScene('Game') as GameSceneRuntime;
    const view = scene.cameras.main.worldView;
    return Math.abs(view.x + view.width / 2 - scene.player.x) < 8
      && Math.abs(view.y + view.height / 2 - scene.player.y) < 8;
  }), { timeout: 10_000 }).toBe(true);
}

async function preparePawn(page: Page): Promise<Point> {
  return page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const scene = game.scene.getScene('Game') as GameSceneRuntime;
    scene.ordersUnlocked = () => true;
    const pawn = scene.economy.pawns.find(p => p.kind === 'collector');
    if (!pawn) throw new Error('No collector pawn in the initial settlement');
    pawn.order = null;
    pawn.orderTarget = null;
    pawn.carrying = null;
    pawn.carriedAmount = 0;
    pawn.workNode = null;
    pawn.arrivalMs = 0;
    pawn.state = 'idle';
    pawn.cooldown = 30;
    pawn.setVelocity(0, 0);
    pawn.setPosition(scene.economy.castleX + 220, scene.economy.castleY + 240);

    // Центрируем камеру на изолированной пешке через Phaser API. Клик в центр
    // canvas не зависит от ручного преобразования world→screen в тестовом коде.
    const camera = scene.cameras.main;
    camera.stopFollow();
    camera.centerOn(pawn.x, pawn.y);
    camera.preRender();

    const canvas = document.querySelector('#game canvas');
    if (!canvas) throw new Error('Game canvas is missing');
    const rect = canvas.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
}

test('phase G: desktop menu is explicit, closable and BUILD order ends after construction', async ({ page }) => {
  await startRun(page);
  const point = await preparePawn(page);
  const isOpen = () => page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss!;
    return (game.scene.getScene('Game') as GameSceneRuntime).orderMenu.isOpen;
  });

  // Обычное удержание мыши не должно запускать long-press.
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.waitForTimeout(650);
  expect(await isOpen()).toBe(false);
  await page.mouse.up();

  await page.mouse.click(point.x, point.y, { modifiers: ['Shift'] });
  await expect.poll(isOpen).toBe(true);
  const entries = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss!;
    const scene = game.scene.getScene('Game') as GameSceneRuntime;
    const pawn = scene.economy.pawns.find(p => p.kind === 'collector')!;
    return scene.orderMenu.entriesFor(pawn).map(e => ({ key: e.key, disabled: e.disabled === true }));
  });
  expect(entries).toEqual([
    { key: 'collect', disabled: false },
    { key: 'build', disabled: false },
    { key: 'repair', disabled: true },
    { key: 'rest', disabled: true },
  ]);

  // Нижняя кнопка «ЧИНИТЬ» имеет центр в 74 CSS px от пешки.
  const disabledPoint = { x: point.x, y: point.y + 74 };
  await page.mouse.click(disabledPoint.x, disabledPoint.y);
  await expect.poll(isOpen).toBe(true);

  await page.mouse.click(point.x, point.y, { modifiers: ['Shift'] });
  await expect.poll(isOpen).toBe(false);
  await page.mouse.click(point.x, point.y, { modifiers: ['Shift'] });
  await expect.poll(isOpen).toBe(true);
  await page.keyboard.press('Escape');
  await expect.poll(isOpen).toBe(false);
  expect(await page.evaluate(() => (window as RuntimeWindow).__tss!.scene.isActive('Pause'))).toBe(false);

  await page.mouse.click(point.x, point.y, { modifiers: ['Shift'] });
  // Кнопка «СТРОИТЬ» расположена справа от центра меню на 74 CSS px.
  const buildPoint = { x: point.x + 74, y: point.y };
  await page.mouse.click(buildPoint.x, buildPoint.y);
  await expect.poll(() => page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss!;
    const scene = game.scene.getScene('Game') as GameSceneRuntime;
    return scene.economy.pawns.find(p => p.kind === 'collector')?.order ?? null;
  })).toBe('build');

  const result = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss!;
    const scene = game.scene.getScene('Game') as GameSceneRuntime;
    const economy = scene.economy;
    const pawn = economy.pawns.find(p => p.kind === 'collector')!;
    const ai = economy.pawnAI;
    ai.enemyNear = () => false;
    economy.resources.wood = 1_000;
    economy.resources.ore = 1_000;
    economy.resources.meat = 1_000;
    pawn.cooldown = 0;
    pawn.carrying = null;
    pawn.carriedAmount = 0;
    pawn.workNode = null;
    pawn.setPosition(economy.castleX, economy.castleY);
    pawn.state = 'idle';
    const freeSpots = economy.freeSpots();
    if (freeSpots.length === 0) throw new Error('No build spots remain for BUILD-order regression');
    const nearest = freeSpots.reduce((best, item) =>
      Math.hypot(item.x - pawn.x, item.y - pawn.y) < Math.hypot(best.x - pawn.x, best.y - pawn.y) ? item : best,
    );
    ai.updateCivilian(pawn, 16, scene.time.now + 16);
    const walksToNearest = pawn.state === 'walk'
      && pawn.body.velocity.x * (nearest.x - pawn.x) + pawn.body.velocity.y * (nearest.y - pawn.y) > 0;
    pawn.setPosition(nearest.x, nearest.y);
    pawn.state = 'idle';
    pawn.cooldown = 0;
    ai.updateCivilian(pawn, 16, scene.time.now + 32);
    const job = economy.buildJobs.find(candidate => candidate.pawn === pawn);
    if (job) {
      pawn.setPosition(job.spot.x, job.spot.y);
      pawn.state = 'work';
      economy.tick(100_000, scene.time.now + 100_000);
      pawn.cooldown = 0;
      pawn.state = 'idle';
      ai.updateCivilian(pawn, 16, scene.time.now + 100_016);
    }
    return {
      walksToNearest,
      jobStarted: Boolean(job),
      orderAfterCompletion: pawn.order,
      targetAfterCompletion: pawn.orderTarget,
      pendingJob: economy.buildJobs.some(candidate => candidate.pawn === pawn),
      autoResumed: pawn.order === null && (pawn.state === 'walk' || pawn.state === 'work' || pawn.carrying !== null),
    };
  });
  expect(result.walksToNearest).toBe(true);
  expect(result.jobStarted).toBe(true);
  expect(result.pendingJob).toBe(false);
  expect(result.orderAfterCompletion).toBeNull();
  expect(result.targetAfterCompletion).toBeNull();
  expect(result.autoResumed).toBe(true);
});

test('phase G: carry phase deposits first and only then applies BUILD', async ({ page }) => {
  await startRun(page);
  await preparePawn(page);
  const result = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss!;
    const scene = game.scene.getScene('Game') as GameSceneRuntime;
    const economy = scene.economy;
    const pawn = economy.pawns.find(p => p.kind === 'collector')!;
    const ai = economy.pawnAI;
    ai.enemyNear = () => false;
    economy.resources.wood = 1_000;
    economy.resources.ore = 1_000;
    pawn.order = 'build';
    pawn.carrying = 'wood';
    pawn.carriedAmount = 5;
    pawn.workNode = null;
    pawn.cooldown = 0;
    pawn.state = 'idle';
    pawn.setPosition(economy.castleX + 280, economy.castleY + 180);
    ai.updateCivilian(pawn, 16, scene.time.now + 16);
    const duringCarry = { order: pawn.order, carrying: pawn.carrying, state: pawn.state };
    pawn.setPosition(economy.castleX, economy.castleY);
    pawn.cooldown = 0;
    pawn.state = 'idle';
    ai.updateCivilian(pawn, 16, scene.time.now + 32);
    const afterDeposit = { order: pawn.order, carrying: pawn.carrying, wood: economy.resources.wood };
    pawn.cooldown = 0;
    pawn.state = 'idle';
    ai.updateCivilian(pawn, 16, scene.time.now + 48);
    return {
      duringCarry,
      afterDeposit,
      appliedAfterDeposit: pawn.order === 'build' && pawn.carrying === null
        && (pawn.state === 'walk' || economy.buildJobs.some(job => job.pawn === pawn)),
    };
  });
  expect(result.duringCarry).toEqual({ order: 'build', carrying: 'wood', state: 'walk' });
  expect(result.afterDeposit.order).toBe('build');
  expect(result.afterDeposit.carrying).toBeNull();
  expect(result.afterDeposit.wood).toBe(1_005);
  expect(result.appliedAfterDeposit).toBe(true);
});

test('phase G: touch long-press opens the same menu; early release and swipe cancel', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-mobile', 'Touch gesture input is exercised in the mobile browser project');
  await startRun(page, 390, 844);
  const point = await preparePawn(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  const touch = async (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number): Promise<void> => {
    await cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }],
    });
  };
  const isOpen = () => page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss!;
    return (game.scene.getScene('Game') as GameSceneRuntime).orderMenu.isOpen;
  });
  const isRinging = () => page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss!;
    return (game.scene.getScene('Game') as GameSceneRuntime).orderMenu.ringing;
  });

  // Ранний отпуск — уверенно до порога 500 мс; не допускаем, чтобы перегруженный
  // runner превратил фиксированное ожидание 250 мс + round-trip в успешный long-press.
  await touch('touchStart', point.x, point.y);
  await page.waitForTimeout(80);
  await touch('touchEnd', point.x, point.y);
  await page.waitForTimeout(120);
  expect(await isOpen()).toBe(false);

  // Свайп от пальца должен отменять удержание ещё до открытия меню.
  await touch('touchStart', point.x, point.y);
  await page.waitForTimeout(80);
  await touch('touchMove', point.x + 20, point.y);
  await page.waitForTimeout(80);
  await touch('touchEnd', point.x + 20, point.y);
  await page.waitForTimeout(120);
  expect(await isOpen()).toBe(false);

  // Касание у края зоны проверяет hit-test при уменьшенном зуме мобильной камеры.
  await touch('touchStart', point.x + 28, point.y);
  await page.waitForTimeout(140);
  expect(await isRinging()).toBe(true);
  await page.waitForTimeout(500);
  expect(await isOpen()).toBe(true);
  await touch('touchEnd', point.x + 28, point.y);
  await cdp.detach();
});

test('phase H: resource HUD labels stock separately from match gold and plays deposit sound', async ({ page }) => {
  await startRun(page, 390, 844);
  const result = await page.evaluate(async () => {
    const game = (window as RuntimeWindow).__tss!;
    const scene = game.scene.getScene('Game') as GameSceneRuntime;
    const economy = scene.economy;
    const hud = scene.hud;
    const hiddenAtStart = !hud.resGroup.visible;
    const soundCalls: string[] = [];
    const audioModule = await import('/src/game/systems/Audio.ts') as unknown as {
      audio: { pickupGold: () => void };
    };
    const originalPickupGold = audioModule.audio.pickupGold;
    audioModule.audio.pickupGold = () => { soundCalls.push('pickupGold'); };
    try {
      economy.deposit('wood', 5);
    } finally {
      audioModule.audio.pickupGold = originalPickupGold;
    }
    const resourcesBounds = hud.resGroup.getBounds();
    const goldBounds = hud.goldText.getBounds();
    const weaponBounds = [...hud.weaponIcons.values()].map(icon => icon.getBounds());
    const overlaps = (a: Bounds, b: Bounds): boolean => (
      a.x < b.x + b.width && a.x + a.width > b.x
      && a.y < b.y + b.height && a.y + a.height > b.y
    );
    const noWeaponOverlap = weaponBounds.every(bounds => !overlaps(resourcesBounds, bounds));
    const assetKeysLoaded = scene.textures.exists('res-wood')
      && scene.textures.exists('res-meat') && scene.textures.exists('res-ore');
    // getBounds() возвращает мировые координаты. HUD компенсирует camera zoom
    // через корневой scrollFactor(0)-контейнер, поэтому для viewport-гейта
    // переводим прямоугольник назад в экранные логические координаты.
    const zoom = scene.cameras.main.zoom;
    const screenResourcesBounds = {
      x: scene.scale.width / 2 + (resourcesBounds.x - scene.scale.width / 2) * zoom,
      y: scene.scale.height / 2 + (resourcesBounds.y - scene.scale.height / 2) * zoom,
      width: resourcesBounds.width * zoom,
      height: resourcesBounds.height * zoom,
    };
    const snapshot = {
      hiddenAtStart,
      visibleAfterDeposit: hud.resGroup.visible,
      labels: [hud.resLabels.wood.text, hud.resLabels.meat.text, hud.resLabels.ore.text],
      values: [hud.resTexts.wood.text, hud.resTexts.meat.text, hud.resTexts.ore.text],
      soundCalls,
      resourcesBounds: {
        x: resourcesBounds.x, y: resourcesBounds.y,
        width: resourcesBounds.width, height: resourcesBounds.height,
      },
      goldBounds: { x: goldBounds.x, y: goldBounds.y, width: goldBounds.width, height: goldBounds.height },
      weaponIconCount: weaponBounds.length,
      noWeaponOverlap,
      assetKeysLoaded,
      withinViewport: screenResourcesBounds.x >= 0 && screenResourcesBounds.y >= 0
        && screenResourcesBounds.x + screenResourcesBounds.width <= scene.scale.width
        && screenResourcesBounds.y + screenResourcesBounds.height <= scene.scale.height,
    };
    economy.resources.wood = 0;
    economy.resources.meat = 0;
    economy.resources.ore = 0;
    economy.emit('change');
    return { ...snapshot, hiddenAfterReset: !hud.resGroup.visible };
  });

  expect(result.hiddenAtStart).toBe(true);
  expect(result.visibleAfterDeposit).toBe(true);
  expect(result.labels).toEqual(['Wood', 'Meat', 'Ore']);
  expect(result.values).toEqual(['5', '0', '0']);
  expect(result.soundCalls).toEqual(['pickupGold']);
  expect(result.resourcesBounds.y).toBeGreaterThanOrEqual(result.goldBounds.y + result.goldBounds.height - 2);
  expect(result.weaponIconCount).toBeGreaterThan(0);
  expect(result.noWeaponOverlap).toBe(true);
  expect(result.assetKeysLoaded).toBe(true);
  expect(result.withinViewport).toBe(true);
  expect(result.hiddenAfterReset).toBe(true);
});
