import { expect, test, type Page } from '@playwright/test';

type ShopModule = {
  loadShop(): { balance: number };
  depositGold(amount: number): void;
  spendGold(amount: number): { ok: boolean; reason?: string };
};

type SpeedupModule = {
  Speedup: new (eco: unknown) => {
    hasTarget(kind: 'repair' | 'heal'): boolean;
    buyWithGold(kind: 'repair' | 'heal'): { ok: boolean; reason?: string };
    buyWithAd(kind: 'repair' | 'heal'): Promise<{ ok: boolean; reason?: string }>;
  };
};

type AdsModule = {
  resetPlacementLimits(): void;
};

type MetaModule = {
  rollMetaDay(): { speedupTokens: number };
  saveMetaState(state: { speedupTokens: number }): boolean;
  speedupTokenBalance(): number;
};

const startupTimeout = 60_000;

async function openGame(page: Page, query = '?lang=en&ysdk=mock'): Promise<void> {
  await page.goto('/' + query);
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });
}

test('shop wallet fails closed when persistence fails', async ({ page }) => {
  await openGame(page);
  const report = await page.evaluate(async () => {
    window.localStorage.clear();
    const shopUrl = new URL('/src/game/shop.ts', window.location.href).href;
    const shop = await import(/* @vite-ignore */ shopUrl) as ShopModule;
    shop.depositGold(60);
    const before = shop.loadShop().balance;
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string): void {
      if (key.toLowerCase().includes('shop')) throw new Error('Injected storage quota failure');
      originalSetItem.call(this, key, value);
    };
    let result: { ok: boolean; reason?: string };
    try {
      result = shop.spendGold(30);
    } finally {
      Storage.prototype.setItem = originalSetItem;
    }
    return { before, result, after: shop.loadShop().balance };
  });

  expect(report.before).toBe(60);
  expect(report.result).toEqual({ ok: false, reason: 'storage' });
  expect(report.after).toBe(60);
});

test('heal speedup clears occupied beds and nearby bleedout only, tracks actual HP, and spends once', async ({ page }) => {
  await openGame(page);
  const report = await page.evaluate(async () => {
    window.localStorage.clear();
    const shopUrl = new URL('/src/game/shop.ts', window.location.href).href;
    const speedupUrl = new URL('/src/game/systems/Speedup.ts', window.location.href).href;
    const shop = await import(/* @vite-ignore */ shopUrl) as ShopModule;
    const module = await import(/* @vite-ignore */ speedupUrl) as SpeedupModule;
    const occupant = {
      state: 'wounded', dead: false, x: 700, y: 0, hp: 63, maxHp: 80, cooldown: 0,
      monasterySlot: 0, monasteryBuilding: null as unknown,
      healBy(amount: number) { this.hp = Math.min(this.maxHp, this.hp + amount); },
    };
    const gateBleeding = {
      state: 'bleeding', dead: false, x: 100, y: 0, hp: 0, maxHp: 90, cooldown: 0,
      monasterySlot: null, monasteryBuilding: null as unknown,
      healBy(amount: number) { this.hp = Math.min(this.maxHp, this.hp + amount); },
    };
    const monasteryBleeding = {
      state: 'bleeding', dead: false, x: 730, y: 20, hp: 0, maxHp: 100, cooldown: 0,
      monasterySlot: null, monasteryBuilding: null as unknown,
      healBy(amount: number) { this.hp = Math.min(this.maxHp, this.hp + amount); },
    };
    const farBleeding = {
      state: 'bleeding', dead: false, x: 2500, y: 2500, hp: 0, maxHp: 110, cooldown: 0,
      monasterySlot: null, monasteryBuilding: null as unknown,
      healBy(amount: number) { this.hp = Math.min(this.maxHp, this.hp + amount); },
    };
    const monastery = {
      kind: 'monastery', alive: true, underConstruction: false, x: 700, y: 0,
      healSlots: [occupant, null] as Array<typeof occupant | null>,
      releaseHealSlot(slot: number) { this.healSlots[slot] = null; },
    };
    occupant.monasteryBuilding = monastery;
    const economy = {
      activeRepair: null,
      castleX: 0, castleY: 0,
      buildings: [monastery],
      pawns: [occupant, gateBleeding, monasteryBleeding, farBleeding],
      healHpTotal: 0, monasteryHealed: 0,
      usedHealSlots() { return this.buildings.reduce((count, building) => count + building.healSlots.filter(Boolean).length, 0); },
      finishRepairInstant() { this.activeRepair = null; },
      emit() {},
    };
    shop.depositGold(45);
    const speedup = new module.Speedup(economy);
    const beforeHeal = economy.healHpTotal;
    const bought = speedup.buyWithGold('heal');
    const afterPurchase = shop.loadShop().balance;
    const after = {
      occupant: { state: occupant.state, hp: occupant.hp, slot: occupant.monasterySlot, ownerCleared: occupant.monasteryBuilding === null },
      gate: { state: gateBleeding.state, hp: gateBleeding.hp },
      nearbyMonastery: { state: monasteryBleeding.state, hp: monasteryBleeding.hp },
      far: { state: farBleeding.state, hp: farBleeding.hp },
      healHpDelta: economy.healHpTotal - beforeHeal,
      healedFromMonastery: economy.monasteryHealed,
      emptySlots: monastery.healSlots.filter(Boolean).length,
      targetAfterUse: speedup.hasTarget('heal'),
    };
    shop.depositGold(45);
    const noTarget = speedup.buyWithGold('heal');
    return { bought, afterPurchase, after, noTarget, walletAfterNoTarget: shop.loadShop().balance };
  });

  expect(report.bought).toEqual({ ok: true });
  expect(report.afterPurchase).toBe(0);
  expect(report.after.occupant).toEqual({ state: 'idle', hp: 80, slot: null, ownerCleared: true });
  expect(report.after.gate).toEqual({ state: 'idle', hp: 90 });
  expect(report.after.nearbyMonastery).toEqual({ state: 'idle', hp: 100 });
  expect(report.after.far).toEqual({ state: 'bleeding', hp: 0 });
  expect(report.after.healHpDelta).toBe(207);
  expect(report.after.healedFromMonastery).toBe(1);
  expect(report.after.emptySlots).toBe(0);
  expect(report.after.targetAfterUse).toBe(false);
  expect(report.noTarget).toEqual({ ok: false, reason: 'noTarget' });
  expect(report.walletAfterNoTarget).toBe(45);
});

