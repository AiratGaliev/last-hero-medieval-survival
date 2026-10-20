import { expect, test, type Page } from '@playwright/test';

// Холодный старт dev-сервера: Vite трансформирует весь граф модулей и ~570
// ассетов. На загруженном CI это занимает больше 30 сек — тест падал с
// «canvas не появился», хотя приложение стартует штатно.
const startupTimeout = 60_000;

type AnimationProbe = { repeat: number; frameRate?: number };
type RuntimeEnemy = {
  kind: string;
  active: boolean;
  x: number;
  y: number;
  anims: {
    currentAnim?: { key: string } | null;
    currentFrame?: { index: number } | null;
  };
};
type RuntimeScene = {
  scene: { isActive: () => boolean; resume: () => void };
  hints: { current: { id: string; ui: string } | null };
  time: { paused: boolean; now: number };
  physics: { world: { resume: () => void } };
  player: { x: number; y: number };
  enemyGroup: {
    getChildren: () => RuntimeEnemy[];
    contains: (enemy: RuntimeEnemy) => boolean;
    remove: (enemy: RuntimeEnemy, removeFromScene?: boolean, destroyChild?: boolean) => unknown;
  };
  spawner: { update: (seconds: number) => void; stopped: boolean };
  spawnEnemy: (kind: string, x: number, y: number) => boolean;
  onEnemyDeath: (enemy: RuntimeEnemy) => void;
  hintOverlayPaused: boolean;
  overlayOpen: boolean;
  pendingLevelUps: number;
  xp: number;
  xpNext: number;
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
  // #boot убирается по Core.READY и это раньше конца preload. Дожидаемся Menu,
  // чтобы BootScene успела зарегистрировать текстуры и глобальные анимации.
  await expect.poll(
    () => page.evaluate(() => {
      const game = (window as unknown as { __tss?: RuntimeGame }).__tss;
      return game?.scene.getScene('Menu').scene.isActive() ?? false;
    }),
    { timeout: startupTimeout, message: 'Menu should become active after BootScene preload and animation registration' },
  ).toBe(true);
  await expect.poll(
    () => page.evaluate(() => {
      const game = (window as unknown as { __tss?: RuntimeGame }).__tss;
      return game?.anims.exists('goblin-idle') ?? false;
    }),
    { timeout: startupTimeout, message: 'Creature animations should be registered after BootScene create' },
  ).toBe(true);
}

