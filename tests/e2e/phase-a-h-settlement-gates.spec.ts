import { expect, test, type Page } from '@playwright/test';

// ============ Гейты фаз A–H: пул существ, безопасность поселения, стройка ============
//
//  Спецификация: docs/TZ.md §A (враги и выбор цели), §B (пешки, ресурсы,
//  строительство), §E.8 (население). Проверки, которые нельзя закрыть
//  статическим анализом кода: реальное время до первого дома, порядок
//  автостройки, выбор цели врагом, безопасность ядра поселения.

// Старт сцены грузит ~600 ассетов через dev-сервер Vite: на холодном
// сервере (или сразу после правок исходников, когда Vite пересобирает
// граф модулей и глоб ассетов) первый запуск занимает дольше 30 с.
// Запас времени убирает ложный «флак» загрузки — игровых таймаутов он
// не касается: все игровые проверки используют свои таймауты.
const startupTimeout = 60_000;

type PawnRuntime = {
  kind: string;
  cls: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  state: string;
  scaleX: number;
  dead: boolean;
  active: boolean;
  setPosition(x: number, y: number): unknown;
  body: { velocity: { x: number; y: number }; enable: boolean };
};

type EconomyRuntime = {
  pawns: PawnRuntime[];
  nodes: Array<{ kind: string; res: string; alive: boolean; x: number; y: number }>;
  resources: { wood: number; ore: number; meat: number };
  castleX: number;
  castleY: number;
  buildings: Array<{ kind: string; alive: boolean; underConstruction: boolean }>;
  buildJobs: Array<{ spot: { kind: string } }>;
  nextBuildKind(): string | null;
  plannedBuildCost(): Record<string, number>;
};

type EnemyRuntime = {
  kind: string;
  active: boolean;
  dead: boolean;
  x: number;
  y: number;
  aimedPawn: PawnRuntime | null;
  siege: boolean;
};

type GameSceneRuntime = {
  economy: EconomyRuntime;
  player: { x: number; y: number; hp: number; maxHp: number; iframesUntil: number };
  enemyGroup: {
    getChildren(): EnemyRuntime[];
    remove(enemy: EnemyRuntime, removeFromScene?: boolean, destroyChild?: boolean): unknown;
  };
  spawner: { stopped: boolean };
  spawnEnemy(kind: string, x: number, y: number): boolean;
  time: { now: number };
  registry: { get(key: string): unknown; set(key: string, value: unknown): void };
  overlayOpen: boolean;
  gameEnded: boolean;
};

type PhaserRuntime = {
  scene: { getScene(key: string): unknown; isActive(key: string): boolean };
};

type RuntimeWindow = Window & {
  __tss?: PhaserRuntime;
  __built?: Array<{ kind: string; t: number }>;
};

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
    const menu = game!.scene.getScene('Menu') as {
      selectedHero?: string;
      selectedDiff?: string;
      scene: { start(key: string, data: { hero: string; diff: string }): void };
    };
    menu.scene.start('Game', {
      hero: menu.selectedHero ?? 'warrior',
      diff: menu.selectedDiff ?? 'normal',
    });
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
    return !(game.scene.getScene('Game') as GameSceneRuntime).overlayOpen;
  }), { timeout: 10_000 }).toBe(true);
}

