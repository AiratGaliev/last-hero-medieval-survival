// ============ Игрок: имя, авторизация ============
// Внутри Яндекс Игр имя берётся из профиля. Гость вводит своё — это же
// требование платформы (п. 1.2: игра должна работать без входа в сторонние
// сервисы, а предложение авторизоваться — только по явному действию игрока).

import { getSdk, isOnYandex, type YandexPlayer } from './sdk';
import { t } from '../i18n';

/** Техническое имя таблицы рекордов в консоли Яндекса (поле «Technical name»). */
export const LEADERBOARD_ID = 'tss_score';

let cached: YandexPlayer | null = null;
let loaded = false;

/** Загружает объект игрока (один раз за сессию). */
export async function loadPlayer(): Promise<YandexPlayer | null> {
  if (loaded) return cached;
  loaded = true;
  const sdk = getSdk();
  if (!sdk) return null;
  try {
    cached = await sdk.getPlayer();
  } catch (err) {
    console.warn('[player] не удалось получить профиль:', err);
    return null;
  }
  return cached;
}

/** Авторизован ли игрок (вне Яндекса — считаем гостем). */
export function isAuthorized(): boolean {
  if (!isOnYandex()) return false;
  try {
    return cached?.isAuthorized() ?? false;
  } catch {
    return false;
  }
}

/**
 * Имя для таблицы рекордов.
 * Авторизован → имя из профиля Яндекса.
 * Гость → то, что он сам ввёл (берётся из localStorage).
 */
export function displayName(fallback: string): string {
  if (isAuthorized()) {
    const name = cached?.getName();
    if (name) return name.slice(0, 24);
  }
  return (fallback || '').trim().slice(0, 24) || defaultGuestName();
}

/** Аватар Яндекса или `null`, если гость / аватар скрыт настройками профиля. */
export function avatarUrl(size: 'small' | 'medium' | 'large' = 'small'): string | null {
  if (!isAuthorized()) return null;
  try {
    return cached?.getPhoto(size) ?? null;
  } catch {
    return null;
  }
}

/** Имя гостя по умолчанию — из активной локали. */
export function defaultGuestName(): string {
  return t('common.guest');
}

/**
 * Предлагает авторизацию. Вызывается только из явной кнопки игрока:
 * требование платформы — не дёргать окно входа без повода.
 */
export async function offerAuth(): Promise<boolean> {
  const sdk = getSdk();
  if (!sdk) return false;
  if (isAuthorized()) return true;

  try {
    await sdk.auth.openAuthDialog();
    // Профиль перечитываем: до входа getPlayer() отдавал гостя.
    cached = await sdk.getPlayer();
    return cached?.isAuthorized() ?? false;
  } catch {
    // Игрок закрыл окно входа — это нормально, не считаем ошибкой
    return false;
  }
}