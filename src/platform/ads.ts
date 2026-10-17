// ============ Реклама ============
// Монетизация — обязательное условие допуска к модерации (п. 1.12), а сами
// требования к рекламе жёсткие:
//   • п. 4.7 — на время показа звук и геймплей обязаны встать на паузу;
//   • п. 4.2 — если игрок вернётся из рекламы, прогресс должен быть сохранён;
//   • п. 4.5 — кнопка rewarded-ролика прямо называет награду.
// Плюс частотность: между межстраничными держим собственную паузу, чтобы
// не вызывать показ на каждом втором проигрыше.

import { getSdk, isOnYandex, isMockMode, serverNow, type YandexSdk } from './sdk';
import { loadJson, saveJson } from '../game/storage';
import { hasNoInterstitial, matchesPlayed } from '../game/meta';
import { track } from './analytics';

/**
 * Пауза между межстраничными показами (TZ §J.4): ≥ 120 сек свой таймер
 * поверх политики площадки.
 */
const INTERSTITIAL_MIN_INTERVAL_MS = 120_000;

let lastInterstitialAt = 0;
let lastError: string | null = null;

/** Приостановка и возобновление на время показа рекламы. */
export interface AdPause {
  pause: () => void;
  resume: () => void;
}

/** Заглушка для окружений без рекламы: ни во что не вмешиваемся. */
const NO_PAUSE: AdPause = { pause: () => {}, resume: () => {} };

/**
 * Ставит игру на паузу на время показа (п. 4.7) и гарантированно снимает
 * паузу после — в том числе если игрок закрыл ролик до конца.
 */
async function withPaused<T>(hooks: AdPause, fn: () => Promise<T>): Promise<T> {
  hooks.pause();
  try {
    return await fn();
  } finally {
    hooks.resume();
  }
}


/** Yandex Games invokes callbacks; these APIs do not return ad results as Promises. */
const AD_CALLBACK_TIMEOUT_MS = 90_000;

function requestFullscreenAd(sdk: YandexSdk): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer = 0;
    const finish = (shown: boolean): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(shown);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      lastError = String(error);
      track('ad_error', { kind: 'interstitial', message: lastError });
      console.warn('[ads] межстраничная не показана:', error);
      finish(false);
    };

    timer = window.setTimeout(() => fail('Interstitial ad callback timed out'), AD_CALLBACK_TIMEOUT_MS);
    try {
      sdk.adv.showFullscreenAdv({
        callbacks: {
          onClose: (wasShown) => finish(wasShown === true),
          onError: fail,
        },
      });
    } catch (error) {
      fail(error);
    }
  });
}

function requestRewardedAd(sdk: YandexSdk): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let rewarded = false;
    let timer = 0;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(rewarded);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      lastError = String(error);
      track('ad_error', { kind: 'rewarded', message: lastError });
      console.warn('[ads] rewarded не показан:', error);
      finish();
    };

    timer = window.setTimeout(() => fail('Rewarded ad callback timed out'), AD_CALLBACK_TIMEOUT_MS);
    try {
      sdk.adv.showRewardedVideo({
        callbacks: {
          onRewarded: () => {
            if (rewarded) return;
            rewarded = true;
            track('ad_rewarded_complete', {});
          },
          onClose: () => finish(),
          onError: fail,
        },
      });
    } catch (error) {
      fail(error);
    }
  });
}

/**
 * Межстраничная реклама по политике §J.4: не раньше 3-го матча, ≥ 120 сек,
 * ≤ 6 за сессию, не после 2 поражений подряд, отключается SKU no_interstitial.
 * При отсутствии SDK, гостевом режиме или ошибке молча возвращает false.
 */
export async function showInterstitial(hooks: AdPause = NO_PAUSE): Promise<boolean> {
  if (!interstitialAllowed()) return false;

  const now = Date.now();
  if (now - lastInterstitialAt < INTERSTITIAL_MIN_INTERVAL_MS) return false;

  const sdk = getSdk();
  if (!sdk) return false;

  try {
    lastError = null;
    const shown = await withPaused(hooks, () => requestFullscreenAd(sdk));
    // The cooldown and session quota track actual impressions, not attempts.
    // A skipped ad must not prevent the next eligible trigger from trying again.
    if (!shown) return false;

    lastInterstitialAt = Date.now();
    interstitialSessionCount += 1;
    return true;
  } catch (err) {
    lastError = String(err);
    track('ad_error', { kind: 'interstitial', message: lastError });
    console.warn('[ads] межстраничная не показана:', err);
    return false;
  }
}

export interface RewardedResult {
  /** Игрок досмотрел до конца и забрал награду. */
  rewarded: boolean;
  /** Показать ли кнопку: ролик доступен и ещё не использовался в этом забеге. */
  available: boolean;
}

