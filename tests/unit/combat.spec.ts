import { describe, expect, it } from 'vitest';
import { COMBAT_TIMING, attackImpactFrameIndex, isFrontalHit, staggerDuration } from '../../src/game/systems/Combat';

describe('directional guard and combat recovery', () => {
  it('treats hits from the facing side as frontal', () => {
    expect(isFrontalHit(false, 100, 160)).toBe(true);
    expect(isFrontalHit(false, 100, 40)).toBe(false);
    expect(isFrontalHit(true, 100, 40)).toBe(true);
    expect(isFrontalHit(true, 100, 160)).toBe(false);
  });
  it('rejects invalid coordinates', () => {
    expect(isFrontalHit(false, Number.NaN, 20)).toBe(false);
  });
  it('stops enemies only after a substantial hit', () => {
    expect(staggerDuration(12, 90, false)).toBe(0);
    expect(staggerDuration(12, 130, false)).toBe(COMBAT_TIMING.LIGHT_STAGGER_MS);
    expect(staggerDuration(12, 190, false)).toBe(COMBAT_TIMING.LIGHT_STAGGER_MS);
    expect(staggerDuration(22, 90, true)).toBe(COMBAT_TIMING.LIGHT_STAGGER_MS);
    expect(staggerDuration(31, 90, false)).toBe(COMBAT_TIMING.HEAVY_STAGGER_MS);
    expect(staggerDuration(12, 251, false)).toBe(COMBAT_TIMING.HEAVY_STAGGER_MS);
  });
});

describe('animation-driven combat impacts', () => {
  it('chooses a middle frame rather than the animation start frame', () => {
    expect(attackImpactFrameIndex(4)).toBe(2);
    expect(attackImpactFrameIndex(6)).toBe(3);
    expect(attackImpactFrameIndex(13)).toBe(6);
  });

  it('handles animations with no useful frame sequence safely', () => {
    expect(attackImpactFrameIndex(0)).toBe(0);
    expect(attackImpactFrameIndex(1)).toBe(0);
    expect(attackImpactFrameIndex(Number.NaN)).toBe(0);
  });
});
