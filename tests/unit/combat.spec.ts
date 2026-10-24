import { describe, expect, it } from 'vitest';
import { COMBAT_TIMING, isFrontalHit, staggerDuration } from '../../src/game/systems/Combat';

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
    expect(staggerDuration(12, 190, false)).toBe(COMBAT_TIMING.LIGHT_STAGGER_MS);
    expect(staggerDuration(22, 90, true)).toBe(COMBAT_TIMING.LIGHT_STAGGER_MS);
    expect(staggerDuration(31, 90, false)).toBe(COMBAT_TIMING.HEAVY_STAGGER_MS);
    expect(staggerDuration(12, 301, false)).toBe(COMBAT_TIMING.HEAVY_STAGGER_MS);
  });
});
