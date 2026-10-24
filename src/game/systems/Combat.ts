/** Единые тайминги ближнего боя, в миллисекундах активной симуляции. */
export const COMBAT_TIMING = {
  FRONT_GUARD_DAMAGE_MULTIPLIER: 0.35,
  GUARD_FRAME_COUNT: 6,
  GUARD_FRAME_RATE: 12,
  ENEMY_MELEE_WINDUP_MS: 240,
  ENEMY_MELEE_RECOVERY_MS: 180,
  PAWN_SWORD_WINDUP_MS: 180,
  PAWN_BOW_WINDUP_MS: 220,
  PAWN_ATTACK_RECOVERY_MS: 120,
  LIGHT_STAGGER_MS: 320,
  HEAVY_STAGGER_MS: 520,
  LIGHT_HIT_FORCE: 120,
  HEAVY_HIT_FORCE: 250,
  HEAVY_HIT_DAMAGE: 30,
} as const;

/** У воина нет вертикального поворота: удар сверху/снизу считаем встречным. */
export function isFrontalHit(facingLeft: boolean, targetX: number, sourceX: number): boolean {
  if (![targetX, sourceX].every(Number.isFinite)) return false;
  const dx = sourceX - targetX;
  if (Math.abs(dx) < 0.001) return true;
  return facingLeft ? dx < 0 : dx > 0;
}

/** Сильное попадание прерывает врага; обычный взмах не оглушает на каждом тике. */
export function staggerDuration(damage: number, force: number, critical: boolean): number {
  if (!Number.isFinite(damage) || !Number.isFinite(force) || damage <= 0 || force < 0) return 0;
  if (force >= COMBAT_TIMING.HEAVY_HIT_FORCE || damage >= COMBAT_TIMING.HEAVY_HIT_DAMAGE) return COMBAT_TIMING.HEAVY_STAGGER_MS;
  if (force >= COMBAT_TIMING.LIGHT_HIT_FORCE || (critical && damage >= 22)) return COMBAT_TIMING.LIGHT_STAGGER_MS;
  return 0;
}

/**
 * Кадр, на котором действие считается попавшим: середина одноразовой анимации.
 * Урон не должен вычисляться в момент play(); он разрешается по animationupdate.
 */
export function attackImpactFrameIndex(frameCount: number): number {
  if (!Number.isInteger(frameCount) || frameCount <= 1) return 0;
  return Math.min(frameCount - 1, Math.max(1, Math.ceil((frameCount - 1) / 2)));
}
