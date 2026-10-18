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
  hp: number;
  maxHp: number;
  underConstruction: boolean;
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
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
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
    building.damage(building.maxHp * 0.71, -1); // 29% HP: 30% warning
    building.damage(building.maxHp * 0.21, -1); // 8% HP: 10% warning
    return {
      started,
      found: true,
      hpFraction: building.hp / building.maxHp,
      warned30: building.warned30,
      warned10: building.warned10,
      warnings,
    };
  });

  expect(monastery.started).toBe(true);
  expect(monastery.found).toBe(true);
  expect(monastery.hpFraction).toBeGreaterThan(0.07);
  expect(monastery.hpFraction).toBeLessThan(0.09);
  expect(monastery.warned30).toBe(true);
  expect(monastery.warned10).toBe(true);
  expect(monastery.warnings).toHaveLength(2);

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
