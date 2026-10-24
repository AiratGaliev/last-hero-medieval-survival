import { expect, test, type Page } from '@playwright/test';

// Local perf-гейм-гейт: проверяет темп симуляции и стоимость рендера в живом
// матче под аппаратным GPU. В CI нет GPU — SwiftShader мерил бы софт-рендер,
// не игру, поэтому там тест пропускается.
test.skip(Boolean(process.env.CI), 'perf gate meaningful only on a machine with a real GPU');

const startupTimeout = 60_000;

type RuntimeEnemy = { active: boolean; dead: boolean; hp: number };

type RuntimePlayer = { hp: number; maxHp: number };

type RuntimeScene = {
  player: RuntimePlayer;
  spawner: { stopped: boolean };
  enemyGroup: { getChildren(): RuntimeEnemy[] };
  spawnEnemy(kind: string, x: number, y: number): boolean;
  overlayOpen: boolean;
  events: {
    on(name: string, cb: () => void): unknown;
    off(name: string, cb: () => void): unknown;
  };
  settlement?: {
    castle?: { hp: number; maxHp: number };
    infrastructureHp?: number;
    infrastructureMax?: number;
  };
};

type RenderDevice = { render: (...args: unknown[]) => unknown };

type RuntimeGame = {
  scene: { isActive(key: string): boolean };
  renderer: RenderDevice;
};

type RendererWindow = Window & { __tss?: RuntimeGame };

async function startMatch(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });
  await expect.poll(
    () => page.evaluate(() => (window as RendererWindow).__tss?.scene.isActive('Menu') ?? false),
    { timeout: startupTimeout },
  ).toBe(true);

  await page.evaluate(() => {
    localStorage.removeItem('tss-meta2');
    localStorage.removeItem('tss-hints');
    const game = (window as RendererWindow).__tss!;
    const menu = game.scene.getScene('Menu') as {
      selectedDiff?: string;
      scene: { start(key: string, data: { hero: string; diff: string }): void };
    };
    menu.scene.start('Game', { hero: 'warrior', diff: menu.selectedDiff ?? 'normal' });
  });

  await expect.poll(
    () => page.evaluate(() => (window as RendererWindow).__tss?.scene.isActive('Game') ?? false),
    { timeout: startupTimeout },
  ).toBe(true);

  // Герой не должен умереть и матч не должен закончиться за окно измерения.
  await page.evaluate(() => {
    const scene = (window as RendererWindow).__tss!.scene.getScene('Game') as unknown as RuntimeScene & {
      player: RuntimePlayer;
      settlement?: RuntimeScene['settlement'];
    };
    scene.player.maxHp = 1e9;
    scene.player.hp = 1e9;
    if (scene.settlement?.castle) {
      scene.settlement.castle.maxHp = 1e9;
      scene.settlement.castle.hp = 1e9;
      scene.settlement.infrastructureMax = 1e9;
      scene.settlement.infrastructureHp = 1e9;
    }
    scene.spawner.stopped = true;
  });

  // Закрыть FTUE-оверлей первым вводом (throttle просыпается на ввод сам).
  const bounds = await page.locator('#game canvas').boundingBox();
  if (!bounds) throw new Error('Game canvas has no layout bounds');
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await expect.poll(
    () => page.evaluate(() => {
      const scene = (window as RendererWindow).__tss?.scene.getScene('Game') as unknown as RuntimeScene | undefined;
      return scene ? !scene.overlayOpen : false;
    }),
    { timeout: 10_000 },
  ).toBe(true);
}

test('match simulation keeps 60 fps step rate and cheap render under pressure', async ({ page }) => {
  await startMatch(page);

  // Стресс без ожиданий спавнера: плотное кольцо противников вокруг героя.
  const ring = await page.evaluate(() => {
    const scene = (window as RendererWindow).__tss!.scene.getScene('Game') as unknown as RuntimeScene;
    let spawned = 0;
    for (let i = 0; i < 24; i++) {
      const a = (Math.PI * 2 * i) / 24;
      const r = 160 + (i % 3) * 120;
      if (scene.spawnEnemy('goblin', scene.player.x + Math.cos(a) * r, scene.player.y + Math.sin(a) * r)) spawned++;
    }
    return spawned;
  });
  expect(ring).toBeGreaterThanOrEqual(20);

  // Окно измерения 10 с: считаем шаги симуляции (scene 'update') и стоимость
  // каждого renderer.render. Внимание: loop.actualFps врёт при включённом
  // fps-limit (считает тики rAF) — поэтому считаем реальные события.
  const meter = await page.evaluate(() => new Promise<{
    steps: number; renders: number; renderMs: number; wallMs: number; alive: number;
  }>((res) => {
    const g = (window as RendererWindow).__tss!;
    const scene = g.scene.getScene('Game') as unknown as RuntimeScene;

    const t0 = performance.now();
    let steps = 0;
    let renders = 0;
    const onStep = (): void => { steps++; };
    scene.events.on('update', onStep);
    const rend = g.renderer as RenderDevice;
    const orig = rend.render.bind(rend);
    let renderMs = 0;
    rend.render = (...args: unknown[]) => {
      const s = performance.now();
      orig(...args);
      renderMs += performance.now() - s;
      renders++;
      return undefined;
    };
    // Герой выкашивает кольцо за несколько секунд — стресс должен длиться всё
    // окно: дозаполняем живых вне досягаемости меча (r 300–500).
    const topUp = window.setInterval(() => {
      const alive = scene.enemyGroup.getChildren().filter((e) => e.active && !e.dead).length;
      for (let i = alive; i < 24; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = 300 + Math.random() * 200;
        scene.spawnEnemy('goblin', scene.player.x + Math.cos(a) * r, scene.player.y + Math.sin(a) * r);
      }
    }, 700);
    setTimeout(() => {
      window.clearInterval(topUp);
      scene.events.off('update', onStep);
      rend.render = orig;
      const wallMs = performance.now() - t0;
      res({
        steps, renders, renderMs: Math.round(renderMs), wallMs: Math.round(wallMs),
        alive: scene.enemyGroup.getChildren().filter((e) => e.active && !e.dead).length,
      });
    }, 10_000);
  }));

  // Границы широкие: гейт ловит регрессии порядка (×2+), а не миллисекунды.
  // В headless-Chrome с записью видео CDP темп падает до ~48 шаг/с, поэтому
  // порог 40: он всё ещё отсекает идл-троттлинг (15/с) и двукратную деградацию.
  const stepsPerSec = meter.steps / (meter.wallMs / 1000);
  const avgRenderMs = meter.renderMs / Math.max(1, meter.renders);
  const summary = `steps/s=${stepsPerSec.toFixed(1)}, renders=${meter.renders}, avgRenderMs=${avgRenderMs.toFixed(2)}, alive=${meter.alive}`;
  expect(stepsPerSec, summary).toBeGreaterThanOrEqual(40); // цель 60
  expect(avgRenderMs, summary).toBeLessThanOrEqual(6); // замер GPU-рендера: ~2.3 мс/кадр
  expect(meter.alive, summary).toBeGreaterThanOrEqual(20); // стресс не развалился
});
