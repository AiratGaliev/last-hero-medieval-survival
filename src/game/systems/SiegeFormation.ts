import type { SiegeProfile } from '../data';

/**
 * Pure formation logic for siege squads.
 *
 * The pincer profile assigns alternating units to opposite flanks while keeping
 * the squad count balanced. Other siege profiles retain their existing single
 * approach direction and spread.
 */
export type SiegeFormationKind = NonNullable<SiegeProfile['formation']> | 'single';

const ANGULAR_SPREAD_RADIANS = 0.28;

export function calculateSiegeSpawnAngles(
  formation: SiegeFormationKind,
  unitCount: number,
  baseAngle: number,
): number[] {
  if (!Number.isSafeInteger(unitCount) || unitCount < 0) {
    throw new RangeError('unitCount must be a non-negative safe integer');
  }
  if (!Number.isFinite(baseAngle)) {
    throw new RangeError('baseAngle must be finite');
  }
  if (unitCount === 0) return [];

  if (formation !== 'pincer') {
    return Array.from(
      { length: unitCount },
      (_, index) => baseAngle + (index % 8) * ANGULAR_SPREAD_RADIANS,
    );
  }

  const unitsPerFlank = Math.ceil(unitCount / 2);
  return Array.from({ length: unitCount }, (_, index) => {
    const flank = index % 2;
    const lane = Math.floor(index / 2);
    const centeredSpread = (lane - (unitsPerFlank - 1) / 2) * ANGULAR_SPREAD_RADIANS;
    return baseAngle + flank * Math.PI + centeredSpread;
  });
}
