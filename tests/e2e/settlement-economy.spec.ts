import { expect, test, type Page } from '@playwright/test';

type PawnRuntime = {
  kind: string;
  setPosition(x: number, y: number): unknown;
  prefix: string;
  state: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  dead: boolean;
  active: boolean;
  carrying: string | null;
  carriedAmount: number;
  taskProgress: number;
  alpha: number;
  arrivalMs: number;
  anims: { currentAnim?: { key: string } | null };
  playMove(moving: boolean): void;
  cooldown: number;
  order: string | null;
  workNode: ResourceNodeRuntime | BuildingRuntime | null;
  bleedTimer: number;
};

type ResourceNodeRuntime = {
  kind: 'tree' | 'sheep' | 'vein';
  sprite: { type: string; body?: unknown };
  res: 'wood' | 'ore' | 'meat';
  x: number;
  y: number;
  alive: boolean;
  available: boolean;
  remaining: number;
  maxRemaining: number;
  claimedBy: PawnRuntime | null;
  claim(pawn: PawnRuntime): boolean;
  release(pawn: PawnRuntime): void;
  extract(): boolean;
  recharge(): void;
  destroy(): void;
};

type BuildingRuntime = {
  kind: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  alpha: number;
  alive: boolean;
  underConstruction: boolean;
  finishConstruction(): void;
  damage(amount: number, siegeIndex: number): void;
};

type BuildSpotRuntime = { kind: string; x: number; y: number };

type EconomyRuntime = {
  resources: { wood: number; ore: number; meat: number };
  pawns: PawnRuntime[];
  nodes: ResourceNodeRuntime[];
  buildings: BuildingRuntime[];
  buildJobs: Array<{ pawn: PawnRuntime; spot: BuildSpotRuntime; building: BuildingRuntime; progress: number }>;
  repairJobs: Array<{ pawn: PawnRuntime; building: BuildingRuntime; progress: number; rebuild: boolean }>;
  pawnAI: {
    updateCivilian(pawn: PawnRuntime, dtMs: number, now: number): void;
    pickBuildSpot(pawn: PawnRuntime): BuildSpotRuntime | null;
  };
  applySettlementCard(id: string): void;
  pawnLimit: number;
  castleX: number;
  castleY: number;
  freeSpots(): BuildSpotRuntime[];
  markSpot(x: number, y: number): void;
  tryStartBuild(kind: string, pawn: PawnRuntime, preferredSpot?: BuildSpotRuntime): boolean;
  repair(building: BuildingRuntime, pawn: PawnRuntime | null): boolean;
  finishRepairInstant(): boolean;
  garrisonLimit(source: string): number;
  tick(dtMs: number, now: number): void;
};

type HUDRuntime = {
  resGroup: { visible: boolean };
  resTexts: { wood: { text: string }; meat: { text: string }; ore: { text: string } };
  garrisonText: { text: string };
};

type PlayerRuntime = {
  x: number;
  y: number;
  speed: number;
  setPosition(x: number, y: number): unknown;
  setVelocity(x: number, y: number): unknown;
};

type GameSceneRuntime = {
  economy: EconomyRuntime;
  player: PlayerRuntime;
  hud: HUDRuntime;
  elapsed: number;
  hintOverlayPaused: boolean;
  time: { now: number; paused: boolean };
  physics: { world: { pause(): void; resume(): void } };
  registry: { get(key: string): unknown; set(key: string, value: unknown): void };
};

type MenuRuntime = {
  selectedHero?: string;
  selectedDiff?: string;
  scene: { start(key: string, data: { hero: string; diff: string }): void };
};

type PhaserRuntime = {
  anims: { exists(key: string): boolean };
  scene: { getScene(key: string): unknown; isActive(key: string): boolean };
};

type RuntimeWindow = Window & {
  __tss?: PhaserRuntime;
  __phaseEFirstResident?: PawnRuntime;
  __phaseEHouseSpot?: BuildSpotRuntime;
};

// Холодный старт dev-сервера: Vite трансформирует весь граф модулей и ~570
// ассетов. На загруженном CI это занимает больше 30 сек — тест падал с
// «canvas не появился», хотя приложение стартует штатно.
const startupTimeout = 60_000;

async function startRun(page: Page): Promise<void> {
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });
  // Wait until BootScene has registered global animations before bypassing the menu UI.
  await expect.poll(
    () => page.evaluate(() => (window as RuntimeWindow).__tss?.scene.isActive('Menu') ?? false),
    { timeout: startupTimeout },
  ).toBe(true);
  await page.evaluate(() => {
    localStorage.removeItem('tss-meta2');
    localStorage.removeItem('tss-hints');
  });
  await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
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
  const canvas = page.locator('#game canvas');
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('Game canvas has no layout bounds');
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await expect.poll(() => page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game?.scene.isActive('Game')) return true;
    return (game.scene.getScene('Game') as GameSceneRuntime).hintOverlayPaused;
  }), { timeout: 10_000 }).toBe(false);
}

test('phase B: four workers, correct faction animations and live Economy tick', async ({ page }) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await startRun(page);
  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss!;
    const scene = game.scene.getScene('Game') as GameSceneRuntime;
    const animations = game.anims;
    const economy = scene.economy;
    const originalTick = economy.tick.bind(economy);
    let tickCalls = 0;
    economy.tick = (dtMs, now) => {
      tickCalls++;
      scene.registry.set('test-economy-tick-calls', tickCalls);
      originalTick(dtMs, now);
    };
    const animationKeys = [
      'pawn-idle', 'pawn-run', 'pawny-idle', 'pawny-run',
      'pawn-work-axe', 'pawn-work-knife', 'pawn-work-pickaxe', 'pawny-work-hammer',
      'pawn-carry-wood', 'pawn-carry-idle-wood', 'pawn-carry-meat', 'pawn-carry-idle-meat',
      'pawn-carry-gold', 'pawn-carry-idle-gold', 'pawny-carry-wood',
      'pawny-carry-idle-wood', 'pawny-carry-meat', 'pawny-carry-idle-meat',
      'pawny-carry-gold', 'pawny-carry-idle-gold',
      'gold-vein-pulse-1', 'gold-vein-pulse-2', 'gold-vein-pulse-3',
      'gold-vein-pulse-4', 'gold-vein-pulse-5',
    ];
    return {
      pawns: economy.pawns.map(p => ({
        kind: p.kind,
        prefix: p.prefix,
        state: p.state,
        distanceToCastle: Math.hypot(p.x - economy.castleX, p.y - economy.castleY),
      })),
      resourcesHiddenAtStart: !scene.hud.resGroup.visible,
      animations: Object.fromEntries(animationKeys.map(key => [key, animations.exists(key)])),
      blueHammerExists: animations.exists('pawn-work-hammer'),
      tickCalls,
    };
  });

  expect(report.pawns.map(p => p.kind).sort()).toEqual(['builder', 'collector', 'collector', 'repairer']);
  expect(report.pawns.filter(p => p.kind === 'collector').every(p => p.prefix === 'pawn')).toBe(true);
  expect(report.pawns.filter(p => p.kind === 'builder' || p.kind === 'repairer')
    .every(p => p.prefix === 'pawny')).toBe(true);
  expect(report.pawns.every(p => p.state === 'idle')).toBe(true);
  expect(report.pawns.every(p => p.distanceToCastle >= 80 && p.distanceToCastle <= 160)).toBe(true);
  expect(report.resourcesHiddenAtStart).toBe(true);
  expect(Object.entries(report.animations).filter(([, exists]) => !exists).map(([key]) => key)).toEqual([]);
  expect(report.blueHammerExists).toBe(false);

  await continueInitialTutorial(page);
  await page.waitForTimeout(700);
  const tickCalls = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss!;
    const scene = game.scene.getScene('Game') as GameSceneRuntime;
    return Number(scene.registry.get('test-economy-tick-calls') ?? 0);
  });
  const economyLive = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss!;
    const scene = game.scene.getScene('Game') as GameSceneRuntime;
    return scene.elapsed > 0 && scene.economy.pawns.length >= 4;
  });
  expect(economyLive).toBe(true);
  expect(tickCalls).toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors.filter(message => /Frame not found|Missing animation/i.test(message))).toEqual([]);
});

test('phase B: player can walk past a civilian without a blocking pawn collider', async ({ page }) => {
  await startRun(page);
  await continueInitialTutorial(page);

  const start = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss!;
    const scene = game.scene.getScene('Game') as GameSceneRuntime;
    const economy = scene.economy;
    const pawn = economy.pawns.find(p => p.kind === 'collector');
    if (!pawn) throw new Error('Player/pawn movement check needs a collector');

    // Freeze civilian AI so the test measures the player collider contract, not target choice.
    (economy.pawnAI as unknown as { updateCivilian: () => void }).updateCivilian = () => {};
    for (const civilian of economy.pawns) {
      // A newly granted collector may still be in its two-second entrance tween.
      // Kill it before positioning the pawn, otherwise the target moves during traversal.
      scene.tweens.killTweensOf(civilian);
      civilian.setPosition(economy.castleX + 220, economy.castleY + 350);
      const body = (civilian as unknown as { body: { setVelocity(x: number, y: number): void } }).body;
      body.setVelocity(0, 0);
    }
    const crossingPawn = pawn;
    const targetX = economy.castleX + 220;
    const targetY = economy.castleY + 350;
    crossingPawn.setPosition(targetX, targetY);
    (crossingPawn as unknown as { body: { setVelocity(x: number, y: number): void } }).body.setVelocity(0, 0);

    const runtimeScene = scene as unknown as {
      spawner: { stopped: boolean };
      hitstopUntil: number;
    };
    runtimeScene.spawner.stopped = true;
    runtimeScene.hitstopUntil = 0;
    scene.player.setPosition(targetX - 180, targetY);
    scene.player.setVelocity(0, 0);
    return {
      playerStartX: scene.player.x,
      pawnX: crossingPawn.x,
      playerY: scene.player.y,
      pawnY: crossingPawn.y,
      playerSpeed: scene.player.speed,
    };
  });

  expect(start.pawnX - start.playerStartX).toBe(180);
  expect(Math.abs(start.playerY - start.pawnY)).toBeLessThan(1);
  expect(start.playerSpeed).toBeGreaterThan(0);

  // Ожидаем фактического пересечения, а не предполагаемую скорость по wall-clock:
  // фоновые/нагруженные CI-раннеры могут терять кадры, и фиксированная задержка
  // делала проверку физического контракта нестабильной.
  await page.keyboard.down('d');
  try {
    await page.waitForFunction(() => {
      const game = (window as RuntimeWindow).__tss!;
      const scene = game.scene.getScene('Game') as GameSceneRuntime;
      const pawn = scene.economy.pawns.find(p => p.kind === 'collector');
      return Boolean(pawn && scene.player.x > pawn.x + 30);
    }, { timeout: 5_000 });
  } finally {
    await page.keyboard.up('d');
  }

  const result = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss!;
    const scene = game.scene.getScene('Game') as GameSceneRuntime;
    const pawn = scene.economy.pawns.find(p => p.kind === 'collector');
    if (!pawn) throw new Error('Collector disappeared during player traversal');
    return {
      playerX: scene.player.x,
      pawnX: pawn.x,
      playerPawnDistance: Math.hypot(scene.player.x - pawn.x, scene.player.y - pawn.y),
    };
  });
  // The player should cross the civilian's position, rather than stopping at its physics body.
  expect(result.playerX).toBeGreaterThan(result.pawnX + 30);
  expect(result.playerPawnDistance).toBeGreaterThan(30);
});

test('phases C-D: harvesting delivers resources and depleted veins can recharge', async ({ page }) => {
  await startRun(page);
  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss!;
    const scene = game.scene.getScene('Game') as GameSceneRuntime;
    const economy = scene.economy;
    const readHudResources = () => ({
      visible: scene.hud.resGroup.visible,
      wood: scene.hud.resTexts.wood.text,
      meat: scene.hud.resTexts.meat.text,
      ore: scene.hud.resTexts.ore.text,
    });
    const initialHudResources = readHudResources();
    const collector = economy.pawns.find(p => p.kind === 'collector');
    const blocker = economy.pawns.find(p => p.kind === 'collector' && p !== collector);
    const initialResources = { ...economy.resources };
    const initialTreeCount = economy.nodes.filter(n => n.kind === 'tree' && n.alive).length;
    const initialSheepCount = economy.nodes.filter(n => n.kind === 'sheep' && n.alive).length;
    const tree = economy.nodes.find(n => n.kind === 'tree' && n.available);
    const sheep = economy.nodes.find(n => n.kind === 'sheep' && n.available);
    const vein = economy.nodes.find(n => n.kind === 'vein' && n.available
      && Math.hypot(n.x - economy.castleX, n.y - economy.castleY) <= 1_000);
    const veins = economy.nodes.filter(n => n.kind === 'vein');
    const minimumVeinDistance = Math.min(...veins.map(n => Math.hypot(n.x - economy.castleX, n.y - economy.castleY)));
    const maximumVeinDistance = Math.max(...veins.map(n => Math.hypot(n.x - economy.castleX, n.y - economy.castleY)));
    const minimumVeinPairDistance = Math.min(...veins.flatMap((node, i) =>
      veins.slice(i + 1).map(other => Math.hypot(node.x - other.x, node.y - other.y))));
    const veinSprites = veins.map(node => ({
      type: node.sprite.type,
      hasPhysicsBody: node.sprite.body != null,
    }));
    if (!collector || !blocker || !tree || !sheep || !vein) throw new Error('Initial settlement nodes or collectors are missing');

    const context = scene.registry.get('tss-pawnai-ctx') as { enemies: () => unknown[] };
    context.enemies = () => [];

    // Reserve every other resource so the actual AI selects this tree deterministically.
    for (const node of economy.nodes) {
      if (node !== tree && node.available) node.claimedBy = blocker;
    }
    tree.claimedBy = null;
    collector.x = tree.x;
    collector.y = tree.y;
    collector.state = 'idle';
    collector.carrying = null;
    collector.carriedAmount = 0;
    collector.taskProgress = 0;
    collector.cooldown = 0;
    collector.order = null;
    collector.workNode = null;

    const woodBefore = economy.resources.wood;
    economy.pawnAI.updateCivilian(collector, 3_999, scene.time.now);
    const woodBeforeThreshold = collector.carrying;
    economy.pawnAI.updateCivilian(collector, 1, scene.time.now + 3_999);
    const carrying = collector.carrying;
    const carriedAmount = collector.carriedAmount;
    const treeDestroyed = !tree.alive;
    const resourceCountBeforeDeposit = economy.resources.wood - woodBefore;

    // Перевозимый ресурс отображается и в неподвижном, и в ходовом цикле.
    // Test the idle-with-load animation directly; an AI tick would start walking home.
    collector.playMove(false);
    const carryIdleAnimation = collector.anims.currentAnim?.key ?? null;
    collector.x = economy.castleX + 300;
    collector.y = economy.castleY;
    collector.cooldown = 0;
    economy.pawnAI.updateCivilian(collector, 16, scene.time.now + 4_016);
    const carryRunAnimation = collector.anims.currentAnim?.key ?? null;

    // Проверяем абсолютный приоритет сдачи ресурса до сброса carrying на складе.
    const carryTarget = economy.nodes.find(n => n !== tree && n.available
      && n.claimedBy === blocker
      && Math.hypot(n.x - economy.castleX, n.y - economy.castleY) > 140);
    if (!carryTarget) throw new Error('Carry-priority regression needs another available distant node');
    carryTarget.claimedBy = null;
    const carryTargetRemaining = carryTarget.remaining;
    collector.x = carryTarget.x;
    collector.y = carryTarget.y;
    collector.cooldown = 0;
    economy.pawnAI.updateCivilian(collector, 16, scene.time.now + 4_024);
    const carryingPriorityRespected = collector.carrying === 'wood'
      && collector.workNode === null
      && carryTarget.remaining === carryTargetRemaining
      && carryTarget.claimedBy === null;
    carryTarget.claimedBy = blocker;

    collector.x = economy.castleX;
    collector.y = economy.castleY;
    collector.cooldown = 0;
    economy.pawnAI.updateCivilian(collector, 16, scene.time.now + 4_032);
    const depositedWood = economy.resources.wood - woodBefore;
    const hudAfterWood = readHudResources();

    // Повторяем тот же поток для овцы: мясо не появляется на земле, а уходит
    // в склад только после возвращения пешки к замку.
    for (const node of economy.nodes) {
      if (node.available && node !== sheep) node.claimedBy = blocker;
    }
    sheep.claimedBy = null;
    collector.x = sheep.x;
    collector.y = sheep.y;
    collector.state = 'idle';
    collector.carrying = null;
    collector.carriedAmount = 0;
    collector.taskProgress = 0;
    collector.cooldown = 0;
    collector.order = null;
    collector.workNode = null;
    const meatBefore = economy.resources.meat;
    economy.pawnAI.updateCivilian(collector, 2_999, scene.time.now + 5_032);
    const meatBeforeThreshold = collector.carrying;
    economy.pawnAI.updateCivilian(collector, 1, scene.time.now + 8_031);
    const carriedMeat = collector.carrying;
    const meatAmount = collector.carriedAmount;
    const sheepDestroyed = !sheep.alive;
    collector.x = economy.castleX;
    collector.y = economy.castleY;
    collector.cooldown = 0;
    economy.pawnAI.updateCivilian(collector, 16, scene.time.now + 15_032);
    const depositedMeat = economy.resources.meat - meatBefore;
    const hudAfterMeat = readHudResources();

    // И руда добывается настоящим циклом AI, до проверки полного истощения.
    for (const node of economy.nodes) {
      if (node.available && node !== vein) node.claimedBy = blocker;
    }
    vein.claimedBy = null;
    collector.x = vein.x;
    collector.y = vein.y;
    collector.state = 'idle';
    collector.carrying = null;
    collector.carriedAmount = 0;
    collector.taskProgress = 0;
    collector.cooldown = 0;
    collector.order = null;
    collector.workNode = null;
    const oreBefore = economy.resources.ore;
    economy.pawnAI.updateCivilian(collector, 4_999, scene.time.now + 15_048);
    const oreBeforeThreshold = collector.carrying;
    economy.pawnAI.updateCivilian(collector, 1, scene.time.now + 20_047);
    const carriedOre = collector.carrying;
    const oreAmount = collector.carriedAmount;
    collector.x = economy.castleX;
    collector.y = economy.castleY;
    collector.cooldown = 0;
    economy.pawnAI.updateCivilian(collector, 16, scene.time.now + 25_048);
    const depositedOre = economy.resources.ore - oreBefore;
    const hudAfterOre = readHudResources();

    const pulseAfterFirstCycle = vein.sprite.type === 'Sprite'
      ? (vein as unknown as { pulse: { visible: boolean } | null }).pulse?.visible ?? null
      : null;
    vein.extract();
    const pulseAfterSecondCycle = (vein as unknown as { pulse: { visible: boolean } | null }).pulse?.visible ?? null;
    const maxRemaining = vein.maxRemaining;
    const remainingCharges = vein.remaining;
    for (let i = 0; i < remainingCharges; i++) vein.extract();
    const veinAfterDepletion = {
      alive: vein.alive,
      remaining: vein.remaining,
      available: vein.available,
      pulseVisible: (vein as unknown as { pulse: { visible: boolean } | null }).pulse?.visible ?? null,
      claimedWhileDepleted: vein.claim(collector),
    };
    vein.recharge();
    const veinAfterRecharge = {
      alive: vein.alive,
      remaining: vein.remaining,
      available: vein.available,
      pulseVisible: (vein as unknown as { pulse: { visible: boolean } | null }).pulse?.visible ?? null,
      canClaim: vein.claim(collector),
    };
    vein.release(collector);

    // Regression: a work node can disappear between AI ticks if another worker takes it.
    const nearCastle = (node: ResourceNodeRuntime) =>
      Math.hypot(node.x - economy.castleX, node.y - economy.castleY) <= 1_000;
    const staleTargetNode = economy.nodes.find(n => n.kind === 'tree'
      && n.available && n.claimedBy === blocker && nearCastle(n));
    const fallbackTargetNode = economy.nodes.find(n => n !== staleTargetNode
      && n.kind === 'tree' && n.available && n.claimedBy === blocker && nearCastle(n));
    if (!staleTargetNode || !fallbackTargetNode) {
      throw new Error('Stale-node regression needs two available reachable trees');
    }
    for (const node of economy.nodes) {
      if (node.available && node !== staleTargetNode && node !== fallbackTargetNode) node.claimedBy = blocker;
    }
    staleTargetNode.claimedBy = null;
    fallbackTargetNode.claimedBy = null;
    collector.carrying = null;
    collector.carriedAmount = 0;
    collector.cooldown = 0;
    collector.order = null;
    collector.taskProgress = 400;
    collector.workNode = staleTargetNode;
    collector.state = 'work';
    collector.x = staleTargetNode.x;
    collector.y = staleTargetNode.y;
    if (!staleTargetNode.claim(collector)) throw new Error('Collector could not claim its stale test target');
    staleTargetNode.destroy();
    collector.x = fallbackTargetNode.x;
    collector.y = fallbackTargetNode.y;
    economy.pawnAI.updateCivilian(collector, 16, scene.time.now + 25_064);
    const staleTargetCleared = collector.workNode === fallbackTargetNode;
    const staleTargetReleased = staleTargetNode.claimedBy === null;

    return {
      staleTargetCleared,
      staleTargetReleased,
      initialResources,
      initialHudResources,
      hudAfterWood,
      hudAfterMeat,
      hudAfterOre,
      carryingPriorityRespected,
      initialTreeCount,
      initialSheepCount,
      carrying,
      carriedAmount,
      woodBeforeThreshold,
      carryIdleAnimation,
      carryRunAnimation,
      treeDestroyed,
      resourceCountBeforeDeposit,
      depositedWood,
      woodBefore,
      woodAfter: economy.resources.wood,
      meatBeforeThreshold,
      oreBeforeThreshold,
      carriedMeat,
      meatAmount,
      sheepDestroyed,
      depositedMeat,
      carriedOre,
      oreAmount,
      depositedOre,
      veinCount: veins.length,
      minimumVeinDistance,
      maximumVeinDistance,
      minimumVeinPairDistance,
      veinSprites,
      treeCount: economy.nodes.filter(n => n.kind === 'tree' && n.alive).length,
      sheepCount: economy.nodes.filter(n => n.kind === 'sheep' && n.alive).length,
      pulseAfterFirstCycle,
      pulseAfterSecondCycle,
      maxRemaining,
      veinAfterDepletion,
      veinAfterRecharge,
    };
  });

  expect(report.initialResources).toEqual({ wood: 0, ore: 0, meat: 0 });
  expect(report.initialTreeCount).toBeGreaterThan(20);
  expect(report.initialSheepCount).toBeGreaterThan(0);
  expect(report.initialSheepCount).toBeLessThanOrEqual(10);
  expect(report.staleTargetCleared).toBe(true);
  expect(report.staleTargetReleased).toBe(true);
  expect(report.initialHudResources).toEqual({ visible: false, wood: '0', meat: '0', ore: '0' });
  expect(report.hudAfterWood).toEqual({ visible: true, wood: '5', meat: '0', ore: '0' });
  expect(report.hudAfterMeat).toEqual({ visible: true, wood: '5', meat: '3', ore: '0' });
  expect(report.hudAfterOre).toEqual({ visible: true, wood: '5', meat: '3', ore: '20' });
  expect(report.carryingPriorityRespected).toBe(true);
  expect(report.woodBeforeThreshold).toBeNull();
  expect(report.meatBeforeThreshold).toBeNull();
  expect(report.oreBeforeThreshold).toBeNull();
  expect(report.carrying).toBe('wood');
  expect(report.carriedAmount).toBe(5);
  expect(report.carryIdleAnimation).toBe('pawn-carry-idle-wood');
  expect(report.carryRunAnimation).toBe('pawn-carry-wood');
  expect(report.treeDestroyed).toBe(true);
  expect(report.resourceCountBeforeDeposit).toBe(0);
  expect(report.depositedWood).toBe(report.carriedAmount);
  expect(report.woodAfter).toBe(report.woodBefore + report.carriedAmount);
  expect(report.carriedMeat).toBe('meat');
  expect(report.meatAmount).toBe(3);
  expect(report.sheepDestroyed).toBe(true);
  expect(report.depositedMeat).toBe(3);
  expect(report.carriedOre).toBe('ore');
  expect(report.oreAmount).toBe(20);
  expect(report.depositedOre).toBe(20);
  expect(report.veinCount).toBe(10);
  expect(report.minimumVeinDistance).toBeGreaterThanOrEqual(200);
  expect(report.maximumVeinDistance).toBeLessThanOrEqual(1_000);
  expect(report.minimumVeinPairDistance).toBeGreaterThanOrEqual(140);
  expect(report.veinSprites.every(node => node.type === 'Sprite' && !node.hasPhysicsBody)).toBe(true);
  expect(report.treeCount).toBe(report.initialTreeCount - 2); // collected tree + stale-target teardown
  expect(report.sheepCount).toBe(report.initialSheepCount - 1);
  expect(report.pulseAfterFirstCycle).toBe(true);
  expect(report.pulseAfterSecondCycle).toBe(false);
  expect(report.veinAfterDepletion).toMatchObject({
    alive: true,
    remaining: 0,
    available: false,
    pulseVisible: false,
    claimedWhileDepleted: false,
  });
  expect(report.veinAfterRecharge).toMatchObject({
    alive: true,
    remaining: report.maxRemaining,
    available: true,
    pulseVisible: true,
    canClaim: true,
  });
});

