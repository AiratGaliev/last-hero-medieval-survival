import { expect, test, type Page } from '@playwright/test';

const startupTimeout = 30_000;

type AnimationProbe = { repeat: number; frameRate?: number };
type RuntimeEnemy = {
  kind: string;
  active: boolean;
  anims: {
    currentAnim?: { key: string } | null;
    currentFrame?: { index: number } | null;
  };
};
type RuntimeScene = {
  scene: { isActive: () => boolean };
  player: { x: number; y: number };
  enemyGroup: {
    getChildren: () => RuntimeEnemy[];
    contains: (enemy: RuntimeEnemy) => boolean;
  };
  spawner: { update: (seconds: number) => void; stopped: boolean };
  spawnEnemy: (kind: string, x: number, y: number) => boolean;
  onEnemyDeath: (enemy: RuntimeEnemy) => void;
  hintOverlayPaused: boolean;
};
type RuntimeGame = {
  anims: { exists: (key: string) => boolean; get: (key: string) => AnimationProbe | null };
  textures: { exists: (key: string) => boolean };
  scene: {
    stop: (key: string) => void;
    start: (key: string, data?: unknown) => void;
    getScene: (key: string) => RuntimeScene;
  };
};

async function openApp(page: Page): Promise<void> {
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });
}

async function startGameplay(page: Page): Promise<void> {
  await page.evaluate(() => {
    const game = (window as unknown as { __tss?: RuntimeGame }).__tss;
    if (!game) throw new Error('Phaser instance was not exported to window.__tss');
    game.scene.stop('Menu');
    game.scene.start('Game', { hero: 'warrior', diff: 'normal' });
  });
  await expect.poll(
    () => page.evaluate(() => {
      const game = (window as unknown as { __tss?: RuntimeGame }).__tss;
      return game?.scene.getScene('Game').scene.isActive() ?? false;
    }),
    { timeout: startupTimeout, message: 'GameScene should start from the menu-independent test path' },
  ).toBe(true);
}

