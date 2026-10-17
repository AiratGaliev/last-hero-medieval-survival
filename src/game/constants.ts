// ============ Последний герой: Средневековое выживание — глобальные константы ============

export const WORLD = {
  SIZE: 3200,          // квадратный мир 3200x3200
  GRASS_MARGIN: 160,   // вода-граница шириной
} as const;

export const PLAYER_BASE = {
  HP: 100,
  SPEED: 200,
  MAGNET_RADIUS: 70,
  IFRAMES: 500,        // мс неуязвимости после урона
  DISPLAY_SCALE: 0.55, // масштаб спрайта (кадры 192x192)
} as const;

export const GAME_DURATION = 15 * 60; // 15 минут, сек

export const ENEMY_CAP = 220;
export const GEM_CAP = 600;
export const PROJECTILE_CAP = 400;
export const DESPAWN_DIST = 1400;

/**
 * Сколько опыта нужно для перехода с уровня `level` на следующий.
 *
 * Кривая подобрана так, чтобы потолок матча (около 4900 опыта при полной
 * зачистке за 15 минут) приходился на MAX_LEVEL. Прежняя формула
 * давала 18–19 уровней и уходила в недостижимый хвост до 30-го.
 */
export const XP_CURVE = (level: number): number =>
  Math.floor(5 + level * 8 + level * level * 0.55);

/**
 * Потолок уровней за матч. Выше не растём: опыт продолжает копиться
 * ради очков, но новых карточек не даёт. Проверяется опытом на
 * реальных прогонах, а не выводится из формулы «на всякий случай».
 */
export const MAX_LEVEL = 24;

export const SCORE = {
  KILL: 10,
  MINUTE: 100,
  LEVEL: 50,
  BOSS: 5000,
  /** ЗАЩИТА: за каждую уцелевшую постройку (включая замок), TZ §E.8 */
  SETTLEMENT: 300,
  /** НАСЕЛЕНИЕ: за каждую уцелевшую пешку */
  POPULATION: 100,
  /** РЕЙТИНГ: только за идеальную победу (босс + замок цел + ≥3 пешек) */
  RATING: 2500,
} as const;

// ============ СЕРИЯ УБИЙСТВ (комбо) ============
export const COMBO = {
  WINDOW: 3,        // сек без убийств — серия сбрасывается
  MIN_DISPLAY: 5,   // показывать счётчик с 5 серии
  BONUS_CAP: 2.0,   // максимум ×2 к очкам за убийство
  BONUS_STEP: 0.01, // +1% к очкам за каждое убийство в серии
  MILESTONES: [25, 50, 100, 200], // вехи: сундучок ресурсов у героя (TZ §H.4)
} as const;

// ============ ПОСЕЛЕНИЕ: пешки, здания, осады (TZ §B, §E, §G) ============

/** Радиусы агро/паники: герой / гарнизон / гражданский (TZ §A.5, §B.6). */
export const AGGRO = { HERO: 600, NPC: 900, PANIC: 220 } as const;

/** Гарнизон: сбор, поводок, перехват, тик AI, смена точки патруля. */
export const GARRISON = {
  RALLY: 700,       // враг ближе — гарнизон выходит на него сам
  LEASH: 900,       // дальше от ближайшего здания — возвращается
  INTERCEPT: 260,   // воин перехватывает врага, идущего к цели
  TICK_MS: 150,     // тик combatAI (фолбэк 250 мс при просадке FPS)
  TICK_FALLBACK_MS: 250,
  PATROL_SWAP: [6000, 10000] as [number, number],
} as const;

/** Таунт мечника: перетянуть 50% урона по зданию в 150 px (TZ §B.7.1). */
export const TAUNT = { RADIUS: 150, SHARE: 0.5 } as const;

/** Отступление при HP < 35%; кайтинг лучника (TZ §B.7.1). */
export const RETREAT_HP = 0.35;
export const KITE = { NEAR: 180, STEP: 80, MAX_LEASH: 420 } as const;

/** Потолок DPS отряда: доля от DPS героя на 10-й минуте (TZ §B.7.1). */
export const GARRISON_DPS_CAP = 0.25;

/** Монах: полевое лечение бесплатно, обительное — за дерево (TZ §B.7.2). */
export const HEALER = {
  RADIUS: 320,
  HPS: 8,
  SWITCH_MS: 500,
  FOLLOW_OFFSET: 200,
  FIELD_WOOD: 0,
  WOUNDED_FREE_AT: 0.5,
} as const;

/** Монастырь: 10 мест, 12 HP/с, 1 дерево за 15 HP (TZ §G). */
export const MONASTERY_SLOTS = 10;
export const HEAL_HP_PER_SEC = 12;
export const HEAL_WOOD_PER_15HP = 1;
/** Истечение кровью: 45 сек без места — окончательная смерть (+15 карта). */
export const BLEEDOUT_SEC = 45;