async function startGameplay(page: Page): Promise<void> {
  // Изолируем первый запуск и закрываем FTUE тем же действием, которым его
  // закрывает игрок. Не подменяем hintOverlayPaused вручную: это оставило бы
  // tutorial overlay открытым и проверяло бы бой в некорректном состоянии.
  await page.evaluate(() => window.localStorage.removeItem('tss-hints'));
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
  await expect.poll(
    () => page.evaluate(() => {
      const game = (window as unknown as { __tss?: RuntimeGame }).__tss;
      if (!game?.scene.getScene('Game').scene.isActive()) return null;
      return game.scene.getScene('Game').hints.current?.id ?? null;
    }),
    { timeout: startupTimeout, message: 'The first-run movement tutorial should be visible' },
  ).toBe('move');
  const canvas = page.locator('#game canvas');
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('Game canvas has no bounds');
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await expect.poll(
    () => page.evaluate(() => {
      const game = (window as unknown as { __tss?: RuntimeGame }).__tss;
      if (!game?.scene.getScene('Game').scene.isActive()) return true;
      return game.scene.getScene('Game').hintOverlayPaused;
    }),
    { timeout: startupTimeout, message: 'The tutorial action should resume active gameplay' },
  ).toBe(false);
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
      'face-bomb-fish', 'face-spider', 'face-snake', 'face-lizard', 'face-turtle',
      'face-gnome', 'face-panda', 'face-spear-goblin', 'face-harpoon-shark', 'face-paddle-shark',
      'face-bear', 'face-minotaur', 'face-boss',
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
      return ['atk', 'atkStrong', 'shoot', 'dead', 'recover', 'hit', 'guardIn', 'guardOut'].includes(anim)
        && game.anims.get(key)?.repeat !== 0;
    });
    const missingAnimations = keys.filter((key) => !game.anims.exists(key));
    const missingTextures = [
      ...keys.filter((key) => !game.textures.exists(key)),
      ...requiredTextures.filter((key) => !game.textures.exists(key)),
    ];
    // Декларация кадров не должна выходить за реальные границы PNG-спрайтлиста.
    // Это ловит тихие Phaser-ошибки, которые обычный exists() не обнаруживает.
    const invalidFrameCounts = boot.CREATURE_SHEETS.flatMap((creature) =>
      creature.sheets.flatMap(([anim, , frames]) => {
        const key = `${creature.kind}-${anim}`;
        if (!game.textures.exists(key)) return [];
        const source = game.textures.get(key).getSourceImage() as { width: number; height: number };
        const availableFrames = Math.floor(source.width / creature.frameW)
          * Math.floor(source.height / creature.frameW);
        return frames > availableFrames
          ? [`${key}: configured ${frames}, PNG provides ${availableFrames}`]
          : [];
      }),
    );
    const invalidDefs = Object.values(data.ENEMIES).filter((enemy) =>
      enemy.hp <= 0 || enemy.speed <= 0 || enemy.damage <= 0
      || enemy.frameW <= 0 || enemy.groundY <= 0 || enemy.body.r <= 0
      || ![enemy.body.cx, enemy.body.cy, enemy.body.r, enemy.groundY].every(Number.isFinite)
      || 'texture' in enemy,
    );
    const expectedLeftFacing = ['gnome', 'harpoon-shark', 'paddle-shark', 'panda', 'spear-goblin'];
    const actualLeftFacing = Object.values(data.ENEMIES)
      .filter((enemy) => enemy.facesRight === false).map((enemy) => enemy.kind).sort();
    const wrongFacing = actualLeftFacing.filter((kind) => !expectedLeftFacing.includes(kind))
      .concat(expectedLeftFacing.filter((kind) => !actualLeftFacing.includes(kind)));
    const legacyIds = [
      'grunt', 'swarm', 'brute', 'bomber', 'taskmaster', 'midboss',
      'boss-minion', 'elite-lancer', 'elite-monk', 'mercenary',
    ];
    const legacyRuntimeKeys = legacyIds.filter((kind) =>
      game.anims.exists(`${kind}-idle`) || game.textures.exists(`${kind}-idle`),
    );

    return {
      kinds, sheetKinds, missingAnimations, missingTextures, nonLooping, invalidFrameCounts,
      invalidDefs: invalidDefs.map((enemy) => enemy.kind), wrongFacing, legacyRuntimeKeys,
      hasMonk: 'monk' in data.HEROES,
      bossWindupRepeat: game.anims.get('boss-windup')?.repeat ?? null,
      bossRecoverRepeat: game.anims.get('boss-recover')?.repeat ?? null,
      minotaurGuardRepeat: game.anims.get('minotaur-guard')?.repeat ?? null,
    };
  });

  expect(report.kinds).toEqual([
    'bear', 'bomb-fish', 'boss', 'gnoll', 'gnome', 'goblin', 'harpoon-shark', 'lizard',
    'minotaur', 'paddle-shark', 'panda', 'pig-rider', 'shaman', 'skull', 'snake',
    'spear-goblin', 'spider', 'thief', 'turtle',
  ]);
  expect(report.sheetKinds).toEqual(report.kinds);
  expect(report.missingAnimations).toEqual([]);
  expect(report.missingTextures).toEqual([]);
  expect(report.invalidFrameCounts).toEqual([]);
  expect(report.nonLooping).toEqual([]);
  expect(report.invalidDefs).toEqual([]);
  expect(report.wrongFacing).toEqual([]);
  expect(report.legacyRuntimeKeys).toEqual([]);
  expect(report.hasMonk).toBe(true);
  expect(report.bossWindupRepeat).toBe(-1);
  expect(report.bossRecoverRepeat).toBe(0);
  expect(report.minotaurGuardRepeat).toBe(-1);
  expect(report.kinds).toHaveLength(19);
  expect(report.sheetKinds).toHaveLength(19);
  expect(pageErrors).toEqual([]);
});

