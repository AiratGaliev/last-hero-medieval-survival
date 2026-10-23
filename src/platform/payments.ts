// ============ Платежи Яндекс Игр (TZ §J.6.1, фаза S) ============
//
// Требования модерации, на которых построен модуль:
//   • 1.13.1 — при старте обязательно сверять getPurchases() ДО нового purchase();
//     consumable: атомарно сохранить награду + receipt token, затем consumePurchase();
//     non-consumable: восстановить entitlement, но НЕ удалять его через consumePurchase();
//   • неизвестный SKU/отсутствующий токен/ошибка персистентности оставляют чек-аут закрытым;
//   • клиентская обработка достаточна для старта (signed: false);
//   • названия/иконки портальной валюты в UI — только из данных SDK
//     (требование 1.13.2, см. getCatalog).
//
// В DEV-сборке вне Яндекса и в QA-режиме (?ysdk=mock) работает локальная
// заглушка. В production локальная выдача запрещена: отсутствие платежей
// на платформе не должно превращать покупку в бесплатное начисление.

import { getSdk, isMockMode, isOnYandex, type YandexCatalogProduct, type YandexPayments } from './sdk';
import { grantSku, grantSkuForPurchase, hasIapEntitlement, rollMetaDay, showcaseUnlocked } from '../game/meta';
import { loadJson, saveJson } from '../game/storage';
import { track } from './analytics';

export type { YandexPayments };

/** Каталог SKU игры (TZ §J.6.2). Идентификаторы = SKU в Консоли Яндекса. */
export const SKUS: Record<string, { crowns?: number; note: string; consumable: boolean }> = {
  crowns_s: { crowns: 90, note: 'DEV mock', consumable: true },
  crowns_m: { crowns: 500, note: 'DEV mock', consumable: true },
  crowns_l: { crowns: 1100, note: 'DEV mock', consumable: true },
  crowns_xl: { crowns: 2500, note: 'DEV mock', consumable: true },
  // One-time starter offer combines spendable rewards with a permanent cosmetic;
  // keep its receipt restorable instead of deleting the only platform entitlement.
  starter_castellan: { crowns: 350, note: 'DEV mock', consumable: false },
  no_interstitial: { note: 'DEV mock', consumable: false },
  // The same pass SKU is reusable each season, so consume each successful season purchase.
  pass_chronicle: { note: 'DEV mock', consumable: true },
  skin_hero_warrior_red: { note: 'DEV mock', consumable: false },
  skin_hero_warrior_yellow: { note: 'DEV mock', consumable: false },
  skin_hero_archer_red: { note: 'DEV mock', consumable: false },
  skin_hero_archer_purple: { note: 'DEV mock', consumable: false },
  skin_hero_lancer_red: { note: 'DEV mock', consumable: false },
  skin_hero_lancer_black: { note: 'DEV mock', consumable: false },
  skin_hero_monk_red: { note: 'DEV mock', consumable: false },
  skin_hero_monk_yellow: { note: 'DEV mock', consumable: false },
  skin_bld_red: { note: 'DEV mock', consumable: false },
  skin_bld_purple: { note: 'DEV mock', consumable: false },
  skin_bld_yellow: { note: 'DEV mock', consumable: false },
  skin_bld_black: { note: 'DEV mock', consumable: false },
  hero_trail_gold: { note: 'DEV mock', consumable: false },
  hero_trail_ember: { note: 'DEV mock', consumable: false },
};

const ONE_SHOT_SKUS = new Set(['starter_castellan', 'no_interstitial']);
const inFlightSkus = new Set<string>();

/** Витрина крон скрыта до 5-го матча (§J.6.4, гейт 45). */
export function showcaseVisible(): boolean {
  return showcaseUnlocked();
}

let payments: YandexPayments | null = null;
let paymentsTried = false;
let pendingProcessed = false;

/**
 * Предзагрузка платежей и восстановление незавершённых покупок до показа
 * сцен. Consumables начисляются идемпотентно и затем потребляются; постоянные
 * покупки остаются в getPurchases() для восстановления entitlement.
 */