test('phase E: the first-house bonus resident enters over two seconds', async ({ page }) => {
  await startRun(page);
  const start = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss!;
    const scene = game.scene.getScene('Game') as GameSceneRuntime;
    const economy = scene.economy;
    const builder = economy.pawns.find(p => p.kind === 'builder');
    const spot = economy.freeSpots().find(s => s.kind === 'house');
    if (!builder || !spot) throw new Error('First-house arrival test needs a builder and a free house spot');
    const existingBuildings = new Set(economy.buildings);
    const existingPawns = new Set(economy.pawns);
    const context = scene.registry.get('tss-pawnai-ctx') as { enemies: () => unknown[] };
    context.enemies = () => [];
    economy.resources.wood = 100;
    economy.resources.ore = 0;
    economy.resources.meat = 0;
    builder.x = spot.x;
    builder.y = spot.y;
    builder.state = 'work';
    builder.order = null;
    builder.cooldown = 0;
    builder.carrying = null;
    builder.carriedAmount = 0;
    builder.taskProgress = 0;
    builder.workNode = null;
    const started = economy.tryStartBuild('house', builder, spot);
    if (!started) throw new Error('Could not start the first house');
    for (let i = 1; i <= 50; i++) economy.tick(200, scene.time.now + i * 200);
    const house = economy.buildings.find(b => b.kind === 'house' && !existingBuildings.has(b));
    const resident = economy.pawns.find(p => p.kind === 'collector' && !existingPawns.has(p));
    if (!house || !resident) throw new Error('First house did not produce its bonus resident');
    const targetDistance = Math.hypot(resident.x - spot.x, resident.y - spot.y);
    const runtimeWindow = window as RuntimeWindow;
    runtimeWindow.__phaseEFirstResident = resident;
    runtimeWindow.__phaseEHouseSpot = spot;
    return {
      houseFinished: house.alive && !house.underConstruction,
      arrivalMs: resident.arrivalMs,
      alpha: resident.alpha,
      state: resident.state,
      anim: resident.anims.currentAnim?.key ?? null,
      targetDistance,
    };
  });
  expect(start.houseFinished).toBe(true);
  expect(start.arrivalMs).toBeGreaterThan(0);
  expect(start.arrivalMs).toBeLessThanOrEqual(2_000);
  expect(start.alpha).toBeLessThan(1);
  expect(start.state).toBe('walk');
  expect(start.anim).toBe('pawn-run');
  expect(start.targetDistance).toBeGreaterThan(250);

  await expect.poll(
    () => page.evaluate(() => (window as RuntimeWindow).__phaseEFirstResident?.arrivalMs ?? null),
    { timeout: 5_000, message: 'First-house resident entrance should finish within two seconds' },
  ).toBe(0);
  const finish = await page.evaluate(() => {
    const w = window as RuntimeWindow;
    const resident = w.__phaseEFirstResident;
    const spot = w.__phaseEHouseSpot;
    if (!resident || !spot) throw new Error('First-house resident state was lost');
    return {
      active: resident.active,
      arrivalMs: resident.arrivalMs,
      alpha: resident.alpha,
      distanceToHouse: Math.hypot(resident.x - spot.x, resident.y - spot.y),
      anim: resident.anims.currentAnim?.key ?? null,
    };
  });
  expect(finish.active).toBe(true);
  expect(finish.arrivalMs).toBe(0);
  expect(finish.alpha).toBe(1);
  expect(finish.distanceToHouse).toBeLessThan(220);
  expect(finish.anim).toBe('pawn-idle');
});

test('phase E: builder walks toward the nearest free spot before spending resources', async ({ page }) => {
  await startRun(page);
  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss!;
    const scene = game.scene.getScene('Game') as GameSceneRuntime;
    const economy = scene.economy;
    const builder = economy.pawns.find(p => p.kind === 'builder');
    if (!builder) throw new Error('Builder is missing from the initial settlement');
    const spots = economy.freeSpots();
    if (!spots.length) throw new Error('No free construction spots are configured');
    const context = scene.registry.get('tss-pawnai-ctx') as { enemies: () => unknown[] };
    context.enemies = () => [];
    economy.resources.wood = 1_000;
    economy.resources.ore = 1_000;
    economy.resources.meat = 0;
    const startX = builder.x;
    const startY = builder.y;
    const nearest = spots.reduce((best, spot) =>
      Math.hypot(spot.x - startX, spot.y - startY) < Math.hypot(best.x - startX, best.y - startY)
        ? spot : best);
    const woodBefore = economy.resources.wood;
    const oreBefore = economy.resources.ore;
    const buildingCountBefore = economy.buildings.length;
    builder.order = 'build';
    builder.state = 'idle';
    builder.cooldown = 0;
    builder.carrying = null;
    builder.carriedAmount = 0;
    builder.workNode = null;
    builder.taskProgress = 0;
    economy.pawnAI.updateCivilian(builder, 16, scene.time.now);
    const velocity = (builder as unknown as { body: { velocity: { x: number; y: number } } }).body.velocity;
    const dx = nearest.x - startX;
    const dy = nearest.y - startY;
    return {
      state: builder.state,
      targetDistance: Math.hypot(dx, dy),
      velocityX: velocity.x,
      velocityY: velocity.y,
      velocityTowardTarget: velocity.x * dx + velocity.y * dy,
      woodBefore,
      woodAfter: economy.resources.wood,
      oreBefore,
      oreAfter: economy.resources.ore,
      buildingCountBefore,
      buildingCountAfter: economy.buildings.length,
    };
  });
  expect(report.targetDistance).toBeGreaterThan(70);
  expect(report.state).toBe('walk');
  expect(Math.hypot(report.velocityX, report.velocityY)).toBeGreaterThan(0);
  expect(report.velocityTowardTarget).toBeGreaterThan(0);
  expect(report.woodAfter).toBe(report.woodBefore);
  expect(report.oreAfter).toBe(report.oreBefore);
  expect(report.buildingCountAfter).toBe(report.buildingCountBefore);
});

test('phases E-F: construction uses the approached spot and repair costs are guarded', async ({ page }) => {
  await startRun(page);
  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss!;
    const scene = game.scene.getScene('Game') as GameSceneRuntime;
    const economy = scene.economy;
    const builder = economy.pawns.find(p => p.kind === 'builder');
    const castle = economy.buildings.find(b => b.kind === 'castle');
    if (!builder || !castle) throw new Error('Builder or castle is missing');

    const initialBuildSpots = economy.freeSpots();
    const footprint: Record<string, { w: number; h: number }> = {
      castle: { w: 288, h: 230 },
      house: { w: 102, h: 154 },
      barracks: { w: 163, h: 218 },
      tower: { w: 109, h: 218 },
      monastery: { w: 163, h: 272 },
      archery: { w: 163, h: 218 },
    };
    const findFootprintOverlaps = (spots: BuildSpotRuntime[]): string[] => {
      const placed = [
        { kind: 'castle', x: economy.castleX, y: economy.castleY },
        ...spots,
      ];
      const overlaps: string[] = [];
      for (let i = 0; i < placed.length; i++) {
        for (let j = i + 1; j < placed.length; j++) {
          const a = placed[i];
          const b = placed[j];
          const fa = footprint[a.kind];
          const fb = footprint[b.kind];
          if (Math.abs(a.x - b.x) < (fa.w + fb.w) / 2
            && Math.abs(a.y - b.y) < (fa.h + fb.h) / 2) {
            overlaps.push(`${a.kind}@${a.x},${a.y} × ${b.kind}@${b.x},${b.y}`);
          }
        }
      }
      return overlaps;
    };
    const buildSpotOverlaps = findFootprintOverlaps(initialBuildSpots);
    const mutableTuning = economy as unknown as { tune: { extraHouseSpots: number } };
    const previousExtraHouseSpots = mutableTuning.tune.extraHouseSpots;
    mutableTuning.tune.extraHouseSpots = 5;
    const expandedBuildSpots = economy.freeSpots();
    const expandedBuildSpotOverlaps = findFootprintOverlaps(expandedBuildSpots);
    mutableTuning.tune.extraHouseSpots = previousExtraHouseSpots;
    economy.resources.wood = 1_000;
    economy.resources.ore = 1_000;
    const houseSpots = economy.freeSpots().filter(s => s.kind === 'house');
    if (houseSpots.length < 2) throw new Error('House build spots are not configured');
    const targetHouseSpot = houseSpots[houseSpots.length - 1];
    const limitBeforeHouse = economy.pawnLimit;
    const woodBeforeHouse = economy.resources.wood;
    const existing = new Set(economy.buildings);
    const pawnContext = scene.registry.get('tss-pawnai-ctx') as { enemies: () => unknown[] };
    pawnContext.enemies = () => [];
    builder.x = targetHouseSpot.x;
    builder.y = targetHouseSpot.y;
    builder.order = 'build';
    builder.state = 'idle';
    builder.cooldown = 0;
    builder.carrying = null;
    builder.workNode = null;
    economy.pawnAI.updateCivilian(builder, 16, scene.time.now);
    const houseStarted = economy.buildings.some(b => b.kind === 'house' && !existing.has(b));
    // Тики симулируются синхронно, а Phaser AnimationState продвигается
    // отдельным игровым циклом. Повторяем AI-тик, пока анимация не активируется.
    for (let i = 1; i <= 8; i++) {
      economy.pawnAI.updateCivilian(builder, 16, scene.time.now + i * 16);
    }
    const houseBuildAnimation = builder.anims.currentAnim?.key ?? null;
    const house = economy.buildings.find(b => !existing.has(b) && b.kind === 'house');
    if (!house) throw new Error('Started house was not registered');

    const houseCost = woodBeforeHouse - economy.resources.wood;
    // Не даём тестовому рану запускать дополнительные стройки во время
    // ускоренного завершения проверяемого дома.
    economy.resources.wood = 0;
    economy.resources.ore = 0;
    builder.order = null;
    builder.x = targetHouseSpot.x;
    builder.y = targetHouseSpot.y;
    builder.state = 'work';
    economy.tick(10_001, scene.time.now + 10_001);
    builder.order = null;
    const houseFinished = house.alive && !house.underConstruction;
    const limitAfterHouse = economy.pawnLimit;
    // Measure the first-house bonus before this test intentionally destroys the house.
    const residentCountAfterHouse = economy.pawns.filter(p => !p.dead && p.kind === 'collector').length;

    const barracksSpot = economy.freeSpots().find(s => s.kind === 'barracks');
    if (!barracksSpot) throw new Error('Barracks build spot is missing');
    economy.resources.wood = 500;
    economy.resources.ore = 500;
    const woodBeforeBarracks = economy.resources.wood;
    const oreBeforeBarracks = economy.resources.ore;
    const limitBeforeBarracks = economy.pawnLimit;
    const startedBarracks = economy.tryStartBuild('barracks', builder, barracksSpot);
    const barracks = economy.buildings.find(b => !existing.has(b) && b.kind === 'barracks');
    if (!barracks) throw new Error('Started barracks was not registered');
    const barracksWoodCost = woodBeforeBarracks - economy.resources.wood;
    const barracksOreCost = oreBeforeBarracks - economy.resources.ore;
    builder.x = barracksSpot.x;
    builder.y = barracksSpot.y;
    builder.state = 'work';
    economy.tick(20_001, scene.time.now + 30_002);
    const garrisonHudText = scene.hud.garrisonText.text;

    economy.resources.wood = 100;
    house.hp = house.maxHp;
    house.underConstruction = false;
    const woodBeforeFullRepair = economy.resources.wood;
    const fullRepairAccepted = economy.repair(house, builder);
    const woodAfterFullRepair = economy.resources.wood;
    const woodBeforeCastleRepair = economy.resources.wood;
    const castleRepairAccepted = economy.repair(castle, builder);
    const woodAfterCastleRepair = economy.resources.wood;
    house.damage(20, -1);
    const damagedRepairAccepted = economy.repair(house, builder);
    const woodAfterDamagedRepair = economy.resources.wood;
    const repairFinished = economy.finishRepairInstant();
    const partiallyRepairedHp = house.hp;

    // Мгновенный ремонт должен восстанавливать не только HP, но и внешний вид
    // разрушенных руин — этот путь используется ускорением ремонта.
    house.damage(house.maxHp + 10, -1);
    const ruinsHp = house.hp;
    const ruinsAlpha = house.alpha;
    economy.resources.wood = 100;
    const woodBeforeRebuild = economy.resources.wood;
    const rebuildAccepted = economy.repair(house, builder);
    const woodAfterRebuild = economy.resources.wood;
    const rebuildFinished = economy.finishRepairInstant();

    // Gate L: разрушенные казармы требуют не только дерево, но и руду.
    barracks.damage(barracks.maxHp + 10, -1);
    economy.resources.wood = 100;
    economy.resources.ore = 0;
    const woodBeforeBarracksNoOre = economy.resources.wood;
    const barracksRebuildWithoutOre = economy.repair(barracks, builder);
    const woodAfterBarracksNoOre = economy.resources.wood;
    economy.resources.ore = 15;
    const woodBeforeBarracksRebuild = economy.resources.wood;
    const oreBeforeBarracksRebuild = economy.resources.ore;
    const barracksRebuildAccepted = economy.repair(barracks, builder);
    const woodAfterBarracksRebuild = economy.resources.wood;
    const oreAfterBarracksRebuild = economy.resources.ore;
    const barracksRebuildFinished = economy.finishRepairInstant();

    // Автоматический ремонтник (поведение позднейшей фазы L) чинит повреждённый дом.
    const repairer = economy.pawns.find(p => p.kind === 'repairer');
    if (!repairer) throw new Error('Automatic repair needs the initial repairer');
    house.damage(10, -1);
    economy.resources.wood = 100;
    const woodBeforeAutoRepair = economy.resources.wood;
    repairer.x = house.x;
    repairer.y = house.y;
    repairer.state = 'idle';
    repairer.order = null;
    repairer.cooldown = 0;
    repairer.carrying = null;
    repairer.carriedAmount = 0;
    repairer.workNode = null;
    repairer.taskProgress = 0;
    // Prevent an unrelated builder job from starting during the accelerated repair tick.
    builder.order = 'collect';
    economy.pawnAI.updateCivilian(repairer, 16, scene.time.now + 35_000);
    const automaticRepairStarted = house.underConstruction && economy.resources.wood === woodBeforeAutoRepair - 30;
    economy.tick(5_001, scene.time.now + 35_016);
    const automaticRepairFinished = !house.underConstruction && house.hp === house.maxHp;

    const prepareRepairer = (building: BuildingRuntime): void => {
      repairer.setPosition(building.x, building.y);
      repairer.state = 'idle';
      repairer.order = null;
      repairer.cooldown = 0;
      repairer.carrying = null;
      repairer.carriedAmount = 0;
      repairer.workNode = null;
      repairer.taskProgress = 0;
    };

    // Полное разрушение ставит underConstruction=true и hp=0, но не создаёт
    // buildJob. Автоматический ремонтник обязан отличить руины от активной стройки.
    house.damage(house.maxHp + 10, -1);
    economy.resources.wood = 100;
    const woodBeforeAutomaticHouseRebuild = economy.resources.wood;
    prepareRepairer(house);
    economy.pawnAI.updateCivilian(repairer, 16, scene.time.now + 36_000);
    const automaticHouseRebuildStarted = house.underConstruction
      && economy.resources.wood === woodBeforeAutomaticHouseRebuild - 60;
    economy.tick(10_001, scene.time.now + 36_016);
    const automaticHouseRebuildFinished = house.alive && !house.underConstruction && house.hp === house.maxHp;

    // Казармы требуют те же 60 дерева и ещё 15 руды, причём ресурсы списываются
    // атомарно до добавления repairJob.
    barracks.damage(barracks.maxHp + 10, -1);
    economy.resources.wood = 100;
    economy.resources.ore = 15;
    const woodBeforeAutomaticBarracksRebuild = economy.resources.wood;
    const oreBeforeAutomaticBarracksRebuild = economy.resources.ore;
    prepareRepairer(barracks);
    economy.pawnAI.updateCivilian(repairer, 16, scene.time.now + 47_000);
    const automaticBarracksRebuildStarted = barracks.underConstruction
      && economy.resources.wood === woodBeforeAutomaticBarracksRebuild - 60
      && economy.resources.ore === oreBeforeAutomaticBarracksRebuild - 15;
    economy.tick(10_001, scene.time.now + 47_016);
    const automaticBarracksRebuildFinished = barracks.alive
      && !barracks.underConstruction && barracks.hp === barracks.maxHp;
    builder.order = null;

    // Phase E fallback: gather inputs when the next structure is unaffordable,
    // then keep gathering even after every build spot is occupied.
    const fallbackTree = economy.nodes.find(n => n.kind === 'tree' && n.available);
    const blocker = economy.pawns.find(p => p.kind === 'collector');
    if (!fallbackTree || !blocker) throw new Error('Builder fallback needs a free tree and collector');
    for (const node of economy.nodes) {
      if (node.available && node !== fallbackTree) node.claimedBy = blocker;
    }
    fallbackTree.claimedBy = null;
    for (const spot of economy.freeSpots().filter(s => s.kind === 'house')) {
      economy.markSpot(spot.x, spot.y);
    }
    economy.resources.wood = 0;
    economy.resources.ore = 0;
    economy.resources.meat = 0;
    builder.x = fallbackTree.x;
    builder.y = fallbackTree.y;
    builder.state = 'idle';
    builder.order = null;
    builder.carrying = null;
    builder.carriedAmount = 0;
    builder.taskProgress = 0;
    builder.cooldown = 0;
    builder.workNode = null;
    economy.pawnAI.updateCivilian(builder, 3_999, scene.time.now + 40_000);
    const builderFallbackBeforeThreshold = builder.carrying;
    economy.pawnAI.updateCivilian(builder, 1, scene.time.now + 43_999);
    const builderFallbackCarry = builder.carrying;
    const builderFallbackAmount = builder.carriedAmount;

    // Fill remaining large-building spots and prove a fully occupied settlement
    // still sends the builder back to a resource node.
    builder.carrying = null;
    builder.carriedAmount = 0;
    builder.taskProgress = 0;
    builder.cooldown = 0;
    builder.workNode = null;
    for (const spot of economy.freeSpots()) economy.markSpot(spot.x, spot.y);
    // The first tree was depleted by the preceding fallback check; use a fresh reachable tree.
    const fullCapacityTree = economy.nodes.find(n => n.kind === 'tree' && n.available
      && Math.hypot(n.x - economy.castleX, n.y - economy.castleY) <= 1_000);
    if (!fullCapacityTree) throw new Error('Full-capacity fallback needs another reachable tree');
    for (const node of economy.nodes) {
      if (node.available && node !== fullCapacityTree) node.claimedBy = blocker;
    }
    fullCapacityTree.claimedBy = null;
    builder.x = fullCapacityTree.x;
    builder.y = fullCapacityTree.y;
    builder.state = 'idle';
    economy.resources.wood = 0;
    economy.resources.ore = 0;
    economy.resources.meat = 0;
    economy.pawnAI.updateCivilian(builder, 3_999, scene.time.now + 50_000);
    const builderFullBeforeThreshold = builder.carrying;
    economy.pawnAI.updateCivilian(builder, 1, scene.time.now + 53_999);
    const builderFullCapacityCarry = builder.carrying;
    const builderFullCapacityAmount = builder.carriedAmount;
    const freeSpotsWhenFull = economy.freeSpots().length;

    return {
      initialBuildSpotCount: initialBuildSpots.length,
      buildSpotOverlaps,
      expandedBuildSpotCount: expandedBuildSpots.length,
      expandedBuildSpotOverlaps,
      houseStarted,
      houseBuildAnimation,
      houseCost,
      houseX: house.x,
      houseY: house.y,
      expectedHouseX: targetHouseSpot.x,
      expectedHouseY: targetHouseSpot.y,
      houseFinished,
      limitBeforeHouse,
      limitAfterHouse,
      residentCountAfterHouse,
      startedBarracks,
      barracksWoodCost,
      barracksOreCost,
      barracksFinished: barracks.alive && !barracks.underConstruction,
      garrisonHudText,
      garrisonLimit: economy.garrisonLimit('barracks'),
      limitBeforeBarracks,
      limitAfterBarracks: economy.pawnLimit,
      fullRepairAccepted,
      woodBeforeFullRepair,
      woodAfterFullRepair,
      castleRepairAccepted,
      woodBeforeCastleRepair,
      woodAfterCastleRepair,
      damagedRepairAccepted,
      woodAfterDamagedRepair,
      repairFinished,
      partiallyRepairedHp,
      houseHpAfterRepair: house.hp,
      houseMaxHp: house.maxHp,
      ruinsHp,
      ruinsAlpha,
      rebuildAccepted,
      woodBeforeRebuild,
      woodAfterRebuild,
      rebuildFinished,
      barracksRebuildWithoutOre,
      woodBeforeBarracksNoOre,
      woodAfterBarracksNoOre,
      barracksRebuildAccepted,
      woodBeforeBarracksRebuild,
      woodAfterBarracksRebuild,
      oreBeforeBarracksRebuild,
      oreAfterBarracksRebuild,
      barracksRebuildFinished,
      rebuiltAlpha: house.alpha,
      rebuiltUnderConstruction: house.underConstruction,
      automaticRepairStarted,
      automaticRepairFinished,
      automaticHouseRebuildStarted,
      automaticHouseRebuildFinished,
      automaticBarracksRebuildStarted,
      automaticBarracksRebuildFinished,
      builderFallbackBeforeThreshold,
      builderFallbackCarry,
      builderFallbackAmount,
      builderFullBeforeThreshold,
      builderFullCapacityCarry,
      builderFullCapacityAmount,
      freeSpotsWhenFull,
    };
  });

  expect(report.initialBuildSpotCount).toBe(10);
  expect(report.buildSpotOverlaps).toEqual([]);
  expect(report.expandedBuildSpotCount).toBe(15);
  expect(report.expandedBuildSpotOverlaps).toEqual([]);
  expect(report.houseStarted).toBe(true);
  expect(report.houseBuildAnimation).toBe('pawny-work-hammer');
  expect(report.houseCost).toBe(30);
  expect(report.houseX).toBe(report.expectedHouseX);
  expect(report.houseY).toBe(report.expectedHouseY);
  expect(report.houseFinished).toBe(true);
  expect(report.limitAfterHouse).toBe(report.limitBeforeHouse + 1);
  expect(report.startedBarracks).toBe(true);
  expect(report.barracksWoodCost).toBe(40);
  expect(report.barracksOreCost).toBe(15);
  expect(report.barracksFinished).toBe(true);
  expect(report.garrisonLimit).toBe(2);
  expect(report.garrisonHudText).toMatch(/0\s*\/\s*2/);
  expect(report.limitAfterBarracks).toBe(report.limitBeforeBarracks);
  expect(report.fullRepairAccepted).toBe(false);
  expect(report.woodAfterFullRepair).toBe(report.woodBeforeFullRepair);
  expect(report.castleRepairAccepted).toBe(false);
  expect(report.woodAfterCastleRepair).toBe(report.woodBeforeCastleRepair);
  expect(report.damagedRepairAccepted).toBe(true);
  expect(report.woodAfterDamagedRepair).toBe(report.woodBeforeCastleRepair - 30);
  expect(report.repairFinished).toBe(true);
  expect(report.partiallyRepairedHp).toBe(report.houseMaxHp);
  expect(report.houseHpAfterRepair).toBe(report.houseMaxHp);
  expect(report.ruinsHp).toBe(0);
  expect(report.ruinsAlpha).toBeCloseTo(0.35, 2);
  expect(report.rebuildAccepted).toBe(true);
  expect(report.woodAfterRebuild).toBe(report.woodBeforeRebuild - 60);
  expect(report.rebuildFinished).toBe(true);
  expect(report.barracksRebuildWithoutOre).toBe(false);
  expect(report.woodAfterBarracksNoOre).toBe(report.woodBeforeBarracksNoOre);
  expect(report.barracksRebuildAccepted).toBe(true);
  expect(report.woodAfterBarracksRebuild).toBe(report.woodBeforeBarracksRebuild - 60);
  expect(report.oreAfterBarracksRebuild).toBe(report.oreBeforeBarracksRebuild - 15);
  expect(report.barracksRebuildFinished).toBe(true);
  expect(report.rebuiltAlpha).toBe(1);
  expect(report.rebuiltUnderConstruction).toBe(false);
  expect(report.automaticRepairStarted).toBe(true);
  expect(report.automaticRepairFinished).toBe(true);
  expect(report.automaticHouseRebuildStarted).toBe(true);
  expect(report.automaticHouseRebuildFinished).toBe(true);
  expect(report.automaticBarracksRebuildStarted).toBe(true);
  expect(report.automaticBarracksRebuildFinished).toBe(true);
  expect(report.builderFallbackBeforeThreshold).toBeNull();
  expect(report.builderFallbackCarry).toBe('wood');
  expect(report.builderFallbackAmount).toBe(5);
  expect(report.builderFullBeforeThreshold).toBeNull();
  expect(report.freeSpotsWhenFull).toBe(0);
  expect(report.builderFullCapacityCarry).toBe('wood');
  expect(report.builderFullCapacityAmount).toBe(5);
  expect(report.residentCountAfterHouse).toBeGreaterThanOrEqual(3);
});

