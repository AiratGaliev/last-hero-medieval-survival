/**
 * Контекстные предложения магазина (§TZ J.6.4).
 *
 * Предложение выбирается только на экране завершённого рана. Сам модуль
 * не зависит от Phaser, поэтому условия и лимит сессии проверяются unit-тестами.
 */
export type StoreOfferKind = 'starter' | 'monastery' | 'pass';

export interface StoreOfferFacts {
  /** Витрина должна быть разблокирована: до 5-го завершённого матча цены скрыты. */
  storefrontUnlocked: boolean;
  passUnlocked: boolean;
  victory: boolean;
  elapsedSeconds: number;
  matchDurationSeconds: number;
  /** Максимум жертв в одном событии обрушения, а не сумма нескольких событий. */
  monasteryCollapseVictims: number;
  passLevelBefore: number;
  passLevelAfter: number;
  passPremium: boolean;
  starterAvailable: boolean;
}

/**
 * Детерминированный приоритет при совпадении условий:
 * обучающий триггер обрушения → near-miss → достижение L30.
 *
 * §J.6.4 не определяет знаменатель для «near-miss ≤5%». Здесь это явно
 * операционализировано как поражение в последних 5% стандартного рана
 * (не более 45 секунд до конца 15-минутного матча).
 */
export function resolveStoreOffer(facts: StoreOfferFacts): StoreOfferKind | null {
  if (!facts.storefrontUnlocked) return null;

  if (facts.monasteryCollapseVictims >= 5 && facts.starterAvailable) {
    return 'monastery';
  }

  const duration = facts.matchDurationSeconds;
  const remaining = duration - facts.elapsedSeconds;
  const nearMiss = !facts.victory
    && Number.isFinite(duration)
    && duration > 0
    && Number.isFinite(facts.elapsedSeconds)
    && remaining >= 0
    && remaining <= duration * 0.05;

  if (nearMiss && facts.starterAvailable) return 'starter';

  if (facts.passUnlocked
      && !facts.passPremium
      && facts.passLevelBefore < 30
      && facts.passLevelAfter >= 30) {
    return 'pass';
  }

  return null;
}

export interface SessionOfferStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const STORE_OFFER_SESSION_KEY = 'tss-store-offer-shown';

function browserSessionStorage(): SessionOfferStorage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.sessionStorage;
  } catch {
    // Закрываем показ, если браузер запрещает sessionStorage: лимит сессии
    // нельзя надёжно гарантировать без устойчивой записи.
    return null;
  }
}

/** Атомарно на уровне одного JS-потока заявляет право показать предложение. */
export function claimStoreOfferForSession(
  storage: SessionOfferStorage | null = browserSessionStorage(),
): boolean {
  if (!storage) return false;
  try {
    if (storage.getItem(STORE_OFFER_SESSION_KEY) !== null) return false;
    storage.setItem(STORE_OFFER_SESSION_KEY, '1');
    return storage.getItem(STORE_OFFER_SESSION_KEY) === '1';
  } catch {
    return false;
  }
}
