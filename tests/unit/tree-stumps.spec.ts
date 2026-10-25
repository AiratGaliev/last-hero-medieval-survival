import { describe, expect, it } from 'vitest';
import { TREE_STUMP_TEXTURES, stumpTextureForTree } from '../../src/game/treeStumps';

describe('tree stump asset pairing', () => {
  it.each([
    ['tree1', 'stump1'],
    ['tree2', 'stump2'],
    ['tree3', 'stump3'],
    ['tree4', 'stump4'],
  ] as const)('%s leaves its matching %s', (tree, stump) => {
    expect(stumpTextureForTree(tree)).toBe(stump);
  });

  it('does not assign a stump to unknown or non-tree textures', () => {
    expect(stumpTextureForTree('tree5')).toBeNull();
    expect(stumpTextureForTree('sheep')).toBeNull();
  });

  it('covers the full four-variant tree and stump asset set', () => {
    expect(Object.keys(TREE_STUMP_TEXTURES)).toEqual(['tree1', 'tree2', 'tree3', 'tree4']);
    expect(Object.values(TREE_STUMP_TEXTURES)).toEqual(['stump1', 'stump2', 'stump3', 'stump4']);
  });
});
