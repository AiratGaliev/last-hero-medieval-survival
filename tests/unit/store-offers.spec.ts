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
  elapsedSeconds: 600,
  matchDurationSeconds: 900,
  monasteryCollapseVictims: 0,
  passLevelBefore: 20,
  passLevelAfter: 20,
  passPremium: false,
  starterAvailable: true,
};

describe('contextual store offer resolution', () => {
  it('never bypasses the five-match storefront gate', () => {
    expect(resolveStoreOffer({ ...base, storefrontUnlocked: false, monasteryCollapseVictims: 8 }))
      .toBeNull();
    expect(resolveStoreOffer({ ...base, storefrontUnlocked: false, passLevelBefore: 29, passLevelAfter: 30 }))
      .toBeNull();
  });

  it('offers the starter pack only for a defeat in the final five percent of a run', () => {
    expect(resolveStoreOffer({ ...base, elapsedSeconds: 855 })).toBe('starter');
    expect(resolveStoreOffer({ ...base, elapsedSeconds: 854 })).toBeNull();
    expect(resolveStoreOffer({ ...base, victory: true, elapsedSeconds: 899 })).toBeNull();
    expect(resolveStoreOffer({ ...base, elapsedSeconds: 899, starterAvailable: false })).toBeNull();
  });

  it('requires five victims from a single collapse and a currently available pack', () => {
    expect(resolveStoreOffer({ ...base, monasteryCollapseVictims: 5 })).toBe('monastery');
    expect(resolveStoreOffer({ ...base, monasteryCollapseVictims: 4 })).toBeNull();
    expect(resolveStoreOffer({ ...base, monasteryCollapseVictims: 8, starterAvailable: false })).toBeNull();
  });

  it('offers the premium track only when a non-premium player crosses level 30', () => {
    expect(resolveStoreOffer({ ...base, passLevelBefore: 29, passLevelAfter: 30 })).toBe('pass');
    expect(resolveStoreOffer({ ...base, passLevelBefore: 30, passLevelAfter: 31 })).toBeNull();
    expect(resolveStoreOffer({ ...base, passLevelBefore: 29, passLevelAfter: 30, passPremium: true })).toBeNull();
    expect(resolveStoreOffer({ ...base, passUnlocked: false, passLevelBefore: 29, passLevelAfter: 30 })).toBeNull();
  });

  it('uses a stable priority when multiple run events qualify', () => {
    expect(resolveStoreOffer({
      ...base, elapsedSeconds: 899, monasteryCollapseVictims: 6, passLevelBefore: 29, passLevelAfter: 30,
    })).toBe('monastery');
    expect(resolveStoreOffer({
      ...base, elapsedSeconds: 899, passLevelBefore: 29, passLevelAfter: 30,
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