test('repair speedup is immediate and an incomplete rewarded ad never applies the effect', async ({ page }) => {
  await openGame(page, '?lang=en&ysdk=mock&mockAd=fail');
  const report = await page.evaluate(async () => {
    window.localStorage.clear();
    const shopUrl = new URL('/src/game/shop.ts', window.location.href).href;
    const speedupUrl = new URL('/src/game/systems/Speedup.ts', window.location.href).href;
    const adsUrl = new URL('/src/platform/ads.ts', window.location.href).href;
    const shop = await import(/* @vite-ignore */ shopUrl) as ShopModule;
    const module = await import(/* @vite-ignore */ speedupUrl) as SpeedupModule;
    const ads = await import(/* @vite-ignore */ adsUrl) as AdsModule;
    ads.resetPlacementLimits();
    let finished = 0;
    const eco = {
      activeRepair: { id: 'repair-job' },
      castleX: 0, castleY: 0, buildings: [], pawns: [],
      healHpTotal: 0, monasteryHealed: 0, usedHealSlots: () => 0,
      finishRepairInstant() { finished++; this.activeRepair = null; },
      emit() {},
    };
    shop.depositGold(30);
    const speedup = new module.Speedup(eco);
    const gold = speedup.buyWithGold('repair');
    const remaining = shop.loadShop().balance;
    const noTarget = speedup.buyWithGold('repair');
    eco.activeRepair = { id: 'repair-job-2' };
    const failedAd = await speedup.buyWithAd('repair');
    const stillActiveAfterFailedAd = eco.activeRepair !== null;
    return { gold, remaining, noTarget, failedAd, stillActiveAfterFailedAd, finished };
  });

  expect(report.gold).toEqual({ ok: true });
  expect(report.remaining).toBe(0);
  expect(report.noTarget).toEqual({ ok: false, reason: 'noTarget' });
  expect(report.failedAd).toEqual({ ok: false, reason: 'adUnavailable' });
  expect(report.stillActiveAfterFailedAd).toBe(true);
  expect(report.finished).toBe(1);
});

test('speedup token is restored and effect is rejected when persistence fails', async ({ page }) => {
  await openGame(page);
  const report = await page.evaluate(async () => {
    window.localStorage.clear();
    const metaUrl = new URL('/src/game/meta.ts', window.location.href).href;
    const speedupUrl = new URL('/src/game/systems/Speedup.ts', window.location.href).href;
    const meta = await import(/* @vite-ignore */ metaUrl) as MetaModule;
    const module = await import(/* @vite-ignore */ speedupUrl) as SpeedupModule;
    const state = meta.rollMetaDay();
    state.speedupTokens = 1;
    if (!meta.saveMetaState(state)) throw new Error('Could not prepare speedup token fixture');

    let finished = 0;
    const eco = {
      activeRepair: { id: 'repair-job' },
      castleX: 0, castleY: 0, buildings: [], pawns: [],
      healHpTotal: 0, monasteryHealed: 0, usedHealSlots: () => 0,
      finishRepairInstant() { finished++; this.activeRepair = null; },
      emit() {},
    };
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string): void {
      if (key.toLowerCase().includes('meta2')) throw new Error('Injected metadata persistence failure');
      originalSetItem.call(this, key, value);
    };
    let result: { ok: boolean; reason?: string };
    try {
      result = new module.Speedup(eco).buyWithToken('repair');
    } finally {
      Storage.prototype.setItem = originalSetItem;
    }
    return { result, tokens: meta.speedupTokenBalance(), finished, repairStillActive: eco.activeRepair !== null };
  });

  expect(report.result).toEqual({ ok: false, reason: 'storage' });
  expect(report.tokens).toBe(1);
  expect(report.finished).toBe(0);
  expect(report.repairStillActive).toBe(true);
});


