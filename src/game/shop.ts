// ============ Мета-магазин: постоянные усиления за накопленное золото ============
// Модуль без Phaser-зависимостей: используется игрой и React-оболочкой.
// Золото зарабатывается в матчах (см. depositGold из commitMeta) и тратится
// в «Лавке торговца» на постоянные (кросс-матчевые) апгрейды. Хранение — localStorage.
//
// import из '../i18n': этот модуль вычисляется до определения языка игровыми
// сценами, а язык определяется в main.ts до их импорта.
import { t } from '../i18n';
import { loadJson, saveJson } from './storage';

export interface ShopUpgradeDef {
  id: ShopUpgradeId;
  name: string;
  desc: string;
  icon: string;              // ключ текстуры, загружается в BootScene
  costs: [number, number, number]; // цена уровня 1/2/3
}

export type ShopUpgradeId = 'might' | 'vitality' | 'speed' | 'magnet' | 'luck';

export const SHOP_UPGRADES: ShopUpgradeDef[] = [
  {
    id: 'might', name: t('shop.might.name'), icon: 'icon-might',
    desc: t('shop.might.desc'),
    costs: [150, 350, 700],
  },
  {
    id: 'vitality', name: t('shop.vitality.name'), icon: 'icon-heart',
    desc: t('shop.vitality.desc'),
    costs: [150, 350, 700],
  },
  {
    id: 'speed', name: t('shop.speed.name'), icon: 'icon-boots',
    desc: t('shop.speed.desc'),
    costs: [120, 300, 600],
  },
  {
    id: 'magnet', name: t('shop.magnet.name'), icon: 'icon-magnet',
    desc: t('shop.magnet.desc'),
    costs: [120, 300, 600],
  },
  {
    id: 'luck', name: t('shop.luck.name'), icon: 'icon-coin',
    desc: t('shop.luck.desc'),
    costs: [180, 420, 800],
  },
];

export interface ShopState {
  balance: number;                      // золото в кошельке
  upgrades: Record<ShopUpgradeId, number>; // уровни 0..3
}

export type ShopLevels = ShopState['upgrades'];

const LS_SHOP = 'tss-shop';

const EMPTY: ShopState = {
  balance: 0,
  upgrades: { might: 0, vitality: 0, speed: 0, magnet: 0, luck: 0 },
};

function sanitize(raw: unknown): ShopState {
  const s = (raw ?? {}) as Partial<ShopState>;
  const up = (s.upgrades ?? {}) as Partial<ShopLevels>;
  // Math.floor обязателен: дробный уровень дал бы costs[2.7] === undefined,
  // покупка прошла бы проверку «хватает ли золота», вычла бы undefined из
  // баланса и обнулила кошелёк при следующем чтении.
  const clampLvl = (v: unknown): number =>
    Math.min(3, Math.max(0, Math.floor(Number(v) || 0)));
  return {
    balance: Math.max(0, Math.floor(Number(s.balance) || 0)),
    upgrades: {
      might: clampLvl(up.might),
      vitality: clampLvl(up.vitality),
      speed: clampLvl(up.speed),
      magnet: clampLvl(up.magnet),
      luck: clampLvl(up.luck),
    },
  };
}

export function loadShop(): ShopState {
  if (typeof window === 'undefined') return cloneEmpty();
  const raw = loadJson<ShopState>(LS_SHOP);
  return raw === null ? cloneEmpty() : sanitize(raw);
}

function cloneEmpty(): ShopState {
  return { ...EMPTY, upgrades: { ...EMPTY.upgrades } };
}

function saveShop(state: ShopState): void {
  saveJson(LS_SHOP, state);
}

/** Начисление золота в кошелёк (вызывается в конце матча). */
export function depositGold(gold: number): void {
  if (gold <= 0) return;
  const st = loadShop();
  st.balance += Math.floor(gold);
  saveShop(st);
}

export interface BuyResult {
  ok: boolean;
  reason?: 'max' | 'poor' | 'unknown';
}

/** Покупка следующего уровня улучшения за золото из кошелька. */
export function buyUpgrade(id: ShopUpgradeId): BuyResult {
  const def = SHOP_UPGRADES.find((u) => u.id === id);
  if (!def) return { ok: false, reason: 'unknown' };
  const st = loadShop();
  const lvl = st.upgrades[id];
  if (lvl >= 3) return { ok: false, reason: 'max' };
  const price = def.costs[lvl];
  if (st.balance < price) return { ok: false, reason: 'poor' };
  st.balance -= price;
  st.upgrades[id] = lvl + 1;
  saveShop(st);
  return { ok: true };
}

/** Текущие уровни — применяется в начале матча (GameScene). */
export function getShopLevels(): ShopLevels {
  return loadShop().upgrades;
}