/** Башня (фаза M ROADMAP): стреляет по ближайшему врагу, приоритет — осада. */
export const TOWER = {
  RANGE: 360,     // перехват осады до подхода к стенам
  PERIOD_MS: 1500,
  DMG: 12,
} as const;

/** Золото матча за босса — однократный дроп кристаллами (TZ §A.4 BOSS_GOLD). */
export const BOSS_GOLD = 300;

/** Осады (TZ §E.4): таймер отступления, окно атаки, потолок урона. */
export const SIEGE = {
  LIFETIME: 60,        // сек — потом уходит за край
  ATTACK_WINDOW: 10,   // сек боя у стены
  MAX_INFRA_DMG: 0.12, // потолок 12% HP инфраструктуры за осаду
  MAX_INFRA_DMG_LOW: 0.06, // ...при HP < 60%
  LOW_HP: 0.6,
  INTERCEPT_R: 260,    // игрок в радиусе перехватывает осаду
  BURN_DMG: 3,         // DoT поджога
  BURN_MS: 6000,
  ANNOUNCE_SEC: 5,     // анонс за 5 секунд
  WOUND_CAP: [1, 1, 2, 2, 3] as readonly number[], // лимит ранений по профилям
} as const;

/** Золотая жила: 4 цикла × 20 руды (TZ §B.3). */
export const VEIN_CHARGES = 4;
export const VEIN_YIELD = 20;
export const VEIN_COUNT = 10;

/** Цена найма гарнизона (TZ §B.9.1) — дерево/руда/мясо. */
export const HIRE_COST = {
  sword: { wood: 20, ore: 10, meat: 5 },
  lance: { wood: 20, ore: 10, meat: 5 },
  bow: { wood: 15, ore: 10, meat: 5 },
  staff: { wood: 25, ore: 15, meat: 5 },
} as const;
export const HIRE_TIME_MS = { sword: 8000, lance: 8000, bow: 10000, staff: 10000 } as const;

/** Новый житель: 25 сек + 10 дерева + 3 мяса при свободном доме (TZ §E.5). */
export const NEW_VILLAGER = { DELAY: 25, wood: 10, meat: 3 } as const;

/** Ремонт: повреждённое 30 дерева/5 с, разрушенное 60/10 (TZ §E.5, §B.4). */
export const REPAIR = { WOOD: 30, MS: 5000, REBUILD_WOOD: 60, REBUILD_MS: 10000 } as const;

/** Радиальное меню приказов (TZ §B.6, §I.6). */
export const LONGPRESS_MS = 500;
export const TOUCH_MIN_PX = 44;

/** Ускорения (TZ §G.8): валюта — кошелёк лавки либо реклама 1/ран. */
export const SPEEDUP_COST = { repair: 30, heal: 45 } as const;

/** Кнопки/оверлеи не меньше 44 px (тач-гейт §I.6). */
export const MIN_TOUCH = 44;

/**
 * Масштаб тени сущностей.
 *
 * Текстура обрезана по содержимому: исходный shadow.png 192×192 содержал
 * мягкое пятно 79×80 в центре и зря занимал 14 КБ. После обрезки тот же
 * видимый размер даётся увеличением масштаба во 192/79 ≈ 2.43 раза.
 */
/** Тень: рамка содержимого в исходнике Shadow.png 192×192 (файл грузится целиком). */
export const SHADOW_BOX = { x: 57, y: 56, w: 79, h: 80 } as const;
/** Ширина исходника Shadow.png — для пересчёта origin. */
export const SHADOW_SRC = 192;
/** Масштаб тени: 0.2 от ширины содержимого (79 px). */
export const SHADOW_SCALE = 0.2;

export const FONT = '"Pixelify Sans", "Press Start 2P", "Courier New", monospace';

// ============ СЛОИ ОТРИСОВКИ ============
// Сущности и декор сортируются по Y: depth = ENTITY_BASE + y (y ∈ 0..3200),
// то есть занимают диапазон ~10..3210. ВСЕ фиксированные слои обязаны лежать
// ВЫШЕ этого диапазона — иначе снаряды/FX/HUD «прячутся» под врагами
// в нижней части карты (баг v1.5: PROJECTILE=500 < depth врагов при y>490).
export const DEPTH = {
  GROUND: -100,
  WATER: -90,
  SHADOW: -50,
  DECOR_BACK: -60,      // дальний план: облака, пена — под сущностями
  GEM: 2,               // кристаллы/мясо/сундуки — на земле, под сущностями
  ENTITY_BASE: 10,      // + y для y-сортировки (максимум ~3210)
  PROJECTILE: 4000,     // стрелы/копья/ножи/бочки — над всеми сущностями
  HPBAR: 4500,          // HP-бары над сущностями (мир-координаты)
  FX: 5000,             // взрывы/пыль/урон/попапы/аура/слэш
  HUD: 9000,            // HUD (экранные координаты, компенсация зума)
  OVERLAY: 9500,        // зарезервировано для внутриигровых оверлеев
} as const;

// Фракции Tiny Swords
export type Faction = 'blue' | 'red' | 'purple' | 'yellow' | 'black';