test('phase K: flaming siege arrows use a bounded pool, visible trail and arrival callback', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await startRun(page);

  const report = await page.evaluate(() => {
    const game = (window as unknown as { __tss?: PhaserRuntime }).__tss;
    if (!game) throw new Error('Phaser game instance is unavailable');
    type TrailRuntime = { active: boolean; visible: boolean };
    type FireArrowRuntime = {
      active: boolean;
      visible: boolean;
      texture: { key: string };
      targetB: { x: number; y: number } | null;
      trailSprites?: TrailRuntime[];
      setPosition(x: number, y: number): unknown;
      isTinted?: boolean;
    };
    type ProjectilesRuntime = {
      size: number;
      enemyShots: { getChildren(): FireArrowRuntime[] };
      shootAtBuilding(
        kind: string, x: number, y: number, tx: number, ty: number,
        dmg: number, fire: boolean, onArrive: () => void,
      ): void;
      update(deltaMs: number): void;
      clear(): void;
    };
    const scene = game.scene.getScene('Game') as GameSceneRuntime & {
      projectiles: ProjectilesRuntime;
      spawner: { stopped: boolean };
    };
    scene.spawner.stopped = true;
    scene.projectiles.clear();
    const castle = scene.economy.buildings.find((building) => building.kind === 'castle');
    if (!castle) throw new Error('Castle is missing');
    const before = scene.projectiles.size;
    let arrivals = 0;
    scene.projectiles.shootAtBuilding(
      'hex', castle.x + 150, castle.y, castle.x, castle.y, 8, true, () => { arrivals++; },
    );
    const arrow = scene.projectiles.enemyShots.getChildren()
      .find((shot) => shot.active && shot.texture.key === 'arrow' && shot.targetB !== null);
    if (!arrow) throw new Error('Fire arrow was not created');
    const result = {
      sizeBefore: before,
      sizeAfter: scene.projectiles.size,
      arrowTexture: arrow.texture.key,
      trailCount: arrow.trailSprites?.length ?? 0,
      trailVisible: arrow.trailSprites?.every((flame) => flame.active && flame.visible) ?? false,
      animationExists: game.anims.exists('fire-arrow-trail'),
      tinted: arrow.isTinted ?? false,
      arrivals: 0,
    };
    arrow.setPosition(castle.x, castle.y);
    scene.projectiles.update(16);
    result.arrivals = arrivals;
    scene.projectiles.clear();
    return result;
  });

  expect(report.sizeAfter).toBe(report.sizeBefore + 1);
  expect(report.arrowTexture).toBe('arrow');
  expect(report.trailCount).toBe(3);
  expect(report.trailVisible).toBe(true);
  expect(report.animationExists).toBe(true);
  expect(report.tinted).toBe(false);
  expect(report.arrivals).toBe(1);
  expect(pageErrors).toEqual([]);
});

test('phase J: barracks hiring spends resources immediately and reserves slots while recruiting', async ({ page }) => {
  await startRun(page);

  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const scene = game.scene.getScene('Game') as GameSceneRuntime & {
      xp: number;
      score: number;
      addXp(value: number): void;
    };
    const economy = scene.economy as unknown as {
      resources: { wood: number; ore: number; meat: number };
      pawns: Array<PawnRuntime & { weapon?: string; cls?: string }>;
      buildings: BuildingRuntime[];
      freeSpots(): BuildSpotRuntime[];
      tryStartBuild(kind: string, pawn: PawnRuntime, spot: BuildSpotRuntime): boolean;
      canHire(weapon: 'sword' | 'lance'): boolean;
      hire(weapon: 'sword' | 'lance', building: BuildingRuntime): boolean;
      hireSlotUse(weapon: 'sword' | 'lance'): number;
      garrisonLimit(source: string): number;
      tick(dtMs: number, now: number): void;
    };
    const builder = economy.pawns.find((pawn) => pawn.kind === 'builder');
    const spot = economy.freeSpots().find((candidate) => candidate.kind === 'barracks');
    if (!builder || !spot) throw new Error('Builder or barracks spot is missing');
    economy.resources.wood = 1_000;
    economy.resources.ore = 1_000;
    economy.resources.meat = 1_000;
    const started = economy.tryStartBuild('barracks', builder, spot);
    const barracks = economy.buildings.find((building) => building.kind === 'barracks');
    if (!started || !barracks) throw new Error('Barracks construction could not start');
    builder.setPosition(spot.x, spot.y);
    builder.state = 'work';
    const buildXpAwards: number[] = [];
    const originalAddXp = scene.addXp.bind(scene);
    scene.addXp = (value: number) => {
      buildXpAwards.push(value);
      originalAddXp(value);
    };
    const scoreBeforeBarracks = scene.score;
    economy.tick(20_001, scene.time.now + 20_001);
    scene.addXp = originalAddXp;
    const barracksBuildScore = scene.score - scoreBeforeBarracks;

    const completed = barracks.alive && !barracks.underConstruction;
    const before = { ...economy.resources };
    const firstAvailable = economy.canHire('sword');
    const firstHired = economy.hire('sword', barracks);
    const afterFirst = { ...economy.resources };
    const slotsAfterFirst = economy.hireSlotUse('sword');
    const secondAvailable = economy.canHire('lance');
    const secondHired = economy.hire('lance', barracks);
    const afterSecond = { ...economy.resources };
    const slotsAfterSecond = economy.hireSlotUse('lance');
    const thirdAvailable = economy.canHire('sword');
    const thirdHired = economy.hire('sword', barracks);
    const afterThirdAttempt = { ...economy.resources };
    const limit = economy.garrisonLimit('barracks');
    economy.tick(10_001, scene.time.now + 30_002);
    const soldiers = economy.pawns
      .filter((pawn) => pawn.cls === 'garrison')
      .map((pawn) => pawn.weapon)
      .sort();
    return {
      completed,
      buildXpAwards,
      barracksBuildScore,
      limit,
      firstAvailable,
      firstHired,
      firstWoodCost: before.wood - afterFirst.wood,
      firstOreCost: before.ore - afterFirst.ore,
      firstMeatCost: before.meat - afterFirst.meat,
      slotsAfterFirst,
      secondAvailable,
      secondHired,
      secondWoodCost: afterFirst.wood - afterSecond.wood,
      secondOreCost: afterFirst.ore - afterSecond.ore,
      secondMeatCost: afterFirst.meat - afterSecond.meat,
      slotsAfterSecond,
      thirdAvailable,
      thirdHired,
      noCostForRejectedHire: afterThirdAttempt.wood === afterSecond.wood
        && afterThirdAttempt.ore === afterSecond.ore
        && afterThirdAttempt.meat === afterSecond.meat,
      soldiers,
    };
  });

  expect(report.completed).toBe(true);
  expect(report.buildXpAwards).toEqual([15]);
  expect(report.barracksBuildScore).toBe(50);
  expect(report.limit).toBe(2);
  expect(report.firstAvailable).toBe(true);
  expect(report.firstHired).toBe(true);
  expect(report.firstWoodCost).toBe(20);
  expect(report.firstOreCost).toBe(10);
  expect(report.firstMeatCost).toBe(5);
  expect(report.slotsAfterFirst).toBe(1);
  expect(report.secondAvailable).toBe(true);
  expect(report.secondHired).toBe(true);
  expect(report.secondWoodCost).toBe(20);
  expect(report.secondOreCost).toBe(10);
  expect(report.secondMeatCost).toBe(5);
  expect(report.slotsAfterSecond).toBe(2);
  expect(report.thirdAvailable).toBe(false);
  expect(report.thirdHired).toBe(false);
  expect(report.noCostForRejectedHire).toBe(true);
  expect(report.soldiers).toEqual(['lance', 'sword']);
});

test('phases K-L: siege wound caps, extinction delay, settlement score and ideal-victory gates match the rules', async ({ page }) => {
  await startRun(page);

  const report = await page.evaluate(async () => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const root = window.location.origin;
    const [data, constants] = await Promise.all([
      import(/* @vite-ignore */ new URL('/src/game/data.ts', root).href) as Promise<{
        SIEGE_SCHEDULE: Array<{ woundCap: number }>;
      }>,
      import(/* @vite-ignore */ new URL('/src/game/constants.ts', root).href) as Promise<{
        SCORE: { SETTLEMENT: number; POPULATION: number; RATING: number };
      }>,
    ]);
    type PawnRef = { kind: string; dead: boolean };
    type SettlementRef = {
      aliveBuildings: Array<unknown>;
      castle: { alive: boolean };
      settlementScore(): { defence: number; population: number; buildings: number; pawns: number };
      isIdealVictory(bossKilled: boolean): boolean;
      beginSiege(index: number, woundCap: number, enemies: unknown[]): void;
      canWoundInSiege(): boolean;
      registerWound(): void;
      checkExtinction(now: number): boolean;
      extinctAt: number | null;
    };
    const scene = game.scene.getScene('Game') as GameSceneRuntime & {
      settlement: SettlementRef;
      economy: EconomyRuntime & {
        pawns: PawnRef[];
        resources: { wood: number; ore: number; meat: number };
        houses: number;
        removePawn(pawn: PawnRef, paid?: boolean): void;
        spawnPawn(kind: string, x?: number, y?: number, announce?: boolean): PawnRef | null;
      };
    };

    const caps = data.SIEGE_SCHEDULE.map((profile) => profile.woundCap);
    const woundResults = caps.map((cap, index) => {
      scene.settlement.beginSiege(index, cap, []);
      const allowed: boolean[] = [];
      for (let n = 0; n < cap + 1; n++) {
        allowed.push(scene.settlement.canWoundInSiege());
        scene.settlement.registerWound();
      }
      return allowed;
    });

    // Удаление населения не должно само по себе начислять замену добровольно ушедшим;
    // здесь моделируется именно окончательная смерть, а не эмиграция из-за потери дома.
    for (const pawn of [...scene.economy.pawns]) scene.economy.removePawn(pawn, false);
    scene.economy.resources.wood = 30;
    const now = scene.time.now + 120_000;
    const atHomePrice = scene.settlement.checkExtinction(now);
    scene.economy.resources.wood = 29;
    const beforeNextCheck = scene.settlement.checkExtinction(now + 59_999);
    const atNextCheck = scene.settlement.checkExtinction(now + 60_000);

    const score = scene.settlement.settlementScore();
    const idealWithoutResidents = scene.settlement.isIdealVictory(true);
    for (let i = 0; i < 3; i++) {
      if (!scene.economy.spawnPawn('collector', undefined, undefined, false)) {
        throw new Error('Could not create residents for positive ideal-victory case');
      }
    }
    const scoreWithResidents = scene.settlement.settlementScore();
    const idealWithBossAndThree = scene.settlement.isIdealVictory(true);
    const idealWithoutBossAndThree = scene.settlement.isIdealVictory(false);
    return {
      caps,
      woundResults,
      houses: scene.economy.houses,
      pawnsBeforeIdealFixture: score.pawns,
      atHomePrice,
      beforeNextCheck,
      atNextCheck,
      extinctAtSet: scene.settlement.extinctAt !== null,
      score,
      scoreWithResidents,
      populationScoreDelta: scoreWithResidents.population - score.population,
      aliveBuildings: scene.settlement.aliveBuildings.length,
      idealWithBoss: idealWithoutResidents,
      idealWithoutBoss: scene.settlement.isIdealVictory(false),
      idealWithBossAndThree,
      idealWithoutBossAndThree,
      castleAlive: scene.settlement.castle.alive,
      scoreConstants: data.SIEGE_SCHEDULE.length > 0 ? constants.SCORE : null,
    };
  });

  expect(report.caps).toEqual([1, 1, 2, 2, 3]);
  expect(report.woundResults).toEqual([[true, false], [true, false], [true, true, false], [true, true, false], [true, true, true, false]]);
  expect(report.houses).toBe(0);
  expect(report.pawnsBeforeIdealFixture).toBe(0);
  expect(report.atHomePrice).toBe(false);
  expect(report.beforeNextCheck).toBe(false);
  expect(report.atNextCheck).toBe(true);
  expect(report.extinctAtSet).toBe(true);
  expect(report.score.defence).toBe(report.aliveBuildings * report.scoreConstants!.SETTLEMENT);
  expect(report.score.population).toBe(0);
  expect(report.idealWithBoss).toBe(false);
  expect(report.idealWithoutBoss).toBe(false);
  expect(report.idealWithBossAndThree).toBe(true);
  expect(report.idealWithoutBossAndThree).toBe(false);
  expect(report.populationScoreDelta).toBe(3 * report.scoreConstants!.POPULATION);
  expect(report.castleAlive).toBe(true);
});

