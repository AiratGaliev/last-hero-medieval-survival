// ============ Yandex Games SDK: загрузка и типы ============
// Игра должна одинаково работать в двух местах:
//   • внутри песочницы Яндекс Игр (основной сценарий публикации);
//   • на обычном вебе и при локальной разработке — там SDK не нужен.
// Модуль скрывает разницу: вне Яндекса все функции ниже — заглушки,
// а игровой код о различиях не знает.
//
// Отдельного облачного сохранения через player.setData() нам делать не нужно:
// для игр, залитых архивом, SDK сама подменяет localStorage надёжным
// хранилищем (см. «Progress loss on iOS» в документации SDK), поэтому весь
// существующий прогресс на localStorage сохраняется сам.

/** Игрок, доступный через SDK (только то, чем пользуется игра). */
export interface YandexPlayer {
  isAuthorized(): boolean;
  getUniqueID(): string;
  getName(): string | undefined;
  getPhoto(size: 'small' | 'medium' | 'large'): string | undefined;
}

/** Запись в таблицу рекордов Яндекса. */
export interface YandexLeaderboardEntry {
  rank: number;
  score: number;
  extraData: string;
  player: { publicName: string; uniqueID: string };
}

export interface YandexLeaderboardEntries {
  entries: YandexLeaderboardEntry[];
  userRank: number;
}

/**
 * Тот срез SDK, который реально использует игра. Описан вручную: официального
 * npm-пакета с типами нет, а тащить зависимость ради объявлений не хочется.
 */
export interface YandexSdk {
  environment: { i18n: { lang: string; tld: string } };
  features: {
    LoadingAPI: { ready(): void };
    GameplayAPI: { start(): void; stop(): void };
  };
  adv: {
    showFullscreenAdv(options?: { callbacks?: {
      onOpen?: () => void;
      onClose?: (wasShown: boolean) => void;
      onError?: (error: object) => void;
    } }): void;
    showRewardedVideo(options?: { callbacks?: {
      onOpen?: () => void;
      onRewarded?: () => void;
      onClose?: (wasShown: boolean) => void;
      onError?: (error: object) => void;
    } }): void;
    /** Стики-баннер (TZ §J.5); может отсутствовать в старых версиях SDK. */
    showBanner?(options?: Record<string, unknown>): void;
    hideBanner?(): void;
  };
  auth: { openAuthDialog(): Promise<void> };
  leaderboards: {
    getDescription(name: string): Promise<unknown>;
    setScore(name: string, score: number, extraData?: string): Promise<void>;
    getPlayerEntry(name: string): Promise<YandexLeaderboardEntry>;
    getEntries(
      name: string,
      options?: { includeUser?: boolean; quantityAround?: number; quantityTop?: number },
    ): Promise<YandexLeaderboardEntries>;
  };
  isAvailableMethod(name: string): Promise<boolean>;
  getPlayer(): Promise<YandexPlayer>;
  /** Серверное время Яндекса (мс эпохи или Date) — для дат ежедневок. */
  getServerTime?(): Promise<number | Date>;
  /** Платёжный слой (фаза S §J.6.1); может отсутствовать в старых версиях SDK. */
  getPayments?(options?: { signed?: boolean }): Promise<YandexPayments>;
  on(event: string, handler: () => void): void;
  off(event: string, handler: () => void): void;
}

/** Покупки Яндекс Игр (TZ §J.6.1) — срез, используемый игрой. */
export interface YandexPayments {
  purchase(options: { id: string }): Promise<{ productID: string; purchaseToken?: string }>;
  consumePurchase(token: string): Promise<void>;
  getPurchases(): Promise<{ productID: string; purchaseToken?: string }[]>;
  /** Каталог SKU с названиями/иконками портальной валюты (требование 1.13.2). */
  getCatalog?(): Promise<Array<{ id: string; title?: string; description?: string; imageURI?: string; price?: string; priceValue?: string; priceCurrencyImage?: string; priceCurrencyCode?: string }>>;
}

/** Скрипт SDK лежит в архиве игры (public/vendor → dist/vendor). */
const SDK_URL = './vendor/yandex-sdk.js';

