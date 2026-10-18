// ============ Платежи Яндекс Игр (TZ §J.6.1, фаза S) ============
//
// Требования модерации, на которых построен модуль:
//   • 1.13.1 — при старте обязательно консумировать необработанные покупки:
//     getPayments() → getPurchases() → consumePurchase() для каждого токена,
//     ДО первого вызова purchase(). Ненулевые необработанные платежи
//     блокируют модерацию;
//   • начисление награды — только после успешного purchase(); повторное
//     начисление исключается консумированием токена сразу после выдачи;
//   • клиентская обработка достаточна для старта (signed: false);
//   • названия/иконки портальной валюты в UI — только из данных SDK
//     (требование 1.13.2, см. getCatalog).
//
// В DEV-сборке вне Яндекса и в QA-режиме (?ysdk=mock) работает локальная
// заглушка. В production локальная выдача запрещена: отсутствие платежей
// на платформе не должно превращать покупку в бесплатное начисление.

import { getSdk, isMockMode, isOnYandex, type YandexCatalogProduct, type YandexPayments } from './sdk';
import { grantSku, showcaseUnlocked } from '../game/meta';
import { track } from './analytics';

export type { YandexPayments };

/** Каталог SKU игры (TZ §J.6.2). Идентификаторы = SKU в Консоли Яндекса. */
export const SKUS: Record<string, { crowns?: number; note: string }> = {
  crowns_s: { crowns: 90, note: '~49' },
  crowns_m: { crowns: 500, note: '~249 (+11%)' },
  crowns_l: { crowns: 1100, note: '~499 (+22%)' },
  crowns_xl: { crowns: 2500, note: '~999 (+39%)' },
  starter_castellan: { crowns: 350, note: 'one-shot 48ч' },
  no_interstitial: { note: 'one-shot' },
  pass_chronicle: { note: 'season' },
  skin_hero_warrior_red: { note: 'cosmetic' },
  skin_hero_archer_purple: { note: 'cosmetic' },
  skin_bld_red: { note: 'cosmetic' },
  hero_trail_gold: { note: 'cosmetic' },
};

/** Витрина крон скрыта до 5-го матча (§J.6.4, гейт 45). */
export function showcaseVisible(): boolean {
  return showcaseUnlocked();
}

let payments: YandexPayments | null = null;
let paymentsTried = false;
let pendingProcessed = false;

/**
 * Предзагрузка платёжного слоя + консумирование необработанных покупок
 * (требование 1.13.1). Вызывается один раз из main.ts до старта сцен.
 * Вне Яндекса — заглушка, консумировать нечего.
 */
export async function initPayments(): Promise<void> {
  if (paymentsTried) return;
  paymentsTried = true;
  if (!isOnYandex()) { pendingProcessed = true; return; }
  const sdk = getSdk();
  if (!sdk?.getPayments) { pendingProcessed = true; return; }
  try {
    payments = await sdk.getPayments({ signed: false });
    await processPending();
  } catch (err) {
    // Платежи недоступны (ЕЛС не активен и т.п.) — играем без инапов
    console.warn('[payments] слой недоступен, витрина будет недоступна:', err);
    payments = null;
    pendingProcessed = true;
  }
}

/**
 * Консумирует все необработанные покупки. Начисление при этом НЕ повторяется:
 * токен без награды по регламенту консумируется молча (ошибка прошлого
 * показа не должна блокировать модерацию), а начисление делает purchase() в
 * момент оплаты.
 */
async function processPending(): Promise<void> {
  if (!payments || pendingProcessed) return;
  try {
    const list = await payments.getPurchases();
    for (const p of list ?? []) {
      if (p.purchaseToken) {
        try {
          await payments.consumePurchase(p.purchaseToken);
        } catch (err) {
          console.warn('[payments] консумирование не удалось:', p.productID, err);
          track('iap_consume_fail', { sku: p.productID, stage: 'pending' });
        }
      }
    }
  } catch (err) {
    console.warn('[payments] getPurchases не удался:', err);
  } finally {
    pendingProcessed = true;
  }
}

