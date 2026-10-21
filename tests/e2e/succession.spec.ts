import { expect, test, type Page } from '@playwright/test';

// Приёмочные проверки преемственности по TZ §F.4–F.13.
// В тестах используется настоящий GameScene/SuccessionScene; в поселение
// добавляется минимальная запись здания-источника, чтобы не ждать автопостройки.

type BuildingRuntime = {
  kind: string;
  alive: boolean;
  underConstruction: boolean;
};

type SuccessionUiData = {
  resourceCost: { wood: number; ore: number; meat?: number } | null;
  firstFree: boolean;
  showResources: boolean;
  resourcesAffordable: boolean;
  goldAffordable: boolean;
  onTakeResources(weapon: string): boolean;
};

type GameSceneRuntime = {
  economy: {
    buildings: BuildingRuntime[];
    pawns: unknown[];
    resources: { wood: number; ore: number; meat: number };
  };
  succession: {
    freeUsed: boolean;
    successionsDone: number;
    resourceCost(): { wood: number; ore: number; meat?: number } | null;
  };
  player: { hero: { id: string }; iframesUntil: number };
  heroDef: { id: string };
  hud: {
    weaponIcons: Map<string, unknown>;
    setIcon(id: string, iconKey: string, level: number, isPassive: boolean): void;
  };
  level: number;
  gold: number;
  activeTimeMs: number;
  overlayOpen: boolean;
  onHeroDeath(): void;
  scene: { start(key: string, data?: unknown): void; resume(): void };
};

type SuccessionSceneRuntime = {
  data_: SuccessionUiData | null;
  adUsed: boolean;
  adInFlight: boolean;
  adButton: {
    setEnabled(on: boolean): void;
    img: { alpha: number };
    hit: { getData(key: string): unknown };
  } | null;
  takeAd(): Promise<void>;
  children: { list: Array<{ type?: string; text?: string }> };
};

type MenuRuntime = {
  selectedHero?: string;
  selectedDiff?: string;
  scene: { start(key: string, data: { hero: string; diff: string }): void };
};

type PhaserRuntime = {
  scene: {
    getScene(key: string): unknown;
    isActive(key: string): boolean;
    stop(key: string): void;
  };
};

type RuntimeWindow = Window & { __tss?: PhaserRuntime };

const startupTimeout = 60_000;

async function startRun(page: Page): Promise<void> {
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });
  await expect.poll(
    () => page.evaluate(() => (window as RuntimeWindow).__tss?.scene.isActive('Menu') ?? false),
    { timeout: startupTimeout },
  ).toBe(true);

  await page.evaluate(() => {
    localStorage.removeItem('tss-succession-free');
    localStorage.removeItem('tss-meta2');
    localStorage.removeItem('tss-hints');
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const menu = game.scene.getScene('Menu') as MenuRuntime;
    // Стартуем не мечником, чтобы проверить реальную замену класса героя.
    menu.scene.start('Game', { hero: 'archer', diff: menu.selectedDiff ?? 'normal' });
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

test('phase N: no living warrior still exposes first-free resource succession and clears the old build', async ({ page }) => {
  await startRun(page);

  const result = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const scene = game.scene.getScene('Game') as GameSceneRuntime;

    scene.economy.buildings.push({
      kind: 'barracks',
      alive: true,
      underConstruction: false,
    });
    const woodBefore = scene.economy.resources.wood;
    const oreBefore = scene.economy.resources.ore;
    const pawnCountBefore = scene.economy.pawns.length;
    // Маркер старого билда: после смены не должен остаться в панели HUD.
    scene.hud.setIcon('obsolete-test-weapon', 'btn-small-blue', 3, false);

    const heroBefore = scene.player.hero.id;
    scene.onHeroDeath();
    const succession = game.scene.getScene('Succession') as SuccessionSceneRuntime;
    const data = succession.data_;
    if (!data) throw new Error('SuccessionScene was not initialized');
    const labels = succession.children.list
      .filter((child) => child.type === 'Text')
      .map((child) => child.text ?? '');
    const renderedFreeBranch = labels.some((label) => label.toUpperCase().includes('FREE'));

    const costAtDisplay = data.resourceCost;
    const showResources = data.showResources;
    const resourcesAffordable = data.resourcesAffordable;
    const accepted = data.onTakeResources('sword');
    game.scene.stop('Succession');

    return {
      renderedFreeBranch,
      showResources,
      resourcesAffordable,
      costAtDisplay,
      accepted,
      heroBefore,
      heroAfter: scene.player.hero.id,
      levelAfter: scene.level,
      invulnerabilityMs: scene.player.iframesUntil - scene.activeTimeMs,
      woodBefore,
      woodAfter: scene.economy.resources.wood,
      oreBefore,
      oreAfter: scene.economy.resources.ore,
      pawnCountBefore,
      pawnCountAfter: scene.economy.pawns.length,
      barracksPreserved: scene.economy.buildings.some((b) => b.kind === 'barracks' && b.alive),
      successionFreeUsed: scene.succession.freeUsed,
      hudIconIds: [...scene.hud.weaponIcons.keys()].sort(),
      overlayOpen: scene.overlayOpen,
    };
  });

  expect(result.renderedFreeBranch).toBe(true);
  expect(result.showResources).toBe(true);
  expect(result.resourcesAffordable).toBe(true);
  expect(result.costAtDisplay).toEqual({ wood: 40, ore: 15 });
  expect(result.accepted).toBe(true);
  expect(result.heroBefore).toBe('archer');
  expect(result.heroAfter).toBe('warrior');
  expect(result.levelAfter).toBe(1);
  expect(result.invulnerabilityMs).toBe(3_000);
  expect(result.woodAfter).toBe(result.woodBefore);
  expect(result.oreAfter).toBe(result.oreBefore);
  expect(result.pawnCountAfter).toBe(result.pawnCountBefore);
  expect(result.barracksPreserved).toBe(true);
  expect(result.successionFreeUsed).toBe(true);
  expect(result.hudIconIds).toEqual(['sword']);
  expect(result.overlayOpen).toBe(false);
});

