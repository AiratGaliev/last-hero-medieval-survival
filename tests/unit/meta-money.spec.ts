// ============ Юнит-тесты денежных путей meta (§K.2, §J.6) ============
//
// В отличие от tests/e2e это брейн-чек математики без браузера: реигра
// чеков IAP, fail-closed откат при отказе записи и сброс дневных лимитов
// на границе московских суток. Каждый тест получает свежий экземпляр
// meta-модуля (vi.resetModules) и чистое хранилище.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunSummary } from '../../src/game/meta';

/** Подменяемые «серверные» часы (msdkDayKey считает от них MSK-дату). */
const clock = vi.hoisted(() => ({ now: Date.parse('2026-10-20T10:00:00Z') }));

const DAY1 = Date.parse('2026-10-20T10:00:00Z'); // MSK 13:00, 20 октября
const DAY2 = DAY1 + 86_400_000;                  // те же 13:00, 21 октября

vi.mock('../../src/platform/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/platform/sdk')>();
  return { ...actual, serverNow: () => clock.now };
});

// --- Хранилище с управляемым отказом записи ---

const store = new Map<string, string>();
/** Ключи, запись в которые падает (эмуляция квоты/приватного режима). */
const failKeys = new Set<string>();

function installWindow(): void {
  const ls = {
    getItem: (key: string): string | null => store.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      if (failKeys.has(key)) throw new Error(`storage full (test): ${key}`);
      store.set(key, String(value));
    },
    removeItem: (key: string): void => {
      store.delete(key);
    },
    clear: (): void => {
      store.clear();
    },
  };
  (globalThis as { window?: unknown }).window = { localStorage: ls };
}

const META_KEY = 'tss-meta2';
const SHOP_KEY = 'tss-shop';

let meta: typeof import('../../src/game/meta');
let shop: typeof import('../../src/game/shop');

// resetModules делает динамический import в beforeEach новым экземпляром
// модуля: в meta.ts есть кэш на уровне модуля (cached), его нельзя
// переносить между тестами.
beforeEach(async () => {
  vi.resetModules();
  store.clear();
  failKeys.clear();
  clock.now = DAY1;
  installWindow();
  meta = await import('../../src/game/meta');
  shop = await import('../../src/game/shop');
});

function runSummary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    victory: true, ideal: false, endless: false, weeklyChallenge: false,
    wave: 0, time: 300, kills: 40, level: 5, gold: 100, score: 1200,
    difficulty: 'campaign', buildingsBuilt: 0, occupiedBaseBuildSpots: 0,
    pawnsAlive: 1, siegesDefended: 0, siegesTotal: 0, monasteryHealed: 0,
    healHp: 0, hires: 0, successions: 0, veterans: 0, firstHouseMin: 0,
    barracks: 0, monastery: 0, archery: 0, bestCombo: 0, bossKilled: false,
    killsByKind: {}, cardsPicked: [], contract: null, ukaz: null,
    challengeMods: [], blessing: null, consumables: [],
    ...over,
  };
}

describe('grantSkuForPurchase: реигра чека IAP', () => {
  it('один токен начисляет кроны ровно один раз', () => {
    const first = meta.grantSkuForPurchase('crowns_s', 'tok-1');
    expect(first.persisted).toBe(true);
    expect(first.granted.crowns).toBeGreaterThan(0); // первая покупка ×2 (§J.6.4)
    expect(meta.loadMetaState().crowns).toBe(first.granted.crowns);

    const replay = meta.grantSkuForPurchase('crowns_s', 'tok-1');
    expect(replay.persisted).toBe(true);
    expect(replay.granted.crowns).toBe(0);
    expect(meta.loadMetaState().crowns).toBe(first.granted.crowns);
  });

  it('неизвестный SKU и пустой токен отклоняются (fail-closed)', () => {
    expect(meta.grantSkuForPurchase('no_such_sku', 'tok-1')).toMatchObject({
      supported: false, persisted: false,
    });
    expect(meta.grantSkuForPurchase('crowns_s', '  ')).toMatchObject({
      supported: false, persisted: false,
    });
    expect(meta.loadMetaState().crowns).toBe(0);
  });
});

describe('fail-closed: отказ записи откатывает выдачу', () => {
  it('grantSkuForPurchase не оставляет токен без персистентности', () => {
    failKeys.add(META_KEY);
    const result = meta.grantSkuForPurchase('crowns_s', 'tok-fail');
    expect(result.persisted).toBe(false);
    expect(result.granted.crowns).toBe(0);

    // После восстановления хранилища кэш откатился: ни крон, ни токена —
    // повторная попытка честно начислит заново.
    failKeys.clear();
    const st = meta.loadMetaState();
    expect(st.crowns).toBe(0);
    expect(st.processedIapTokens).not.toContain('tok-fail');
  });

  it('applyRunToMeta при отказе записи не платит славу', () => {
    failKeys.add(META_KEY);
    const res = meta.applyRunToMeta(runSummary());
    expect(res.persisted).toBe(false);

    failKeys.clear();
    expect(meta.loadMetaState().glory).toBe(0);
    expect(meta.loadMetaState().matchesPlayed).toBe(0);
  });
});

