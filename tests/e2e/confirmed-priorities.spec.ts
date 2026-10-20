import { expect, test, type Page } from '@playwright/test';

type RuntimeGame = {
  scene: {
    getScene(key: string): unknown;
    isActive(key: string): boolean;
  };
};
type RuntimeWindow = Window & { __tss?: RuntimeGame };
type MenuRuntime = {
  selectedHero?: string;
  selectedDiff?: string;
  scene: { start(key: string, data: { hero: string; diff: string }): void };
};
type HintRuntime = {
  current: { id: string; ui: string } | null;
};
type BuildingRuntime = {
  kind: string;
  alive: boolean;
  hp: number;
  maxHp: number;
  underConstruction: boolean;
  collapsePending: boolean;
  healSlots: (unknown | null)[];
  warned30: boolean;
  warned10: boolean;
  damage(amount: number, siegeIndex: number): void;
};
type EconomyRuntime = {
  resources: { wood: number; ore: number; meat: number };
  pawns: unknown[];
  buildings: BuildingRuntime[];
  tryStartBuild(kind: string, pawn: unknown): boolean;
  repair(building: BuildingRuntime, pawn: unknown | null): boolean;
};
type GameSceneRuntime = {
  elapsed: number;
  hintOverlayPaused: boolean;
  hints: HintRuntime;
  economy: EconomyRuntime;
  hud: { announce(message: string, color?: string): void };
  time: { now: number };
  weapons: { estimateTheoreticalDps(): number };
  heroDpsAtTenMinutes: number | null;
  garrisonDpsBudget: { reset(nowMs?: number): void };
  damageEnemyByPawn(enemy: unknown, damage: number, weapon: string): void;
};

const startupTimeout = 30_000;

async function openGame(page: Page): Promise<void> {
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });
}

async function startRun(page: Page): Promise<void> {
  await openGame(page);
  // Each test begins as a first-run FTUE session regardless of persisted browser state.
  await page.evaluate(() => window.localStorage.removeItem('tss-hints'));
  await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser game debug handle is unavailable');
    const menu = game.scene.getScene('Menu') as MenuRuntime;
    menu.scene.start('Game', {
      hero: menu.selectedHero ?? 'warrior',
      diff: menu.selectedDiff ?? 'normal',
    });
  });
  await expect.poll(
    () => page.evaluate(() => (window as RuntimeWindow).__tss?.scene.isActive('Game') ?? false),
    { timeout: startupTimeout },
  ).toBe(true);
}