test('creature sheets, combat animations, projectiles and hero-monk regression assets load at runtime', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await openApp(page);

  const report = await page.evaluate(async () => {
    const game = (window as unknown as { __tss?: RuntimeGame }).__tss;
    if (!game) throw new Error('Phaser game instance is unavailable');
    const root = window.location.origin;
    const [data, boot] = await Promise.all([
      import(/* @vite-ignore */ new URL('/src/game/data.ts', root).href) as Promise<{
        ENEMIES: Record<string, {
          kind: string; hp: number; speed: number; damage: number; frameW: number;
          groundY: number; body: { cx: number; cy: number; r: number }; facesRight?: boolean;
          texture?: string;
        }>;
        HEROES: Record<string, unknown>;
      }>,
      import(/* @vite-ignore */ new URL('/src/game/scenes/BootScene.ts', root).href) as Promise<{
        CREATURE_SHEETS: Array<{
          kind: string; dir: string; base: string; frameW: number;
          sheets: Array<[string, string, number, number]>;
        }>;
      }>,
    ]);

    const kinds = Object.keys(data.ENEMIES).sort();
    const sheetKinds = boot.CREATURE_SHEETS.map((item) => item.kind).sort();
    const faceKeys = [
      'face-goblin', 'face-thief', 'face-gnoll', 'face-skull', 'face-shaman',
      'face-bomb-fish', 'face-bear', 'face-minotaur', 'face-boss',
    ];
    const requiredTextures = [
      'proj-bone', 'proj-hex', 'fx-hex', ...faceKeys,
      'hero-monk-idle', 'hero-monk-run', 'hero-monk-atk', 'fx-heal', 'barrel',
    ];
    const keys = boot.CREATURE_SHEETS.flatMap((creature) =>
      creature.sheets.map(([anim]) => `${creature.kind}-${anim}`),
    );
    const nonLooping = keys.filter((key) => {
      const anim = key.slice(key.lastIndexOf('-') + 1);
      return ['atk', 'shoot', 'dead', 'recover'].includes(anim)
        && game.anims.get(key)?.repeat !== 0;
    });
    const missingAnimations = keys.filter((key) => !game.anims.exists(key));
    const missingTextures = [
      ...keys.filter((key) => !game.textures.exists(key)),
      ...requiredTextures.filter((key) => !game.textures.exists(key)),
    ];
    const invalidDefs = Object.values(data.ENEMIES).filter((enemy) =>
      enemy.hp <= 0 || enemy.speed <= 0 || enemy.damage <= 0
      || enemy.frameW <= 0 || enemy.groundY <= 0 || enemy.body.r <= 0
      || ![enemy.body.cx, enemy.body.cy, enemy.body.r, enemy.groundY].every(Number.isFinite)
      || 'texture' in enemy
      || (enemy.kind === 'bear' && enemy.facesRight !== true),
    );
    const legacyIds = [
      'grunt', 'swarm', 'brute', 'bomber', 'taskmaster', 'midboss',
      'boss-minion', 'elite-lancer', 'elite-monk', 'mercenary',
    ];
    const legacyRuntimeKeys = legacyIds.filter((kind) =>
      game.anims.exists(`${kind}-idle`) || game.textures.exists(`${kind}-idle`),
    );

    return {
      kinds, sheetKinds, missingAnimations, missingTextures, nonLooping,
      invalidDefs: invalidDefs.map((enemy) => enemy.kind), legacyRuntimeKeys,
      hasMonk: 'monk' in data.HEROES,
      bossWindupRepeat: game.anims.get('boss-windup')?.repeat ?? null,
      bossRecoverRepeat: game.anims.get('boss-recover')?.repeat ?? null,
      minotaurGuardRepeat: game.anims.get('minotaur-guard')?.repeat ?? null,
    };
  });

  expect(report.kinds).toEqual([
    'bear', 'bomb-fish', 'boss', 'gnoll', 'goblin', 'minotaur', 'pig-rider', 'shaman', 'skull', 'thief',
  ]);
  expect(report.sheetKinds).toEqual(report.kinds);
  expect(report.missingAnimations).toEqual([]);
  expect(report.missingTextures).toEqual([]);
  expect(report.nonLooping).toEqual([]);
  expect(report.invalidDefs).toEqual([]);
  expect(report.legacyRuntimeKeys).toEqual([]);
  expect(report.hasMonk).toBe(true);
  expect(report.bossWindupRepeat).toBe(-1);
  expect(report.bossRecoverRepeat).toBe(0);
  expect(report.minotaurGuardRepeat).toBe(-1);
  expect(report.kinds).toHaveLength(10);
  expect(report.sheetKinds).toHaveLength(10);
  expect(pageErrors).toEqual([]);
});

test('enemy weight tiers and scheduled waves stay aligned with the ten-kind pool', async ({ page }) => {
  await openApp(page);
  const report = await page.evaluate(async () => {
    const root = window.location.origin;
    const data = await import(/* @vite-ignore */ new URL('/src/game/data.ts', root).href) as {
      ENEMIES: Record<string, unknown>;
      WAVE_EVENTS: Array<{ t: number; type: string; enemy?: string; count?: number; interval?: number }>;
      pickRegularKind: (minute: number, rng: () => number) => string;
    };
    const latestKindAt = (minute: number) => data.pickRegularKind(minute, () => 0.999999);
    const byTimeAndType = (t: number, type: string) =>
      data.WAVE_EVENTS.find((event) => event.t === t && event.type === type);
    const pool = new Set(Object.keys(data.ENEMIES));
    const unknownKinds = data.WAVE_EVENTS.filter((event) => event.enemy && !pool.has(event.enemy));
    const sorted = data.WAVE_EVENTS.every((event, index, events) =>
      index === 0 || events[index - 1].t <= event.t,
    );
    const poolSamples = Array.from({ length: 26 }, (_, minute) =>
      [0, 0.5, 0.999999].map((rng) => data.pickRegularKind(minute, () => rng)),
    ).flat();

    return {
      sorted,
      unknownKinds: unknownKinds.map((event) => ({ t: event.t, enemy: event.enemy })),
      invalidSamples: poolSamples.filter((kind) => !pool.has(kind)),
      unlocks: [
        [0, latestKindAt(0)], [1, latestKindAt(1)], [2, latestKindAt(2)],
        [3, latestKindAt(3)], [5, latestKindAt(5)], [7, latestKindAt(7)],
        [9, latestKindAt(9)], [11, latestKindAt(11)],
      ],
      bossAt15: byTimeAndType(900, 'boss')?.enemy,
      bearAt5: byTimeAndType(300, 'elite')?.enemy,
      minotaurAt10: byTimeAndType(600, 'elite')?.enemy,
      finalHorde: byTimeAndType(840, 'ring'),
      firstSpawnInterval: byTimeAndType(0, 'rate')?.interval,
    };
  });

  expect(report.sorted).toBe(true);
  expect(report.unknownKinds).toEqual([]);
  expect(report.invalidSamples).toEqual([]);
  expect(report.unlocks).toEqual([
    [0, 'goblin'], [1, 'goblin'], [2, 'thief'], [3, 'gnoll'],
    [5, 'skull'], [7, 'shaman'], [9, 'pig-rider'], [11, 'bomb-fish'],
  ]);
  expect(report.bearAt5).toBe('bear');
  expect(report.minotaurAt10).toBe('minotaur');
  expect(report.bossAt15).toBe('boss');
  expect(report.finalHorde).toMatchObject({ enemy: 'goblin', count: 40 });
  expect(report.firstSpawnInterval).toBe(850);
});