test('enemy weight tiers, daily pool and scheduled waves stay aligned with the expanded pool', async ({ page }) => {
  await openApp(page);
  const report = await page.evaluate(async () => {
    const root = window.location.origin;
    const data = await import(/* @vite-ignore */ new URL('/src/game/data.ts', root).href) as {
      ENEMIES: Record<string, unknown>;
      WAVE_EVENTS: Array<{ t: number; type: string; enemy?: string; count?: number; interval?: number }>;
      pickRegularKind: (minute: number, rng: () => number, pool?: readonly string[]) => string;
      pickDailyPool: (seed: string) => string[];
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
    const dailyPool = data.pickDailyPool('2026-10-19');
    const sameDailyPool = data.pickDailyPool('2026-10-19');
    const otherDailyPool = data.pickDailyPool('2026-10-20');
    const dailySamples = Array.from({ length: 30 }, (_, i) =>
      data.pickRegularKind(i / 2, () => (i % 3) / 3, dailyPool),
    );

    return {
      sorted,
      dailyPool,
      sameDailyPool,
      otherDailyPool,
      dailySamples,
      dailyPoolHasBosses: dailyPool.some((kind) => ['bear', 'minotaur', 'boss'].includes(kind)),
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
  expect(report.dailyPool).toEqual(report.sameDailyPool);
  expect(report.dailyPool).toHaveLength(9);
  expect(report.dailyPool).toContain('goblin');
  expect(report.dailyPool).toContain('thief');
  expect(report.dailyPool).toContain('gnoll');
  expect(report.otherDailyPool).not.toEqual(report.dailyPool);
  expect(report.dailyPoolHasBosses).toBe(false);
  expect(report.dailySamples.every((kind) => report.dailyPool.includes(kind))).toBe(true);
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

test('phase I: every reserved creature spawns under the cap with runtime animations', async ({ page }) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await openApp(page);
  await startGameplay(page);

  const report = await page.evaluate(async () => {
    const game = (window as unknown as { __tss?: RuntimeGame }).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const root = window.location.origin;
    const [data, constants] = await Promise.all([
      import(/* @vite-ignore */ new URL('/src/game/data.ts', root).href) as Promise<{
        ENEMIES: Record<string, { isElite?: boolean; isBoss?: boolean }>;
        pickDailyPool: (seed: string) => string[];
      }>,
      import(/* @vite-ignore */ new URL('/src/game/constants.ts', root).href) as Promise<{
        ENEMY_CAP: number;
      }>,
    ]);
    const scene = game.scene.getScene('Game');
    scene.spawner.stopped = true;
    const reserved = [
      'spider', 'snake', 'lizard', 'turtle', 'gnome', 'panda',
      'spear-goblin', 'harpoon-shark', 'paddle-shark',
    ];
    const results = reserved.map((kind, index) => ({
      kind,
      spawned: scene.spawnEnemy(kind, scene.player.x + 160 + index * 28, scene.player.y + 120),
      hasIdle: game.anims.exists(`${kind}-idle`),
      hasAttack: game.anims.exists(`${kind}-atk`),
      hasPortrait: game.textures.exists(`face-${kind}`),
    }));
    // Проверяем реальную границу, а не тривиальное условие «9 меньше 220».
    // Пул заполняется синхронно в одном evaluate, до следующего физического тика.
    while (scene.enemyGroup.getLength() < constants.ENEMY_CAP) {
      const accepted = scene.spawnEnemy(
        'goblin',
        scene.player.x + 180,
        scene.player.y + 100,
      );
      if (!accepted) break;
    }
    const groupCountAtCap = scene.enemyGroup.getLength();
    const extraSpawnAccepted = scene.spawnEnemy(
      'goblin',
      scene.player.x + 180,
      scene.player.y + 100,
    );
    const groupCountAfterRejected = scene.enemyGroup.getLength();
    const active = scene.enemyGroup.getChildren().filter((enemy) => enemy.active);
    const pool = data.pickDailyPool('2026-10-19');
    return {
      results,
      activeCount: active.length,
      cap: constants.ENEMY_CAP,
      groupCountAtCap,
      extraSpawnAccepted,
      groupCountAfterRejected,
      dailyPoolValid: pool.every((kind) => kind in data.ENEMIES
        && !data.ENEMIES[kind].isElite && !data.ENEMIES[kind].isBoss),
    };
  });

  expect(report.results.every((item) => item.spawned && item.hasIdle && item.hasAttack && item.hasPortrait)).toBe(true);
  expect(report.results.map((item) => item.kind)).toEqual([
    'spider', 'snake', 'lizard', 'turtle', 'gnome', 'panda',
    'spear-goblin', 'harpoon-shark', 'paddle-shark',
  ]);
  expect(report.groupCountAtCap).toBe(report.cap);
  expect(report.extraSpawnAccepted).toBe(false);
  expect(report.groupCountAfterRejected).toBe(report.cap);
  expect(report.activeCount).toBeLessThanOrEqual(report.cap);
  expect(report.dailyPoolValid).toBe(true);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors.filter((message) => /Frame not found|Missing animation/i.test(message))).toEqual([]);
});



test('phase I: every reserved creature enters its combat movement state', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await openApp(page);
  await startGameplay(page);

  const initial = await page.evaluate(() => {
    const game = (window as unknown as { __tss?: RuntimeGame }).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const scene = game.scene.getScene('Game');
    scene.spawner.stopped = true;
    const kinds = [
      'spider', 'snake', 'lizard', 'turtle', 'gnome',
      'panda', 'spear-goblin', 'harpoon-shark', 'paddle-shark',
    ];
    const started = kinds.map((kind, index) => {
      const x = scene.player.x + 540 + index * 30;
      const y = scene.player.y + 300;
      if (!scene.spawnEnemy(kind, x, y)) return { kind, spawned: false, x, y };
      const enemy = scene.enemyGroup.getChildren().find((candidate) =>
        candidate.active && candidate.kind === kind
          && Math.hypot(candidate.x - x, candidate.y - y) < 4);
      if (!enemy) return { kind, spawned: false, x, y };
      return { kind, spawned: true, x: enemy.x, y: enemy.y };
    });
    return started;
  });

  await page.waitForTimeout(450);
  const movement = await page.evaluate((positions) => {
    const game = (window as unknown as { __tss?: RuntimeGame }).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const scene = game.scene.getScene('Game');
    return positions.map((initialPosition) => {
      const enemy = scene.enemyGroup.getChildren().find((candidate) =>
        candidate.active && candidate.kind === initialPosition.kind);
      return {
        kind: initialPosition.kind,
        spawned: initialPosition.spawned,
        distance: enemy ? Math.hypot(enemy.x - initialPosition.x, enemy.y - initialPosition.y) : 0,
      };
    });
  }, initial);
  expect(movement.every((result) => result.spawned && result.distance > 1)).toBe(true);

  expect(pageErrors).toEqual([]);
});

test('phase I: harpoon shark still fires when its throw animation is interrupted', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await openApp(page);
  await startGameplay(page);

  await page.evaluate(() => {
    const game = (window as unknown as { __tss?: RuntimeGame }).__tss;
    if (!game) throw new Error('Phaser runtime is unavailable');
    const scene = game.scene.getScene('Game') as RuntimeScene & {
      __e2eHarpoonInterrupted?: boolean;
    };
    scene.spawner.stopped = true;
    // 900 px гарантируют, что выпущенный снаряд не попадёт в героя до проверки:
    // скорость гарпуна 320 px/с, срок жизни — 2400 мс.
    const x = scene.player.x + 450;
    const y = scene.player.y;
    if (!scene.spawnEnemy('harpoon-shark', x, y)) throw new Error('Could not spawn harpoon shark');
    const shark = scene.enemyGroup.getChildren().find((candidate) =>
      candidate.active && candidate.kind === 'harpoon-shark') as RuntimeEnemy | undefined;
    if (!shark) throw new Error('Harpoon shark disappeared immediately after spawn');
    const animated = shark as unknown as {
      on(event: string, listener: (animation: { key: string }) => void): void;
      play(key: string, ignoreIfPlaying?: boolean): unknown;
    };
    // Подписка устанавливается до первого AI-тика. Это исключает гонку старого
    // теста, который обнаруживал ключ анимации уже после возможного выпуска.
    animated.on('animationstart', (animation) => {
      if (animation.key !== 'harpoon-shark-atk') return;
      scene.player.setPosition(shark.x - 900, shark.y);
      scene.__e2eHarpoonInterrupted = true;
      animated.play('harpoon-shark-run', true);
    });
  });

  await expect.poll(() => page.evaluate(() => {
    const game = (window as unknown as { __tss?: RuntimeGame }).__tss;
    if (!game) return false;
    const scene = game.scene.getScene('Game') as RuntimeScene & {
      __e2eHarpoonInterrupted?: boolean;
    };
    return scene.__e2eHarpoonInterrupted === true;
  }), { timeout: 3_000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => {
    const game = (window as unknown as { __tss?: RuntimeGame }).__tss;
    if (!game) return false;
    const scene = game.scene.getScene('Game') as RuntimeScene & {
      projectiles: {
        enemyShots: { getChildren(): Array<{ active: boolean; shotKind?: string; texture: { key: string } }> };
      };
    };
    return scene.projectiles.enemyShots.getChildren()
      .some((shot) => shot.active && shot.shotKind === 'harpoon' && shot.texture.key === 'proj-harpoon');
  }), { timeout: 2_500 }).toBe(true);
  expect(pageErrors).toEqual([]);
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
    // Advance the wave director directly after the tutorial has been dismissed.
    scene.spawner.stopped = false;
    scene.spawner.update(2.1);
    return scene.enemyGroup.getChildren().filter((enemy) => enemy.active).map((enemy) => enemy.kind);
  });
  expect(opening).toContain('goblin');

  const deathStart = await page.evaluate(() => {
    const game = (window as unknown as { __tss?: RuntimeGame }).__tss;
    if (!game) throw new Error('Phaser game instance is unavailable');
    const scene = game.scene.getScene('Game');
    // Изолируем lifecycle-сценарий от сторонних overlay-сцен. В штатной игре
    // GameScene корректно приостанавливается при LevelUp/Pause; тест смерти
    // должен проверять анимацию в активной сцене, а не продолжительность паузы.
    for (const overlay of ['LevelUp', 'Pause', 'Succession']) game.scene.stop(overlay);
    scene.scene.resume();
    scene.time.paused = false;
    scene.physics.world.resume();
    scene.hintOverlayPaused = false;
    scene.overlayOpen = false;
    scene.pendingLevelUps = 0;
    scene.xp = 0;
    scene.xpNext = Number.MAX_SAFE_INTEGER;
    // Не оставляем обычные волны, чтобы бой не генерировал сторонние события.
    scene.spawner.stopped = true;
    for (const enemy of scene.enemyGroup.getChildren()) {
      scene.enemyGroup.remove(enemy, true, true);
    }
    if (!scene.spawnEnemy('boss', scene.player.x + 450, scene.player.y + 450)) {
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
      sceneTime: scene.time.now,
    };
  });
  expect(deathStart).toMatchObject({ active: true, anim: 'boss-dead', remainsInGroup: false });

  await page.waitForTimeout(500);
  const deathProgressed = await page.evaluate(() => {
    const game = (window as unknown as { __tss?: RuntimeGame }).__tss;
    const scene = game?.scene.getScene('Game');
    const boss = (window as unknown as { __phaseABoss?: RuntimeEnemy }).__phaseABoss;
    return {
      active: boss?.active ?? false,
      anim: boss?.anims.currentAnim?.key ?? null,
      frame: boss?.anims.currentFrame?.index ?? null,
      sceneTime: scene?.time.now ?? null,
      scenePaused: scene?.time.paused ?? null,
    };
  });
  expect(deathProgressed.active).toBe(true);
  expect(deathProgressed.anim).toBe('boss-dead');
  expect(deathProgressed.frame).toBeGreaterThan(0);
  expect(deathProgressed.sceneTime).toBeGreaterThan(deathStart.sceneTime);
  expect(deathProgressed.scenePaused).toBe(false);

  // Таймер сцены и game loop могут слегка расходиться с wall-clock на CI,
  // особенно в WebGL mobile/desktop профилях. Проверяем ожидаемое состояние
  // polling-ом с конечным timeout, а не фиксированным sleep ровно на границе.
  await expect.poll(
    () => page.evaluate(() => {
      const boss = (window as unknown as { __phaseABoss?: RuntimeEnemy }).__phaseABoss;
      return boss?.active ?? false;
    }),
    { timeout: 5_000, message: 'Ogre should be destroyed after the one-shot boss-dead animation' },
  ).toBe(false);
  expect(pageErrors).toEqual([]);
});