test('phase J: sword taunt redirects siege damage only while HOLD is explicitly ordered', async ({ page }) => {
  await startRun(page);

  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const scene = game.scene.getScene('Game') as GameSceneRuntime & {
      settlement: {
        castle: BuildingRuntime;
        beginSiege(index: number, woundCap: number, enemies: unknown[]): void;
        damageBuilding(building: BuildingRuntime, raw: number, siegeIndex: number, isBoss?: boolean): void;
      };
      economy: EconomyRuntime & {
        pawns: Array<PawnRuntime & { weapon?: string; cls?: string; orderTarget?: { x: number; y: number } | null }>;
        hire(weapon: 'sword', building: BuildingRuntime): boolean;
      };
    };
    const economy = scene.economy;
    const builder = economy.pawns.find((pawn) => pawn.kind === 'builder');
    const spot = economy.freeSpots().find((candidate) => candidate.kind === 'barracks');
    if (!builder || !spot) throw new Error('Builder or barracks spot is missing');
    economy.resources.wood = 1_000;
    economy.resources.ore = 1_000;
    economy.resources.meat = 1_000;
    const buildStarted = economy.tryStartBuild('barracks', builder, spot);
    const barracks = economy.buildings.find((building) => building.kind === 'barracks');
    if (!buildStarted || !barracks) throw new Error('Barracks construction did not start');
    builder.setPosition(spot.x, spot.y);
    builder.state = 'work';
    economy.tick(20_001, scene.time.now + 20_001);
    const hired = economy.hire('sword', barracks);
    economy.tick(8_001, scene.time.now + 28_002);
    const sword = economy.pawns.find((pawn) => pawn.kind === 'fighter' && pawn.weapon === 'sword');
    if (!hired || !sword) throw new Error('Sword garrison was not recruited');

    const castle = scene.settlement.castle;
    sword.setPosition(castle.x + 100, castle.y);
    sword.state = 'fight';
    sword.hp = sword.maxHp;
    sword.order = null;
    sword.orderTarget = null;
    castle.hp = castle.maxHp;
    scene.settlement.beginSiege(0, 1, []);
    scene.settlement.damageBuilding(castle, 100, 0, false);
    const noOrder = {
      fighterDamage: sword.maxHp - sword.hp,
      buildingDamage: castle.maxHp - castle.hp,
    };

    sword.hp = sword.maxHp;
    sword.order = 'hold';
    sword.orderTarget = { x: castle.x, y: castle.y };
    castle.hp = castle.maxHp;
    scene.settlement.beginSiege(0, 1, []);
    scene.settlement.damageBuilding(castle, 100, 0, false);
    const holdOrder = {
      fighterDamage: sword.maxHp - sword.hp,
      buildingDamage: castle.maxHp - castle.hp,
    };

    return { noOrder, holdOrder };
  });

  expect(report.noOrder.fighterDamage).toBe(0);
  expect(report.noOrder.buildingDamage).toBeGreaterThan(0);
  expect(report.holdOrder.fighterDamage).toBeGreaterThan(0);
  expect(report.holdOrder.buildingDamage).toBeLessThan(report.noOrder.buildingDamage);
});

test('phase L: repair and siege callbacks award the specified XP and micro-score', async ({ page }) => {
  await startRun(page);
  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const scene = game.scene.getScene('Game') as GameSceneRuntime & {
      xp: number;
      xpNext: number;
      xpMult: number;
      level: number;
      score: number;
      economy: EconomyRuntime & { emit(event: string, ...args: unknown[]): boolean };
      settlement: {
        beginSiege(index: number, woundCap: number, enemies: unknown[]): void;
        endSiege(outcome: 'defended' | 'partial' | 'ignored'): void;
      };
    };
    scene.xp = 0;
    scene.xpNext = 10_000;
    scene.xpMult = 1;
    scene.level = 1;
    scene.score = 0;
    const building = scene.economy.buildings.find((candidate) => candidate.kind === 'castle');
    if (!building) throw new Error('Castle is missing');
    scene.economy.emit('repairDone', { building });
    const repairXp = scene.xp;
    const scoreAfterRepair = scene.score;

    scene.settlement.beginSiege(0, 1, []);
    scene.settlement.endSiege('defended');
    const defendedXp = scene.xp - repairXp;
    const defendedScore = scene.score - scoreAfterRepair;

    scene.settlement.beginSiege(0, 1, []);
    scene.settlement.endSiege('partial');
    const partialXp = scene.xp - repairXp - defendedXp;
    const partialScore = scene.score - scoreAfterRepair - defendedScore;
    return { repairXp, scoreAfterRepair, defendedXp, defendedScore, partialXp, partialScore };
  });

  expect(report.repairXp).toBe(8);
  expect(report.scoreAfterRepair).toBe(0);
  expect(report.defendedXp).toBe(40);
  expect(report.defendedScore).toBe(150);
  expect(report.partialXp).toBe(20);
  expect(report.partialScore).toBe(75);
});

test('phase L: assembly construction helper keeps and completes its assigned job', async ({ page }) => {
  await startRun(page);
  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const scene = game.scene.getScene('Game') as GameSceneRuntime & {
      spawner: { stopped: boolean };
      enemyGroup: { clear(removeFromScene?: boolean, destroyChildren?: boolean): void };
    };
    const economy = scene.economy;
    scene.spawner.stopped = true;
    scene.enemyGroup.clear(true, true);
    economy.resources.wood = 1_000;
    economy.resources.ore = 1_000;
    economy.resources.meat = 1_000;
    economy.applySettlementCard('assembly');

    const builder = economy.pawns.find((pawn) => pawn.kind === 'builder');
    const collector = economy.pawns.find((pawn) => pawn.kind === 'collector');
    if (!builder || !collector) throw new Error('Builder or collector is missing');

    const firstSpot = economy.pawnAI.pickBuildSpot(builder);
    if (!firstSpot || !economy.tryStartBuild(firstSpot.kind, builder, firstSpot)) {
      throw new Error('Could not reserve the builder job');
    }
    builder.setPosition(firstSpot.x, firstSpot.y);
    builder.state = 'work';
    builder.cooldown = 0;

    // pickBuildSpot returns the same target the collector's helper policy will select.
    const helperSpot = economy.pawnAI.pickBuildSpot(collector);
    if (!helperSpot) throw new Error('No free spot remains for the assembly helper');
    collector.setPosition(helperSpot.x, helperSpot.y);
    collector.state = 'idle';
    collector.cooldown = 0;
    collector.arrivalMs = 0;
    collector.order = null;
    collector.carrying = null;
    collector.carriedAmount = 0;
    collector.workNode = null;
    collector.taskProgress = 0;
    const claimedNode = economy.nodes.find((node) => node.available && !node.claimedBy);
    if (!claimedNode || !claimedNode.claim(collector)) throw new Error('Could not reserve a resource node for claim-release test');
    collector.workNode = claimedNode;

    const now = scene.time.now;
    economy.pawnAI.updateCivilian(collector, 16, now + 16);
    const helperJob = economy.buildJobs.find((job) => job.pawn === collector);
    if (!helperJob) throw new Error('Assembly did not assign the collector to construction');

    economy.pawnAI.updateCivilian(collector, 16, now + 32);
    const stayedAssigned = economy.buildJobs.some((job) => job.pawn === collector
      && job.building === helperJob.building) && collector.state === 'work';
    economy.tick(60_000, now + 60_032);
    const completed = helperJob.building.alive
      && !helperJob.building.underConstruction
      && helperJob.building.hp === helperJob.building.maxHp
      && !economy.buildJobs.some((job) => job.pawn === collector);

    return { stayedAssigned, completed, resourceClaimReleased: claimedNode.claimedBy === null };
  });

  expect(report.stayedAssigned).toBe(true);
  expect(report.completed).toBe(true);
  expect(report.resourceClaimReleased).toBe(true);
});

test('phase L: assembly repair helper keeps and completes its assigned job', async ({ page }) => {
  await startRun(page);
  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const scene = game.scene.getScene('Game') as GameSceneRuntime & {
      spawner: { stopped: boolean };
      enemyGroup: { clear(removeFromScene?: boolean, destroyChildren?: boolean): void };
    };
    const economy = scene.economy;
    scene.spawner.stopped = true;
    scene.enemyGroup.clear(true, true);
    economy.resources.wood = 1_000;
    economy.resources.ore = 1_000;
    economy.resources.meat = 1_000;

    const builder = economy.pawns.find((pawn) => pawn.kind === 'builder');
    const collector = economy.pawns.find((pawn) => pawn.kind === 'collector');
    const repairer = economy.pawns.find((pawn) => pawn.kind === 'repairer');
    const houseSpot = economy.freeSpots().find((spot) => spot.kind === 'house');
    if (!builder || !collector || !repairer || !houseSpot) {
      throw new Error('Builder, collector, repairer or house spot is missing');
    }

    const existingBuildings = new Set(economy.buildings);
    if (!economy.tryStartBuild('house', builder, houseSpot)) throw new Error('House construction did not start');
    builder.setPosition(houseSpot.x, houseSpot.y);
    builder.state = 'work';
    builder.cooldown = 0;
    const now = scene.time.now;
    economy.tick(20_001, now + 20_001);
    const house = economy.buildings.find((building) => !existingBuildings.has(building)
      && building.kind === 'house');
    if (!house || house.underConstruction) throw new Error('Test house did not finish construction');

    repairer.dead = true; // Force the «Вече» fallback to provide the repair labor.
    house.damage(10, -1);
    economy.applySettlementCard('assembly');
    economy.resources.wood = 100;
    collector.setPosition(house.x, house.y);
    collector.state = 'idle';
    collector.cooldown = 0;
    collector.arrivalMs = 0;
    collector.order = null;
    collector.carrying = null;
    collector.carriedAmount = 0;
    collector.workNode = null;
    collector.taskProgress = 0;
    const claimedNode = economy.nodes.find((node) => node.available && !node.claimedBy);
    if (!claimedNode || !claimedNode.claim(collector)) throw new Error('Could not reserve a resource node for repair claim-release test');
    collector.workNode = claimedNode;

    const woodBefore = economy.resources.wood;
    economy.pawnAI.updateCivilian(collector, 16, now + 20_017);
    const repairJob = economy.repairJobs.find((job) => job.pawn === collector && job.building === house);
    const paid = economy.resources.wood === woodBefore - 30;
    if (!repairJob) throw new Error('Assembly did not assign the collector to repair');

    economy.pawnAI.updateCivilian(collector, 16, now + 20_033);
    const stayedAssigned = economy.repairJobs.some((job) => job.pawn === collector
      && job.building === house) && collector.state === 'work';
    economy.tick(5_001, now + 25_034);
    const completed = house.hp === house.maxHp && !economy.repairJobs.some((job) => job.pawn === collector);

    return { paid, stayedAssigned, completed, resourceClaimReleased: claimedNode.claimedBy === null };
  });

  expect(report.paid).toBe(true);
  expect(report.stayedAssigned).toBe(true);
  expect(report.completed).toBe(true);
  expect(report.resourceClaimReleased).toBe(true);
});

test('phase L: settlement cards unlock after the first house, support rank II, and stop at rank II', async ({ page }) => {
  await startRun(page);
  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const scene = game.scene.getScene('Game') as GameSceneRuntime & {
      generateChoices(): Array<{ kind: string; id?: string; subtitle: string }>;
      economy: EconomyRuntime & {
        card(id: string): number;
        applySettlementCard(id: string): void;
      };
    };
    const before = scene.generateChoices();
    const builder = scene.economy.pawns.find((pawn) => pawn.kind === 'builder');
    const spot = scene.economy.freeSpots().find((candidate) => candidate.kind === 'house');
    if (!builder || !spot) throw new Error('Builder or house build spot is missing');
    scene.economy.resources.wood = 1_000;
    scene.economy.resources.ore = 1_000;
    scene.economy.resources.meat = 1_000;
    if (!scene.economy.tryStartBuild('house', builder, spot)) throw new Error('House construction did not start');
    const house = scene.economy.buildings.find((candidate) => candidate.kind === 'house' && candidate.underConstruction);
    if (!house) throw new Error('House was not registered');
    builder.setPosition(spot.x, spot.y);
    builder.state = 'work';
    scene.economy.tick(20_001, scene.time.now + 20_001);
    if (house.underConstruction || !house.alive) throw new Error('House was not completed');

    const afterHouse = scene.generateChoices();
    const settlementCard = afterHouse.find((card) => card.kind === 'settlement');
    if (!settlementCard?.id) throw new Error('Settlement card is missing after the first house');
    const id = settlementCard.id;
    scene.economy.applySettlementCard(id);
    const rankOne = scene.economy.card(id);
    scene.economy.applySettlementCard(id);
    const rankTwo = scene.economy.card(id);
    scene.economy.applySettlementCard(id);
    const rankThree = scene.economy.card(id);
    const afterRankTwo = scene.generateChoices();
    return {
      hadCardsBeforeHouse: before.some((card) => card.kind === 'settlement'),
      settlementCardCountAfterHouse: afterHouse.filter((card) => card.kind === 'settlement').length,
      id,
      rankOne,
      rankTwo,
      rankThree,
      cardOfferedAfterRankTwo: afterRankTwo.some((card) => card.kind === 'settlement' && card.id === id),
    };
  });

  expect(report.hadCardsBeforeHouse).toBe(false);
  expect(report.settlementCardCountAfterHouse).toBe(1);
  expect(report.id).toBeTruthy();
  expect(report.rankOne).toBe(1);
  expect(report.rankTwo).toBe(2);
  expect(report.rankThree).toBe(2);
  expect(report.cardOfferedAfterRankTwo).toBe(false);
});

test('phase L: all combo milestones grant their rewards without match-score inflation', async ({ page }) => {
  await startRun(page);
  const scoreBefore = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const scene = game.scene.getScene('Game') as GameSceneRuntime & {
      score: number;
      comboMilestones: readonly number[];
      comboMilestone(combo: number, x: number, y: number): void;
      runRng(): number;
      xpMagnetUntil: number;
      spawner: { stopped: boolean };
      enemyGroup: { clear(removeFromScene?: boolean, destroyChildren?: boolean): void };
    };
    scene.spawner.stopped = true;
    scene.enemyGroup.clear(true, true);
    scene.economy.resources.wood = 0;
    scene.economy.resources.ore = 0;
    scene.economy.resources.meat = 0;
    scene.comboMilestones = [25, 50, 100, 200];
    // Фиксируем ветку 50/50: первые две вехи всегда выдают ресурсы.
    scene.runRng = () => 0.1;
    const hero = scene.player as unknown as { hp: number; maxHp: number };
    hero.hp = 1;
    const initialScore = scene.score;
    for (const milestone of scene.comboMilestones) {
      scene.comboMilestone(milestone, scene.player.x, scene.player.y);
    }
    return initialScore;
  });

  await page.waitForTimeout(1_400);
  const result = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const scene = game.scene.getScene('Game') as GameSceneRuntime & {
      score: number;
      xpMagnetUntil: number;
      activeTimeMs: number;
      time: { now: number };
    };
    const hero = scene.player as unknown as { hp: number; maxHp: number };
    return {
      wood: scene.economy.resources.wood,
      ore: scene.economy.resources.ore,
      meat: scene.economy.resources.meat,
      score: scene.score,
      xpMagnetActive: scene.xpMagnetUntil > scene.activeTimeMs,
      heroFullyHealed: hero.hp === hero.maxHp,
    };
  });
  expect(result.wood).toBe(70);
  expect(result.ore).toBe(40);
  expect(result.meat).toBe(30);
  expect(result.score).toBe(scoreBefore);
  expect(result.xpMagnetActive).toBe(true);
  expect(result.heroFullyHealed).toBe(true);
});
test('phase L: rank II doubles numeric settlement-card effects and rank III cannot stack them', async ({ page }) => {
  await startRun(page);
  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime unavailable');
    type CardEconomy = EconomyRuntime & {
      card(id: string): number;
      applySettlementCard(id: string): void;
      workYield(resource: 'wood' | 'meat' | 'ore'): number;
      veinCharges(): number;
      pawnLimit: number;
      pawnAI: { bleedoutSec(): number };
      monastery: { healWoodMultiplier(): number };
    };
    const scene = game.scene.getScene('Game') as GameSceneRuntime & {
      economy: CardEconomy;
      spawner: { siegeAlarmSeconds(): number };
      siegeArrowDurationMs(): number;
      spawnEnemy(kind: string, x: number, y: number): boolean;
      enemyGroup: { getChildren(): Array<{ active: boolean; kind: string; ctx?: { siegeInterceptRadius(): number } }> };
      heroDpsAtTenMinutes: number | null;
      damageEnemyByPawn(enemy: unknown, damage: number, weapon: string): void;
    };
    const economy = scene.economy;
    const castle = economy.buildings.find((building) => building.kind === 'castle');
    const builder = economy.pawns.find((pawn) => pawn.kind === 'builder');
    const houseSpot = economy.freeSpots().find((spot) => spot.kind === 'house');
    if (!castle || !builder || !houseSpot) throw new Error('Castle, builder or house spot missing');
    economy.resources.wood = 100;
    economy.resources.ore = 100;
    economy.resources.meat = 100;
    if (!economy.tryStartBuild('house', builder, houseSpot)) throw new Error('House construction did not start');
    const house = economy.buildings.find((building) => building.kind === 'house' && building.underConstruction);
    if (!house) throw new Error('House was not registered');
    builder.setPosition(houseSpot.x, houseSpot.y);
    builder.state = 'work';
    economy.tick(10_001, scene.time.now + 10_001);
    if (house.underConstruction || !house.alive) throw new Error('House did not finish construction');
    const masonryBaseHp = castle.maxHp;
    const masonryHouseBaseHp = house.maxHp;
    economy.applySettlementCard('masonry');
    const masonryRankOneHp = castle.maxHp;
    const masonryHouseRankOneHp = house.maxHp;
    economy.applySettlementCard('masonry');
    const masonryRankTwoHp = castle.maxHp;
    const masonryHouseRankTwoHp = house.maxHp;
    economy.applySettlementCard('masonry');
    const masonryRankThreeHp = castle.maxHp;
    const masonryHouseRankThreeHp = house.maxHp;

    const assemblyBaseLimit = economy.pawnLimit;
    economy.applySettlementCard('assembly');
    const assemblyRankOneLimit = economy.pawnLimit;
    economy.applySettlementCard('assembly');
    const assemblyRankTwoLimit = economy.pawnLimit;
    economy.applySettlementCard('assembly');
    const assemblyRankThreeLimit = economy.pawnLimit;

    const woodBase = economy.workYield('wood');
    economy.applySettlementCard('forestry');
    const forestryRankOne = economy.workYield('wood');
    economy.applySettlementCard('forestry');
    const forestryRankTwo = economy.workYield('wood');

    const meatBase = economy.workYield('meat');
    economy.applySettlementCard('provisions');
    const provisionsRankOne = economy.workYield('meat');
    economy.applySettlementCard('provisions');
    const provisionsRankTwo = economy.workYield('meat');

    const veinBase = economy.veinCharges();
    economy.applySettlementCard('deepmines');
    const deepminesRankOne = economy.veinCharges();
    economy.applySettlementCard('deepmines');
    const deepminesRankTwo = economy.veinCharges();

    const bleedBase = economy.pawnAI.bleedoutSec();
    economy.applySettlementCard('fieldmedic');
    const fieldmedicRankOne = economy.pawnAI.bleedoutSec();
    const fieldmedicWoodRankOne = economy.monastery.healWoodMultiplier();
    economy.applySettlementCard('fieldmedic');
    const fieldmedicRankTwo = economy.pawnAI.bleedoutSec();
    const fieldmedicWoodRankTwo = economy.monastery.healWoodMultiplier();

    const alarmBase = scene.spawner.siegeAlarmSeconds();
    const arrowBase = scene.siegeArrowDurationMs();
    economy.applySettlementCard('alarm');
    const alarmRankOne = scene.spawner.siegeAlarmSeconds();
    const arrowRankOne = scene.siegeArrowDurationMs();
    economy.applySettlementCard('alarm');
    const alarmRankTwo = scene.spawner.siegeAlarmSeconds();
    const arrowRankTwo = scene.siegeArrowDurationMs();

    if (!scene.spawnEnemy('goblin', scene.player.x + 300, scene.player.y + 200)) {
      throw new Error('Could not spawn militia test enemy');
    }
    const enemy = scene.enemyGroup.getChildren().find((candidate) => candidate.active && candidate.kind === 'goblin');
    if (!enemy?.ctx) throw new Error('Spawned enemy context is missing');
    const radiusBase = enemy.ctx.siegeInterceptRadius();
    const dealt: number[] = [];
    scene.heroDpsAtTenMinutes = null;
    const dummy = {
      active: true, dead: false, def: { scale: 1 },
      x: scene.player.x + 50, y: scene.player.y + 50,
      takeDamage: (amount: number): boolean => { dealt.push(amount); return false; },
    };
    scene.damageEnemyByPawn(dummy, 40, 'sword');
    economy.applySettlementCard('militia');
    const radiusRankOne = enemy.ctx.siegeInterceptRadius();
    scene.damageEnemyByPawn(dummy, 40, 'sword');
    economy.applySettlementCard('militia');
    const radiusRankTwo = enemy.ctx.siegeInterceptRadius();
    scene.damageEnemyByPawn(dummy, 40, 'sword');

    return {
      masonryBaseHp, masonryRankOneHp, masonryRankTwoHp, masonryRankThreeHp,
      masonryHouseBaseHp, masonryHouseRankOneHp, masonryHouseRankTwoHp, masonryHouseRankThreeHp,
      assemblyBaseLimit, assemblyRankOneLimit, assemblyRankTwoLimit, assemblyRankThreeLimit,
      woodBase, forestryRankOne, forestryRankTwo,
      meatBase, provisionsRankOne, provisionsRankTwo,
      veinBase, deepminesRankOne, deepminesRankTwo,
      bleedBase, fieldmedicRankOne, fieldmedicRankTwo, fieldmedicWoodRankOne, fieldmedicWoodRankTwo,
      alarmBase, alarmRankOne, alarmRankTwo, arrowBase, arrowRankOne, arrowRankTwo,
      radiusBase, radiusRankOne, radiusRankTwo, dealt,
    };
  });

  expect(report.masonryRankOneHp).toBe(Math.round(report.masonryBaseHp * 1.15));
  expect(report.masonryRankTwoHp).toBe(Math.round(report.masonryBaseHp * 1.3));
  expect(report.masonryRankThreeHp).toBe(report.masonryRankTwoHp);
  expect(report.masonryHouseRankOneHp).toBe(Math.round(report.masonryHouseBaseHp * 1.15));
  expect(report.masonryHouseRankTwoHp).toBe(Math.round(report.masonryHouseBaseHp * 1.3));
  expect(report.masonryHouseRankThreeHp).toBe(report.masonryHouseRankTwoHp);
  expect(report.assemblyRankOneLimit).toBe(report.assemblyBaseLimit + 1);
  expect(report.assemblyRankTwoLimit).toBe(report.assemblyBaseLimit + 2);
  expect(report.assemblyRankThreeLimit).toBe(report.assemblyRankTwoLimit);
  expect(report.forestryRankOne).toBe(Math.round(report.woodBase * 1.2));
  expect(report.forestryRankTwo).toBe(Math.round(report.woodBase * 1.4));
  expect(report.provisionsRankOne).toBe(Math.round(report.meatBase * 4 / 3));
  expect(report.provisionsRankTwo).toBe(Math.round(report.meatBase * 5 / 3));
  expect(report.deepminesRankOne).toBe(report.veinBase + 1);
  expect(report.deepminesRankTwo).toBe(report.veinBase + 2);
  expect(report.fieldmedicRankOne).toBe(report.bleedBase + 15);
  expect(report.fieldmedicRankTwo).toBe(report.bleedBase + 30);
  expect(report.fieldmedicWoodRankOne).toBeCloseTo(0.75, 5);
  expect(report.fieldmedicWoodRankTwo).toBeCloseTo(0.5, 5);
  expect(report.alarmBase).toBe(5);
  expect(report.alarmRankOne).toBe(8);
  expect(report.alarmRankTwo).toBe(11);
  expect(report.arrowBase).toBe(3_000);
  expect(report.arrowRankOne).toBe(5_000);
  expect(report.arrowRankTwo).toBe(7_000);
  expect(report.radiusBase).toBe(260);
  expect(report.radiusRankOne).toBe(300);
  expect(report.radiusRankTwo).toBe(340);
  expect(report.dealt).toEqual([40, 50, 60]);
});

