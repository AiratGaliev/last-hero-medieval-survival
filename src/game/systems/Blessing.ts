/**
 * Доменная логика благословений рана (§J.3 / R4).
 *
 * Модуль не зависит от Phaser, состояния MetaState или UI: меню получает
 * три уникальных варианта по seed, а списание/начисление жетонов остаётся
 * в мета-слое, где обеспечивается атомарное сохранение.
 */

export type BlessingId =
  | 'bl_pawn_speed'
  | 'bl_castle_hp'
  | 'bl_first_siege'
  | 'bl_vein'
  | 'bl_heal_wood'
  | 'bl_wood_start'
  | 'bl_combo'
  | 'bl_speedup_token';

export interface BlessingDef {
  id: BlessingId;
  nameKey: string;
  descKey: string;
}

export const BLESSINGS: readonly BlessingDef[] = [
  { id: 'bl_pawn_speed', nameKey: 'blessing.pawn_speed.name', descKey: 'blessing.pawn_speed.desc' },
  { id: 'bl_castle_hp', nameKey: 'blessing.castle_hp.name', descKey: 'blessing.castle_hp.desc' },
  { id: 'bl_first_siege', nameKey: 'blessing.first_siege.name', descKey: 'blessing.first_siege.desc' },
  { id: 'bl_vein', nameKey: 'blessing.vein.name', descKey: 'blessing.vein.desc' },
  { id: 'bl_heal_wood', nameKey: 'blessing.heal_wood.name', descKey: 'blessing.heal_wood.desc' },
  { id: 'bl_wood_start', nameKey: 'blessing.wood_start.name', descKey: 'blessing.wood_start.desc' },
  { id: 'bl_combo', nameKey: 'blessing.combo.name', descKey: 'blessing.combo.desc' },
  { id: 'bl_speedup_token', nameKey: 'blessing.speedup_token.name', descKey: 'blessing.speedup_token.desc' },
];

/** Локальный hash, идентичный историческому генератору благословений. */
function blessingSeedHash(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** PRNG Mulberry32: один и тот же seed всегда выдаёт тот же порядок вариантов. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Три уникальных варианта для R4; не использует глобальный Math.random(). */
export function rollBlessings(seed: string): BlessingId[] {
  const random = mulberry32(blessingSeedHash(`bless:${seed}`));
  const pool = BLESSINGS.map((blessing) => blessing.id);
  const picked: BlessingId[] = [];
  for (let i = 0; i < 3 && pool.length > 0; i++) {
    const index = Math.floor(random() * pool.length);
    const [id] = pool.splice(index, 1);
    if (id) picked.push(id);
  }
  return picked;
}