async function continueInitialTutorial(page: Page): Promise<void> {
  await expect.poll(
    () => page.evaluate(() => {
      const game = (window as RuntimeWindow).__tss;
      if (!game?.scene.isActive('Game')) return null;
      return (game.scene.getScene('Game') as GameSceneRuntime).hints.current?.id ?? null;
    }),
    { timeout: 10_000 },
  ).toBe('move');

  const canvas = page.locator('#game canvas');
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('Game canvas has no bounds');
  const viewport = page.viewportSize();
  if (viewport && viewport.width <= 600) {
    // На мобильном профиле посылаем touch-событие, как на реальном устройстве.
    await page.touchscreen.tap(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  } else {
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  }
  await expect.poll(
    () => page.evaluate(() => {
      const game = (window as RuntimeWindow).__tss;
      return game?.scene.isActive('Game')
        ? (game.scene.getScene('Game') as GameSceneRuntime).hintOverlayPaused
        : true;
    }),
  ).toBe(false);
}

test('urgent FTUE hints bypass cooldown and anchor layouts stay within desktop/mobile viewports', async ({ page }) => {
  await openGame(page);
  const moduleUrl = new URL('/src/game/systems/Hints.ts', page.url()).href;
  const policy = await page.evaluate(async (url) => {
    const hints = await import(/* @vite-ignore */ url) as {
      canPresentHintAt: (now: number, last: number, urgent?: boolean, cooldown?: number) => boolean;
      getHintLayout: (width: number, height: number, ui: 'banner' | 'overlay', anchor?: 'top' | 'center' | 'bottom') => {
        x: number; y: number; width: number; textWidth: number; panelHeight: number;
      };
    };
    return {
      urgent: hints.canPresentHintAt(1_000, 999, true),
      normalWithinCooldown: hints.canPresentHintAt(1_000, 999, false),
      normalAfterCooldown: hints.canPresentHintAt(21_000, 999, false),
      desktop: hints.getHintLayout(1440, 900, 'overlay'),
      mobile: hints.getHintLayout(390, 844, 'overlay'),
    };
  }, moduleUrl);

  expect(policy.urgent).toBe(true);
  expect(policy.normalWithinCooldown).toBe(false);
  expect(policy.normalAfterCooldown).toBe(true);
  expect(policy.desktop.x - policy.desktop.width / 2).toBeGreaterThanOrEqual(16);
  expect(policy.desktop.x + policy.desktop.width / 2).toBeLessThanOrEqual(1440 - 16);
  expect(policy.mobile.x - policy.mobile.width / 2).toBeGreaterThanOrEqual(16);
  expect(policy.mobile.x + policy.mobile.width / 2).toBeLessThanOrEqual(390 - 16);
  expect(policy.mobile.textWidth).toBeLessThan(policy.mobile.width);
});

test('mobile FTUE long-press cannot open an order menu on the same touch', async ({ page }) => {
  const viewport = page.viewportSize();
  test.skip(!viewport || viewport.width > 600, 'Touch-specific regression');

  await startRun(page);
  await expect.poll(
    () => page.evaluate(() => {
      const game = (window as RuntimeWindow).__tss;
      if (!game?.scene.isActive('Game')) return null;
      return (game.scene.getScene('Game') as GameSceneRuntime).hints.current?.id ?? null;
    }),
    { timeout: 10_000 },
  ).toBe('move');

  // Ставим жителя прямо под точку касания, чтобы pointerdown мог запустить long-press.
  const center = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const scene = game.scene.getScene('Game') as unknown as {
      cameras: { main: { midPoint: { x: number; y: number } } };
      economy: {
        pawns: Array<{ active: boolean; dead: boolean; cls: string; setPosition(x: number, y: number): void }>;
      };
    };
    const pawn = scene.economy.pawns.find((candidate) =>
      candidate.active && !candidate.dead && candidate.cls === 'civilian');
    if (!pawn) throw new Error('No living civilian is available for the overlay touch test');
    const x = scene.cameras.main.midPoint.x;
    const y = scene.cameras.main.midPoint.y;
    pawn.setPosition(x, y);
    return { x, y };
  });
  expect(Number.isFinite(center.x)).toBe(true);
  expect(Number.isFinite(center.y)).toBe(true);

  const canvas = page.locator('#game canvas');
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('Game canvas has no bounds');
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }],
  });
  try {
    // Overlay закрывается на pointerdown; удержание не должно продолжить
    // тот же жест в игровой слой и открыть radial order menu через 500 мс.
    await page.waitForTimeout(650);
    const orderMenuOpen = await page.evaluate(() => {
      const game = (window as RuntimeWindow).__tss!;
      const scene = game.scene.getScene('Game') as unknown as { orderMenu: { isOpen: boolean } };
      return scene.orderMenu.isOpen;
    });
    expect(orderMenuOpen).toBe(false);
  } finally {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  }
});