test('phase L: resident respawn requires a house, waits 25 seconds, and retries after missing resources', async ({ page }) => {
  await startRun(page);

  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const scene = game.scene.getScene('Game') as GameSceneRuntime & {
      spawner: { stopped: boolean };
      economy: EconomyRuntime & {
        resources: { wood: number; ore: number; meat: number };
        houses: number;
        pawnAI: { updateCivilian(pawn: PawnRuntime, dtMs: number, now: number): void };
        removePawn(pawn: PawnRuntime, paid?: boolean): void;
      };
    };
    const economy = scene.economy;
    scene.spawner.stopped = true;

    // Pause only civilian AI for deterministic timing; Economy still processes
    // build jobs, resource payment and the actual resident respawn queue.
    const ai = economy.pawnAI;
    const originalUpdateCivilian = ai.updateCivilian.bind(ai);
    ai.updateCivilian = () => {};
    const living = (): number => economy.pawns.filter((pawn) => !pawn.dead).length;
    const firstVictim = economy.pawns.find((pawn) => !pawn.dead && pawn.kind === 'collector');
    if (!firstVictim) throw new Error('Initial collector is missing');

    economy.removePawn(firstVictim, true);
    const livingAfterFirstDeath = living();
    economy.resources.wood = 100;
    economy.resources.meat = 100;
    economy.tick(25_000, scene.time.now + 25_000);
    const livingAfterNoHouseDeadline = living();
    const housesWithoutHome = economy.houses;

    const builder = economy.pawns.find((pawn) => !pawn.dead && pawn.kind === 'builder');
    const houseSpot = economy.freeSpots().find((spot) => spot.kind === 'house');
    if (!builder || !houseSpot) throw new Error('Builder or house spot is missing');
    economy.resources.wood = 100;
    economy.resources.ore = 100;
    economy.resources.meat = 100;
    if (!economy.tryStartBuild('house', builder, houseSpot)) throw new Error('Could not start house construction');
    const house = economy.buildings.find((building) => building.kind === 'house' && building.underConstruction);
    if (!house) throw new Error('House was not registered');
    builder.setPosition(houseSpot.x, houseSpot.y);
    builder.state = 'work';
    economy.tick(10_001, scene.time.now + 35_001);
    if (!house.alive || house.underConstruction || economy.houses !== 1) {
      throw new Error('House did not finish construction');
    }

    const secondVictim = economy.pawns.find((pawn) => !pawn.dead && pawn.kind === 'collector');
    if (!secondVictim) throw new Error('No collector available for the resource retry test');
    economy.removePawn(secondVictim, true);
    economy.resources.wood = 0;
    economy.resources.meat = 0;
    economy.tick(25_000, scene.time.now + 60_001);
    const livingAtInsufficientResources = living();
    economy.tick(4_999, scene.time.now + 65_000);
    const livingBeforeResourceRetry = living();
    economy.resources.wood = 10;
    economy.resources.meat = 3;
    economy.tick(1, scene.time.now + 65_001);
    const livingAfterResourceRetry = living();
    const resourcesAfterRetry = { wood: economy.resources.wood, meat: economy.resources.meat };

    const thirdVictim = economy.pawns.find((pawn) => !pawn.dead && pawn.kind === 'collector');
    if (!thirdVictim) throw new Error('Respawned collector is missing for exact-timer test');
    economy.removePawn(thirdVictim, true);
    economy.resources.wood = 10;
    economy.resources.meat = 3;
    economy.tick(24_999, scene.time.now + 90_000);
    const livingBeforeExactDeadline = living();
    economy.tick(1, scene.time.now + 90_001);
    const livingAtExactDeadline = living();
    const resourcesAfterExactRespawn = { wood: economy.resources.wood, meat: economy.resources.meat };

    ai.updateCivilian = originalUpdateCivilian;
    return {
      housesWithoutHome,
      livingAfterFirstDeath,
      livingAfterNoHouseDeadline,
      houseCount: economy.houses,
      livingAtInsufficientResources,
      livingBeforeResourceRetry,
      livingAfterResourceRetry,
      resourcesAfterRetry,
      livingBeforeExactDeadline,
      livingAtExactDeadline,
      resourcesAfterExactRespawn,
    };
  });

  expect(report.housesWithoutHome).toBe(0);
  expect(report.livingAfterNoHouseDeadline).toBe(report.livingAfterFirstDeath);
  expect(report.houseCount).toBe(1);
  expect(report.livingBeforeResourceRetry).toBe(report.livingAtInsufficientResources);
  expect(report.livingAfterResourceRetry).toBe(report.livingBeforeResourceRetry + 1);
  expect(report.resourcesAfterRetry).toEqual({ wood: 0, meat: 0 });
  expect(report.livingBeforeExactDeadline).toBe(report.livingAfterResourceRetry - 1);
  expect(report.livingAtExactDeadline).toBe(report.livingBeforeExactDeadline + 1);
  expect(report.resourcesAfterExactRespawn).toEqual({ wood: 0, meat: 0 });
});

test('phase K: siege profiles target outer houses and fall back from monastery to houses', async ({ page }) => {
  await startRun(page);
  const report = await page.evaluate(async () => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const root = window.location.origin;
    const data = await import(/* @vite-ignore */ new URL('/src/game/data.ts', root).href) as {
      SIEGE_SCHEDULE: Array<{ target: string }>;
    };
    type SiegeUnit = { active: boolean; kind: string; buildingTarget: unknown };
    const scene = game.scene.getScene('Game') as GameSceneRuntime & {
      spawner: { stopped: boolean };
      settlement: { castle: BuildingRuntime };
      assignSiegeTarget(profile: { target: string }, enemies: SiegeUnit[]): void;
      spawnEnemy(kind: string, x: number, y: number): boolean;
      enemyGroup: { getChildren(): SiegeUnit[] };
    };
    const economy = scene.economy;
    scene.spawner.stopped = true;
    economy.resources.wood = 1_000;
    economy.resources.ore = 1_000;
    economy.resources.meat = 1_000;

    const builder = economy.pawns.find((pawn) => pawn.kind === 'builder');
    const houseSpot = economy.freeSpots().find((spot) => spot.kind === 'house');
    if (!builder || !houseSpot) throw new Error('Builder or house spot is missing');
    if (!economy.tryStartBuild('house', builder, houseSpot)) throw new Error('Could not start outer house');
    const house = economy.buildings.find((building) => building.kind === 'house' && building.underConstruction);
    if (!house) throw new Error('House was not registered');
    builder.setPosition(houseSpot.x, houseSpot.y);
    builder.state = 'work';
    economy.tick(10_001, scene.time.now + 10_001);
    if (!house.alive || house.underConstruction) throw new Error('House did not finish');

    if (!scene.spawnEnemy('skull', scene.player.x + 450, scene.player.y + 320)) {
      throw new Error('Could not spawn siege-target test enemy');
    }
    const enemy = scene.enemyGroup.getChildren().find((candidate) =>
      candidate.active && candidate.kind === 'skull');
    if (!enemy) throw new Error('Spawned skull was not found');

    const secondHouseSpot = economy.freeSpots().find((spot) => spot.kind === 'house');
    if (!secondHouseSpot || !economy.tryStartBuild('house', builder, secondHouseSpot)) {
      throw new Error('Could not start second house for reconnaissance split');
    }
    const secondHouse = economy.buildings.find((building) =>
      building.kind === 'house' && building.underConstruction && building !== house);
    if (!secondHouse) throw new Error('Second house was not registered');
    builder.setPosition(secondHouseSpot.x, secondHouseSpot.y);
    builder.state = 'work';
    economy.tick(10_001, scene.time.now + 20_002);
    if (!secondHouse.alive || secondHouse.underConstruction) throw new Error('Second house did not finish');

    const scoutUnits = Array.from({ length: 3 }, () => ({
      active: true,
      kind: 'skull',
      buildingTarget: null as unknown,
    }));
    scene.assignSiegeTarget(data.SIEGE_SCHEDULE[0], scoutUnits);
    const scoutTargetsTwoHouses = scoutUnits.filter((unit) => unit.buildingTarget === house).length === 2
      && scoutUnits.filter((unit) => unit.buildingTarget === secondHouse).length === 1;

    const barracksSpot = economy.freeSpots().find((spot) => spot.kind === 'barracks');
    if (!barracksSpot || !economy.tryStartBuild('barracks', builder, barracksSpot)) {
      throw new Error('Could not start barracks for split-target siege profiles');
    }
    const barracks = economy.buildings.find((building) => building.kind === 'barracks' && building.underConstruction);
    if (!barracks) throw new Error('Barracks was not registered');
    builder.setPosition(barracksSpot.x, barracksSpot.y);
    builder.state = 'work';
    economy.tick(30_001, scene.time.now + 40_002);
    if (!barracks.alive || barracks.underConstruction) throw new Error('Barracks did not finish');

    const raidUnits = Array.from({ length: 5 }, () => ({
      active: true,
      kind: 'skull',
      buildingTarget: null as unknown,
    }));
    scene.assignSiegeTarget(data.SIEGE_SCHEDULE[1], raidUnits);
    const raidTargetSplit = raidUnits.filter((unit) => unit.buildingTarget === house).length === 3
      && raidUnits.filter((unit) => unit.buildingTarget === barracks).length === 2;

    const pincerUnits = Array.from({ length: 10 }, () => ({
      active: true,
      kind: 'skull',
      buildingTarget: null as unknown,
    }));
    scene.assignSiegeTarget(data.SIEGE_SCHEDULE[3], pincerUnits);
    const pincerTargetSplit = pincerUnits.filter((unit) => unit.buildingTarget === house).length === 5
      && pincerUnits.filter((unit) => unit.buildingTarget === barracks).length === 5;

    scene.assignSiegeTarget(data.SIEGE_SCHEDULE[2], [enemy]);
    const burnFallsBackToHouse = enemy.buildingTarget === house;

    const monasterySpot = economy.freeSpots().find((spot) => spot.kind === 'monastery');
    if (!monasterySpot) throw new Error('Monastery spot is missing');
    if (!economy.tryStartBuild('monastery', builder, monasterySpot)) throw new Error('Could not start monastery');
    const monastery = economy.buildings.find((building) => building.kind === 'monastery' && building.underConstruction);
    if (!monastery) throw new Error('Monastery was not registered');
    builder.setPosition(monasterySpot.x, monasterySpot.y);
    builder.state = 'work';
    economy.tick(25_001, scene.time.now + 35_002);
    if (!monastery.alive || monastery.underConstruction) throw new Error('Monastery did not finish');

    scene.assignSiegeTarget(data.SIEGE_SCHEDULE[2], [enemy]);
    const burnTargetsMonastery = enemy.buildingTarget === monastery;
    scene.assignSiegeTarget(data.SIEGE_SCHEDULE[4], [enemy]);
    const assaultTargetsCastle = enemy.buildingTarget === scene.settlement.castle;

    return { scoutTargetsTwoHouses, raidTargetSplit, pincerTargetSplit, burnFallsBackToHouse, burnTargetsMonastery, assaultTargetsCastle };
  });

  expect(report.scoutTargetsTwoHouses).toBe(true);
  expect(report.raidTargetSplit).toBe(true);
  expect(report.pincerTargetSplit).toBe(true);
  expect(report.burnFallsBackToHouse).toBe(true);
  expect(report.burnTargetsMonastery).toBe(true);
  expect(report.assaultTargetsCastle).toBe(true);
});


test('phase K: siege attack window expires even while the hero is intercepting the attackers', async ({ page }) => {
  await startRun(page);
  // Enemy.preUpdate() намеренно замирает, пока открыт обучающий overlay FTUE:
  // пауза сцены останавливает и AI осады. Без закрытия подсказки срок окна
  // атаки не истекает и юнит остаётся в группе — проверять тут нечего.
  await continueInitialTutorial(page);

  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    type SiegeEnemyRuntime = {
      active: boolean;
      kind: string;
      siege: boolean;
      buildingTarget: unknown;
      attackWindowEnds: number;
      spawnedAt: number;
      setPosition(x: number, y: number): unknown;
      preUpdate(time: number, delta: number): void;
    };
    const scene = game.scene.getScene('Game') as GameSceneRuntime & {
      activeTimeMs: number;
      spawner: { stopped: boolean };
      spawnSiegeUnit(kind: string, x: number, y: number, firer: boolean): SiegeEnemyRuntime | null;
      enemyGroup: { getChildren(): SiegeEnemyRuntime[] };
      settlement: { castle: BuildingRuntime };
    };
    scene.spawner.stopped = true;
    const activeNow = scene.activeTimeMs;
    const enemy = scene.spawnSiegeUnit('skull', scene.player.x + 40, scene.player.y, false);
    if (!enemy) throw new Error('Could not spawn siege interception fixture');
    enemy.buildingTarget = scene.settlement.castle;
    enemy.siege = true;
    enemy.spawnedAt = activeNow - 20_000;
    enemy.attackWindowEnds = activeNow - 1;

    // Враг находится внутри радиуса перехвата. Просроченное окно всё равно
    // должно завершить осаду раньше, чем AI выберет погоню за героем.
    enemy.preUpdate(scene.time.now, 16);
    return {
      active: enemy.active,
      siege: enemy.siege,
      remainsInGroup: scene.enemyGroup.getChildren().includes(enemy),
    };
  });

  expect(report.active).toBe(false);
  expect(report.siege).toBe(false);
  expect(report.remainsInGroup).toBe(false);
});


test('phase K: siege deadlines use active gameplay time across an FTUE overlay pause', async ({ page }) => {
  await startRun(page);
  await continueInitialTutorial(page);

  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    type SiegeEnemyRuntime = {
      active: boolean;
      siege: boolean;
      buildingTarget: unknown;
      spawnedAt: number;
      attackWindowEnds: number;
      preUpdate(time: number, delta: number): void;
    };
    const scene = game.scene.getScene('Game') as GameSceneRuntime & {
      activeTimeMs: number;
      hintOverlayPaused: boolean;
      update(time: number, delta: number): void;
      player: { x: number; y: number; hp: number; iframesUntil: number };
      hurtPlayer(amount: number): void;
      siegeAlive: boolean;
      spawnSiegeUnit(kind: string, x: number, y: number, firer: boolean): SiegeEnemyRuntime | null;
      enemyGroup: { getChildren(): SiegeEnemyRuntime[] };
      siegeTick(ignoredWallTime?: number): void;
      settlement: {
        castle: BuildingRuntime;
        beginSiege(index: number, woundCap: number, enemies: SiegeEnemyRuntime[]): void;
      };
    };
    const activeNow = scene.activeTimeMs;
    const playerHpBefore = scene.player.hp;
    scene.player.iframesUntil = activeNow + 3000;
    const registeredActiveNow = Number(scene.registry.get('tss-active-time-ms'));
    const castle = scene.settlement.castle;
    const windowEnemy = scene.spawnSiegeUnit('skull', castle.x + 150, castle.y, false);
    const lifetimeEnemy = scene.spawnSiegeUnit('skull', castle.x + 170, castle.y + 20, false);
    if (!windowEnemy || !lifetimeEnemy) throw new Error('Could not spawn siege pause fixtures');

    windowEnemy.buildingTarget = castle;
    windowEnemy.siege = true;
    windowEnemy.spawnedAt = activeNow - 45_000;
    windowEnemy.attackWindowEnds = activeNow + 10_000;

    lifetimeEnemy.buildingTarget = castle;
    lifetimeEnemy.siege = true;
    lifetimeEnemy.spawnedAt = activeNow - 45_000;
    lifetimeEnemy.attackWindowEnds = activeNow + 180_000;
    scene.settlement.beginSiege(2, 2, [windowEnemy, lifetimeEnemy]);
    scene.siegeAlive = true;

    // Моделируем 120 секунд системного времени под блокирующей подсказкой
    // синтетическим скачком timestamp: игровая симуляция и её часы не тикают.
    scene.hintOverlayPaused = true;
    scene.registry.set('tss-hint-overlay-paused', true);
    scene.registry.set('tss-freeze', 0);
    scene.time.paused = true;
    scene.physics.world.pause();
    const futureTime = activeNow + 120_000;
    const originalWallTime = scene.time.now;
    scene.time.now = futureTime + 16;
    scene.update(futureTime, 120_000);
    const activeTimeDuringPause = scene.activeTimeMs;
    windowEnemy.preUpdate(futureTime, 16);
    lifetimeEnemy.preUpdate(futureTime, 16);

    scene.hintOverlayPaused = false;
    scene.registry.set('tss-hint-overlay-paused', false);
    scene.time.paused = false;
    scene.physics.world.resume();
    scene.update(futureTime + 16, 16);
    windowEnemy.preUpdate(futureTime + 16, 16);
    lifetimeEnemy.preUpdate(futureTime + 16, 16);
    // Дополнительный аргумент отражает wall-clock timestamp движка; production
    // siegeTick обязан игнорировать его и брать значение activeTimeMs.
    scene.siegeTick(futureTime + 16);
    scene.hurtPlayer(10);
    const playerHpAfterResume = scene.player.hp;
    const iframeStillActive = scene.player.iframesUntil > scene.activeTimeMs;
    scene.time.now = originalWallTime;

    return {
      activeNow,
      playerHpBefore,
      playerHpAfterResume,
      iframeStillActive,
      registeredActiveNow,
      activeTimeDuringPause,
      activeTimeAfter: scene.activeTimeMs,
      attackWindowStillActive: windowEnemy.siege,
      windowEnemyInGroup: scene.enemyGroup.getChildren().includes(windowEnemy),
      lifetimeEnemyInGroup: scene.enemyGroup.getChildren().includes(lifetimeEnemy),
    };
  });

  expect(report.registeredActiveNow).toBe(report.activeNow);
  expect(report.activeTimeDuringPause).toBe(report.activeNow);
  expect(report.playerHpAfterResume).toBe(report.playerHpBefore);
  expect(report.iframeStillActive).toBe(true);
  expect(report.activeTimeAfter).toBe(report.activeNow + 16);
  expect(report.attackWindowStillActive).toBe(true);
  expect(report.windowEnemyInGroup).toBe(true);
  expect(report.lifetimeEnemyInGroup).toBe(true);
});


test('phase K: building fire pauses with gameplay and applies exactly three DoT over six active seconds', async ({ page }) => {
  await startRun(page);
  await continueInitialTutorial(page);

  const initial = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const scene = game.scene.getScene('Game') as GameSceneRuntime & {
      spawner: { stopped: boolean };
    };
    scene.spawner.stopped = true;
    const economy = scene.economy;
    economy.resources.wood = 1_000;
    economy.resources.ore = 1_000;
    economy.resources.meat = 1_000;
    const builder = economy.pawns.find((pawn) => pawn.kind === 'builder');
    const spot = economy.freeSpots().find((candidate) => candidate.kind === 'house');
    if (!builder || !spot || !economy.tryStartBuild('house', builder, spot)) {
      throw new Error('Could not build the house required for the fire timer test');
    }
    const building = economy.buildings.find((candidate) => candidate.kind === 'house' && candidate.underConstruction);
    if (!building) throw new Error('House construction object is missing');
    builder.setPosition(spot.x, spot.y);
    builder.state = 'work';
    economy.tick(10_001, scene.time.now + 10_001);
    if (!building.alive || building.underConstruction) throw new Error('Test house did not finish');
    (building as unknown as { __e2eFireTarget: boolean }).__e2eFireTarget = true;
    // Пауза включается до ignite, чтобы кадр между созданием таймера и pause
    // не списывал часть исходного интервала.
    scene.hintOverlayPaused = true;
    building.ignite(0);
    return { remaining: (building as unknown as { burnRemainingMs: number }).burnRemainingMs };
  });
  expect(initial.remaining).toBe(6_000);

  await page.waitForTimeout(700);
  const duringPause = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss!;
    const scene = game.scene.getScene('Game') as GameSceneRuntime;
    const building = scene.economy.buildings.find((candidate) => (candidate as unknown as { __e2eFireTarget?: boolean }).__e2eFireTarget === true);
    return building ? (building as unknown as { burnRemainingMs: number }).burnRemainingMs : -1;
  });
  expect(duringPause).toBe(6_000);

  await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss!;
    (game.scene.getScene('Game') as GameSceneRuntime & { hintOverlayPaused: boolean }).hintOverlayPaused = false;
  });
  await expect.poll(async () => page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss!;
    const scene = game.scene.getScene('Game') as GameSceneRuntime;
    const building = scene.economy.buildings.find((candidate) => (candidate as unknown as { __e2eFireTarget?: boolean }).__e2eFireTarget === true);
    return building ? (building as unknown as { burnRemainingMs: number }).burnRemainingMs : -1;
  }), { timeout: 3_000 }).toBeLessThan(6_000);

  const damageTotal = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss!;
    const scene = game.scene.getScene('Game') as GameSceneRuntime;
    const building = scene.economy.buildings.find((candidate) => (candidate as unknown as { __e2eFireTarget?: boolean }).__e2eFireTarget === true);
    if (!building) throw new Error('House disappeared during fire timer test');
    const burn = building as unknown as {
      burnRemainingMs: number;
      tickBurn(dtMs: number): number;
    };
    // Перезапускаем таймер, чтобы точно проверить полный интервал, независимо
    // от того, сколько кадров прошло между восстановлением симуляции и замером.
    building.ignite(0);
    // Повторный прямой вызов проверяет математику DoT при фиксированном полном
    // интервале; предыдущие assertions отдельно проверяют реальный отсчёт и паузу.
    burn.burnRemainingMs = 6_000;
    const first = burn.tickBurn(5_500);
    const remainingAfterFirst = burn.burnRemainingMs;
    const last = burn.tickBurn(5_000); // только оставшиеся 500 мс могут нанести урон
    const afterExpiry = burn.tickBurn(5_000);
    return {
      first,
      remainingAfterFirst,
      last,
      afterExpiry,
      remaining: burn.burnRemainingMs,
      total: first + last + afterExpiry,
    };
  });
  expect(damageTotal.first).toBeCloseTo(2.75, 5);
  expect(damageTotal.remainingAfterFirst).toBe(500);
  expect(damageTotal.last).toBeCloseTo(0.25, 5);
  expect(damageTotal.afterExpiry).toBe(0);
  expect(damageTotal.remaining).toBe(0);
  expect(damageTotal.total).toBeCloseTo(3, 5);
});