test('speedup wallet and rewarded actions are separate clickable controls', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openGame(page);
  await page.evaluate(() => {
    localStorage.removeItem('tss-meta2');
    localStorage.removeItem('tss-hints');
    const runtime = (window as Window & { __tss?: {
      scene: { getScene(key: string): unknown };
    } }).__tss;
    if (!runtime) throw new Error('Phaser runtime is unavailable');
    const menu = runtime.scene.getScene('Menu') as {
      selectedHero?: string;
      selectedDiff?: string;
      scene: { start(key: string, data: { hero: string; diff: string }): void };
    };
    menu.scene.start('Game', { hero: menu.selectedHero ?? 'warrior', diff: menu.selectedDiff ?? 'normal' });
  });
  await expect.poll(() => page.evaluate(() => (
    (window as Window & { __tss?: { scene: { isActive(key: string): boolean } } }).__tss
      ?.scene.isActive('Game') ?? false
  )), { timeout: startupTimeout }).toBe(true);
  await page.mouse.click(640, 360);
  await expect.poll(() => page.evaluate(() => {
    const runtime = (window as Window & { __tss?: { scene: { getScene(key: string): unknown } } }).__tss;
    return !((runtime?.scene.getScene('Game') as { hintOverlayPaused?: boolean })?.hintOverlayPaused ?? true);
  }), { timeout: 10_000 }).toBe(true);
  // Реальная цель ремонта: без repairJobs у активной игры кнопка через ~0.7 c
  // per-frame updateSpeedups сбрасывается в «NONE» (enabled=false), и клик
  // между замером и нажатием молча терялся. В свежем ране из построек есть
  // только замок, поэтому job якорим на него: job без пешки не исполняется
  // и не удаляется (cleanup спит до прогресса пешки) — см. Economy.tick.
  await page.evaluate(() => {
    const runtime = (window as unknown as { __tss?: { scene: { getScene(key: string): unknown } } }).__tss;
    const scene = runtime?.scene.getScene('Game') as unknown as {
      // Свойство сцены называется economy; eco — поле систем (Speedup/PawnAI).
      economy?: {
        buildings?: Array<{ kind?: string; alive?: boolean }>;
        repairJobs?: Array<Record<string, unknown>>;
      };
    };
    const eco = scene?.economy;
    const castle = eco?.buildings?.find((b) => b.kind === 'castle' && b.alive);
    if (!eco || !castle || !Array.isArray(eco.repairJobs)) {
      throw new Error(`economy/castle unavailable: eco=${eco ? 1 : 0} buildings=${(eco?.buildings ?? []).map((b) => b.kind).join(',')}`);
    }
    if (!eco.repairJobs.some((job) => job.building === castle)) {
      eco.repairJobs.push({ building: castle, progress: 0, pawn: null, rebuild: false });
    }
  });

  const expected = await page.evaluate(() => {
    type ButtonRuntime = {
      img: { getBounds(): { x: number; y: number; width: number; height: number } };
      hit: { getBounds(): { x: number; y: number; width: number; height: number }; input?: unknown };
      txt: { text: string; alpha: number };
    };
    type RuntimeScene = {
      hud: {
        speedupButtons: Record<string, ButtonRuntime>;
        setSpeedupHandlers(handlers: Record<string, () => void>): void;
        updateSpeedups: (repairTarget: boolean, healTarget: boolean, balance: number, token: boolean, repairAd: boolean, healAd: boolean) => void;
      };
      scale: { width: number; height: number };
      cameras: { main: { zoom: number } };
    };
    const runtime = (window as Window & { __tss?: { scene: { getScene(key: string): unknown } } }).__tss;
    if (!runtime) throw new Error('Phaser runtime is unavailable');
    const scene = runtime.scene.getScene('Game') as RuntimeScene;
    const called: string[] = [];
    scene.hud.setSpeedupHandlers({
      repairCurrency: () => called.push('repairCurrency'),
      repairAd: () => called.push('repairAd'),
      healCurrency: () => called.push('healCurrency'),
      healAd: () => called.push('healAd'),
    });
    scene.hud.updateSpeedups(true, true, 0, false, true, true);
    const repairCurrency = scene.hud.speedupButtons.repairCurrency;
    const repairAd = scene.hud.speedupButtons.repairAd;
    if (!repairCurrency || !repairAd) throw new Error('Explicit speedup controls were not created');

    const canvas = document.querySelector('#game canvas');
    if (!canvas) throw new Error('Canvas not found');
    const rect = canvas.getBoundingClientRect();
    const zoom = scene.cameras.main.zoom;
    const toCss = (bounds: { x: number; y: number; width: number; height: number }) => {
      const logicalX = scene.scale.width / 2 + (bounds.x + bounds.width / 2 - scene.scale.width / 2) * zoom;
      const logicalY = scene.scale.height / 2 + (bounds.y + bounds.height / 2 - scene.scale.height / 2) * zoom;
      return {
        x: rect.left + logicalX / scene.scale.width * rect.width,
        y: rect.top + logicalY / scene.scale.height * rect.height,
      };
    };
    const imageCenter = toCss(repairAd.img.getBounds());
    const hitCenter = toCss(repairAd.hit.getBounds());
    const snapshot = {
      currencyLabel: repairCurrency.txt.text,
      currencyAlpha: repairCurrency.img.alpha,
      adLabel: repairAd.txt.text,
      adAlpha: repairAd.img.alpha,
      imageCenter,
      hitCenter,
      screenSize: { width: rect.width, height: rect.height },
    };
    (window as Window & { __phaseOSpeedupCalls?: string[] }).__phaseOSpeedupCalls = called;
    return snapshot;
  });

  expect(expected.currencyLabel).toBe('NEED 30 GOLD');
  expect(expected.currencyAlpha).toBeLessThan(1);
  expect(expected.adLabel).toBe('AD');
  expect(expected.adAlpha).toBe(1);
  expect(Math.abs(expected.imageCenter.x - expected.hitCenter.x)).toBeLessThan(2);
  expect(Math.abs(expected.imageCenter.y - expected.hitCenter.y)).toBeLessThan(2);

  // Phaser кэширует bounding rect канвы и обновляет его в step() не чаще
  // 500 мс. #boot — статический блок на 100dvh, канва создана ниже него:
  // после удаления boot канва переносится на top=0, но кэш ещё хранит
  // старый top, и клик по CSS-координатам уходит мимо (pointer.y < 0).
  // Перед кликом принудительно обновляем кэш (§R4-перф: реальный pointer).
  await page.evaluate(() => {
    const runtime = (window as Window & { __tss?: { scene: { getScene(key: string): unknown } } }).__tss;
    const scene = runtime?.scene.getScene('Game') as { scale: { refresh(): void } } | undefined;
    if (!scene) throw new Error('Phaser runtime is unavailable');
    scene.scale.refresh();
  });
  await page.mouse.click(expected.imageCenter.x, expected.imageCenter.y);
  await expect.poll(() => page.evaluate(() => (
    (window as Window & { __phaseOSpeedupCalls?: string[] }).__phaseOSpeedupCalls ?? []
  ))).toEqual(['repairAd']);
});