describe('кошелёк лавки: отказ отдельной записи откатывает мета-снимок', () => {
  it('золото не зачислено и не потеряно: награду можно забрать повторно', () => {
    // xp=80 при текущем сезоне пропуска: ран (+25 XP) пересекает уровень 1
    // — бесплатная ветка уровня 1 платит золотом, значит участвует кошелёк.
    // Сезон обязателен: rollMetaDay() сбрасывает пропуск с чужим ключом.
    const st = meta.loadMetaState();
    st.pass = {
      season: `p${meta.passSeasonIndexFor()}`,
      xp: 80,
      premium: false,
      claimedFree: 0,
      claimedPrem: 0,
    };
    meta.saveMetaState(st);

    // meta-запись успешна, кошелёк (tss-shop) недоступен.
    failKeys.add(SHOP_KEY);
    const res = meta.applyRunToMeta(runSummary());
    expect(res.persisted).toBe(false);

    failKeys.clear();
    expect(meta.loadMetaState().glory).toBe(0);
    expect(shop.loadShop().balance).toBe(0);
    expect(meta.loadMetaState().pass.xp).toBe(80); // снимок откатился целиком

    // Второй прогон с рабочим хранилищем начисляет всё заново.
    const retry = meta.applyRunToMeta(runSummary());
    expect(retry.persisted).toBe(true);
    expect(retry.passRewards.some((r) => r.kind === 'gold')).toBe(true);
    expect(meta.loadMetaState().glory).toBeGreaterThan(0);
    expect(shop.loadShop().balance).toBeGreaterThan(0);
  });
});

describe('дневные лимиты: сброс на границе московских суток (§J.3)', () => {
  it('сундук ограничен, лимит восстанавливается в новый MSK-день', () => {
    // FTUE-гейт: сундук доступен не раньше набранных матчей (§H.7).
    const st = meta.loadMetaState();
    st.matchesPlayed = meta.DAILY_BONUS_AFTER_MATCHES;
    meta.saveMetaState(st);

    expect(meta.DAILY_CHEST_LIMIT).toBe(2);
    expect(meta.claimDailyChest()).not.toBeNull();
    expect(meta.dailyChestLeft()).toBe(1);
    expect(meta.claimDailyChest()).not.toBeNull();
    expect(meta.dailyChestLeft()).toBe(0);
    expect(meta.claimDailyChest()).toBeNull();

    clock.now = DAY2;
    expect(meta.dailyChestLeft()).toBe(2);
    expect(meta.claimDailyChest()).not.toBeNull();
    expect(meta.loadMetaState().dailyChest.date).toBe('2026-10-21');
  });

  it('дар дня требует набранных матчей (fail-closed)', () => {
    expect(meta.DAILY_BONUS_AFTER_MATCHES).toBeGreaterThan(0);
    const result = meta.claimDailyBonus();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('locked');
  });
});

describe('runValueFor: общий маппинг метрик заданий (§H.17)', () => {
  function qm(over: Partial<import('../../src/game/meta').QuestMetrics> = {}) {
    return {
      ideal: false, buildingsBuilt: 0, siegesDefended: 0, monasteryHealed: 0,
      healHp: 0, hires: 0, successions: 0, kills: 0, firstHouseMin: 0,
      barracks: 0, monastery: 0, archery: 0, veterans: 0, gold: 0,
      score: 0, time: 0, bestCombo: 0, bossKilled: false,
      ...over,
    };
  }

  it('дробное HP лечения округляется, время полается, sentinel дома = 99', () => {
    expect(meta.runValueFor('healHp', qm({ healHp: 12.6 }))).toBe(13);
    expect(meta.runValueFor('time', qm({ time: 119.9 }))).toBe(119);
    expect(meta.runValueFor('firstHouseMin', qm({ firstHouseMin: 0 }))).toBe(99);
    expect(meta.runValueFor('firstHouseMin', qm({ firstHouseMin: 2 }))).toBe(2);
  });

  it('идеальная победа и преемник босса корректны на краях', () => {
    expect(meta.runValueFor('idealWin', qm({ ideal: true }))).toBe(1);
    expect(meta.runValueFor('idealWin', qm())).toBe(0);
    expect(meta.runValueFor('successionBoss', qm({ successions: 1, bossKilled: true }))).toBe(1);
    expect(meta.runValueFor('successionBoss', qm({ bossKilled: true }))).toBe(0);
    expect(meta.runValueFor('noSuccessionBoss', qm({ bossKilled: true }))).toBe(1);
    expect(meta.runValueFor('noSuccessionBoss', qm({ successions: 1, bossKilled: true }))).toBe(0);
  });
});