export interface PurchaseResult {
  ok: boolean;
  /** Что начислено (кроны/скин/расходник) — из grantSku. */
  granted?: ReturnType<typeof grantSku>;
  reason?: 'locked' | 'fail' | 'duplicate';
}

/**
 * Покупка SKU. Награда начисляется через meta.grantSku сразу после
 * подтверждения платформы, затем токен консумируется. one-shot SKU
 * (starter_castellan, no_interstitial) защищены от повторной выдачи.
 */
export async function purchaseSku(sku: string): Promise<PurchaseResult> {
  const oneShot = sku === 'starter_castellan' || sku === 'no_interstitial' || sku === 'pass_chronicle';
  if (oneShot && purchasedOnce().includes(sku)) {
    return { ok: false, reason: 'duplicate' };
  }

  // Локальная симуляция разрешена только в dev-сборке. В частности,
  // ?ysdk=mock не должен позволять бесплатно получать SKU в production.
  if (import.meta.env.DEV && (isMockMode() || !isOnYandex())) {
    const granted = grantSku(sku);
    markPurchasedOnce(sku);
    return { ok: true, granted };
  }

  // Fail-closed: в Yandex Games/production отсутствие платёжного слоя —
  // это отказ покупки, никогда не локальная выдача награды.
  if (!isOnYandex() || !payments) {
    console.warn('[payments] покупка отклонена: платёжный слой недоступен', sku);
    return { ok: false, reason: 'fail' };
  }

  try {
    await processPending();
    const res = await payments.purchase({ id: sku });
    const granted = grantSku(sku);
    markPurchasedOnce(sku);
    track('iap_purchase', { sku });
    if (res.purchaseToken) {
      try {
        await payments.consumePurchase(res.purchaseToken);
      } catch (err) {
        // Токен остался необработанным — при следующем старте уйдёт в
        // processPending. Награда уже выдана, повторной выдачи не будет.
        console.warn('[payments] consume после покупки не удался:', sku, err);
        track('iap_consume_fail', { sku, stage: 'post-purchase' });
      }
    }
    return { ok: true, granted };
  } catch (err) {
    console.warn('[payments] покупка не состоялась:', sku, err);
    return { ok: false, reason: 'fail' };
  }
}

// ---------- one-shot локально (гости/заглушка) ----------

const LS_ONCE = 'tss-sku-once';

function purchasedOnce(): string[] {
  try {
    const raw = localStorage.getItem(LS_ONCE);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function markPurchasedOnce(sku: string): void {
  try {
    const list = purchasedOnce();
    if (!list.includes(sku)) {
      list.push(sku);
      localStorage.setItem(LS_ONCE, JSON.stringify(list));
    }
  } catch {
    // хранилище недоступно — one-shot не критичен для гостей
  }
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

/** Accept only HTTP(S) images from SDK; resolve relative URIs against the game origin. */
function safeCatalogImageUri(uri: string | undefined): string | undefined {
  if (!uri?.trim() || typeof window === 'undefined') return undefined;
  try {
    const parsed = new URL(uri, window.location.href);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
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
      const priceValue = product.priceValue?.trim() || undefined;
      const priceCurrencyCode = product.priceCurrencyCode?.trim() || undefined;
      const price = product.price?.trim()
        || (priceValue && priceCurrencyCode ? priceValue + ' ' + priceCurrencyCode : undefined);
      let currencyImageUri: string | undefined;
      try {
        currencyImageUri = product.getPriceCurrencyImage?.('small');
      } catch {
        // Currency artwork is optional; the canonical price string is still useful.
      }
      return [{
        id: product.id.trim(),
        title: product.title?.trim() || undefined,
        description: product.description?.trim() || undefined,
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
