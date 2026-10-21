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
const SUCCESSION_LOCAL_PREFIX = 'tss-succession-free@';
const SUCCESSION_OWNER_KEY = 'tss-succession-free-owner';
let successionFreeUsed: boolean | null = null;
let successionFreeHydrated = false;
let successionLocalStorageKey: string | null = null;
let successionAccountId: string | null = null;
let successionSaveQueue: Promise<void> = Promise.resolve();

function playerUniqueId(player: YandexPlayer | null): string | null {
  try {
    const id = player?.getUniqueID().trim();
    return id || null;
  } catch {
    return null;
  }
}

function accountSuccessionKey(id: string): string {
  return `${SUCCESSION_LOCAL_PREFIX}${encodeURIComponent(id)}`;
}

function readLegacySuccessionFlag(): boolean {
  let used = loadJson<boolean>('succession-free') === true;
  try {
    // Старые релизы могли хранить raw '1' вместо JSON-boolean.
    used ||= window.localStorage.getItem('tss-succession-free') === '1';
  } catch {
    // Приватный режим: ниже останется false, пока облако не восстановит запись.
  }
  return used;
}

function saveSuccessionLocal(used: boolean): void {
  const id = playerUniqueId(cached) ?? successionAccountId;
  if (id) {
    const key = accountSuccessionKey(id);
    successionAccountId = id;
    successionLocalStorageKey = key;
    try {
      window.localStorage.setItem(key, String(used));
      // Владелец нужен только для одноразовой миграции старого общего ключа.
      window.localStorage.setItem(SUCCESSION_OWNER_KEY, id);
    } catch {
      // Облачная запись остаётся доступным источником.
    }
    return;
  }
  // Вне Yandex Games нет стабильного ID профиля: остаётся прежний локальный ключ.
  saveJson('succession-free', used);
}

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

function saveSuccessionFreeUsedToCloud(player: YandexPlayer, used: boolean): void {
  if (!player.setData) return;
  successionSaveQueue = successionSaveQueue
    .then(() => player.setData!({ [SUCCESSION_FREE_USED_KEY]: used }, true))
    .catch((error: unknown) => {
      // Локальная запись уже сохранена; ошибка синхронизации не должна ломать матч.
      console.warn('[player] не удалось синхронизировать преемственность:', error);
    });
}

/**
 * Синхронизирует lifetime-флаг аккаунта. Локальный fallback изолирован по
 * getUniqueID(), а глобальный ключ мигрируется один раз к первому увиденному
 * профилю. Успешный cloud false не наследует флаг другого аккаунта с устройства.
 */
export async function hydrateSuccessionFreeUsed(): Promise<void> {
  if (successionFreeHydrated) return;

  const player = await loadPlayer();
  const accountId = playerUniqueId(player);
  successionAccountId = accountId;
  successionLocalStorageKey = accountId ? accountSuccessionKey(accountId) : null;

  let localUsed = readLegacySuccessionFlag();
  if (accountId) {
    try {
      const localAccountValue = window.localStorage.getItem(successionLocalStorageKey!);
      const owner = window.localStorage.getItem(SUCCESSION_OWNER_KEY);
      if (localAccountValue === 'true') {
        localUsed = true;
      } else if (localAccountValue === 'false') {
        localUsed = false;
      } else if (owner === accountId) {
        // Этот профиль уже владел старым ключом до локальной миграции.
        localUsed = readLegacySuccessionFlag();
      } else if (!owner) {
        // Миграция старого общего значения ровно для первого профиля после обновления.
        try { window.localStorage.setItem(SUCCESSION_OWNER_KEY, accountId); } catch { /* storage недоступен */ }
      } else {
        // На этом устройстве старый ключ принадлежал другому профилю.
        localUsed = false;
      }
    } catch {
      // Профиль остаётся работоспособным даже при заблокированном localStorage.
    }
  }

  let cloudUsed = false;
  let cloudReadSucceeded = false;
  let cloudHasFlag = false;
  if (player?.getData) {
    try {
      const data = await playerDataWithTimeout(player);
      const value = data[SUCCESSION_FREE_USED_KEY];
      cloudHasFlag = typeof value === 'boolean';
      cloudUsed = value === true;
      cloudReadSucceeded = true;
    } catch {
      // Сеть и доступность облака — внешние условия; продолжаем с локальным fallback.
    }
  }

  // Использованный lifetime-флаг никогда не сбрасывается ответом stale-cloud false.
  successionFreeUsed = localUsed || cloudUsed;
  successionFreeHydrated = true;
  saveSuccessionLocal(successionFreeUsed);

  // true локально восстанавливает облако, если оно пустое/stale или чтение не прошло.
  // При первом успешном чтении записываем и false, чтобы новый профиль был отделён
  // от общего legacy-ключа на следующих устройствах/сессиях.
  if (player?.setData && (
    (successionFreeUsed && !cloudUsed)
    || (cloudReadSucceeded && !cloudHasFlag)
  )) {
    saveSuccessionFreeUsedToCloud(player, successionFreeUsed);
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
  saveSuccessionLocal(true);
  if (cached) saveSuccessionFreeUsedToCloud(cached, true);
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