export async function initPayments(): Promise<void> {
  if (paymentsTried) return;
  paymentsTried = true;
  if (!isOnYandex()) { pendingProcessed = true; return; }
  const sdk = getSdk();
  if (!sdk?.getPayments) {
    // Keep initialization retryable if the SDK payment layer becomes available later.
    paymentsTried = false;
    pendingProcessed = false;
    return;
  }
  try {
    payments = await sdk.getPayments({ signed: false });
    await processPending();
  } catch (err) {
    // Purchases unavailable (for example, ELS or console configuration is incomplete).
    console.warn('[payments] layer unavailable; in-app purchases stay closed:', err);
    payments = null;
    paymentsTried = false;
    pendingProcessed = false;
  }
}

/**
 * Reconcile unfinished purchases before allowing a new checkout.
 * Unknown SKUs and receipts without tokens are left untouched: deleting a
 * paid-but-unmapped receipt would permanently lose the player's purchase.
 */
async function processPending(): Promise<boolean> {
  if (!payments) return false;
  if (pendingProcessed) return true;

  let reconciled = true;
  try {
    const list = await payments.getPurchases();
    if (!Array.isArray(list)) {
      pendingProcessed = false;
      return false;
    }

    for (const purchase of list) {
      const sku = typeof purchase?.productID === 'string' ? purchase.productID : '';
      const token = typeof purchase?.purchaseToken === 'string' ? purchase.purchaseToken.trim() : '';
      if (!sku || !SKUS[sku] || !token) {
        console.warn('[payments] pending receipt left unprocessed; SKU/token is missing or unsupported', sku || '(missing SKU)');
        // Keep the receipt untouched; checkout remains blocked until it is mapped in code.
        reconciled = false;
        continue;
      }
      const result = grantSkuForPurchase(sku, token);
      if (!result.supported || !result.persisted) {
        // grantSkuForPurchase rolls back the in-memory ledger if storage fails.
        // Keep the receipt pending, but allow a retry if storage recovers.
        reconciled = false;
        continue;
      }
      if (ONE_SHOT_SKUS.has(sku)) markPurchasedOnce(sku);

      if (SKUS[sku].consumable) {
        try {
          await payments.consumePurchase(token);
        } catch (err) {
          console.warn('[payments] consume pending receipt failed:', sku, err);
          track('iap_consume_fail', { sku, stage: 'pending' });
          reconciled = false;
        }
      }
      // Non-consumable purchases intentionally remain available to getPurchases()
      // so a reinstall or empty local store can restore the entitlement.
    }
  } catch (err) {
    console.warn('[payments] getPurchases failed; checkout remains closed:', err);
    reconciled = false;
  }

  pendingProcessed = reconciled;
  return reconciled;
}

export interface PurchaseResult {
  ok: boolean;
  /** Что начислено (кроны/скин/расходник) — из grantSku. */
  granted?: ReturnType<typeof grantSku>;
  reason?: 'locked' | 'fail' | 'duplicate';
}

/**
 * Fail-closed checkout:
 * - only registered, reward-mapped SKUs can be purchased;
 * - startup receipts must be reconciled first;
 * - purchase response must match the requested SKU and include a token;
 * - reward + token ledger are persisted before consuming a consumable.
 */