test('intro overlay really pauses gameplay; monastery warnings and garrison damage cap are wired end-to-end', async ({ page }) => {
  await startRun(page);
  await expect.poll(
    () => page.evaluate(() => {
      const game = (window as RuntimeWindow).__tss;
      if (!game?.scene.isActive('Game')) return false;
      return (game.scene.getScene('Game') as GameSceneRuntime).hintOverlayPaused;
    }),
    { timeout: 10_000 },
  ).toBe(true);
  const elapsedBefore = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss!;
    return (game.scene.getScene('Game') as GameSceneRuntime).elapsed;
  });
  await page.waitForTimeout(500);
  const elapsedDuringOverlay = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss!;
    return (game.scene.getScene('Game') as GameSceneRuntime).elapsed;
  });
  expect(elapsedDuringOverlay).toBe(elapsedBefore);
  await continueInitialTutorial(page);

  const monastery = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss!;
    const scene = game.scene.getScene('Game') as GameSceneRuntime;
    const economy = scene.economy;
    economy.resources.wood = 10_000;
    economy.resources.ore = 10_000;
    economy.resources.meat = 10_000;
    const builder = economy.pawns[0] ?? null;
    const started = economy.tryStartBuild('monastery', builder);
    const building = economy.buildings.find((candidate) => candidate.kind === 'monastery');
    if (!started || !building) return { started, found: Boolean(building), warnings: [] as string[] };

    // Finish this test building immediately; exercise the production callback, not a mock.
    building.underConstruction = false;
    building.hp = building.maxHp;
    building.healSlots[0] = economy.pawns[0] ?? {};
    building.healSlots[1] = economy.pawns[1] ?? {};

    const warnings: string[] = [];
    const originalAnnounce = scene.hud.announce.bind(scene.hud);
    scene.hud.announce = (message: string, color?: string): void => {
      warnings.push(message);
      originalAnnounce(message, color);
    };
    building.damage(building.maxHp * 0.71, -1); // 29% HP: предупреждение 30%
    building.damage(building.maxHp * 0.30, -1); // Смертельный удар пересекает и 10%, оба предупреждения обязательны.
    const woodBeforeRepair = economy.resources.wood;
    const repairAccepted = economy.repair(building, economy.pawns[0] ?? null);
    return {
      started,
      found: true,
      hpFraction: building.hp / building.maxHp,
      warned30: building.warned30,
      warned10: building.warned10,
      collapsePending: building.collapsePending,
      aliveAtWarning: building.alive,
      repairAccepted,
      woodBeforeRepair,
      woodAfterRepair: economy.resources.wood,
      warnings,
    };
  });

  expect(monastery.started).toBe(true);
  expect(monastery.found).toBe(true);
  expect(monastery.hpFraction).toBeGreaterThan(0);
  expect(monastery.hpFraction).toBeLessThan(0.01);
  expect(monastery.warned30).toBe(true);
  expect(monastery.warned10).toBe(true);
  expect(monastery.collapsePending).toBe(true);
  expect(monastery.warnings).toHaveLength(2);
  expect(monastery.aliveAtWarning).toBe(true);
  expect(monastery.repairAccepted).toBe(false);
  expect(monastery.woodAfterRepair).toBe(monastery.woodBeforeRepair);

  const aliveDuringCollapseWindow = async (): Promise<boolean> => page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss!;
    const scene = game.scene.getScene('Game') as GameSceneRuntime;
    return scene.economy.buildings.find((building) => building.kind === 'monastery')?.alive ?? false;
  });
  await page.waitForTimeout(1_000);
  expect(await aliveDuringCollapseWindow()).toBe(true);
  await page.waitForTimeout(2_200);
  expect(await aliveDuringCollapseWindow()).toBe(false);

  const expectedDpsAtTenMinutes = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss!;
    const scene = game.scene.getScene('Game') as GameSceneRuntime;
    // Advance only the in-game elapsed marker to just before the 10:00 boundary.
    scene.elapsed = 599.99;
    return scene.weapons.estimateTheoreticalDps();
  });
  await expect.poll(
    () => page.evaluate(() => {
      const game = (window as RuntimeWindow).__tss!;
      return (game.scene.getScene('Game') as GameSceneRuntime).heroDpsAtTenMinutes;
    }),
  ).toBe(expectedDpsAtTenMinutes);

  const heroDps = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss!;
    const scene = game.scene.getScene('Game') as GameSceneRuntime;
    const currentHeroDps = scene.weapons.estimateTheoreticalDps();
    scene.heroDpsAtTenMinutes = 100; // deterministic fixture for the shared limiter
    scene.garrisonDpsBudget.reset(scene.time.now);
    return currentHeroDps;
  });
  expect(Number.isFinite(heroDps)).toBe(true);
  expect(heroDps).toBeGreaterThan(0);
  await page.waitForTimeout(1_100);

  const damage = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss!;
    const scene = game.scene.getScene('Game') as GameSceneRuntime;
    const received: number[] = [];
    const target = {
      active: true,
      dead: false,
      def: { scale: 1 },
      x: 10,
      y: 10,
      takeDamage: (amount: number): boolean => { received.push(amount); return false; },
    };
    scene.damageEnemyByPawn(target, 100, 'sword');
    scene.damageEnemyByPawn(target, 100, 'sword');
    return received;
  });
  expect(damage).toEqual([25]);
});

test('phase J: low-FPS combat fallback is selected before checking the per-pawn accumulator', async ({ page }) => {
  await startRun(page);
  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const scene = game.scene.getScene('Game') as GameSceneRuntime & {
      game: { loop: { actualFps: number } };
      economy: EconomyRuntime & {
        pawns: Array<{ state: string }>;
        pawnAI: {
          curTickMs: number;
          combatAcc: Map<object, number>;
          updateCombat(pawn: object, dtMs: number, now: number): void;
        };
      };
    };
    const pawn = scene.economy.pawns[0];
    if (!pawn) throw new Error('Initial settlement has no pawn');
    const previousFps = scene.game.loop.actualFps;
    const previousTick = scene.economy.pawnAI.curTickMs;
    const previousState = pawn.state;
    const ai = scene.economy.pawnAI;
    scene.game.loop.actualFps = 30;
    ai.curTickMs = 150;
    ai.combatAcc.delete(pawn);
    ai.updateCombat(pawn, 150, scene.time.now);
    const result = {
      selectedTickMs: ai.curTickMs,
      accumulatorAfterFirstFrame: ai.combatAcc.get(pawn) ?? null,
    };
    ai.combatAcc.delete(pawn);
    ai.curTickMs = previousTick;
    scene.game.loop.actualFps = previousFps;
    pawn.state = previousState;
    return result;
  });

  expect(report.selectedTickMs).toBe(250);
  expect(report.accumulatorAfterFirstFrame).toBe(150);
});