// ============ Реестр rewarded-плейсментов (TZ §J.3) ============
// Лимиты централизованы. События ad_* шлются из одной точки (§K.2).
//
// За ран (сбрасываются resetPlacementLimits() в начале матча):
//   R1 succession        — преемственность: выбор воина бесплатно
//   R2 repair-speedup    — ускорение ремонта
//   R3 heal-speedup      — ускорение лечения
//   R4 blessing          — благословение перед раном (1 из 3)
//   R5 wallet-x2         — ×2 золота в кошелёк (end-экран)
//   R9 glory-x2          — ×2 славы (end-экран; потолок не поднимает, §H.16)
//
// За день (даты — с сервера Яндекса, персистятся):
//   R6 challenge-reroll  — реролл модификаторов вызова дня (1/день)
//   R7 daily-chest       — ежедневный сундук (2/день)
//   R8 shop-refresh      — освежение лавки (1/день)
//   R10 quest-reroll     — реролл задания дня (3/день)
//   R11 bonus-x2         — ×2 дар ежедневки (1/день)
//   R12 consumable       — «Подкова удачи» за рекламу (расходник, 2 активных)
export type AdPlacement =
  | 'succession' | 'repair-speedup' | 'heal-speedup'
  | 'blessing' | 'wallet-x2' | 'glory-x2'
  | 'challenge-reroll' | 'daily-chest' | 'shop-refresh' | 'quest-reroll'
  | 'bonus-x2' | 'consumable';

/** Лимит за ран (per-run) или за день (daily), TZ §J.3. */
export const PLACEMENT_LIMITS: Record<AdPlacement, { limit: number; period: 'run' | 'day' }> = {
  succession: { limit: 1, period: 'run' },
  'repair-speedup': { limit: 1, period: 'run' },
  'heal-speedup': { limit: 1, period: 'run' },
  blessing: { limit: 1, period: 'run' },
  'wallet-x2': { limit: 1, period: 'run' },
  'glory-x2': { limit: 1, period: 'run' },
  'challenge-reroll': { limit: 1, period: 'day' },
  'daily-chest': { limit: 2, period: 'day' },
  'shop-refresh': { limit: 1, period: 'day' },
  'quest-reroll': { limit: 3, period: 'day' },
  'bonus-x2': { limit: 1, period: 'day' },
  consumable: { limit: 1, period: 'day' },
};

const usedPlacements = new Map<AdPlacement, number>();
/** True while any rewarded video is being requested or shown. */
let rewardedInFlight = false;

const LS_AD_DAY = 'tss-ads-day';

interface AdDayState { date: string; used: Record<string, number> }

function todayKey(): string {
  // Daily rewarded limits must roll over at the same UTC boundary as daily offers.
  return new Date(serverNow()).toISOString().slice(0, 10);
}

function loadDay(): AdDayState {
  const raw = loadJson<AdDayState | null>(LS_AD_DAY);
  const date = todayKey();
  if (!raw || raw.date !== date) return { date, used: {} };
  return { date, used: raw.used ?? {} };
}

function saveDay(st: AdDayState): void {
  saveJson(LS_AD_DAY, st);
}

function usedCount(p: AdPlacement): number {
  const def = PLACEMENT_LIMITS[p];
  if (def.period === 'day') return loadDay().used[p] ?? 0;
  return usedPlacements.get(p) ?? 0;
}

/** Доступен ли показ: лимит не исчерпан и платформа умеет показывать. */
export function placementAvailable(p: AdPlacement): boolean {
  // Yandex permits one rewarded video at a time. Hide/disable every rewarded
  // placement while another one is in flight, not just after it is rewarded.
  if (rewardedInFlight || !rewardedAvailable()) return false;
  return usedCount(p) < PLACEMENT_LIMITS[p].limit;
}

/** Показ rewarded-ролика под плейсмент с учётом лимита. */
export async function showPlacementRewarded(
  placement: AdPlacement,
  hooks: AdPause = NO_PAUSE,
): Promise<RewardedResult> {
  if (!placementAvailable(placement)) {
    return { rewarded: false, available: false };
  }
  const res = await showRewarded(hooks);
  if (res.rewarded) {
    if (PLACEMENT_LIMITS[placement].period === 'day') {
      const day = loadDay();
      day.used[placement] = (day.used[placement] ?? 0) + 1;
      saveDay(day);
    } else {
      usedPlacements.set(placement, (usedPlacements.get(placement) ?? 0) + 1);
    }
  }
  return res;
}

/** Сброс лимитов за ран (в начале матча). Дневные лимиты не трогаем. */
export function resetPlacementLimits(): void {
  usedPlacements.clear();
}