test('phase N: later succession without a resource cost renders safely and keeps the resource branch unavailable', async ({ page }) => {
  await startRun(page);

  const result = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const scene = game.scene.getScene('Game') as GameSceneRuntime;
    scene.economy.buildings.push({
      kind: 'barracks',
      alive: true,
      underConstruction: false,
    });
    scene.succession.freeUsed = true;
    scene.succession.successionsDone = 3;
    scene.gold = 0;

    scene.onHeroDeath();
    const succession = game.scene.getScene('Succession') as SuccessionSceneRuntime;
    const data = succession.data_;
    if (!data) throw new Error('SuccessionScene was not initialized');
    const result = {
      active: game.scene.isActive('Succession'),
      costIsNull: data.resourceCost === null,
      resourceBranchVisible: data.showResources,
      resourcesAffordable: data.resourcesAffordable,
      goldAffordable: data.goldAffordable,
      hasFreeLabel: succession.children.list.some(
        (child) => child.type === 'Text' && (child.text ?? '').toUpperCase().includes('FREE'),
      ),
    };
    game.scene.stop('Succession');
    return result;
  });

  expect(result.active).toBe(true);
  expect(result.costIsNull).toBe(true);
  expect(result.resourceBranchVisible).toBe(false);
  expect(result.resourcesAffordable).toBe(false);
  expect(result.goldAffordable).toBe(false);
  expect(result.hasFreeLabel).toBe(false);
});

test('phase N: a failed rewarded attempt dims only the ad branch and leaves surrender available', async ({ page }) => {
  await startRun(page);

  const result = await page.evaluate(async () => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const scene = game.scene.getScene('Game') as GameSceneRuntime;
    scene.economy.buildings.push({
      kind: 'barracks',
      alive: true,
      underConstruction: false,
    });
    scene.succession.freeUsed = true;
    scene.succession.successionsDone = 1;
    scene.onHeroDeath();

    const succession = game.scene.getScene('Succession') as SuccessionSceneRuntime;
    if (!succession.adButton) throw new Error('Rewarded button was not created');
    await succession.takeAd();
    const labels = succession.children.list
      .filter((child) => child.type === 'Text')
      .map((child) => child.text ?? '');
    const result = {
      active: game.scene.isActive('Succession'),
      adUsed: succession.adUsed,
      adInFlight: succession.adInFlight,
      adButtonAlpha: succession.adButton.img.alpha,
      adButtonCursorState: succession.adButton.hit.getData('cursor'),
      surrenderVisible: labels.some((label) => label.toUpperCase().includes('SURRENDER')),
    };
    game.scene.stop('Succession');
    return result;
  });

  expect(result.active).toBe(true);
  expect(result.adUsed).toBe(true);
  expect(result.adInFlight).toBe(false);
  expect(result.adButtonAlpha).toBeLessThan(1);
  expect(result.adButtonCursorState).toBe('disabled');
  expect(result.surrenderVisible).toBe(true);
});
