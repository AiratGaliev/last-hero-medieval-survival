import { expect, test, type Page } from '@playwright/test';

type PawnRuntime = {
  kind: string;
  state: string;
  statusBadge: { text: string; visible: boolean; active: boolean } | null;
  updateStatusBadge(): void;
};

type SceneRuntime = {
  economy: { pawns: PawnRuntime[]; card(id: string): number };
  damageEnemyByPawn(
    enemy: { active: boolean; dead: boolean; x: number; y: number; def: { scale: number }; takeDamage(amount: number): boolean },
    dmg: number,
    weapon: string,
  ): void;
  elapsed: number;
  time: { now: number };
  hintOverlayPaused: boolean;
  garrisonDebugText: { text: string; active: boolean } | null;
  heroDpsAtTenMinutes: number | null;
  garrisonRawDamageSinceTen: number;
  garrisonAppliedDamageSinceTen: number;
  garrisonDpsMeasurementStartElapsed: number | null;
  nextGarrisonDebugUpdateAt: number;
  updateGarrisonDebugText(now: number): void;
  garrisonDpsBudget: {
    reset(nowMs?: number): void;
    apply(rawDamage: number, nowMs: number, heroDps: number): number;
  };
};

type MenuRuntime = {
  selectedHero?: string;
  selectedDiff?: string;
  scene: { start(key: string, data: { hero: string; diff: string }): void };
};

type PhaserRuntime = { scene: { getScene(key: string): unknown; isActive(key: string): boolean } };
type RuntimeWindow = Window & { __tss?: PhaserRuntime };

const startupTimeout = 30_000;

async function startRun(page: Page, debug = false): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(debug ? '/?lang=en&ysdk=mock&debug' : '/?lang=en&ysdk=mock');
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

  const canvas = page.locator('#game canvas');
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('Game canvas has no layout bounds');
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await expect.poll(() => page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss;
    if (!game?.scene.isActive('Game')) return true;
    return !(game.scene.getScene('Game') as SceneRuntime).hintOverlayPaused;
  }), { timeout: 10_000 }).toBe(true);
}

test('phase J: pawn status badges appear for retreat/wounded and clear after recovery', async ({ page }) => {
  await startRun(page);
  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss!;
    const scene = game.scene.getScene('Game') as SceneRuntime;
    const pawn = scene.economy.pawns.find(p => p.kind === 'collector')!;
    if (!pawn) throw new Error('No collector pawn in the initial settlement');

    pawn.state = 'retreat';
    pawn.updateStatusBadge();
    const retreat = { text: pawn.statusBadge?.text ?? null, visible: pawn.statusBadge?.visible ?? false };

    pawn.state = 'wounded';
    pawn.updateStatusBadge();
    const wounded = { text: pawn.statusBadge?.text ?? null, visible: pawn.statusBadge?.visible ?? false };

    pawn.state = 'idle';
    pawn.updateStatusBadge();
    return {
      retreat,
      wounded,
      clearedAfterRecovery: pawn.statusBadge === null,
      debugOffByDefault: scene.garrisonDebugText === null,
    };
  });

  expect(report.retreat).toEqual({ text: 'RETREAT', visible: true });
  expect(report.wounded).toEqual({ text: 'WOUNDED', visible: true });
  expect(report.clearedAfterRecovery).toBe(true);
  expect(report.debugOffByDefault).toBe(true);
});

test('phase J: ?debug reports observed squad DPS vs hero baseline and the 25% budget is bounded', async ({ page }) => {
  await startRun(page, true);
  const report = await page.evaluate(() => {
    const game = (window as RuntimeWindow).__tss!;
    const scene = game.scene.getScene('Game') as SceneRuntime;
    if (!scene.garrisonDebugText?.active) throw new Error('DPS debug panel was not created');

    const initialText = scene.garrisonDebugText.text;
    const previous = {
      hero: scene.heroDpsAtTenMinutes,
      raw: scene.garrisonRawDamageSinceTen,
      applied: scene.garrisonAppliedDamageSinceTen,
      startedAt: scene.garrisonDpsMeasurementStartElapsed,
      elapsed: scene.elapsed,
    };

    // Фиксированный десятисекундный срез проверяет формулу панели без ожидания 10-минутного матча.
    scene.heroDpsAtTenMinutes = 100;
    scene.garrisonDpsMeasurementStartElapsed = scene.elapsed - 10;
    scene.garrisonRawDamageSinceTen = 200;
    scene.garrisonAppliedDamageSinceTen = 25;
    // Вызываем настоящий путь урона гарнизона по учебной цели, чтобы проверить
    // не только форматирование панели, но и прирост raw/applied счётчиков.
    scene.garrisonDpsBudget.reset(scene.time.now - 1_000);
    scene.damageEnemyByPawn({
      active: true,
      dead: false,
      x: 500,
      y: 500,
      def: { scale: 1 },
      takeDamage: () => false,
    }, 20, 'sword');
    const countersAfterHit = {
      raw: scene.garrisonRawDamageSinceTen,
      applied: scene.garrisonAppliedDamageSinceTen,
    };
    scene.nextGarrisonDebugUpdateAt = 0;
    scene.updateGarrisonDebugText(scene.time.now + 10_000);
    const measuredText = scene.garrisonDebugText.text;

    const budget = scene.garrisonDpsBudget;
    budget.reset(0);
    const noFreeBurst = budget.apply(100, 0, 100);
    const firstHalfSecond = budget.apply(100, 500, 100);
    const secondHalfSecond = budget.apply(100, 1_000, 100);
    const bankedAfterIdle = budget.apply(100, 6_000, 100);
    budget.reset(scene.time.now);

    // Возвращаем состояние реального матча, чтобы QA-подмена не меняла его дальнейшую симуляцию.
    scene.heroDpsAtTenMinutes = previous.hero;
    scene.garrisonRawDamageSinceTen = previous.raw;
    scene.garrisonAppliedDamageSinceTen = previous.applied;
    scene.garrisonDpsMeasurementStartElapsed = previous.startedAt;
    scene.elapsed = previous.elapsed;
    scene.nextGarrisonDebugUpdateAt = 0;

    return {
      initialText,
      measuredText,
      countersAfterHit,
      budget: { noFreeBurst, firstHalfSecond, secondHalfSecond, bankedAfterIdle },
    };
  });

  expect(report.initialText).toContain('GARRISON DPS QA');
  expect(report.initialText).toContain('10:00');
  expect(report.initialText).toContain('25%');
  expect(report.measuredText).toContain('Hero @10:00: 100.0 DPS');
  expect(report.countersAfterHit).toEqual({ raw: 220, applied: 45 });
  expect(report.measuredText).toContain('Squad raw: 22.0 DPS (22.0%)');
  expect(report.measuredText).toContain('Squad applied: 4.5 DPS (4.5%, cap 25%)');
  expect(report.budget).toEqual({
    noFreeBurst: 0,
    firstHalfSecond: 12,
    secondHalfSecond: 13,
    bankedAfterIdle: 25,
  });
});
