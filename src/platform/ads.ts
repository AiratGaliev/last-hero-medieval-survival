// ============ Реклама ============
// Монетизация — обязательное условие допуска к модерации (п. 1.12), а сами
// требования к рекламе жёсткие:
//   • п. 4.7 — на время показа звук и геймплей обязаны встать на паузу;
//   • п. 4.2 — если игрок вернётся из рекламы, прогресс должен быть сохранён;
//   • п. 4.5 — кнопка rewarded-ролика прямо называет награду.
// Плюс частотность: между межстраничными держим собственную паузу, чтобы
// не вызывать показ на каждом втором проигрыше.

import { getSdk, isOnYandex } from './sdk';

/** Пауза между межстраничными показами. */
const INTERSTITIAL_COOLDOWN_MS = 150_000;

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

/**
 * Межстраничная реклама. Показывается по кулдауну; при отсутствии SDK,
 * гостевом режиме или ошибке молча возвращает false.
 */
export async function showInterstitial(hooks: AdPause = NO_PAUSE): Promise<boolean> {
  if (!isOnYandex()) return false;

  const now = Date.now();
  if (now - lastInterstitialAt < INTERSTITIAL_COOLDOWN_MS) return false;

  const sdk = getSdk();
  if (!sdk) return false;

  try {
    const shown = await withPaused(hooks, () => sdk.adv.showFullscreenAdv());
    lastInterstitialAt = Date.now();
    lastError = null;
    return shown === true;
  } catch (err) {
    lastError = String(err);
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

/**
 * Rewarded-ролик за воскрешение. `blockers` должны глушить звук на время
 * показа; награду начисляет вызывающий код — только здесь она не выдаётся,
 * чтобы её нельзя было получить дважды на одном показе.
 */
export async function showRewarded(hooks: AdPause = NO_PAUSE): Promise<RewardedResult> {
  if (!isOnYandex()) return { rewarded: false, available: false };

  const sdk = getSdk();
  if (!sdk) return { rewarded: false, available: false };

  try {
    const res = await withPaused(hooks, () => sdk.adv.showRewardedVideo());
    return { rewarded: res?.rewarded === true, available: true };
  } catch (err) {
    lastError = String(err);
    console.warn('[ads] rewarded не показан:', err);
    return { rewarded: false, available: true };
  }
}

/** Можно ли предлагать rewarded-кнопку. Вне Яндекса её не показываем. */
export function rewardedAvailable(): boolean {
  return isOnYandex();
}

/** Последняя ошибка показа — для отладочной панели. */
export function lastAdError(): string | null {
  return lastError;
}