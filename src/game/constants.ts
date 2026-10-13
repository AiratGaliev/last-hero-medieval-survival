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

export const FONT = '"Pixelify Sans", "Press Start 2P", "Courier New", monospace';

export const DEPTH = {
  GROUND: -100,
  WATER: -90,
  SHADOW: -50,
  GEM: 2,
  ENTITY_BASE: 10,     // + y для сортировки
  PROJECTILE: 500,
  FX: 600,
  HUD: 1000,
  OVERLAY: 2000,
} as const;

// Фракции Tiny Swords
export type Faction = 'blue' | 'red' | 'purple' | 'yellow' | 'black';