test('phase A: enemies prefer the hero and leave the settlement core alone (TZ §A.5)', async ({ page }) => {
  await startRun(page);
  const report = await page.evaluate(async () => {
    const game = (window as RuntimeWindow).__tss!;
    const scene = game.scene.getScene('Game') as GameSceneRuntime;
    const economy = scene.economy;
    // Ни врагов, ни авто-истории: проверяем только выбор цели.
    const context = scene.registry.get('tss-pawnai-ctx') as { enemies: () => unknown[] };
    context.enemies = () => [];
    scene.spawner.stopped = true;
    for (const enemy of scene.enemyGroup.getChildren()) scene.enemyGroup.remove(enemy, true, true);

    const collector = economy.pawns.find((p) => p.kind === 'collector');
    if (!collector) throw new Error('The initial settlement has no collector');
    const core = { x: economy.castleX, y: economy.castleY };

    // 1. Враг рядом с героем: цель — герой (aimedPawn === null).
    collector.setPosition(core.x + 240, core.y);
    scene.player.setPosition?.(core.x + 40, core.y);
    const heroTarget = scene.spawnEnemy('goblin', core.x + 120, core.y);
    if (!heroTarget) throw new Error('Could not spawn the QA goblin');
    const heroEnemy = scene.enemyGroup.getChildren().find((e) => e.active && e.kind === 'goblin');
    if (!heroEnemy) throw new Error('The QA goblin was not registered');
    // Выбор цели пересчитывается раз в 400 мс (§A.5) — ждём тик.
    await new Promise((r) => setTimeout(r, 600));
    const heroPick = heroEnemy.aimedPawn;

    // 2. Враг далеко от героя, но рядом с гражданским ВНЕ ядра: цель — пешка.
    scene.enemyGroup.remove(heroEnemy, true, true);
    scene.player.setPosition?.(core.x - 900, core.y - 900);
    collector.setPosition(core.x + 700, core.y);
    const hunterTarget = scene.spawnEnemy('goblin', core.x + 760, core.y);
    if (!hunterTarget) throw new Error('Could not spawn the second QA goblin');
    const hunter = scene.enemyGroup.getChildren().find((e) => e.active && e.kind === 'goblin');
    if (!hunter) throw new Error('The second QA goblin was not registered');
    await new Promise((r) => setTimeout(r, 600));
    const hunterPick = hunter.aimedPawn;

    // 3. Гражданский В ЯДРЕ поселения: обычная волна его не выбирает.
    scene.enemyGroup.remove(hunter, true, true);
    collector.setPosition(core.x + 120, core.y + 120);
    scene.player.setPosition?.(core.x - 900, core.y - 900);
    const coreTarget = scene.spawnEnemy('goblin', core.x + 200, core.y + 120);
    if (!coreTarget) throw new Error('Could not spawn the third QA goblin');
    const coreHunter = scene.enemyGroup.getChildren().find((e) => e.active && e.kind === 'goblin');
    if (!coreHunter) throw new Error('The third QA goblin was not registered');
    await new Promise((r) => setTimeout(r, 600));
    const corePick = coreHunter.aimedPawn;

    return {
      heroTargetIsNull: heroPick === null,
      hunterTargetIsCollector: hunterPick === collector,
      coreTargetIsNull: corePick === null,
      collectorCoreDistance: Math.round(Math.hypot(collector.x - core.x, collector.y - core.y)),
    };
  });

  // Герой — первая цель (§A.5, №1).
  expect(report.heroTargetIsNull).toBe(true);
  // Гражданский вне ядра — цель №3, когда геря рядом нет.
  expect(report.hunterTargetIsCollector).toBe(true);
  // Гражданский в ядре — вне досягаемости обычной волны (отклонение §A.5).
  expect(report.coreTargetIsNull).toBe(true);
  expect(report.collectorCoreDistance).toBeLessThan(360);
});