export async function purchaseSku(sku: string): Promise<PurchaseResult> {
  if (!SKUS[sku]) {
    console.warn('[payments] unknown SKU rejected before checkout:', sku);
    return { ok: false, reason: 'fail' };
  }
  const meta = rollMetaDay();
  const alreadyOwnedCosmetic = sku.startsWith('skin_')
    && meta.skins.owned.includes(sku);
  if (alreadyOwnedCosmetic
    || (ONE_SHOT_SKUS.has(sku)
      && (purchasedOnce().includes(sku) || hasIapEntitlement(meta, sku)))
    || (sku === 'pass_chronicle' && meta.pass.premium)) {
    return { ok: false, reason: 'duplicate' };
  }
  if (inFlightSkus.has(sku)) return { ok: false, reason: 'fail' };
  inFlightSkus.add(sku);

  try {
    // A transient startup failure must not permanently disable purchases for this session.
    if (!payments && isOnYandex()) await initPayments();

    // Local simulation is allowed only in a development build.
    if (import.meta.env.DEV && (isMockMode() || !isOnYandex())) {
      const granted = grantSku(sku);
      if (ONE_SHOT_SKUS.has(sku)) markPurchasedOnce(sku);
      return { ok: true, granted };
    }

    if (!isOnYandex() || !payments) {
      console.warn('[payments] purchase rejected: platform payment layer unavailable', sku);
      return { ok: false, reason: 'fail' };
    }

    if (!(await processPending())) {
      console.warn('[payments] purchase rejected: unresolved platform receipts remain');
      return { ok: false, reason: 'fail' };
    }

    const receipt = await payments.purchase({ id: sku });
    const returnedSku = typeof receipt?.productID === 'string' ? receipt.productID : '';
    const token = typeof receipt?.purchaseToken === 'string' ? receipt.purchaseToken.trim() : '';
    if (returnedSku !== sku || !token) {
      // Leave the platform receipt for the next reconciliation pass; never
      // guess a reward when the response is incomplete or names another SKU.
      pendingProcessed = false;
      console.warn('[payments] purchase response is incomplete or mismatched', { requested: sku, returned: returnedSku });
      return { ok: false, reason: 'fail' };
    }

    const result = grantSkuForPurchase(sku, token);
    if (!result.supported || !result.persisted) {
      pendingProcessed = false;
      console.warn('[payments] reward not consumed because its receipt ledger could not be persisted', sku);
      return { ok: false, reason: 'fail' };
    }

    if (ONE_SHOT_SKUS.has(sku)) markPurchasedOnce(sku);
    track('iap_purchase', { sku });

    if (SKUS[sku].consumable) {
      try {
        await payments.consumePurchase(token);
      } catch (err) {
        // The receipt ledger makes the next reconciliation idempotent.
        pendingProcessed = false;
        console.warn('[payments] consume after purchase failed; receipt will be retried:', sku, err);
        track('iap_consume_fail', { sku, stage: 'post-purchase' });
      }
    }
    return { ok: true, granted: result.granted };
  } catch (err) {
    console.warn('[payments] platform purchase failed:', sku, err);
    return { ok: false, reason: 'fail' };
  } finally {
    inFlightSkus.delete(sku);
  }
}

// ---------- one-shot локально (гости/заглушка) ----------

const LS_ONCE = 'tss-sku-once';

function purchasedOnce(): string[] {
  return loadJson<string[]>(LS_ONCE) ?? [];
}

function markPurchasedOnce(sku: string): void {
  const list = purchasedOnce();
  if (list.includes(sku)) return;
  // хранилище недоступно — one-shot не критичен для гостей
  saveJson(LS_ONCE, [...list, sku]);
}

export interface CatalogProduct {
  id: string;
  title?: string;
  description?: string;
  imageURI?: string;
  price?: string;
  priceValue?: string;
  priceCurrencyCode?: string;
  priceCurrencyImage?: string;
}

/** Accept only HTTP(S) URLs from SDK; resolve relative URIs against the game origin. */
function safeCatalogImageUri(uri: unknown): string | undefined {
  if (typeof uri !== 'string' || !uri.trim() || typeof window === 'undefined') return undefined;
  try {
    const parsed = new URL(uri, window.location.href);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

function catalogText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Load and normalize the official SDK catalog. Empty/error results stay empty so
 * the platform store can fail closed rather than showing fictional local prices.
 */
export async function fetchCatalog(): Promise<CatalogProduct[]> {
  const sdk = getSdk();
  if (!payments && sdk?.getPayments && isOnYandex()) {
    try { payments = await sdk.getPayments({ signed: false }); } catch { payments = null; }
  }
  if (!payments?.getCatalog) return [];

  try {
    const products = await payments.getCatalog();
    if (!Array.isArray(products)) return [];
    return products.flatMap((product: YandexCatalogProduct) => {
      if (!product || typeof product.id !== 'string' || !product.id.trim()) return [];
      const priceValue = catalogText(product.priceValue);
      const priceCurrencyCode = catalogText(product.priceCurrencyCode);
      const price = catalogText(product.price)
        || (priceValue && priceCurrencyCode ? priceValue + ' ' + priceCurrencyCode : undefined);
      let currencyImageUri: string | undefined;
      try {
        currencyImageUri = product.getPriceCurrencyImage?.('small');
      } catch {
        // Currency artwork is optional; the canonical price string is still useful.
      }
      return [{
        id: product.id.trim(),
        title: catalogText(product.title),
        description: catalogText(product.description),
        imageURI: safeCatalogImageUri(product.imageURI),
        price,
        priceValue,
        priceCurrencyCode,
        priceCurrencyImage: safeCatalogImageUri(currencyImageUri),
      }];
    });
  } catch {
    return [];
  }
}