// ============ Interstitial-политика (TZ §J.4) ============
//
// Триггеры: экран поражения (тап «ЕЩЁ РАЗ») и экран победы (тап продолжения).
//   • не раньше 3-го матча аккаунта (FTUE-защита);
//   • интервал ≥ 120 сек между показами (свой таймер поверх политики YG);
//   • потолок ≤ 6 показов за сессию;
//   • запрет: во время рана, на SuccessionScene, после 2 поражений подряд;
//   • ошибка/таймаут — молча пропускаем, показ не засчитывается;
//   • SKU no_interstitial отключает межстраничные (rewarded остаётся).

const INTERSTITIAL_MAX_SESSION = 6;

let interstitialSessionCount = 0;
let lossesInRow = 0;

/** Матч закончился поражением/победой — вызывается экраном результата. */
export function registerRunOutcome(victory: boolean): void {
  lossesInRow = victory ? 0 : lossesInRow + 1;
}

/** Можно ли показать межстраничный по политике §J.4 (без гарантии показа). */
export function interstitialAllowed(): boolean {
  if (!isOnYandex()) return false;
  if (hasNoInterstitial()) return false;                  // SKU фазы S
  if (matchesPlayed() < 3) return false;                  // FTUE: не раньше 3-го матча
  if (interstitialSessionCount >= INTERSTITIAL_MAX_SESSION) return false;
  if (lossesInRow >= 2) return false;                     // anti-churn §H.14
  return true;
}

/**
 * Rewarded-ролик за воскрешение. `blockers` должны глушить звук на время
 * показа; награду начисляет вызывающий код — только здесь она не выдаётся,
 * чтобы её нельзя было получить дважды на одном показе.
 */
async function requestRewarded(hooks: AdPause = NO_PAUSE): Promise<RewardedResult> {
  // QA-режим (?ysdk=mock): ролик «досмотрен» мгновенно — вся реестр R1–R11
  // проверяется end-to-end без Консоли (покупки в mock и так выдаются локально)
  if (isMockMode()) {
    track('ad_impression', { kind: 'rewarded', mock: true });
    // QA-only failure switch lets Playwright verify that an incomplete view
    // neither grants the refresh nor consumes the placement's daily limit.
    const mockFailed = new URLSearchParams(window.location.search).get('mockAd') === 'fail';
    if (mockFailed) return { rewarded: false, available: true };
    track('ad_rewarded_complete', { mock: true });
    return { rewarded: true, available: true };
  }
  if (!isOnYandex()) return { rewarded: false, available: false };

  const sdk = getSdk();
  if (!sdk) return { rewarded: false, available: false };

  try {
    track('ad_impression', { kind: 'rewarded' });
    // The reward callback is authoritative; resolve only when the ad closes
    // (or fails), so the game remains paused for the full ad lifecycle.
    const rewarded = await withPaused(hooks, () => requestRewardedAd(sdk));
    return { rewarded, available: true };
  } catch (err) {
    lastError = String(err);
    track('ad_error', { kind: 'rewarded', message: lastError });
    console.warn('[ads] rewarded не показан:', err);
    return { rewarded: false, available: true };
  }
}

/** Prevent overlapping rewarded videos across all placements and direct callers. */
export async function showRewarded(hooks: AdPause = NO_PAUSE): Promise<RewardedResult> {
  if (rewardedInFlight) {
    return { rewarded: false, available: false };
  }

  rewardedInFlight = true;
  try {
    // Keep the lock through callback completion/error and at least one
    // microtask in mock mode, so rapid repeated activations cannot race.
    return await requestRewarded(hooks);
  } finally {
    rewardedInFlight = false;
  }
}

/** Можно ли предлагать rewarded-кнопку. Вне Яндекса её не показываем. */
export function rewardedAvailable(): boolean {
  return isOnYandex();
}

/** Последняя ошибка показа — для отладочной панели. */
// ============ Стики-баннер (TZ §J.5) ============
// Только вне рана: меню / мета-сцены / экран конца. В бою и оверлеях рана
// баннер скрыт — иначе перекрывает HUD и злит игрока (антиспам §J.9).

let bannerVisible = false;

/** Показать стики-баннер (idempotent: повторный вызов без SDK — no-op). */
export function showStickyBanner(): void {
  if (bannerVisible) return;
  const sdk = getSdk();
  if (!sdk?.adv?.showBanner) return;
  try {
    sdk.adv.showBanner({});
    bannerVisible = true;
  } catch (err) {
    console.warn('[ads] showBanner не удался:', err);
  }
}

/** Скрыть стики-баннер (idempotent). */
export function hideStickyBanner(): void {
  if (!bannerVisible) return;
  const sdk = getSdk();
  if (!sdk?.adv?.hideBanner) return;
  try {
    sdk.adv.hideBanner();
    bannerVisible = false;
  } catch (err) {
    console.warn('[ads] hideBanner не удался:', err);
  }
}