// ============ Игрок: имя, авторизация ============
// Внутри Яндекс Игр имя берётся из профиля. Гость вводит своё — это же
// требование платформы (п. 1.2: игра должна работать без входа в сторонние
// сервисы, а предложение авторизоваться — только по явному действию игрока).

import { getSdk, isOnYandex, type YandexPlayer } from './sdk';
import { loadJson, saveJson } from '../game/storage';
import { t } from '../i18n';

/** Техническое имя таблицы рекордов в консоли Яндекса (поле «Technical name»). */
export const LEADERBOARD_ID = 'tss_score';

let cached: YandexPlayer | null = null;
let loaded = false;

const SUCCESSION_FREE_USED_KEY = 'successionFreeUsed';
const SUCCESSION_FLAG_TIMEOUT_MS = 2_500;
let successionFreeUsed: boolean | null = null;
let successionFreeHydrated = false;
let successionSaveQueue: Promise<void> = Promise.resolve();

/** Время ответа SDK ограничено: сбой облака не должен блокировать старт игры. */
async function playerDataWithTimeout(
  player: YandexPlayer,
): Promise<Record<string, unknown>> {
  if (!player.getData) throw new Error('Yandex Player.getData unavailable');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      player.getData([SUCCESSION_FREE_USED_KEY]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Yandex Player.getData timed out')), SUCCESSION_FLAG_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function saveSuccessionFreeUsedToCloud(player: YandexPlayer): void {
  if (!player.setData) return;
  successionSaveQueue = successionSaveQueue
    .then(() => player.setData!({ [SUCCESSION_FREE_USED_KEY]: true }, true))
    .catch((error: unknown) => {
      // Локальная запись уже сохранена; ошибка синхронизации не должна ломать матч.
      console.warn('[player] не удалось синхронизировать преемственность:', error);
    });
}

/**
 * Однократно объединяет локальный флаг с данными игрока Yandex Games.
 * Значение монотонное: уже использованная бесплатная смена не сбрасывается
 * из-за пустого/устаревшего локального значения на другом устройстве.
 */
export async function hydrateSuccessionFreeUsed(): Promise<void> {
  if (successionFreeHydrated) return;

  let localUsed = loadJson<boolean>('succession-free') === true;
  try {
    // Совместимость со старой версией, которая хранила строку '1'.
    localUsed ||= window.localStorage.getItem('tss-succession-free') === '1';
  } catch {
    // Приватный режим/запрещённое хранилище: облачный слой всё ещё доступен.
  }

  const player = await loadPlayer();
  let cloudUsed = false;
  let cloudReadSucceeded = false;
  if (player?.getData) {
    try {
      const data = await playerDataWithTimeout(player);
      cloudUsed = data[SUCCESSION_FREE_USED_KEY] === true;
      cloudReadSucceeded = true;
    } catch {
      // Сеть и доступность облака — внешние условия; продолжаем с localStorage.
    }
  }

  successionFreeUsed = localUsed || cloudUsed;
  successionFreeHydrated = true;
  if (successionFreeUsed) saveJson('succession-free', true);

  // Если локальная запись есть, а облачная — нет, восстанавливаем облако.
  if (localUsed && !cloudUsed && cloudReadSucceeded && player) {
    saveSuccessionFreeUsedToCloud(player);
  }
}

/** null означает, что bootstrap ещё не выполнил гидратацию. */
export function getSuccessionFreeUsed(): boolean | null {
  return successionFreeHydrated ? successionFreeUsed : null;
}

/** Записать lifetime-флаг локально и в облако, не дожидаясь сетевого ответа. */
export function persistSuccessionFreeUsed(): void {
  successionFreeUsed = true;
  successionFreeHydrated = true;
  if (cached) saveSuccessionFreeUsedToCloud(cached);
}

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