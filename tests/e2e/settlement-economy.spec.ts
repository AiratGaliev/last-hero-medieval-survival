import { expect, test, type Page } from '@playwright/test';

type PawnRuntime = {
  kind: string;
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
  pawnAI: { updateCivilian(pawn: PawnRuntime, dtMs: number, now: number): void };
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

type GameSceneRuntime = {
  economy: EconomyRuntime;
  hud: HUDRuntime;
  elapsed: number;
  hintOverlayPaused: boolean;
  time: { now: number };
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

const startupTimeout = 30_000;

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
    const previousClaims = economy.nodes.map(n => n.claimedBy);
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

    return {
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
  expect(report.treeCount).toBe(report.initialTreeCount - 1);
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
      rebuiltAlpha: house.alpha,
      rebuiltUnderConstruction: house.underConstruction,
      automaticRepairStarted,
      automaticRepairFinished,
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
  expect(report.rebuiltAlpha).toBe(1);
  expect(report.rebuiltUnderConstruction).toBe(false);
  expect(report.automaticRepairStarted).toBe(true);
  expect(report.automaticRepairFinished).toBe(true);
  expect(report.builderFallbackBeforeThreshold).toBeNull();
  expect(report.builderFallbackCarry).toBe('wood');
  expect(report.builderFallbackAmount).toBe(5);
  expect(report.builderFullBeforeThreshold).toBeNull();
  expect(report.freeSpotsWhenFull).toBe(0);
  expect(report.builderFullCapacityCarry).toBe('wood');
  expect(report.builderFullCapacityAmount).toBe(5);
  expect(report.residentCountAfterHouse).toBeGreaterThanOrEqual(3);
});
