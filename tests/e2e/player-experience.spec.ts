import { expect, test } from '@playwright/test';

type RuntimeWindow = Window & {
  __tss?: {
    scene: {
      getScene(key: string): unknown;
      isActive(key: string): boolean;
    };
  };
  __levelUpBeamCardCount?: number;
  __levelUpFinished?: boolean;
};

type LevelUpRuntime = {
  cards: Array<{
    card: unknown;
    icon: {
      type: string;
      texture: { key: string };
      anims: { currentAnim: { key: string } | null };
    };
  }>;
  showHeroLevelUpBeam(
    point: { x: number; y: number } | undefined,
    width: number,
    height: number,
  ): void;
  chooseCard(card: unknown): void;
};

const startupTimeout = 60_000;

async function startBareRun(page: import('@playwright/test').Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 720 });
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
  if (!bounds) throw new Error('Game canvas is missing');
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await expect.poll(() => page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game?.scene.isActive('Game')) return true;
    return !(game.scene.getScene('Game') as { hintOverlayPaused: boolean }).hintOverlayPaused;
  }), { timeout: 10_000 }).toBe(true);
}

test('level-up uses animated dynamite icon and plays its beam after the cards disappear', async ({ page }) => {
  await startBareRun(page);

  await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const gameScene = game.scene.getScene('Game') as {
      scene: {
        pause(): void;
        launch(key: string, payload: unknown): void;
        resume(): void;
      };
    };
    gameScene.scene.pause();
    gameScene.scene.launch('LevelUp', {
      heroPoint: { x: 0.5, y: 0.58 },
      topInset: 0,
      getChoices: () => [{
        kind: 'weapon-up',
        id: 'bomb',
        title: 'Powder Keg',
        subtitle: 'LEVEL 1 → 2',
        desc: 'Damage and radius increase',
        icon: 'icon-bomb',
        levelFrom: 1,
        levelTo: 2,
      }],
      onChoose: () => true,
      onFinished: () => {
        (window as RuntimeWindow).__levelUpFinished = true;
        gameScene.scene.resume();
      },
    });
  });

  await expect.poll(() => page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game?.scene.isActive('LevelUp')) return 0;
    return (game.scene.getScene('LevelUp') as LevelUpRuntime).cards.length;
  }), { timeout: startupTimeout }).toBe(1);

  const icon = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss!;
    const levelUp = game.scene.getScene('LevelUp') as LevelUpRuntime;
    const icon = levelUp.cards[0].icon;
    const original = levelUp.showHeroLevelUpBeam.bind(levelUp);
    levelUp.showHeroLevelUpBeam = (point, width, height) => {
      (window as RuntimeWindow).__levelUpBeamCardCount = levelUp.cards.length;
      original(point, width, height);
    };
    levelUp.chooseCard(levelUp.cards[0].card);
    return {
      type: icon.type,
      texture: icon.texture.key,
      animation: icon.anims.currentAnim?.key ?? null,
      cardsAfterChoose: levelUp.cards.length,
    };
  });

  expect(icon.type).toBe('Sprite');
  expect(icon.texture).toBe('barrel');
  expect(icon.animation).toBe('barrel-burn');
  expect(icon.cardsAfterChoose).toBe(0);

  await expect.poll(
    () => page.evaluate(() => (window as RuntimeWindow).__levelUpBeamCardCount ?? -1),
    { timeout: 5_000 },
  ).toBe(0);
  await expect.poll(
    () => page.evaluate(() => (window as RuntimeWindow).__levelUpFinished === true),
    { timeout: 5_000 },
  ).toBe(true);
  await expect.poll(
    () => page.evaluate(() => (window as RuntimeWindow).__tss?.scene.isActive('LevelUp') ?? true),
    { timeout: 5_000 },
  ).toBe(false);
});
