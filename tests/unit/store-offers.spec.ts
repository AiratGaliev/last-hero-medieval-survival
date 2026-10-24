import { describe, expect, it } from 'vitest';
import {
  claimStoreOfferForSession,
  resolveStoreOffer,
  STORE_OFFER_SESSION_KEY,
  type StoreOfferFacts,
  type SessionOfferStorage,
} from '../../src/game/storeOffers';

const base: StoreOfferFacts = {
  storefrontUnlocked: true,
  passUnlocked: true,
  victory: false,
  endless: false,
  bossHpRemainingPercent: null,
  monasteryCollapseVictims: 0,
  passLevelBefore: 20,
  passLevelAfter: 20,
  passPremium: false,
  starterAvailable: true,
};

describe('contextual store offer resolution', () => {
  it('does not bypass the paid storefront gate for starter and pass offers', () => {
    expect(resolveStoreOffer({ ...base, storefrontUnlocked: false, elapsedSeconds: 899 }))
      .toBeNull();
    expect(resolveStoreOffer({ ...base, storefrontUnlocked: false, passLevelBefore: 29, passLevelAfter: 30 }))
      .toBeNull();
  });

  it('keeps the monastery education trigger available even before the paid storefront unlocks', () => {
    expect(resolveStoreOffer({
      ...base, storefrontUnlocked: false, monasteryCollapseVictims: 5, starterAvailable: false,
    })).toBe('monastery');
  });

  it('offers the starter pack only when a standard-run defeat leaves at most 5% boss HP', () => {
    expect(resolveStoreOffer({ ...base, bossHpRemainingPercent: 5 })).toBe('starter');
    expect(resolveStoreOffer({ ...base, bossHpRemainingPercent: 4.9 })).toBe('starter');
    expect(resolveStoreOffer({ ...base, bossHpRemainingPercent: 5.01 })).toBeNull();
    expect(resolveStoreOffer({ ...base, bossHpRemainingPercent: 100 })).toBeNull();
    expect(resolveStoreOffer({ ...base, bossHpRemainingPercent: null })).toBeNull();
    expect(resolveStoreOffer({ ...base, victory: true, bossHpRemainingPercent: 1 })).toBeNull();
    expect(resolveStoreOffer({ ...base, endless: true, bossHpRemainingPercent: 1 })).toBeNull();
    expect(resolveStoreOffer({
      ...base, bossHpRemainingPercent: 5, starterAvailable: false,
    })).toBeNull();
  });

  it('requires five victims from a single collapse, but education is independent from pack availability', () => {
    expect(resolveStoreOffer({ ...base, monasteryCollapseVictims: 5 })).toBe('monastery');
    expect(resolveStoreOffer({ ...base, monasteryCollapseVictims: 4 })).toBeNull();
    expect(resolveStoreOffer({ ...base, monasteryCollapseVictims: 8, starterAvailable: false })).toBe('monastery');
  });

  it('offers the premium track only when a non-premium player crosses level 30', () => {
    expect(resolveStoreOffer({ ...base, passLevelBefore: 29, passLevelAfter: 30 })).toBe('pass');
    expect(resolveStoreOffer({ ...base, passLevelBefore: 30, passLevelAfter: 31 })).toBeNull();
    expect(resolveStoreOffer({ ...base, passLevelBefore: 29, passLevelAfter: 30, passPremium: true })).toBeNull();
    expect(resolveStoreOffer({ ...base, passUnlocked: false, passLevelBefore: 29, passLevelAfter: 30 })).toBeNull();
  });

  it('uses a stable priority when multiple run events qualify', () => {
    expect(resolveStoreOffer({
      ...base, bossHpRemainingPercent: 4, monasteryCollapseVictims: 6, passLevelBefore: 29, passLevelAfter: 30,
    })).toBe('monastery');
    expect(resolveStoreOffer({
      ...base, bossHpRemainingPercent: 4, passLevelBefore: 29, passLevelAfter: 30,
    })).toBe('starter');
  });
});

describe('one store offer per browser session', () => {
  it('claims an empty session once and rejects repeated claims', () => {
    const values = new Map<string, string>();
    const storage: SessionOfferStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
    };

    expect(claimStoreOfferForSession(storage)).toBe(true);
    expect(values.get(STORE_OFFER_SESSION_KEY)).toBe('1');
    expect(claimStoreOfferForSession(storage)).toBe(false);
  });

  it('fails closed when session storage cannot be written', () => {
    const storage: SessionOfferStorage = {
      getItem: () => null,
      setItem: () => { throw new Error('storage disabled'); },
    };
    expect(claimStoreOfferForSession(storage)).toBe(false);
    expect(claimStoreOfferForSession(null)).toBe(false);
  });
});
