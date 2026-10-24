import { describe, expect, it } from 'vitest';
import { PAWNS } from '../../src/game/data';

describe('universal civilian workers', () => {
  it('uses one visual identity, base speed and full tool set for every legacy civilian kind', () => {
    const civilians = [PAWNS.collector, PAWNS.builder, PAWNS.repairer];
    for (const pawn of civilians) {
      expect(pawn.cls).toBe('civilian');
      expect(pawn.prefix).toBe('pawn');
      expect(pawn.speed).toBe(180);
      expect(new Set(pawn.tools)).toEqual(new Set(['axe', 'pickaxe', 'knife', 'hammer']));
    }
  });

  it('does not merge the civilian visual rules with combat garrison roles', () => {
    expect(PAWNS.fighter.cls).toBe('garrison');
    expect(PAWNS.healer.cls).toBe('garrison');
    expect(PAWNS.fighter.weapon).toBe('sword');
    expect(PAWNS.healer.weapon).toBe('staff');
  });
});