test('gameplay spawns the opening goblin and keeps Ogre death animation alive to completion', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await openApp(page);
  await startGameplay(page);

  const opening = await page.evaluate(() => {
    const game = (window as unknown as { __tss?: RuntimeGame }).__tss;
    if (!game) throw new Error('Phaser game instance is unavailable');
    const scene = game.scene.getScene('Game');
    // Tutorial overlay is a separate UX gate; advance the wave director directly
    // to assert the real spawn callback without waiting for a player interaction.
    scene.hintOverlayPaused = false;
    scene.spawner.stopped = false;
    scene.spawner.update(2.1);
    return scene.enemyGroup.getChildren().filter((enemy) => enemy.active).map((enemy) => enemy.kind);
  });
  expect(opening).toContain('goblin');

  const deathStart = await page.evaluate(() => {
    const game = (window as unknown as { __tss?: RuntimeGame }).__tss;
    if (!game) throw new Error('Phaser game instance is unavailable');
    const scene = game.scene.getScene('Game');
    if (!scene.spawnEnemy('boss', scene.player.x + 90, scene.player.y + 90)) {
      throw new Error('Could not create a QA Ogre');
    }
    const boss = scene.enemyGroup.getChildren().find((enemy) => enemy.active && enemy.kind === 'boss');
    if (!boss) throw new Error('QA Ogre was not added to the enemy group');
    scene.onEnemyDeath(boss);
    (window as unknown as { __phaseABoss?: RuntimeEnemy }).__phaseABoss = boss;
    return {
      active: boss.active,
      anim: boss.anims.currentAnim?.key ?? null,
      remainsInGroup: scene.enemyGroup.contains(boss),
    };
  });
  expect(deathStart).toEqual({ active: true, anim: 'boss-dead', remainsInGroup: false });

  await page.waitForTimeout(500);
  const deathProgressed = await page.evaluate(() => {
    const boss = (window as unknown as { __phaseABoss?: RuntimeEnemy }).__phaseABoss;
    return {
      active: boss?.active ?? false,
      anim: boss?.anims.currentAnim?.key ?? null,
      frame: boss?.anims.currentFrame?.index ?? null,
    };
  });
  expect(deathProgressed.active).toBe(true);
  expect(deathProgressed.anim).toBe('boss-dead');
  expect(deathProgressed.frame).not.toBeNull();

  await page.waitForTimeout(900);
  const deathFinished = await page.evaluate(() => {
    const boss = (window as unknown as { __phaseABoss?: RuntimeEnemy }).__phaseABoss;
    return boss?.active ?? false;
  });
  expect(deathFinished).toBe(false);
  expect(pageErrors).toEqual([]);
});
