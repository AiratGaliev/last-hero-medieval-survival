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

/**
 * ⚠️ `name`/`desc` — геттеры, а не значения.
 *
 * Статические импорты вычисляются ДО `await detectLanguage()` в main.ts, так
 * что модуль уровня `t('shop.…')` в литерале замораживал язык на стартовом
 * 'ru': вся вкладка «ЛАВКА» в англоязычной сборке показывала русские названия.
 * Геттер переводит ключ в момент обращения, то есть уже после определения
 * языка. Создание апгрейдов не изменилось — оно data-only.
 */
export const SHOP_UPGRADES: ShopUpgradeDef[] = [
  {
    id: 'might', get name() { return t('shop.might.name'); }, icon: 'icon-might',
    get desc() { return t('shop.might.desc'); },
    costs: [150, 350, 700],
  },
  {
    id: 'vitality', get name() { return t('shop.vitality.name'); }, icon: 'icon-heart',
    get desc() { return t('shop.vitality.desc'); },
    costs: [150, 350, 700],
  },
  {
    id: 'speed', get name() { return t('shop.speed.name'); }, icon: 'icon-boots',
    get desc() { return t('shop.speed.desc'); },
    costs: [120, 300, 600],
  },
  {
    id: 'magnet', get name() { return t('shop.magnet.name'); }, icon: 'icon-magnet',
    get desc() { return t('shop.magnet.desc'); },
    costs: [120, 300, 600],
  },
  {
    id: 'luck', get name() { return t('shop.luck.name'); }, icon: 'icon-coin',
    get desc() { return t('shop.luck.desc'); },
    costs: [180, 420, 800],
  },
];

export interface ShopState {
  balance: number;                      // золото в кошельке
  upgrades: Record<ShopUpgradeId, number>; // уровни 0..3
}

export type ShopLevels = ShopState['upgrades'];

const LS_SHOP = 'tss-shop';
let shopSavedListener: (() => void) | null = null;

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

function saveShop(state: ShopState): boolean {
  const saved = saveJson(LS_SHOP, state);
  if (saved) shopSavedListener?.();
  return saved;
}

/** Подключает сохранение общего облачного снимка после изменения кошелька/апгрейдов. */
export function setShopSavedListener(listener: (() => void) | null): void {
  shopSavedListener = listener;
}

/** Восстанавливает облачный снимок магазина без рекурсивного события синхронизации. */
export function restoreShopState(raw: unknown): boolean {
  return saveJson(LS_SHOP, sanitize(raw));
}

/** Начисление золота в кошелёк (вызывается в конце матча). */
export function depositGold(gold: number): void {
  const amount = Math.floor(gold);
  if (!Number.isFinite(gold) || amount <= 0) return;
  const st = loadShop();
  st.balance += amount;
  if (!saveShop(st)) {
    console.warn('[shop] не удалось сохранить начисленное золото кошелька');
  }
}

/**
 * Общая покупка за кошелёк (TZ §G.8): ускорения ремонта/лечения.
 * Списание атомарно: loadShop() → проверка → saveShop() в одном вызове,
 * иначе двойной клик списал бы дважды.
 */
export function spendGold(amount: number): BuyResult {
  const cost = Math.floor(amount);
  if (!Number.isFinite(amount) || cost <= 0) return { ok: false, reason: 'unknown' };
  const st = loadShop();
  if (st.balance < cost) return { ok: false, reason: 'poor' };
  st.balance -= cost;
  if (!saveShop(st)) return { ok: false, reason: 'storage' };
  return { ok: true };
}

/** Текущий баланс кошелька (HUD матча, TZ §G.10). */
export interface BuyResult {
  ok: boolean;
  reason?: 'max' | 'poor' | 'unknown' | 'storage';
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
  if (!saveShop(st)) return { ok: false, reason: 'storage' };
  return { ok: true };
}

/** Текущие уровни — применяется в начале матча (GameScene). */
export function getShopLevels(): ShopLevels {
  return loadShop().upgrades;
}