test('phase K: ranged siege units start the ten-second attack window at their firing distance', async ({ page }) => {
  await startRun(page);
  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    type SiegeEnemyRuntime = {
      active: boolean;
      kind: string;
      siege: boolean;
      buildingTarget: unknown;
      attackWindowEnds: number;
      spawnedAt: number;
      setPosition(x: number, y: number): unknown;
    };
    const scene = game.scene.getScene('Game') as GameSceneRuntime & {
      spawner: { stopped: boolean };
      siegeAlive: boolean;
      activeTimeMs: number;
      spawnSiegeUnit(kind: string, x: number, y: number, firer: boolean): SiegeEnemyRuntime | null;
      siegeTick(now?: number): void;
      settlement: {
        castle: BuildingRuntime;
        siegeIdx: number;
        beginSiege(index: number, woundCap: number, enemies: SiegeEnemyRuntime[]): void;
      };
    };
    scene.spawner.stopped = true;
    const castle = scene.settlement.castle;
    const now = scene.time.now;
    const activeNow = scene.activeTimeMs;
    const ranged = scene.spawnSiegeUnit('shaman', castle.x + 320, castle.y, true);
    if (!ranged) throw new Error('Could not spawn ranged siege fixture');
    ranged.buildingTarget = castle;
    scene.settlement.beginSiege(2, 2, [ranged]);
    scene.siegeAlive = true;
    scene.siegeTick(now);
    return { deadline: ranged.attackWindowEnds, now: activeNow, distance: Math.hypot(ranged.x - castle.x, ranged.y - castle.y) };
  });
  expect(report.distance).toBeLessThan(330);
  expect(report.deadline).toBe(report.now + 10_000);
});



test('phase K: siege building-attack cadence matches the documented DPS budget', async ({ page }) => {
  await startRun(page);
  const cadence = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    type CadenceEnemy = {
      active: boolean;
      kind: string;
      siege: boolean;
      buildingTarget: unknown;
      attackWindowEnds: number;
    };
    type RuntimeScene = GameSceneRuntime & {
      player: { setPosition(x: number, y: number): unknown };
      settlement: { castle: BuildingRuntime };
      spawnSiegeUnit(kind: string, x: number, y: number, firer: boolean): CadenceEnemy | null;
      enemyGroup: { remove(child: unknown, removeFromScene?: boolean, destroyChild?: boolean): void };
    };
    type RuntimeEnemy = {
      updateSiege(time: number, delta: number): void;
      buildingAtkCd: number;
      ctx: Record<string, unknown> & {
        playerX: () => number;
        playerY: () => number;
        attackBuilding: (...args: unknown[]) => void;
        siegeShoot: (...args: unknown[]) => void;
        attackPawn: (...args: unknown[]) => void;
        nearPawn?: (...args: unknown[]) => unknown;
        siegeInterceptRadius?: () => number;
      };
    };
    const scene = game.scene.getScene('Game') as unknown as RuntimeScene;
    const castle = scene.settlement.castle;
    const now = scene.time.now;
    scene.player.setPosition(0, 0);
    const result: Record<string, number> = {};
    const profiles = [
      { kind: 'skull', offset: 100, expected: 1500 },
      { kind: 'pig-rider', offset: 100, expected: 1500 },
      { kind: 'gnoll', offset: 250, expected: 1500 },
      { kind: 'shaman', offset: 250, expected: 2400 },
      { kind: 'boss', offset: 100, expected: 535 },
    ];
    for (const profile of profiles) {
      const enemy = scene.spawnSiegeUnit(profile.kind, castle.x + profile.offset, castle.y, profile.kind === 'shaman');
      if (!enemy) throw new Error(`Could not spawn ${profile.kind} siege cadence fixture`);
      enemy.siege = true;
      enemy.buildingTarget = castle;
      enemy.attackWindowEnds = now + 10_000;
      const runtime = enemy as unknown as RuntimeEnemy;
      runtime.ctx = {
        ...runtime.ctx,
        playerX: () => 0,
        playerY: () => 0,
        attackBuilding: () => {},
        siegeShoot: () => {},
        attackPawn: () => {},
        nearPawn: () => null,
        siegeInterceptRadius: () => 1,
      };
      runtime.updateSiege(now + 1, 16);
      result[profile.kind] = runtime.buildingAtkCd;
      scene.enemyGroup.remove(enemy, true, true);
      if (result[profile.kind] !== profile.expected) {
        throw new Error(`${profile.kind} cadence was ${result[profile.kind]}, expected ${profile.expected}`);
      }
    }
    return result;
  });
  expect(cadence).toEqual({
    skull: 1500,
    'pig-rider': 1500,
    gnoll: 1500,
    shaman: 2400,
    boss: 535,
  });
});


test('phase K: pig-rider siege charge telegraphs and adds one 8 HP building hit', async ({ page }) => {
  await startRun(page);
  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    type SiegeEnemyRuntime = {
      active: boolean;
      kind: string;
      siege: boolean;
      buildingTarget: unknown;
      attackWindowEnds: number;
      setPosition(x: number, y: number): unknown;
    };
    type RuntimeScene = GameSceneRuntime & {
      player: { setPosition(x: number, y: number): unknown };
      settlement: { castle: BuildingRuntime };
      spawnSiegeUnit(kind: string, x: number, y: number, firer: boolean): SiegeEnemyRuntime | null;
      enemyGroup: { remove(child: unknown, removeFromScene?: boolean, destroyChild?: boolean): void };
    };
    type RuntimeEnemy = {
      updateSiege(time: number, delta: number): void;
      siegeChargeStage: 'idle' | 'windup' | 'charge' | 'recover';
      siegeChargeTimerMs: number;
      buildingAtkCd: number;
      ctx: Record<string, unknown> & {
        playerX: () => number;
        playerY: () => number;
        attackBuilding: (target: unknown, damage: number, fire?: boolean, isBoss?: boolean) => void;
        siegeShoot: (...args: unknown[]) => void;
        attackPawn: (...args: unknown[]) => void;
        nearPawn?: (...args: unknown[]) => unknown;
        siegeInterceptRadius?: () => number;
      };
    };
    const scene = game.scene.getScene('Game') as unknown as RuntimeScene;
    const castle = scene.settlement.castle;
    const now = scene.time.now;
    scene.player.setPosition(0, 0);
    const enemy = scene.spawnSiegeUnit('pig-rider', castle.x + 100, castle.y, false);
    if (!enemy) throw new Error('Could not spawn pig-rider charge fixture');
    enemy.siege = true;
    enemy.buildingTarget = castle;
    enemy.attackWindowEnds = now + 10_000;
    const damageEvents: number[] = [];
    const runtime = enemy as unknown as RuntimeEnemy;
    runtime.ctx = {
      ...runtime.ctx,
      playerX: () => 0,
      playerY: () => 0,
      attackBuilding: (_target, damage) => damageEvents.push(damage),
      siegeShoot: () => {},
      attackPawn: () => {},
      nearPawn: () => null,
      siegeInterceptRadius: () => 1,
    };
    runtime.updateSiege(now + 1, 8_000);
    const stageAtChargeStart = runtime.siegeChargeStage;
    const chargeHitsBeforeContact = damageEvents.filter((damage) => damage === 8).length;
    runtime.updateSiege(now + 481, 480);
    const stageAfterTelegraph = runtime.siegeChargeStage;
    enemy.setPosition(castle.x + 30, castle.y);
    runtime.updateSiege(now + 700, 50);
    const chargeHits = damageEvents.filter((damage) => damage === 8).length;
    const stageAfterContact = runtime.siegeChargeStage;
    scene.enemyGroup.remove(enemy, true, true);
    return { stageAtChargeStart, chargeHitsBeforeContact, stageAfterTelegraph, chargeHits, stageAfterContact };
  });
  expect(report.stageAtChargeStart).toBe('windup');
  expect(report.chargeHitsBeforeContact).toBe(0);
  expect(report.stageAfterTelegraph).toBe('charge');
  expect(report.chargeHits).toBe(1);
  expect(report.stageAfterContact).toBe('recover');
});


test('phase K: pig-rider charge timeout outside contact radius does not damage the building', async ({ page }) => {
  await startRun(page);
  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    type SiegeEnemyRuntime = {
      active: boolean;
      kind: string;
      siege: boolean;
      buildingTarget: unknown;
      attackWindowEnds: number;
    };
    type RuntimeScene = GameSceneRuntime & {
      player: { setPosition(x: number, y: number): unknown };
      settlement: { castle: BuildingRuntime };
      spawnSiegeUnit(kind: string, x: number, y: number, firer: boolean): SiegeEnemyRuntime | null;
      enemyGroup: { remove(child: unknown, removeFromScene?: boolean, destroyChild?: boolean): void };
    };
    type RuntimeEnemy = {
      updateSiege(time: number, delta: number): void;
      siegeChargeStage: 'idle' | 'windup' | 'charge' | 'recover';
      siegeChargeTimerMs: number;
      buildingAtkCd: number;
      ctx: Record<string, unknown> & {
        playerX: () => number;
        playerY: () => number;
        attackBuilding: (target: unknown, damage: number) => void;
        siegeShoot: (...args: unknown[]) => void;
        attackPawn: (...args: unknown[]) => void;
        nearPawn?: (...args: unknown[]) => unknown;
        siegeInterceptRadius?: () => number;
      };
    };
    const scene = game.scene.getScene('Game') as unknown as RuntimeScene;
    const castle = scene.settlement.castle;
    const now = scene.time.now;
    scene.player.setPosition(0, 0);
    const enemy = scene.spawnSiegeUnit('pig-rider', castle.x + 100, castle.y, false);
    if (!enemy) throw new Error('Could not spawn pig-rider timeout fixture');
    enemy.siege = true;
    enemy.buildingTarget = castle;
    enemy.attackWindowEnds = now + 10_000;
    const damageEvents: number[] = [];
    const runtime = enemy as unknown as RuntimeEnemy;
    runtime.siegeChargeStage = 'charge';
    runtime.siegeChargeTimerMs = 0;
    runtime.buildingAtkCd = 100_000;
    runtime.ctx = {
      ...runtime.ctx,
      playerX: () => 0,
      playerY: () => 0,
      attackBuilding: (_target, damage) => damageEvents.push(damage),
      siegeShoot: () => {},
      attackPawn: () => {},
      nearPawn: () => null,
      siegeInterceptRadius: () => 1,
    };
    runtime.updateSiege(now + 1_000, 16);
    scene.enemyGroup.remove(enemy, true, true);
    return { damageEvents, stage: runtime.siegeChargeStage };
  });
  expect(report.damageEvents).toEqual([]);
  expect(report.stage).toBe('recover');
});


test('phase K: building fire displays the loaded dynamite and fire assets and clears them after six active seconds', async ({ page }) => {
  await startRun(page);
  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const scene = game.scene.getScene('Game') as GameSceneRuntime & {
      settlement: { castle: BuildingRuntime };
    };
    type SpriteRuntime = {
      active: boolean;
      visible: boolean;
      texture: { key: string };
      anims: { currentAnim?: { key: string } | null };
    };
    type BurningBuildingRuntime = BuildingRuntime & {
      ignite(siegeIndex: number): void;
      tickBurn(dtMs: number): number;
      burnSprite: SpriteRuntime | null;
      fireFx: SpriteRuntime | null;
    };
    const castle = scene.settlement.castle as unknown as BurningBuildingRuntime;
    castle.ignite(0);
    const visual = {
      dynamiteKey: castle.burnSprite?.texture.key ?? null,
      dynamiteVisible: castle.burnSprite?.active === true && castle.burnSprite.visible,
      dynamiteAnimation: castle.burnSprite?.anims.currentAnim?.key ?? null,
      fireKey: castle.fireFx?.texture.key ?? null,
      fireVisible: castle.fireFx?.active === true && castle.fireFx.visible,
      fireAnimation: castle.fireFx?.anims.currentAnim?.key ?? null,
      burnAnimationRegistered: game.anims.exists('barrel-burn'),
      fireAnimationRegistered: game.anims.exists('building-fire-loop'),
    };
    const dotDamage = castle.tickBurn(6_000);
    return {
      ...visual,
      dotDamage,
      remainingDynamite: castle.burnSprite !== null,
      remainingFireFx: castle.fireFx !== null,
    };
  });

  expect(report.dynamiteKey).toBe('barrel');
  expect(report.dynamiteVisible).toBe(true);
  expect(report.dynamiteAnimation).toBe('barrel-burn');
  expect(report.fireKey).toBe('fx-fire');
  expect(report.fireVisible).toBe(true);
  expect(report.fireAnimation).toBe('building-fire-loop');
  expect(report.burnAnimationRegistered).toBe(true);
  expect(report.fireAnimationRegistered).toBe(true);
  expect(report.dotDamage).toBe(3);
  expect(report.remainingDynamite).toBe(false);
  expect(report.remainingFireFx).toBe(false);
});


test('phase K: ordinary wave enemies do not damage castle buildings', async ({ page }) => {
  await startRun(page);
  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    type RegularEnemyRuntime = {
      active: boolean;
      kind: string;
      siege: boolean;
      preUpdate(time: number, delta: number): void;
    };
    type RuntimeScene = GameSceneRuntime & {
      hints: { setEnabled(enabled: boolean): void };
      started: boolean;
      spawner: { stopped: boolean };
      settlement: { castle: BuildingRuntime };
      enemyGroup: {
        clear(removeFromScene?: boolean, destroyChildren?: boolean): void;
        getChildren(): RegularEnemyRuntime[];
        remove(child: unknown, removeFromScene?: boolean, destroyChild?: boolean): void;
      };
      spawnEnemy(kind: string, x: number, y: number): boolean;
    };
    const scene = game.scene.getScene('Game') as unknown as RuntimeScene;
    scene.hints.setEnabled(false);
    scene.started = true;
    scene.spawner.stopped = true;
    scene.enemyGroup.clear(true, true);
    scene.player.setPosition(0, 0);
    const castle = scene.settlement.castle;
    if (!scene.spawnEnemy('skull', castle.x + 80, castle.y)) {
      throw new Error('Could not spawn regular-wave enemy fixture');
    }
    const enemy = scene.enemyGroup.getChildren().find((candidate) =>
      candidate.active && candidate.kind === 'skull');
    if (!enemy) throw new Error('Regular-wave enemy fixture is missing');
    enemy.siege = false;
    const castleHpBefore = castle.hp;
    const now = scene.time.now;
    // AI active-time ticks advance deterministically. Normal enemies can attack
    // the hero or pawns but must never use the building-damage callback.
    for (let i = 0; i < 120; i++) enemy.preUpdate(now + i * 16, 16);
    const castleHpAfter = castle.hp;
    scene.enemyGroup.remove(enemy, true, true);
    return { castleHpBefore, castleHpAfter, siege: enemy.siege };
  });
  expect(report.siege).toBe(false);
  expect(report.castleHpAfter).toBe(report.castleHpBefore);
});


test('phase K: destroying the last barracks removes the settlement succession source', async ({ page }) => {
  await startRun(page);
  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    type RuntimeJob = { building: BuildingRuntime };
    type RuntimeEconomy = EconomyRuntime & { buildJobs: RuntimeJob[] };
    type RuntimeScene = GameSceneRuntime & {
      hints: { setEnabled(enabled: boolean): void };
      settlement: {
        hasSuccessionSource(): boolean;
        aliveBuildings: BuildingRuntime[];
      };
    };
    const scene = game.scene.getScene('Game') as unknown as RuntimeScene;
    scene.hints.setEnabled(false);
    const economy = scene.economy as RuntimeEconomy;
    economy.resources.wood = 10_000;
    economy.resources.ore = 10_000;
    economy.resources.meat = 10_000;

    // Isolate the last source in case a scenario prebuilt one.
    for (const building of [...economy.buildings]) {
      if (['barracks', 'archery', 'monastery'].includes(building.kind) && building.alive) {
        building.damage(building.maxHp + 1, -1);
      }
    }
    // После изоляции источника преемственности быть не должно: переменная
    // хранит ОТСУТСТВИЕ источника, а не его наличие.
    const noSourceInitially = !scene.settlement.hasSuccessionSource();
    const builder = economy.pawns.find((pawn) => pawn.kind === 'builder');
    const spot = economy.freeSpots().find((candidate) => candidate.kind === 'barracks');
    if (!builder || !spot) throw new Error('Builder or barracks spot is unavailable');
    if (!economy.tryStartBuild('barracks', builder, spot)) {
      throw new Error('Could not start barracks for succession-source regression');
    }
    const barracks = economy.buildings.find((building) =>
      building.kind === 'barracks' && building.underConstruction);
    if (!barracks) throw new Error('Barracks construction object was not registered');
    for (let i = economy.buildJobs.length - 1; i >= 0; i--) {
      if (economy.buildJobs[i].building === barracks) economy.buildJobs.splice(i, 1);
    }
    barracks.finishConstruction();
    const sourceWhileBarracksAlive = scene.settlement.hasSuccessionSource();
    barracks.damage(barracks.maxHp + 1, -1);
    const sourceAfterBarracksDestroyed = scene.settlement.hasSuccessionSource();
    return {
      noSourceInitially,
      sourceWhileBarracksAlive,
      sourceAfterBarracksDestroyed,
      // Разрушенные казармы становятся РУИНАМИ: alive остаётся true, но
      // здание выпадает из Settlement.aliveBuildings (alive && !underConstruction),
      // то есть больше не является ни источником преемственности, ни целью найма.
      barracksStillActive: scene.settlement.aliveBuildings.includes(barracks),
      barracksIsRuins: barracks.underConstruction,
    };
  });
  expect(report.noSourceInitially).toBe(true);
  expect(report.sourceWhileBarracksAlive).toBe(true);
  expect(report.barracksIsRuins).toBe(true);
  expect(report.barracksStillActive).toBe(false);
  expect(report.sourceAfterBarracksDestroyed).toBe(false);
});



