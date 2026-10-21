/**
 * Общая политика игровых «juice»-эффектов (§H.13).
 *
 * На мобильных устройствах отключаем camera shake и обычный hitstop.
 * Ключевые биты второй фазы босса и победы разрешены явно; на остальных
 * профилях обычные time-effects ограничены интервалом в 3 секунды активной игры.
 */
export type QualityLevel = 'low' | 'high';

export function detectQualityLevel(
  userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent,
  maxTouchPoints: number = typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints,
  prefersReducedMotion: boolean = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
): QualityLevel {
  if (prefersReducedMotion) return 'low';
  const mobileOrTablet = /Android|iPhone|iPad|iPod|Mobile|Tablet|PlayBook|Silk/i.test(userAgent)
    || (/Macintosh/i.test(userAgent) && maxTouchPoints > 1);
  return mobileOrTablet ? 'low' : 'high';
}

export class JuicePolicy {
  private lastTimeEffectAt = Number.NEGATIVE_INFINITY;

  constructor(
    readonly qualityLevel: QualityLevel = detectQualityLevel(),
    private readonly timeEffectCooldownMs = 3_000,
  ) {
    if (!Number.isFinite(timeEffectCooldownMs) || timeEffectCooldownMs < 0) {
      throw new RangeError('timeEffectCooldownMs must be a finite non-negative number');
    }
  }

  /** Camera shake is deliberately disabled on the low-quality profile. */
  canShake(): boolean {
    return this.qualityLevel === 'high';
  }

  /**
   * Returns whether a time effect can start at this active-game timestamp.
   * Essential effects bypass both the mobile gate and the shared cooldown.
   */
  allowTimeEffect(activeTimeMs: number, essential = false): boolean {
    if (!Number.isFinite(activeTimeMs) || activeTimeMs < 0) return false;
    if (this.qualityLevel === 'low' && !essential) return false;
    if (!essential && activeTimeMs - this.lastTimeEffectAt < this.timeEffectCooldownMs) {
      return false;
    }
    this.lastTimeEffectAt = activeTimeMs;
    return true;
  }

  /** New match: do not carry the prior match's time-effect budget forward. */
  resetBudget(): void {
    this.lastTimeEffectAt = Number.NEGATIVE_INFINITY;
  }
}
