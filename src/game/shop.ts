// ============ Мета-магазин: постоянные усиления за накопленное золото ============
// Модуль без Phaser-зависимостей: используется игрой и React-оболочкой.
// Золото зарабатывается в матчах (см. depositGold из commitMeta) и тратится
// в «Лавке торговца» на постоянные (кросс-матчевые) апгрейды. Хранение — localStorage.

export interface ShopUpgradeDef {
  id: ShopUpgradeId;
  name: string;
  desc: string;
  icon: string;              // /assets/game/<icon>.png
  costs: [number, number, number]; // цена уровня 1/2/3
}

export type ShopUpgradeId = 'might' | 'vitality' | 'speed' | 'magnet' | 'luck';

export const SHOP_UPGRADES: ShopUpgradeDef[] = [
  {
    id: 'might', name: 'Сила предков', icon: 'icon-might',
    desc: '+6% урона оружия за уровень',
    costs: [150, 350, 700],
  },
  {
    id: 'vitality', name: 'Дублёная кожа', icon: 'icon-heart',
    desc: '+15 макс. HP за уровень',
    costs: [150, 350, 700],
  },
  {
    id: 'speed', name: 'Сапоги из лавки', icon: 'icon-boots',
    desc: '+4% скорости за уровень',
    costs: [120, 300, 600],
  },
  {
    id: 'magnet', name: 'Жадный компас', icon: 'icon-magnet',
    desc: '+20% радиуса подбора за уровень',
    costs: [120, 300, 600],
  },
  {
    id: 'luck', name: 'Кроличья лапка', icon: 'icon-coin',
    desc: '+5% шанса крита за уровень',
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
  const clampLvl = (v: unknown): number => Math.min(3, Math.max(0, Number(v) || 0));
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
  if (typeof window === 'undefined') return { ...EMPTY, upgrades: { ...EMPTY.upgrades } };
  try {
    const raw = window.localStorage.getItem(LS_SHOP);
    if (!raw) return { ...EMPTY, upgrades: { ...EMPTY.upgrades } };
    return sanitize(JSON.parse(raw));
  } catch {
    return { ...EMPTY, upgrades: { ...EMPTY.upgrades } };
  }
}

function saveShop(state: ShopState): void {
  try {
    window.localStorage.setItem(LS_SHOP, JSON.stringify(state));
  } catch {
    // приватный режим — не сохраняем
  }
}

function emitChange(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('tss-shop-updated'));
  }
}

/** Начисление золота в кошелёк (вызывается в конце матча). */
export function depositGold(gold: number): void {
  if (gold <= 0) return;
  const st = loadShop();
  st.balance += Math.floor(gold);
  saveShop(st);
  emitChange();
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
  emitChange();
  return { ok: true };
}

/** Текущие уровни — применяется в начале матча (GameScene). */
export function getShopLevels(): ShopLevels {
  return loadShop().upgrades;
}