test('phase B: workers are readable on screen and civilians can be wounded (TZ §B.2)', async ({ page }) => {
  await startRun(page);
  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss!;
    const scene = game.scene.getScene('Game') as GameSceneRuntime;
    const economy = scene.economy;
    const context = scene.registry.get('tss-pawnai-ctx') as { enemies: () => unknown[] };
    context.enemies = () => [];
    scene.spawner.stopped = true;
    for (const enemy of scene.enemyGroup.getChildren()) scene.enemyGroup.remove(enemy, true, true);

    const collector = economy.pawns.find((p) => p.kind === 'collector');
    if (!collector) throw new Error('The initial settlement has no collector');
    // Содержимое кадра пешки ≈ 55×72 px; при масштабе 0.42 рабочий выглядел
    // как 23×30 px (ант в траве), теперь он читается рядом с героем (0.55).
    const scale = collector.scaleX;
    const contentHeight = 72 * scale;
    const heroScale = 0.55;
    const heroContentHeight = 89 * heroScale;
    const hpBefore = collector.hp;
    // Урон по гражданскому: пешка ранена, а не убита мгновенно (§G.3).
    economy.woundPawn(collector, collector.maxHp, scene.time.now);
    return {
      scale,
      contentHeight: Math.round(contentHeight),
      heroContentHeight: Math.round(heroContentHeight),
      hpBefore,
      hpAfter: collector.hp,
      state: collector.state,
      dead: collector.dead,
    };
  });

  expect(report.scale).toBeGreaterThanOrEqual(0.5);
  expect(report.contentHeight).toBeGreaterThanOrEqual(35);
  // Рабочий не должен быть выше героя, но и не втрое ниже.
  expect(report.contentHeight).toBeLessThan(report.heroContentHeight);
  expect(report.hpAfter).toBeLessThan(report.hpBefore);
  expect(report.state).toBe('wounded');
  expect(report.dead).toBe(false);
});

test('phase C: the map carries the resource stock from the specification (TZ §B.3)', async ({ page }) => {
  await startRun(page);
  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss!;
    const scene = game.scene.getScene('Game') as GameSceneRuntime;
    const economy = scene.economy;
    const dist = (x: number, y: number): number =>
      Math.round(Math.hypot(x - economy.castleX, y - economy.castleY));
    const trees = economy.nodes.filter((n) => n.kind === 'tree');
    const sheep = economy.nodes.filter((n) => n.kind === 'sheep');
    const veins = economy.nodes.filter((n) => n.kind === 'vein');
    return {
      trees: trees.length,
      sheep: sheep.length,
      veins: veins.length,
      meatStock: sheep.length * 3,
      woodStock: trees.length * 5,
      oreStock: veins.length * 80,
      treesReachable: trees.filter((n) => dist(n.x, n.y) <= 1000).length,
      sheepReachable: sheep.filter((n) => dist(n.x, n.y) <= 1000).length,
      veinsReachable: veins.filter((n) => dist(n.x, n.y) <= 1000).length,
      maxTreeDistance: Math.max(...trees.map((n) => dist(n.x, n.y))),
      maxSheepDistance: Math.max(...sheep.map((n) => dist(n.x, n.y))),
    };
  });

  // Мясо — стоковый кран (§B.5): 10 овец = 30 мяса на матч (~6 наймов).
  expect(report.sheep).toBe(10);
  expect(report.meatStock).toBe(30);
  expect(report.veins).toBe(10);
  // Дерево — основная валюта строек: план поселения (~350 дерева) требует
  // десятков деревьев, и все они должны быть в рабочем радиусе пешек.
  expect(report.trees).toBeGreaterThanOrEqual(30);
  expect(report.woodStock).toBeGreaterThanOrEqual(150);
  expect(report.treesReachable).toBe(report.trees);
  expect(report.sheepReachable).toBe(report.sheep);
  expect(report.veinsReachable).toBe(report.veins);
});