test('phase K: siege schedule warns five seconds before exact profile start times', async ({ page }) => {
  await startRun(page);
  const report = await page.evaluate(async () => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const root = window.location.origin;
    const [data, constants] = await Promise.all([
      import(/* @vite-ignore */ new URL('/src/game/data.ts', root).href) as Promise<{
        SIEGE_SCHEDULE: Array<{ t: number; target: string; woundCap: number; name: string }>;
        WAVE_EVENTS: unknown[];
      }>,
      import(/* @vite-ignore */ new URL('/src/game/constants.ts', root).href) as Promise<{
        SIEGE: { ANNOUNCE_SEC: number };
      }>,
    ]);
    type SiegeRuntimeProfile = { t: number; target: string; woundCap: number; name: string };
    type RuntimeSpawner = {
      elapsed: number;
      eventIdx: number;
      siegeIdx: number;
      siegeAnnounced: boolean;
      stopped: boolean;
      timer: number;
      o: {
        endless?: boolean;
        siegeIntervalSec?: number | null;
        extraSiege?: boolean;
        contractQuiet?: boolean;
        alarmLevel?: () => number;
      };
      ctx: {
        announce(text: string, color?: string): void;
        beginSiege(profile: SiegeRuntimeProfile, index: number): void;
      };
      update(dtSec: number): void;
    };
    const scene = game.scene.getScene('Game') as GameSceneRuntime & { spawner: RuntimeSpawner };
    scene.registry.set('tss-siege-warn', 0);
    const spawner = scene.spawner;
    const warnings: Array<{ at: number; text: string }> = [];
    const starts: Array<{ at: number; index: number; target: string; woundCap: number }> = [];

    // Изолируем расписание от обычных spawn events; исполняется публичный update(0),
    // без ожидания 15 минут и без таймеров реального времени.
    spawner.stopped = false;
    spawner.o.endless = false;
    spawner.o.siegeIntervalSec = null;
    spawner.o.extraSiege = false;
    spawner.o.contractQuiet = false;
    spawner.o.alarmLevel = () => 0;
    spawner.eventIdx = data.WAVE_EVENTS.length;
    spawner.elapsed = 0;
    spawner.siegeIdx = 0;
    spawner.siegeAnnounced = false;
    spawner.timer = 1_200;
    spawner.ctx.announce = (text) => warnings.push({ at: spawner.elapsed, text });
    spawner.ctx.beginSiege = (profile, index) => starts.push({
      at: spawner.elapsed,
      index,
      target: profile.target,
      woundCap: profile.woundCap,
    });

    const alarmSeconds = constants.SIEGE.ANNOUNCE_SEC;
    for (const profile of data.SIEGE_SCHEDULE) {
      spawner.elapsed = profile.t - alarmSeconds;
      spawner.siegeAnnounced = false;
      spawner.update(0);
      spawner.elapsed = profile.t;
      spawner.update(0);
    }
    spawner.stopped = true;
    return {
      warningTimes: warnings.map((warning) => warning.at),
      warningCount: warnings.length,
      startTimes: starts.map((start) => start.at),
      indexes: starts.map((start) => start.index),
      targets: starts.map((start) => start.target),
      woundCaps: starts.map((start) => start.woundCap),
    };
  });

  expect(report.warningCount).toBe(5);
  expect(report.warningTimes).toEqual([355, 475, 595, 715, 805]);
  expect(report.startTimes).toEqual([360, 480, 600, 720, 810]);
  expect(report.indexes).toEqual([0, 1, 2, 3, 4]);
  expect(report.targets).toEqual(['houses', 'houses', 'monastery', 'houses', 'castle']);
  expect(report.woundCaps).toEqual([1, 1, 2, 2, 3]);
});



test('phase K: a 150 HP house survives ten flaming siege hits including burn damage', async ({ page }) => {
  await startRun(page);
  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    type BurningBuildingRuntime = BuildingRuntime & {
      ignite(siegeIndex: number): void;
      tickBurn(dtMs: number): number;
      fireTimer: number;
    };
    type RuntimeEconomy = EconomyRuntime & { buildJobs: Array<{ building: BuildingRuntime }> };
    type RuntimeSettlement = {
      castle: BuildingRuntime;
      beginSiege(index: number, woundCap: number, enemies: unknown[]): void;
      damageBuilding(building: BuildingRuntime, raw: number, siegeIndex: number, isBoss?: boolean): void;
      capApplied: boolean;
    };
    const scene = game.scene.getScene('Game') as GameSceneRuntime & {
      settlement: RuntimeSettlement;
    };
    const economy = scene.economy as RuntimeEconomy;
    economy.resources.wood = 10_000;
    economy.resources.ore = 10_000;
    economy.resources.meat = 10_000;
    const builder = economy.pawns.find((pawn) => pawn.kind === 'builder');
    const spot = economy.freeSpots().find((candidate) => candidate.kind === 'house');
    if (!builder || !spot) throw new Error('Builder or house spot is unavailable');
    if (!economy.tryStartBuild('house', builder, spot)) throw new Error('Could not start test house');
    const house = economy.buildings.find((building) =>
      building.kind === 'house' && building.underConstruction) as BuildingRuntime | undefined;
    if (!house) throw new Error('House construction object was not registered');
    for (let i = economy.buildJobs.length - 1; i >= 0; i--) {
      if (economy.buildJobs[i].building === house) economy.buildJobs.splice(i, 1);
    }
    house.finishConstruction();
    const burning = house as BurningBuildingRuntime;
    scene.settlement.beginSiege(0, 1, []);
    let directDamage = 0;
    let dotDamage = 0;
    for (let i = 0; i < 10; i++) {
      scene.settlement.damageBuilding(house, 5, 0, false);
      directDamage += 5;
      burning.ignite(0);
      // Prevent the test's synthetic large active-time steps from accumulating
      // particle objects; the independent visual test checks the real FX lifecycle.
      burning.fireTimer = 1_000_000;
      const dot = burning.tickBurn(i === 9 ? 6_000 : 2_400);
      dotDamage += dot;
      scene.settlement.damageBuilding(house, dot, 0, false);
    }
    return {
      maxHp: house.maxHp,
      hp: house.hp,
      directDamage,
      dotDamage,
      totalDamage: directDamage + dotDamage,
      capApplied: scene.settlement.capApplied,
      alive: house.alive,
    };
  });

  expect(report.maxHp).toBe(150);
  expect(report.directDamage).toBe(50);
  expect(report.dotDamage).toBeCloseTo(13.8, 5);
  expect(report.totalDamage).toBeLessThan(150);
  expect(report.hp).toBeGreaterThan(0);
  expect(report.alive).toBe(true);
  expect(report.capApplied).toBe(false);
});


test('phase K: hero interception cancels a pig-rider charge before building impact', async ({ page }) => {
  await startRun(page);
  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    type SiegeEnemyRuntime = {
      active: boolean;
      kind: string;
      siege: boolean;
      buildingTarget: unknown;
      attackWindowEnds: number;
    };
    type RuntimeScene = GameSceneRuntime & {
      player: { x: number; y: number; setPosition(x: number, y: number): unknown };
      settlement: { castle: BuildingRuntime };
      spawnSiegeUnit(kind: string, x: number, y: number, firer: boolean): SiegeEnemyRuntime | null;
      enemyGroup: { remove(child: unknown, removeFromScene?: boolean, destroyChild?: boolean): void };
    };
    type RuntimeEnemy = {
      updateSiege(time: number, delta: number): void;
      siegeChargeStage: 'idle' | 'windup' | 'charge' | 'recover';
      siegeChargeTimerMs: number;
      siegeChargeCooldownMs: number;
      buildingAtkCd: number;
      ctx: Record<string, unknown> & {
        playerX: () => number;
        playerY: () => number;
        attackBuilding: (target: unknown, damage: number, fire?: boolean, isBoss?: boolean) => void;
        siegeShoot: (...args: unknown[]) => void;
        attackPawn: (...args: unknown[]) => void;
        nearPawn?: (...args: unknown[]) => unknown;
        siegeInterceptRadius?: () => number;
      };
    };
    const scene = game.scene.getScene('Game') as unknown as RuntimeScene;
    const castle = scene.settlement.castle;
    const now = scene.time.now;
    const enemy = scene.spawnSiegeUnit('pig-rider', castle.x + 100, castle.y, false);
    if (!enemy) throw new Error('Could not spawn pig-rider interception fixture');
    enemy.siege = true;
    enemy.buildingTarget = castle;
    enemy.attackWindowEnds = now + 10_000;
    const damageEvents: number[] = [];
    const runtime = enemy as unknown as RuntimeEnemy;
    runtime.siegeChargeStage = 'windup';
    runtime.siegeChargeTimerMs = 200;
    runtime.buildingAtkCd = 100_000;
    runtime.ctx = {
      ...runtime.ctx,
      playerX: () => enemy.x + 30,
      playerY: () => enemy.y,
      attackBuilding: (_target, damage) => damageEvents.push(damage),
      siegeShoot: () => {},
      attackPawn: () => {},
      nearPawn: () => null,
      siegeInterceptRadius: () => 260,
    };
    runtime.updateSiege(now + 100, 100);
    const state = {
      stage: runtime.siegeChargeStage,
      timer: runtime.siegeChargeTimerMs,
      cooldown: runtime.siegeChargeCooldownMs,
      damageEvents,
    };
    scene.enemyGroup.remove(enemy, true, true);
    return state;
  });

  expect(report.stage).toBe('idle');
  expect(report.timer).toBe(0);
  expect(report.cooldown).toBe(8_000);
  expect(report.damageEvents).toEqual([]);
});


test('phase K: siege infrastructure caps exclude unfinished and ruined buildings and clamp damage at 12%/6%', async ({ page }) => {
  await startRun(page);
  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    type SettlementBudgetRuntime = {
      castle: BuildingRuntime;
      infrastructureMax: number;
      infrastructureHp: number;
      capApplied: boolean;
      beginSiege(index: number, woundCap: number, enemies: unknown[]): void;
      damageBuilding(building: BuildingRuntime, raw: number, siegeIndex: number, isBoss?: boolean): void;
    };
    const scene = game.scene.getScene('Game') as GameSceneRuntime & {
      settlement: SettlementBudgetRuntime;
      spawner: { stopped: boolean };
    };
    scene.spawner.stopped = true;
    const economy = scene.economy;
    economy.resources.wood = 1_000;
    economy.resources.ore = 1_000;
    economy.resources.meat = 1_000;
    const builder = economy.pawns.find((pawn) => pawn.kind === 'builder');
    const spot = economy.freeSpots().find((candidate) => candidate.kind === 'house');
    if (!builder || !spot) throw new Error('Builder or house spot unavailable');

    const castle = scene.settlement.castle;
    const initialMax = scene.settlement.infrastructureMax;
    if (!economy.tryStartBuild('house', builder, spot)) throw new Error('House construction did not start');
    const house = economy.buildings.find((candidate) => candidate.kind === 'house' && candidate.underConstruction);
    if (!house) throw new Error('House construction object missing');
    const maxDuringConstruction = scene.settlement.infrastructureMax;
    builder.setPosition(spot.x, spot.y);
    builder.state = 'work';
    economy.tick(10_001, scene.time.now + 10_001);
    const maxAfterConstruction = scene.settlement.infrastructureMax;
    if (!house.alive || house.underConstruction) throw new Error('House did not finish');
    house.damage(house.maxHp, -1);
    const maxAfterRuin = scene.settlement.infrastructureMax;

    // На базе из одного замка потолок равен 12% × 500 = 60 HP за осаду.
    castle.hp = castle.maxHp;
    scene.settlement.beginSiege(0, 1, []);
    const highStart = castle.hp;
    scene.settlement.damageBuilding(castle, 100, 0);
    scene.settlement.damageBuilding(castle, 100, 0);
    const highLoss = highStart - castle.hp;
    const highCapApplied = scene.settlement.capApplied;

    // При инфраструктуре <60% HP применяется страховочный потолок 6% × 500 = 30.
    castle.hp = castle.maxHp;
    scene.settlement.damageBuilding(castle, 250, -1);
    scene.settlement.beginSiege(0, 1, []);
    const lowStart = castle.hp;
    scene.settlement.damageBuilding(castle, 100, 0);
    const lowLoss = lowStart - castle.hp;
    const lowCapApplied = scene.settlement.capApplied;

    return {
      initialMax,
      maxDuringConstruction,
      maxAfterConstruction,
      houseMaxHp: house.maxHp,
      maxAfterRuin,
      highLoss,
      highCapApplied,
      lowLoss,
      lowCapApplied,
    };
  });

  expect(report.maxDuringConstruction).toBe(report.initialMax);
  expect(report.maxAfterConstruction).toBe(report.initialMax + report.houseMaxHp);
  expect(report.maxAfterRuin).toBe(report.initialMax);
  expect(report.highLoss).toBeCloseTo(report.initialMax * 0.12, 5);
  expect(report.highCapApplied).toBe(true);
  expect(report.lowLoss).toBeCloseTo(report.initialMax * 0.06, 5);
  expect(report.lowCapApplied).toBe(true);
});


test('phase K: HUD exposes castle HP separately from aggregate infrastructure and population', async ({ page }) => {
  await startRun(page);
  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const scene = game.scene.getScene('Game') as GameSceneRuntime & {
      hud: {
        updateSettlement(castle: number, infra: number, population: number, garrison: string): void;
        settleCastleBar: { displayWidth: number; displayHeight: number; texture: { key: string } };
        settleInfraBar: { displayWidth: number; displayHeight: number; texture: { key: string } };
        settlePopBar: { displayWidth: number; displayHeight: number; texture: { key: string } };
      };
      settlement: { castle: BuildingRuntime };
    };
    const hud = scene.hud;
    const castle = scene.settlement.castle;
    const previousHp = castle.hp;
    castle.hp = castle.maxHp * 0.25;
    hud.updateSettlement(0.25, 0.8, 0.75, 'Garrison 1/4');
    const result = {
      castleWidth: hud.settleCastleBar.displayWidth,
      infrastructureWidth: hud.settleInfraBar.displayWidth,
      populationWidth: hud.settlePopBar.displayWidth,
      castleTexture: hud.settleCastleBar.texture.key,
      castleHpFraction: castle.hp / castle.maxHp,
      barsHaveHeight: hud.settleCastleBar.displayHeight > 0
        && hud.settleInfraBar.displayHeight > 0 && hud.settlePopBar.displayHeight > 0,
    };
    castle.hp = previousHp;
    return result;
  });
  expect(report.castleWidth).toBeLessThan(report.infrastructureWidth);
  expect(report.castleWidth).toBeLessThan(report.populationWidth);
  expect(report.castleTexture).toBe('bar-fill-red');
  expect(report.castleHpFraction).toBe(0.25);
  expect(report.barsHaveHeight).toBe(true);
});


test('phase K: siege wound cap counts only newly wounded pawns and skips wounded targets', async ({ page }) => {
  await startRun(page);
  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const scene = game.scene.getScene('Game') as GameSceneRuntime & {
      spawner: { stopped: boolean };
      settlement: {
        beginSiege(index: number, woundCap: number, enemies: unknown[]): void;
        siegeWoundPawn(pawn: PawnRuntime, dmg: number, now: number): void;
        canWoundInSiege(): boolean;
      };
      economy: EconomyRuntime & {
        spawnPawn(kind: string, x?: number, y?: number, announce?: boolean): PawnRuntime | null;
        woundPawn(pawn: PawnRuntime, dmg: number, now: number): boolean;
      };
    };
    scene.spawner.stopped = true;
    const now = scene.time.now;
    const availableResidents = scene.economy.pawns.filter((pawn) =>
      pawn.cls === 'civilian' && !pawn.dead
        && pawn.state !== 'wounded' && pawn.state !== 'bleeding');
    const alreadyWounded = availableResidents[0] ?? null;
    const firstAvailable = availableResidents[1] ?? null;
    const secondAvailable = availableResidents[2] ?? null;
    if (!alreadyWounded || !firstAvailable || !secondAvailable) {
      throw new Error(`Need 3 existing available residents for wound-cap test; found ${availableResidents.length}`);
    }
    const preWoundApplied = scene.economy.woundPawn(alreadyWounded, alreadyWounded.maxHp + 1, now);
    if (!preWoundApplied || alreadyWounded.state !== 'wounded') {
      throw new Error('Could not prepare an already-wounded pawn');
    }

    scene.settlement.beginSiege(0, 1, []);
    scene.settlement.siegeWoundPawn(alreadyWounded, alreadyWounded.maxHp + 1, now);
    const slotAvailableAfterRejectedTarget = scene.settlement.canWoundInSiege();
    scene.settlement.siegeWoundPawn(firstAvailable, firstAvailable.maxHp + 1, now);
    scene.settlement.siegeWoundPawn(secondAvailable, secondAvailable.maxHp + 1, now);
    return {
      alreadyWoundedState: alreadyWounded.state,
      firstAvailableState: firstAvailable.state,
      secondAvailableState: secondAvailable.state,
      firstAvailableHp: firstAvailable.hp,
      secondAvailableHp: secondAvailable.hp,
      slotAvailableAfterRejectedTarget,
      capExhausted: !scene.settlement.canWoundInSiege(),
    };
  });

  expect(report.alreadyWoundedState).toBe('wounded');
  expect(report.slotAvailableAfterRejectedTarget).toBe(true);
  expect(report.firstAvailableState).toBe('wounded');
  expect(report.secondAvailableState).not.toBe('wounded');
  expect(report.secondAvailableHp).toBeGreaterThan(0);
  expect(report.capExhausted).toBe(true);
});


test('phase K: destroying the castle sets the castle defeat cause and announces the loss', async ({ page }) => {
  await startRun(page);
  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const scene = game.scene.getScene('Game') as GameSceneRuntime & {
      gameEnded: boolean;
      loseCause: string | null;
      settlement: {
        castle: BuildingRuntime;
        damageBuilding(building: BuildingRuntime, raw: number, siegeIndex: number, isBoss?: boolean): void;
      };
      hud: {
        announce(message: string, color?: string): void;
        feed(message: string, color?: string): void;
      };
    };
    // The test checks the immediate defeat route; prevent its delayed game-over
    // transition from navigating away while Playwright reads the result.
    scene.gameEnded = true;
    scene.loseCause = null;
    const announcements: string[] = [];
    scene.hud.announce = (message: string): void => { announcements.push(message); };
    scene.hud.feed = (): void => {};
    const castle = scene.settlement.castle;
    scene.settlement.damageBuilding(castle, castle.hp + 1, -1, true);
    return {
      castleAlive: castle.alive,
      castleHp: castle.hp,
      loseCause: scene.loseCause,
      announcementCount: announcements.length,
      lastAnnouncement: announcements.length > 0 ? announcements[announcements.length - 1] : '',
    };
  });

  expect(report.castleAlive).toBe(false);
  expect(report.castleHp).toBe(0);
  expect(report.loseCause).toBe('castle');
  expect(report.announcementCount).toBeGreaterThanOrEqual(2);
  expect(report.lastAnnouncement.toLowerCase()).toContain('castle');
});


test('phase M: autonomous archers prioritize siege shamans over closer enemies', async ({ page }) => {
  await startRun(page);
  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const scene = game.scene.getScene('Game') as GameSceneRuntime & {
      hints?: { setEnabled(enabled: boolean): void };
    };
    scene.hints?.setEnabled(false);
    scene.registry.set('tss-hint-overlay-paused', false);

    type FighterPawn = PawnRuntime & {
      weapon: string;
      order: string | null;
      attackCd: number;
    };
    type EconomyWithCombat = {
      castleX: number;
      castleY: number;
      spawnFighter(weapon: 'bow' | 'sword'): FighterPawn;
      pawnAI: { updateCombat(pawn: FighterPawn, dtMs: number, now: number): void };
    };
    const economy = scene.economy as unknown as EconomyWithCombat;
    const archer = economy.spawnFighter('bow');
    const postX = economy.castleX + 70;
    const postY = economy.castleY + 80;
    archer.setPosition(postX, postY);
    archer.weapon = 'bow';
    archer.order = null;
    archer.attackCd = 0;

    const closerEnemy = {
      active: true, dead: false, kind: 'skull', siege: false,
      x: postX + 40, y: postY,
    };
    const siegeShaman = {
      active: true, dead: false, kind: 'shaman', siege: true,
      x: postX + 200, y: postY,
    };
    const context = scene.registry.get('tss-pawnai-ctx') as {
      enemies: () => unknown[];
      shootArrow: (from: unknown, target: unknown) => void;
    };
    context.enemies = () => [closerEnemy, siegeShaman];
    const shots: string[] = [];
    context.shootArrow = (_from, target) => {
      const enemy = target as { kind: string; siege: boolean };
      shots.push(enemy.kind + ':' + String(enemy.siege));
    };

    economy.pawnAI.updateCombat(archer, 1_000, scene.time.now + 1_000);
    return { shots, state: archer.state };
  });

  expect(report.shots[0]).toBe('shaman:true');
  expect(report.state).toBe('fight');
});

test('phase M: an archer beyond the 420 px leash returns to its post before attacking', async ({ page }) => {
  await startRun(page);
  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const scene = game.scene.getScene('Game') as GameSceneRuntime & {
      hints?: { setEnabled(enabled: boolean): void };
    };
    scene.hints?.setEnabled(false);
    scene.registry.set('tss-hint-overlay-paused', false);

    type FighterPawn = PawnRuntime & {
      weapon: string;
      order: string | null;
      attackCd: number;
      body: { velocity: { x: number; y: number } };
    };
    type EconomyWithCombat = {
      castleX: number;
      castleY: number;
      spawnFighter(weapon: 'bow' | 'sword'): FighterPawn;
      pawnAI: { updateCombat(pawn: FighterPawn, dtMs: number, now: number): void };
    };
    const economy = scene.economy as unknown as EconomyWithCombat;
    const archer = economy.spawnFighter('bow');
    const postX = economy.castleX + 70;
    const postY = economy.castleY + 80;
    archer.setPosition(postX + 500, postY);
    archer.weapon = 'bow';
    archer.order = null;
    archer.attackCd = 0;

    const enemy = {
      active: true, dead: false, kind: 'skull', siege: false,
      x: postX + 450, y: postY,
    };
    const context = scene.registry.get('tss-pawnai-ctx') as {
      enemies: () => unknown[];
      shootArrow: (from: unknown, target: unknown) => void;
    };
    context.enemies = () => [enemy];
    let shots = 0;
    context.shootArrow = () => { shots++; };

    economy.pawnAI.updateCombat(archer, 1_000, scene.time.now + 1_000);
    const velocity = archer.body.velocity;
    return {
      state: archer.state,
      velocityX: velocity.x,
      towardPost: (postX - archer.x) * velocity.x + (postY - archer.y) * velocity.y,
      shots,
    };
  });

  expect(report.state).toBe('walk');
  expect(report.velocityX).toBeLessThan(0);
  expect(report.towardPost).toBeGreaterThan(0);
  expect(report.shots).toBe(0);
});

