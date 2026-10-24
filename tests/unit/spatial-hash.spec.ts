import { describe, expect, it } from 'vitest';
import { SpatialHash } from '../../src/game/systems/SpatialHash';

describe('SpatialHash', () => {
  it('returns nearby-cell candidates, including cells across the origin', () => {
    const near = { id: 'near', x: -12, y: 8 };
    const negativeCell = { id: 'negative', x: -85, y: -15 };
    const far = { id: 'far', x: 250, y: 0 };
    const hash = new SpatialHash<{ id: string; x: number; y: number }>(100);
    const out: typeof near[] = [];

    hash.rebuild([near, negativeCell, far]);
    expect(hash.query(0, 0, 40, out)).toBe(out);
    expect(out).toContain(near);
    expect(out).toContain(negativeCell);
    expect(out).not.toContain(far);
  });

  it('clears old buckets on rebuild and reuses the caller array', () => {
    const oldItem = { id: 'old', x: 10, y: 10 };
    const newItem = { id: 'new', x: 210, y: 10 };
    const hash = new SpatialHash<{ id: string; x: number; y: number }>(100);
    const out: typeof oldItem[] = [];

    hash.rebuild([oldItem]);
    hash.query(10, 10, 20, out);
    expect(out).toContain(oldItem);

    hash.rebuild([newItem]);
    expect(hash.query(10, 10, 20, out)).toBe(out);
    expect(out).not.toContain(oldItem);
    expect(hash.query(210, 10, 20, out)).toContain(newItem);
  });

  it('rejects an invalid radius without leaving stale results', () => {
    const item = { id: 'item', x: 0, y: 0 };
    const hash = new SpatialHash<{ id: string; x: number; y: number }>(100);
    const out: typeof item[] = [];

    hash.rebuild([item]);
    hash.query(0, 0, 20, out);
    expect(out).toContain(item);

    expect(hash.query(0, 0, Number.NaN, out)).toBe(out);
    expect(out).toEqual([]);
  });

  it('rejects an invalid cell size', () => {
    expect(() => new SpatialHash<{ x: number; y: number }>(0)).toThrow(RangeError);
    expect(() => new SpatialHash<{ x: number; y: number }>(Number.NaN)).toThrow(RangeError);
  });
});