/** Внутри песочницы init() может висеть — не будем вешать загрузочный экран. */
const INIT_TIMEOUT_MS = 6000;

let sdk: YandexSdk | null = null;
let initPromise: Promise<YandexSdk | null> | null = null;
/** Локальный QA-режим: ветка «мы на Яндексе» без загрузки их SDK. */
let mockMode = false;

/**
 * Смещение серверного времени Яндекса относительно локальных часов.
 * Даты ежедневок/заданий обязаны браться с сервера площадки (гейт Q),
 * а не с локальных часов, которые игрок может перевести.
 */
let timeOffsetMs = 0;

declare global {
  interface Window {
    YaGames?: { init(options?: { signed?: boolean }): Promise<YandexSdk> };
  }
}

/**
 * Настоящий Yandex Games — здесь грузится SDK. Вне песочницы он пытается
 * слать postMessage родительскому фрейму и сыплет ошибками, поэтому по
 * чужому hostname мы его не трогаем.
 */
function isRealYandbox(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.YaGames) return true;
  try {
    return /(^|\.)(yandex|ya)\./i.test(window.location.hostname);
  } catch {
    return false;
  }
}

/**
 * `?ysdk=mock` — локальный QA-режим: платформенный слой считает, что мы на
 * площадке (можно прогонять ветки лидерборда, рекламы и игрока), но реальный
 * SDK не подгружается. Без него все вызовы тихо возвращают пустое — ровно
 * так же, как у гостя.
 */
function wantsMock(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).get('ysdk') === 'mock';
  } catch {
    return false;
  }
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`[sdk] не загрузился: ${src}`));
    document.head.appendChild(el);
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/**
 * Инициализирует SDK. Возвращает `null` вне Яндекс Игр или если что-то
 * пошло не так — игра обязана запускаться в обоих случаях.
 */
export function initSdk(): Promise<YandexSdk | null> {
  if (initPromise) return initPromise;

  mockMode = wantsMock();

  initPromise = (async (): Promise<YandexSdk | null> => {
    if (typeof window === 'undefined') return null;
    if (mockMode) return null;
    if (!isRealYandbox()) return null;

    try {
      if (!window.YaGames) await loadScript(SDK_URL);
      if (!window.YaGames) throw new Error('[sdk] глобал YaGames не появился');

      const instance = await withTimeout(window.YaGames.init(), INIT_TIMEOUT_MS);
      if (!instance) throw new Error('[sdk] init() не ответил вовремя');

      sdk = instance;
      void syncServerTime();
      return sdk;
    } catch (err) {
      console.warn('[sdk] недоступен, играем без него:', err);
      return null;
    }
  })();

  return initPromise;
}

/** Инициализированный SDK или `null`. Не инициирует загрузку. */
export function getSdk(): YandexSdk | null {
  return sdk;
}

/** Подтягивает серверное время площадки (не блокирует запуск при ошибке). */
export async function syncServerTime(): Promise<void> {
  const s = sdk;
  if (!s || typeof s.getServerTime !== 'function') return;
  try {
    const raw = await withTimeout(s.getServerTime(), 4000);
    if (raw === null || raw === undefined) return;
    const ms = raw instanceof Date ? raw.getTime() : Number(raw);
    if (Number.isFinite(ms) && ms > 1_000_000_000_000) {
      timeOffsetMs = ms - Date.now();
    } else if (Number.isFinite(ms) && ms > 1_000_000_000) {
      // Секунды → миллисекунды
      timeOffsetMs = ms * 1000 - Date.now();
    }
  } catch {
    // Нет доступа к методу — молча играем по локальным часам
  }
}

/**
 * «Серверное сейчас» для дат ежедневок/заданий/сезонов. Вне Яндекса и в
 * QA-режиме — локальные часы (смещение нулевое).
 */
export function serverNow(): number {
  return Date.now() + timeOffsetMs;
}

/** Работаем ли мы в окружении Yandex Games (включая QA-режим). */
export function isOnYandex(): boolean {
  return sdk !== null || mockMode;
}

/** QA-режим (?ysdk=mock): платформа «есть», реального SDK нет. */
export function isMockMode(): boolean {
  return mockMode;
}