test('healing speedup refuses to charge when the only monastery occupant is already dead', async ({ page }) => {
  await openGame(page);
  const report = await page.evaluate(async () => {
    window.localStorage.clear();
    const shopUrl = new URL('/src/game/shop.ts', window.location.href).href;
    const speedupUrl = new URL('/src/game/systems/Speedup.ts', window.location.href).href;
    const shop = await import(/* @vite-ignore */ shopUrl) as ShopModule;
    const module = await import(/* @vite-ignore */ speedupUrl) as SpeedupModule;
    shop.depositGold(45);
    const deadPatient = { dead: true, hp: 0, maxHp: 80 };
    const monastery = {
      kind: 'monastery', alive: true, underConstruction: false, x: 900, y: 900,
      healSlots: [deadPatient],
      releaseHealSlot(slot: number) { this.healSlots[slot] = null; },
    };
    const economy = {
      activeRepair: null, castleX: 0, castleY: 0,
      buildings: [monastery], pawns: [],
      healHpTotal: 0, monasteryHealed: 0,
      usedHealSlots: () => 1,
      finishRepairInstant() { this.activeRepair = null; },
      emit() {},
    };
    const speedup = new module.Speedup(economy);
    const targetBeforePurchase = speedup.hasTarget('heal');
    const result = speedup.buyWithGold('heal');
    return { targetBeforePurchase, result, balance: shop.loadShop().balance };
  });

  expect(report.targetBeforePurchase).toBe(false);
  expect(report.result).toEqual({ ok: false, reason: 'noTarget' });
  expect(report.balance).toBe(45);
});