test('phase J: enemy target priority is hero, then garrison, then civilian', async ({ page }) => {
  await startRun(page);
  await continueInitialTutorial(page);

  await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    type EnemyTarget = {
      active: boolean;
      kind: string;
      x: number;
      y: number;
      aimedPawn: unknown;
      pickTarget(): void;
      setVelocity(x: number, y: number): unknown;
    };
    const scene = game.scene.getScene('Game') as unknown as {
      economy: {
        castleX: number;
        castleY: number;
        pawns: Array<{
          active: boolean;
          dead: boolean;
          state: string;
          cls: 'civilian' | 'garrison';
          setPosition(x: number, y: number): unknown;
        }>;
        spawnPawn(
          kind: string,
          nearX?: number,
          nearY?: number,
          announce?: boolean,
        ): { setPosition(x: number, y: number): unknown } | null;
      };
      player: { setPosition(x: number, y: number): unknown };
      spawner: { stopped: boolean };
      spawnEnemy(kind: string, x: number, y: number): boolean;
      enemyGroup: { getChildren(): EnemyTarget[] };
    };
    scene.spawner.stopped = true;
    scene.player.setPosition(scene.economy.castleX - 1_200, scene.economy.castleY - 200);
    const x = scene.economy.castleX + 650;
    const y = scene.economy.castleY + 120;
    if (!scene.spawnEnemy('goblin', x, y)) throw new Error('Could not create target-selection enemy');
    const enemy = scene.enemyGroup.getChildren().find((candidate) =>
      candidate.active && candidate.kind === 'goblin'
        && Math.hypot(candidate.x - x, candidate.y - y) < 5);
    if (!enemy) throw new Error('Spawned goblin could not be found');
    enemy.setVelocity(0, 0);
    // Убираем прочий гарнизон за радиус агро и оставляем гражданского рядом.
    for (const existing of scene.economy.pawns) {
      if (existing.cls === 'garrison') existing.setPosition(x - 950, y);
    }
    const pawn = scene.economy.pawns.find((candidate) =>
      candidate.active && !candidate.dead && candidate.cls === 'civilian'
        && candidate.state !== 'wounded' && candidate.state !== 'bleeding');
    if (!pawn) throw new Error('No living civilian is available for target-selection test');
    // Гражданский находится вне safe-core, поэтому может быть выбран.
    pawn.setPosition(x + 60, y);
    enemy.pickTarget();
    if (enemy.aimedPawn !== pawn) throw new Error('Enemy did not fall back to a civilian when no garrison is in aggro range');

    // Гарнизон дальше ближайшего гражданского, но в радиусе агро: его категория
    // обязана победить независимо от дистанции до гражданского.
    const garrison = scene.economy.spawnPawn('fighter', x + 700, y, false);
    if (!garrison) throw new Error('Could not create a garrison target');
    garrison.setPosition(x + 700, y);
    enemy.pickTarget();
    if (enemy.aimedPawn !== garrison) throw new Error('Enemy preferred a closer civilian over a garrison');
    (window as RuntimeWindow & { __phaseJEnemy?: EnemyTarget }).__phaseJEnemy = enemy;
  });

  const heroPriority = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    const enemy = (window as RuntimeWindow & {
      __phaseJEnemy?: { x: number; y: number; aimedPawn: unknown; pickTarget(): void };
    }).__phaseJEnemy;
    if (!game || !enemy) throw new Error('Target-selection fixture was lost');
    const scene = game.scene.getScene('Game') as GameSceneRuntime & {
      player: GameSceneRuntime['player'] & { setPosition(x: number, y: number): unknown };
    };
    scene.player.setPosition(enemy.x + 100, enemy.y);
    // Вызываем реальный selector напрямую, без гонки с таймером pick раз в 400 мс.
    enemy.pickTarget();
    return enemy.aimedPawn === null;
  });
  expect(heroPriority).toBe(true);
});