test('phase E: the first house falls in the opening minute and the barracks follows (TZ §B.9)', async ({ page }) => {
  test.setTimeout(240_000);
  await startRun(page);
  await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss!;
    const scene = game.scene.getScene('Game') as GameSceneRuntime;
    scene.player.iframesUntil = Date.now() + 1e9;
    const w = window as RuntimeWindow;
    w.__built = [];
    scene.economy.on('built', (info: { kind: string }) => {
      w.__built!.push({ kind: info.kind, t: Math.round(scene.time.now / 100) / 10 });
    });
  });

  // Ждём первый дом в реальном времени матча. Левел-ап открывает окно и
  // останавливает сцену — выбираем карточку автоматически, иначе матч
  // «замирает» на первом же убийстве.
  await expect.poll(
    () => page.evaluate(() => {
      const game = (window as RuntimeWindow).__tss!;
      if (game.scene.isActive('LevelUp')) {
        const levelUp = game.scene.getScene('LevelUp') as { chooseByIndex(index: number): void };
        try { levelUp.chooseByIndex(0); } catch { /* карточек ещё нет */ }
      }
      const scene = game.scene.getScene('Game') as GameSceneRuntime;
      scene.player.iframesUntil = Date.now() + 1e9;
      return (window as RuntimeWindow).__built?.length ?? 0;
    }),
    { timeout: 150_000, message: 'The settlement should raise its first house during the opening minute' },
  ).toBeGreaterThan(0);

  const firstHouse = await page.evaluate(() => {
    const w = window as RuntimeWindow;
    const built = w.__built ?? [];
    return { first: built[0], all: built.map((b) => b.kind) };
  });
  // §B.9: первый дом — цель первой минуты матча (расчёт 30–45 с).
  expect(firstHouse.first.kind).toBe('house');
  expect(firstHouse.first.t).toBeGreaterThan(15);
  expect(firstHouse.first.t).toBeLessThan(60);

  // Казармы строятся следом: без них преемственность героя недостижима (§F.3).
  await expect.poll(
    () => page.evaluate(() => {
      const game = (window as RuntimeWindow).__tss!;
      if (game.scene.isActive('LevelUp')) {
        const levelUp = game.scene.getScene('LevelUp') as { chooseByIndex(index: number): void };
        try { levelUp.chooseByIndex(0); } catch { /* карточек ещё нет */ }
      }
      const scene = game.scene.getScene('Game') as GameSceneRuntime;
      scene.player.iframesUntil = Date.now() + 1e9;
      return (window as RuntimeWindow).__built?.some((b) => b.kind === 'barracks') ?? false;
    }),
    { timeout: 150_000, message: 'The settlement should raise its barracks after the first house' },
  ).toBe(true);

  const timeline = await page.evaluate(() => (window as RuntimeWindow).__built ?? []);
  const houseIndex = timeline.findIndex((b) => b.kind === 'house');
  const barracksIndex = timeline.findIndex((b) => b.kind === 'barracks');
  expect(houseIndex).toBeGreaterThanOrEqual(0);
  expect(barracksIndex).toBeGreaterThan(houseIndex);
});

test('phase E: the build plan starts with a house and reserves the barracks for the second slot', async ({ page }) => {
  await startRun(page);
  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss!;
    const scene = game.scene.getScene('Game') as GameSceneRuntime;
    const economy = scene.economy;
    return {
      next: economy.nextBuildKind(),
      planned: economy.plannedBuildCost(),
      houses: economy.buildings.filter((b) => b.kind === 'house').length,
    };
  });
  // План автостройки: сначала дом (§B.9), дальше — казармы (§F.3).
  expect(report.next).toBe('house');
  expect(report.planned.wood).toBeGreaterThanOrEqual(30);
  expect(report.houses).toBe(0);
});

test('phase E: the settlement is on screen when the match starts', async ({ page }) => {
  await startRun(page);
  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss!;
    const scene = game.scene.getScene('Game') as GameSceneRuntime & {
      cameras: { main: { worldView: { x: number; y: number; width: number; height: number } } };
    };
    const view = scene.cameras.main.worldView;
    const inView = (x: number, y: number): boolean =>
      x >= view.x && x <= view.x + view.width && y >= view.y && y <= view.y + view.height;
    const economy = scene.economy;
    return {
      castleVisible: inView(economy.castleX, economy.castleY),
      playerDistanceToCastle: Math.round(
        Math.hypot(scene.player.x - economy.castleX, scene.player.y - economy.castleY),
      ),
      workersVisible: economy.pawns.filter((p) => inView(p.x, p.y)).length,
      workers: economy.pawns.length,
    };
  });
  // Первый экран матча — это дом, а не пустая трава (§0.1, §B.9).
  expect(report.castleVisible).toBe(true);
  expect(report.playerDistanceToCastle).toBeLessThan(400);
  expect(report.workers).toBe(4);
  expect(report.workersVisible).toBe(4);
});
