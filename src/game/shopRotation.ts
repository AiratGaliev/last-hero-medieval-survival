import { serverNow } from '../platform/sdk';
import { mskDayKey } from '../platform/calendar';
import { loadJson, saveJson } from './storage';
import { SKINS } from './meta';

/** Three cosmetic offers that rotate daily; the full catalogue remains accessible. */
export interface DailyShopRotation {
  date: string;
  ids: string[];
  refreshed: boolean;
}

const STORAGE_KEY = 'tss-shop-rotation-v1';
const OFFER_COUNT = 3;

const eligibleIds = (): string[] =>
  SKINS.filter((skin) => skin.price > 0 && (skin.kind === 'hero' || skin.kind === 'building' || skin.kind === 'trail'))
    .map((skin) => skin.id);

function dateKey(): string {
  // Единый календарь live-ops (TZ §J.3/§H.17): ротация лавки и дневные лимиты
  // рекламы (tss-ads-day, mskDayKey) обязаны переключаться в один и тот же миг
  // 00:00 Europe/Moscow. Раньше дата бралась по UTC (см. дефект daily-shop),
  // и в окне 21:00–24:00 UTC обновлённая лавка расходилась с лимитом рекламы.
  return mskDayKey(serverNow());
}

function hashSeed(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pickOffers(date: string, exclude: string[] = []): string[] {
  const eligible = eligibleIds();
  const excluded = new Set(exclude);
  let pool = eligible.filter((id) => !excluded.has(id));
  if (pool.length < OFFER_COUNT) pool = eligible;

  const random = seededRandom(hashSeed(`shop:${date}:${exclude.join('|')}`));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(OFFER_COUNT, pool.length));
}

function isValidRotation(value: unknown, today: string): value is DailyShopRotation {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<DailyShopRotation>;
  const eligible = new Set(eligibleIds());
  return state.date === today
    && Array.isArray(state.ids)
    && state.ids.length === OFFER_COUNT
    && state.ids.every((id) => typeof id === 'string' && eligible.has(id))
    && new Set(state.ids).size === OFFER_COUNT
    && typeof state.refreshed === 'boolean';
}

/** Return today's persisted offers, creating the deterministic daily set if needed. */
export function getDailyShopRotation(): DailyShopRotation {
  const today = dateKey();
  const stored = loadJson<unknown>(STORAGE_KEY);
  if (isValidRotation(stored, today)) return stored;

  const rotation: DailyShopRotation = {
    date: today,
    ids: pickOffers(today),
    refreshed: false,
  };
  saveJson(STORAGE_KEY, rotation);
  return rotation;
}

/**
 * Replace today's offers once after a rewarded ad succeeds.
 * The helper persists the result so reloads cannot reset the daily rotation.
 */
export function refreshDailyShopRotation(): DailyShopRotation | null {
  const current = getDailyShopRotation();
  if (current.refreshed) return current;

  const rotation: DailyShopRotation = {
    date: current.date,
    ids: pickOffers(current.date, current.ids),
    refreshed: true,
  };
  if (!saveJson(STORAGE_KEY, rotation)) return null;
  return rotation;
}
