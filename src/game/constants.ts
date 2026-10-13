// ============ Tiny Sword Survivors — глобальные константы ============

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

export const XP_CURVE = (level: number): number =>
  Math.floor(5 + level * 10 + level * level * 1.2);

export const SCORE = {
  KILL: 10,
  MINUTE: 100,
  LEVEL: 50,
  BOSS: 5000,
} as const;

// ============ СЕРИЯ УБИЙСТВ (комбо) ============
export const COMBO = {
  WINDOW: 3,        // сек без убийств — серия сбрасывается
  MIN_DISPLAY: 5,   // показывать счётчик с 5 серии
  BONUS_CAP: 2.0,   // максимум ×2 к очкам за убийство
  BONUS_STEP: 0.01, // +1% к очкам за каждое убийство в серии
  MILESTONES: [10, 25, 50, 100], // попапы на этапах
} as const;

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