test('phase M: a monk follows the rear of an engaged fighter and never enters combat state', async ({ page }) => {
  await startRun(page);
  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const scene = game.scene.getScene('Game') as GameSceneRuntime & {
      hints?: { setEnabled(enabled: boolean): void };
    };
    scene.hints?.setEnabled(false);
    scene.registry.set('tss-hint-overlay-paused', false);

    type FighterPawn = PawnRuntime & {
      weapon: string;
      order: string | null;
      attackCd: number;
      body: { velocity: { x: number; y: number } };
      healTarget: PawnRuntime | null;
      healHeroPoint: { x: number; y: number } | null;
    };
    type EconomyWithCombat = {
      castleX: number;
      castleY: number;
      spawnFighter(weapon: 'bow' | 'sword'): FighterPawn;
      spawnPawn(kind: 'healer', nearX?: number, nearY?: number, announce?: boolean): FighterPawn | null;
      pawnAI: { updateCombat(pawn: FighterPawn, dtMs: number, now: number): void };
    };
    const economy = scene.economy as unknown as EconomyWithCombat;
    const fighter = economy.spawnFighter('sword');
    const monk = economy.spawnPawn('healer', economy.castleX, economy.castleY, false);
    if (!monk) throw new Error('Could not create the monk fixture');

    fighter.setPosition(economy.castleX + 200, economy.castleY);
    fighter.state = 'fight';
    fighter.weapon = 'sword';
    monk.setPosition(economy.castleX - 100, economy.castleY + 100);
    monk.weapon = 'staff';
    monk.order = null;
    monk.healTarget = null;
    monk.healHeroPoint = null;

    const enemy = {
      active: true, dead: false, kind: 'skull', siege: true,
      x: fighter.x + 100, y: fighter.y,
    };
    const context = scene.registry.get('tss-pawnai-ctx') as {
      enemies: () => unknown[];
      pawnAttackEnemy: (...args: unknown[]) => void;
    };
    context.enemies = () => [enemy];
    let attackCalls = 0;
    context.pawnAttackEnemy = () => { attackCalls++; };

    economy.pawnAI.updateCombat(monk, 1_000, scene.time.now + 1_000);
    const velocity = monk.body.velocity;
    return {
      state: monk.state,
      velocityX: velocity.x,
      velocityY: velocity.y,
      attackCalls,
    };
  });

  expect(report.state).not.toBe('fight');
  expect(report.velocityX).toBeGreaterThan(0);
  expect(report.velocityY).toBeLessThan(0);
  expect(Math.abs(Math.abs(report.velocityX) - Math.abs(report.velocityY))).toBeLessThan(3);
  expect(report.attackCalls).toBe(0);
});


test('phase M: all new buildings and unit animations have loaded textures', async ({ page }) => {
  await startRun(page);
  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const runtime = game as unknown as PhaserRuntime & {
      textures: { exists(key: string): boolean };
    };
    const textureKeys = [
      'archery', 'monastery', 'tower',
      'pawn-archer-idle', 'pawn-archer-run', 'pawn-archer-atk',
      'pawn-monk-idle', 'pawn-monk-run', 'pawn-monk-atk',
    ];
    const animationKeys = [
      'pawn-archer-idle', 'pawn-archer-run', 'pawn-archer-atk',
      'pawn-monk-idle', 'pawn-monk-run', 'pawn-monk-atk',
    ];
    return {
      textures: Object.fromEntries(textureKeys.map(key => [key, runtime.textures.exists(key)])),
      animations: Object.fromEntries(animationKeys.map(key => [key, runtime.anims.exists(key)])),
    };
  });

  expect(Object.values(report.textures).every(Boolean)).toBe(true);
  expect(Object.values(report.animations).every(Boolean)).toBe(true);
});

test('phase M: tower fires at a siege target before a closer ordinary enemy', async ({ page }) => {
  await startRun(page);
  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const scene = game.scene.getScene('Game') as unknown as GameSceneRuntime & {
      towerTick(now: number): void;
      activeEnemies(): Array<{
        active: boolean;
        dead: boolean;
        kind: string;
        siege: boolean;
        x: number;
        y: number;
      }>;
      projectiles: {
        fireFriendlyArrow(x: number, y: number, angle: number, damage: number): void;
      };
    };

    const tower = {
      kind: 'tower', x: 500, y: 500, hp: 200, maxHp: 200,
      alpha: 1, alive: true, underConstruction: false,
      finishConstruction: () => {}, damage: () => {},
    };
    scene.economy.buildings.push(tower);
    const ordinary = {
      active: true, dead: false, kind: 'skull', siege: false,
      x: tower.x + 40, y: tower.y - 40,
    };
    const siegeShaman = {
      active: true, dead: false, kind: 'shaman', siege: true,
      x: tower.x + 100, y: tower.y + 60,
    };
    scene.activeEnemies = () => [ordinary, siegeShaman];

    const shots: Array<{ x: number; y: number; angle: number; damage: number }> = [];
    scene.projectiles.fireFriendlyArrow = (x, y, angle, damage) => {
      shots.push({ x, y, angle, damage });
    };
    scene.towerTick(scene.time.now + 1_000);
    return { shot: shots[0] ?? null, shots: shots.length };
  });

  expect(report.shots).toBe(1);
  expect(report.shot).not.toBeNull();
  expect(Math.abs(report.shot!.angle - Math.PI / 4)).toBeLessThan(0.1);
  expect(report.shot!.damage).toBeGreaterThan(0);
});


test('phase M: field healing rescues a bleeding pawn at 50% HP without spending wood', async ({ page }) => {
  await startRun(page);
  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const scene = game.scene.getScene('Game') as GameSceneRuntime & {
      hints?: { setEnabled(enabled: boolean): void };
    };
    scene.hints?.setEnabled(false);
    scene.registry.set('tss-hint-overlay-paused', false);

    type HealerPawn = PawnRuntime & {
      weapon: string;
      healTarget: PawnRuntime | null;
      healHeroPoint: { x: number; y: number } | null;
      body: { velocity: { x: number; y: number } };
    };
    type EconomyWithHealer = {
      castleX: number;
      castleY: number;
      resources: { wood: number };
      pawns: PawnRuntime[];
      spawnPawn(kind: 'healer', nearX?: number, nearY?: number, announce?: boolean): HealerPawn | null;
      healerAI: { update(now: number): void };
      pawnAI: {
        updateCivilian(pawn: PawnRuntime, dtMs: number, now: number): void;
        updateCombat(pawn: HealerPawn, dtMs: number, now: number): void;
      };
    };
    const economy = scene.economy as unknown as EconomyWithHealer;
    const victim = economy.pawns.find(p => p.kind === 'collector');
    const monk = economy.spawnPawn('healer', economy.castleX, economy.castleY, false);
    if (!victim || !monk) throw new Error('Could not create healer rescue fixtures');

    monk.setPosition(economy.castleX + 100, economy.castleY);
    monk.weapon = 'staff';
    monk.healTarget = null;
    monk.healHeroPoint = null;
    victim.setPosition(economy.castleX + 180, economy.castleY);
    victim.hp = 0;
    victim.state = 'wounded';
    victim.bleedTimer = 0;
    victim.cooldown = 0;

    const context = scene.registry.get('tss-pawnai-ctx') as { enemies: () => unknown[] };
    context.enemies = () => [];
    economy.resources.wood = 1_000;
    const woodBefore = economy.resources.wood;
    const now = scene.time.now + 1_000;
    economy.healerAI.update(now);
    const targetAssigned = monk.healTarget === victim;

    // Без обители раненый переходит в bleeding, но монах может ещё успеть
    // поднять его до 50% — моделируем активное игровое время без ожидания браузера.
    economy.pawnAI.updateCivilian(victim, 16, now);
    // Проверяем назначение после перехода wounded -> bleeding: очередное
    // назначение каждые 500 мс не должно лишить монаха цели перед спасением.
    economy.healerAI.update(now + 500);
    const targetRetainedAfterBleed = monk.healTarget === victim;
    for (let i = 0; i < 180 && (victim.state === 'wounded' || victim.state === 'bleeding'); i++) {
      const tickNow = now + 500 + (i + 1) * 150;
      economy.pawnAI.updateCivilian(victim, 150, tickNow);
      economy.pawnAI.updateCombat(monk, 150, tickNow);
    }

    return {
      targetAssigned,
      targetRetainedAfterBleed,
      state: victim.state,
      hp: victim.hp,
      maxHp: victim.maxHp,
      bleedTimer: victim.bleedTimer,
      monkTargetCleared: monk.healTarget === null,
      woodBefore,
      woodAfter: economy.resources.wood,
    };
  });

  expect(report.targetAssigned).toBe(true);
  expect(report.targetRetainedAfterBleed).toBe(true);
  expect(report.state).toBe('idle');
  expect(report.hp).toBeGreaterThanOrEqual(report.maxHp * 0.5);
  expect(report.bleedTimer).toBeGreaterThan(0);
  expect(report.monkTargetCleared).toBe(true);
  expect(report.woodAfter).toBe(report.woodBefore);
});


test('phase M: monastery collapse announces occupied beds and waits three active seconds', async ({ page }) => {
  await startRun(page);
  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const scene = game.scene.getScene('Game') as GameSceneRuntime & {
      hints?: { setEnabled(enabled: boolean): void };
      hud: HUDRuntime & { announce(text: string, color?: string): void };
    };
    scene.hints?.setEnabled(false);
    scene.registry.set('tss-hint-overlay-paused', false);

    type MonasteryRuntime = BuildingRuntime & {
      occupiedSlots: number;
      collapsePending: boolean;
      claimHealSlot(unit: unknown): number | null;
      tickMonasteryCollapse(dtMs: number): void;
    };
    const economy = scene.economy;
    const builder = economy.pawns.find(p => p.kind === 'builder');
    const spot = economy.freeSpots().find(s => s.kind === 'monastery');
    if (!builder || !spot) throw new Error('Builder or monastery build spot is missing');
    economy.resources.wood = 1_000;
    economy.resources.ore = 1_000;
    economy.resources.meat = 1_000;
    if (!economy.tryStartBuild('monastery', builder, spot)) {
      throw new Error('Could not create the monastery fixture');
    }
    const monastery = economy.buildings.find(b => b.kind === 'monastery') as MonasteryRuntime | undefined;
    if (!monastery) throw new Error('Monastery fixture is missing');
    monastery.finishConstruction();
    economy.buildJobs.splice(economy.buildJobs.findIndex(job => job.building === monastery), 1);

    const occupiedPawns = economy.pawns.filter(p => p.kind === 'collector').slice(0, 2);
    if (occupiedPawns.length !== 2) throw new Error('Two valid monastery occupants are required');
    monastery.claimHealSlot(occupiedPawns[0]);
    monastery.claimHealSlot(occupiedPawns[1]);
    const announcements: string[] = [];
    scene.hud.announce = (text) => announcements.push(text);

    monastery.damage(260, 0); // ниже 30% HP: первое предупреждение
    monastery.damage(monastery.hp, 0); // ниже 10% HP: критическое предупреждение и окно реакции
    const critical = {
      hp: monastery.hp,
      alive: monastery.alive,
      pending: monastery.collapsePending,
      occupiedSlots: monastery.occupiedSlots,
    };
    monastery.tickMonasteryCollapse(2_999);
    const beforeDeadline = { hp: monastery.hp, alive: monastery.alive, pending: monastery.collapsePending };
    monastery.tickMonasteryCollapse(1);

    return {
      announcements,
      critical,
      beforeDeadline,
      afterDeadline: { hp: monastery.hp, alive: monastery.alive, pending: monastery.collapsePending },
    };
  });

  expect(report.announcements).toHaveLength(2);
  expect(report.announcements.every(message => message.includes('2'))).toBe(true);
  expect(report.critical).toEqual({ hp: 1, alive: true, pending: true, occupiedSlots: 2 });
  expect(report.beforeDeadline).toEqual({ hp: 1, alive: true, pending: true });
  expect(report.afterDeadline.alive).toBe(false);
  expect(report.afterDeadline.pending).toBe(false);
});


test('phase M: monastery healing never grants more HP than the available wood can fund', async ({ page }) => {
  await startRun(page);
  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const scene = game.scene.getScene('Game') as GameSceneRuntime & {
      hints?: { setEnabled(enabled: boolean): void };
    };
    scene.hints?.setEnabled(false);
    scene.registry.set('tss-hint-overlay-paused', false);

    type SlotPawn = PawnRuntime & {
      monasterySlot: number | null;
      monasteryBuilding: BuildingRuntime | null;
      healBy(amount: number): void;
    };
    type MonasteryBuilding = BuildingRuntime & {
      healSlots: Array<SlotPawn | null>;
      claimHealSlot(unit: unknown): number | null;
      releaseHealSlot(slot: number): void;
    };
    type EconomyWithMonastery = EconomyRuntime & {
      monasteryHealTick(dtMs: number): void;
    };
    const economy = scene.economy as unknown as EconomyWithMonastery;
    const builder = economy.pawns.find(p => p.kind === 'builder');
    const spot = economy.freeSpots().find(s => s.kind === 'monastery');
    const first = economy.pawns.find(p => p.kind === 'collector');
    const second = economy.pawns.find(p => p.kind === 'collector' && p !== first);
    if (!builder || !spot || !first || !second) throw new Error('Monastery healing fixtures are unavailable');
    economy.resources.wood = 1_000;
    if (!economy.tryStartBuild('monastery', builder, spot)) throw new Error('Could not start monastery fixture');
    const monastery = economy.buildings.find(b => b.kind === 'monastery' && b.underConstruction) as MonasteryBuilding | undefined;
    if (!monastery) throw new Error('Monastery was not registered');
    monastery.finishConstruction();
    const jobIndex = economy.buildJobs.findIndex(job => job.building === monastery);
    if (jobIndex >= 0) economy.buildJobs.splice(jobIndex, 1);

    const firstPawn = first as SlotPawn;
    const secondPawn = second as SlotPawn;
    const firstSlot = monastery.claimHealSlot(firstPawn);
    const secondSlot = monastery.claimHealSlot(secondPawn);
    if (firstSlot === null || secondSlot === null) throw new Error('Could not occupy two monastery slots');
    firstPawn.monasterySlot = firstSlot;
    firstPawn.monasteryBuilding = monastery;
    secondPawn.monasterySlot = secondSlot;
    secondPawn.monasteryBuilding = monastery;
    firstPawn.hp = firstPawn.maxHp * 0.25;
    secondPawn.hp = secondPawn.maxHp * 0.25;
    firstPawn.state = 'wounded';
    secondPawn.state = 'wounded';

    // Дерева хватает на один полный тик (12 HP = 0.8 дерева) и только
    // частичное лечение второй койки; оба слота не могут потратить один баланс.
    economy.resources.wood = 0.9;
    const woodBefore = economy.resources.wood;
    const hpBefore = firstPawn.hp + secondPawn.hp;
    economy.monasteryHealTick(1_000);
    const hpAfter = firstPawn.hp + secondPawn.hp;
    return {
      woodBefore,
      woodAfter: economy.resources.wood,
      hpRestored: hpAfter - hpBefore,
      occupiedSlots: monastery.occupiedSlots,
      firstSlotOwner: firstPawn.monasteryBuilding === monastery,
      secondSlotOwner: secondPawn.monasteryBuilding === monastery,
    };
  });

  expect(report.hpRestored).toBeLessThanOrEqual(report.woodBefore * 15 + 0.01);
  expect(report.woodAfter).toBeGreaterThanOrEqual(0);
  expect(report.woodAfter).toBeLessThan(report.woodBefore);
  expect(report.occupiedSlots).toBe(2);
  expect(report.firstSlotOwner).toBe(true);
  expect(report.secondSlotOwner).toBe(true);
});

test('phase M: field rescue releases only the assigned monastery slot when two monasteries use index zero', async ({ page }) => {
  await startRun(page);
  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const scene = game.scene.getScene('Game') as GameSceneRuntime & {
      hints?: { setEnabled(enabled: boolean): void };
    };
    scene.hints?.setEnabled(false);
    scene.registry.set('tss-hint-overlay-paused', false);

    type MonasteryFixture = BuildingRuntime & {
      healSlots: Array<SlotPawn | null>;
      occupiedSlots: number;
      releaseHealSlot(slot: number): void;
    };
    type SlotPawn = PawnRuntime & {
      weapon: string;
      healTarget: SlotPawn | null;
      healHeroPoint: { x: number; y: number } | null;
      monasterySlot: number | null;
      monasteryBuilding: MonasteryFixture | null;
      bleedTimer: number;
      updateBleedBadge(): void;
    };
    type EconomyWithHealer = EconomyRuntime & {
      pawnAI: {
        updateCombat(pawn: SlotPawn, dtMs: number, now: number): void;
      };
    };
    const economy = scene.economy as unknown as EconomyWithHealer;
    const target = economy.pawns.find(p => p.kind === 'collector') as SlotPawn | undefined;
    const other = economy.pawns.find(p => p.kind === 'collector' && p !== target) as SlotPawn | undefined;
    const monk = economy.pawns.find(p => p.kind === 'healer') as SlotPawn | undefined
      ?? (economy as unknown as { spawnPawn(kind: 'healer', x?: number, y?: number, announce?: boolean): SlotPawn | null })
        .spawnPawn('healer', economy.castleX, economy.castleY, false) ?? undefined;
    if (!target || !other || !monk) throw new Error('Could not create two-monastery rescue fixtures');

    const makeMonastery = (x: number, occupant: SlotPawn): MonasteryFixture => ({
      kind: 'monastery',
      x, y: economy.castleY,
      hp: 360, maxHp: 360, alpha: 1, alive: true, underConstruction: false,
      healSlots: [occupant],
      get occupiedSlots() { return this.healSlots.filter(Boolean).length; },
      finishConstruction: () => {},
      damage: () => {},
      releaseHealSlot(slot: number) {
        if (slot >= 0 && slot < this.healSlots.length) this.healSlots[slot] = null;
      },
    }) as MonasteryFixture;

    const firstMonastery = makeMonastery(economy.castleX - 100, target);
    const secondMonastery = makeMonastery(economy.castleX + 100, other);
    economy.buildings.push(firstMonastery, secondMonastery);
    target.monasterySlot = 0;
    target.monasteryBuilding = firstMonastery;
    other.monasterySlot = 0;
    other.monasteryBuilding = secondMonastery;

    target.setPosition(economy.castleX + 20, economy.castleY);
    target.state = 'bleeding';
    target.bleedTimer = 20;
    target.hp = target.maxHp * 0.5 - 2;
    monk.setPosition(target.x + 10, target.y);
    monk.weapon = 'staff';
    monk.state = 'idle';
    monk.healTarget = target;
    monk.healHeroPoint = null;

    economy.pawnAI.updateCombat(monk, 1_000, scene.time.now + 1_000);
    return {
      rescuedState: target.state,
      hp: target.hp,
      maxHp: target.maxHp,
      firstSlot: firstMonastery.healSlots[0] === null ? null : 'occupied',
      secondSlotStillOwned: secondMonastery.healSlots[0] === other,
      targetSlot: target.monasterySlot,
      targetBuilding: target.monasteryBuilding,
      monkTargetCleared: monk.healTarget === null,
    };
  });

  expect(report.rescuedState).toBe('idle');
  expect(report.hp).toBeGreaterThanOrEqual(report.maxHp * 0.5);
  expect(report.firstSlot).toBeNull();
  expect(report.secondSlotStillOwned).toBe(true);
  expect(report.targetSlot).toBeNull();
  expect(report.targetBuilding).toBeNull();
  expect(report.monkTargetCleared).toBe(true);
});


test('phase M: one wounded pawn reserves exactly one monastery bed across repeated AI ticks', async ({ page }) => {
  await startRun(page);
  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const scene = game.scene.getScene('Game') as GameSceneRuntime & {
      hints?: { setEnabled(enabled: boolean): void };
    };
    scene.hints?.setEnabled(false);
    scene.registry.set('tss-hint-overlay-paused', false);

    type SlotPawn = PawnRuntime & {
      monasterySlot: number | null;
      monasteryBuilding: BuildingRuntime | null;
    };
    type MonasteryBuilding = BuildingRuntime & {
      healSlots: Array<SlotPawn | null>;
      occupiedSlots: number;
      claimHealSlot(unit: unknown): number | null;
    };
    const economy = scene.economy;
    const victim = economy.pawns.find(p => p.kind === 'collector') as SlotPawn | undefined;
    const builder = economy.pawns.find(p => p.kind === 'builder');
    const spot = economy.freeSpots().find(s => s.kind === 'monastery');
    if (!victim || !builder || !spot) throw new Error('Monastery slot fixture is unavailable');
    economy.resources.wood = 1_000;
    economy.resources.ore = 1_000;
    if (!economy.tryStartBuild('monastery', builder, spot)) throw new Error('Could not build monastery fixture');
    const monastery = economy.buildings.find(b => b.kind === 'monastery' && b.underConstruction) as MonasteryBuilding | undefined;
    if (!monastery) throw new Error('Monastery fixture is missing');
    monastery.finishConstruction();
    const jobIndex = economy.buildJobs.findIndex(job => job.building === monastery);
    if (jobIndex >= 0) economy.buildJobs.splice(jobIndex, 1);

    victim.setPosition(monastery.x + 20, monastery.y);
    victim.hp = victim.maxHp * 0.2;
    victim.state = 'wounded';
    victim.monasterySlot = null;
    victim.monasteryBuilding = null;
    for (let i = 0; i < 5; i++) {
      economy.pawnAI.updateCivilian(victim, 150, scene.time.now + i * 150);
    }
    const owners = monastery.healSlots.filter(slot => slot === victim).length;
    return {
      occupiedSlots: monastery.occupiedSlots,
      referencesToVictim: owners,
      slotIndex: victim.monasterySlot,
      ownerMatches: victim.monasteryBuilding === monastery,
    };
  });

  expect(report.occupiedSlots).toBe(1);
  expect(report.referencesToVictim).toBe(1);
  expect(report.slotIndex).toBe(0);
  expect(report.ownerMatches).toBe(true);
});
