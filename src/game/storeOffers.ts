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
  /** Бесконечный режим не запускает предложение стартового набора за near-miss. */
  endless: boolean;
  /** Остаток HP финального босса в процентах на момент поражения; null, если босса нет. */
  bossHpRemainingPercent: number | null;
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
 * Для триггера стартового набора «near-miss ≤5%» означает поражение в обычном
 * режиме, пока финальный босс ещё жив и у него осталось не больше 5% HP.
 * Оставшееся время рана не измеряет близость к победе: босс появляется на
 * 15-й минуте, а финальная схватка может продолжаться после отметки 900 с.
 */
export function resolveStoreOffer(facts: StoreOfferFacts): StoreOfferKind | null {
  // Образовательный триггер не зависит от доступности платной витрины:
  // если пак закрыт/истёк, экран результата всё равно объяснит механику.
  if (facts.monasteryCollapseVictims >= 5) return 'monastery';

  if (!facts.storefrontUnlocked) return null;

  const bossRemaining = facts.bossHpRemainingPercent;
  const nearMiss = !facts.victory
    && !facts.endless
    && typeof bossRemaining === 'number'
    && Number.isFinite(bossRemaining)
    && bossRemaining > 0
    && bossRemaining <= 5;

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
