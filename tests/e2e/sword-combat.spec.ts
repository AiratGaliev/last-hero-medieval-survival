import { expect, test, type Page } from '@playwright/test';

const startupTimeout = 60_000;

type RuntimeEnemy = {
  kind: string;
  active: boolean;
  dead: boolean;
  x: number;
  y: number;
  hp: number;
  body?: { setVelocity(x: number, y: number): unknown };
};

type RuntimePlayer = {
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  anims: { currentAnim?: { key?: string } | null };
  play(key: string, ignoreIfPlaying?: boolean): unknown;
};

type RuntimeScene = {
  player: RuntimePlayer;
  enemyGroup: {
    getChildren(): RuntimeEnemy[];
    remove(enemy: RuntimeEnemy, removeFromScene?: boolean, destroyChild?: boolean): unknown;
  };
  spawner: { stopped: boolean };
  weapons: {
    cooldowns: Map<string, number>;
    fireSword(dmg: number, count: number): void;
  };
  children: { list: Array<{ texture?: { key?: string }; destroy(): unknown }> };
  registry: { get(key: string): unknown; set(key: string, value: unknown): void };
  spawnEnemy(kind: string, x: number, y: number): boolean;
  overlayOpen: boolean;
};

type RuntimeGame = {
  scene: { getScene(key: string): unknown; isActive(key: string): boolean };
};

type RuntimeWindow = Window & { __tss?: RuntimeGame };

async function startWarriorRun(page: Page): Promise<void> {
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
    const game = (window as RuntimeWindow).__tss!;
    const menu = game.scene.getScene('Menu') as {
      selectedHero?: string;
      selectedDiff?: string;
      scene: { start(key: string, data: { hero: string; diff: string }): void };
    };
    menu.scene.start('Game', {
      hero: 'warrior',
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
  await expect.poll(
    () => page.evaluate(() => {
      const scene = (window as RuntimeWindow).__tss?.scene.getScene('Game') as RuntimeScene | undefined;
      return scene ? !scene.overlayOpen : false;
    }),
    { timeout: 10_000 },
  ).toBe(true);
}

function slashCount(scene: RuntimeScene): number {
  return scene.children.list.filter((child) => child.texture?.key === 'slash').length;
}

function clearEnemies(scene: RuntimeScene): void {
  for (const enemy of [...scene.enemyGroup.getChildren()]) {
    scene.enemyGroup.remove(enemy, true, true);
  }
}

test('warrior only swings in sword range and uses attack2 on a surviving target', async ({ page }) => {
  await startWarriorRun(page);

  const idleReport = await page.evaluate(() => {
    const scene = (window as RuntimeWindow).__tss!.scene.getScene('Game') as RuntimeScene;
    scene.spawner.stopped = true;
    clearEnemies(scene);
    // Проверяем цикл атаки напрямую, не полагаясь на случайное состояние кулдауна.
    scene.weapons.cooldowns.set('sword', 60_000);
    for (const child of [...scene.children.list]) {
      if (child.texture?.key === 'slash') child.destroy();
    }
    scene.player.play('player-idle', true);
    scene.weapons.fireSword(12, 1);
    return {
      animation: scene.player.anims.currentAnim?.key ?? '',
      slashes: slashCount(scene),
    };
  });
  expect(idleReport.animation).not.toMatch(/^player-atk/);
  expect(idleReport.slashes).toBe(0);

  const farReport = await page.evaluate(() => {
    const scene = (window as RuntimeWindow).__tss!.scene.getScene('Game') as RuntimeScene;
    scene.player.play('player-idle', true);
    if (!scene.spawnEnemy('goblin', scene.player.x + 300, scene.player.y)) {
      throw new Error('Could not spawn a goblin outside sword reach');
    }
    const target = scene.enemyGroup.getChildren().find((enemy) => enemy.active && !enemy.dead && enemy.kind === 'goblin');
    if (!target) throw new Error('Far QA goblin was not registered');
    target.body?.setVelocity(0, 0);
    const hpBefore = target.hp;
    scene.weapons.fireSword(12, 1);
    return {
      animation: scene.player.anims.currentAnim?.key ?? '',
      hpBefore,
      hpAfter: target.hp,
      slashes: slashCount(scene),
    };
  });
  expect(farReport.animation).not.toMatch(/^player-atk/);
  expect(farReport.hpAfter).toBe(farReport.hpBefore);
  expect(farReport.slashes).toBe(0);

  const firstHit = await page.evaluate(() => {
    const scene = (window as RuntimeWindow).__tss!.scene.getScene('Game') as RuntimeScene;
    clearEnemies(scene);
    scene.player.play('player-idle', true);
    if (!scene.spawnEnemy('goblin', scene.player.x + 60, scene.player.y)) {
      throw new Error('Could not spawn a goblin in sword reach');
    }
    const target = scene.enemyGroup.getChildren().find((enemy) => enemy.active && !enemy.dead && enemy.kind === 'goblin');
    if (!target) throw new Error('Close QA goblin was not registered');
    target.hp = 1_000;
    target.body?.setVelocity(0, 0);
    scene.registry.set('qa-sword-target', target);
    const hpBefore = target.hp;
    scene.weapons.fireSword(12, 1);
    return {
      animation: scene.player.anims.currentAnim?.key ?? '',
      hpBefore,
      hpAfter: target.hp,
    };
  });
  expect(firstHit.animation).toBe('player-atk1');
  expect(firstHit.hpAfter).toBeLessThan(firstHit.hpBefore);

  await expect.poll(
    () => page.evaluate(() => {
      const scene = (window as RuntimeWindow).__tss!.scene.getScene('Game') as RuntimeScene;
      return scene.player.anims.currentAnim?.key ?? '';
    }),
    { timeout: 2_000 },
  ).toBe('player-atk2');

  await expect.poll(
    () => page.evaluate(() => {
      const scene = (window as RuntimeWindow).__tss!.scene.getScene('Game') as RuntimeScene;
      const target = scene.registry.get('qa-sword-target') as RuntimeEnemy | undefined;
      return target?.hp ?? Number.POSITIVE_INFINITY;
    }),
    { timeout: 2_000 },
  ).toBeLessThan(firstHit.hpAfter);
});
