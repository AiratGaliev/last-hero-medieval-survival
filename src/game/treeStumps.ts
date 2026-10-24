/** Matching tree/stump sprites from Tiny Swords. Keep suffixes paired. */
export const TREE_STUMP_TEXTURES = {
  tree1: 'stump1',
  tree2: 'stump2',
  tree3: 'stump3',
  tree4: 'stump4',
} as const;

export type TreeTextureKey = keyof typeof TREE_STUMP_TEXTURES;
export type StumpTextureKey = (typeof TREE_STUMP_TEXTURES)[TreeTextureKey];

/** Return the matching stump for a tree texture; unknown textures do not spawn a fake stump. */
export function stumpTextureForTree(textureKey: string): StumpTextureKey | null {
  return Object.prototype.hasOwnProperty.call(TREE_STUMP_TEXTURES, textureKey)
    ? TREE_STUMP_TEXTURES[textureKey as TreeTextureKey]
    : null;
}
