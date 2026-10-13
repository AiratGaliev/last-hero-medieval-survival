// ============ Таблица рекордов ============
// Гибрид по требованиям платформы:
//   • авторизованные игроки попадают в общий зал через ysdk.leaderboards;
//   • гости видят локальную таблицу на своём устройстве.
// Гостей SDK в общий зал не пускает принципиально (метод setScore доступен
// только авторизованным), поэтому локальный список нужен в любом случае —
// он же служит резервом, если запрос к SDK не удался.
//
// Частые методы лидерборда ограничены по частоте (getEntries — 20 запросов
// за 5 минут), поэтому ответ кэшируем на короткое время.

import { getSdk, isOnYandex } from './sdk';
import { isAuthorized, LEADERBOARD_ID } from './player';

export interface ScoreEntry {
  rank: number;
  name: string;
  score: number;
  kills: number;
  level: number;
  timeSurvived: number;
  victory: boolean;
  /** true — запись из общего зала Яндекса, false — локальная. */
  online: boolean;
}

export interface NewScore {
  name: string;
  score: number;
  kills: number;
  level: number;
  timeSurvived: number;
  victory: boolean;
}

const LS_RECORDS = 'tss-records';
const LOCAL_LIMIT = 10;

/** Кэш ответа SDK, чтобы не упираться в лимит частоты. */
const CACHE_MS = 60_000;
let cache: { at: number; entries: ScoreEntry[] } | null = null;

// ---------- Кодирование в extraData ----------
//
// SDK отдаёт из записи только счёт и имя; убийства/уровень/время едут
// в extraData. Формат компактный и однозначный — «киллы|уровень|время|флаг».
// Если разбор не удался — показываем запись без деталей, а не роняем зал.

function encodeExtra(s: NewScore): string {
  return `${s.kills}|${s.level}|${s.timeSurvived}|${s.victory ? 1 : 0}`;
}

function decodeExtra(raw: string): Pick<ScoreEntry, 'kills' | 'level' | 'timeSurvived' | 'victory'> {
  const fallback = { kills: 0, level: 0, timeSurvived: 0, victory: false };
  const parts = (raw ?? '').split('|');
  if (parts.length < 4) return fallback;
  const [kills, level, time, vic] = parts;
  const n = (v: string | undefined): number => Math.max(0, Math.floor(Number(v) || 0));
  return { kills: n(kills), level: n(level), timeSurvived: n(time), victory: vic === '1' };
}

// ---------- Локальная таблица ----------

function readLocal(): NewScore[] {
  try {
    const raw = window.localStorage.getItem(LS_RECORDS);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x): x is NewScore => !!x && typeof (x as NewScore).score === 'number')
      .sort((a, b) => b.score - a.score)
      .slice(0, LOCAL_LIMIT);
  } catch {
    return [];
  }
}

function writeLocal(list: NewScore[]): void {
  try {
    window.localStorage.setItem(LS_RECORDS, JSON.stringify(list.slice(0, LOCAL_LIMIT)));
  } catch {
    // приватный режим — просто не сохраняем
  }
}

/** Всегда держит локальную копию, чтобы зал не пустовал при ошибке сети. */
function pushLocal(score: NewScore): void {
  const list = readLocal();
  const same = list.find(
    (r) => r.score === score.score && r.name === score.name && r.kills === score.kills,
  );
  if (!same) list.push(score);
  writeLocal(list.sort((a, b) => b.score - a.score));
}

function localEntries(victoryOnly: boolean): ScoreEntry[] {
  return readLocal()
    .filter((r) => (victoryOnly ? r.victory : true))
    .slice(0, LOCAL_LIMIT)
    .map((r, i) => ({ rank: i + 1, ...r, online: false }));
}

// ---------- Публичное API ----------

export interface SaveResult {
  /** Ушло ли в общий зал Яндекса. */
  online: boolean;
  /** Человекочитаемая причина, если online === false. */
  reason?: 'guest' | 'error';
}

/**
 * Сохраняет результат матча. Всегда пишет в локальную таблицу; в общий зал
 * отправляет только авторизованным — иначе SDK вернёт ошибку.
 */
export async function submitScore(score: NewScore): Promise<SaveResult> {
  pushLocal(score);
  cache = null;

  if (!isOnYandex()) return { online: false, reason: 'guest' };
  if (!isAuthorized()) return { online: false, reason: 'guest' };

  const sdk = getSdk();
  if (!sdk) return { online: false, reason: 'guest' };

  try {
    if (await sdk.isAvailableMethod('leaderboards.setScore')) {
      await sdk.leaderboards.setScore(LEADERBOARD_ID, Math.max(0, Math.floor(score.score)), encodeExtra(score));
      return { online: true };
    }
    return { online: false, reason: 'error' };
  } catch (err) {
    // Не повод ломать игрокам экран: результат уже сохранён локально
    console.warn('[leaderboard] setScore не удался:', err);
    return { online: false, reason: 'error' };
  }
}

export interface TopResult {
  entries: ScoreEntry[];
  /** Из какого источника показан зал. */
  online: boolean;
}

/**
 * Отдаёт зал славы. Фильтр побед применяется на клиенте: фильтров на стороне
 * Яндекса нет, а запросить таблицу дважды ради фильтра нельзя — лимит частоты.
 */
export async function topScores(limit = LOCAL_LIMIT, victoryOnly = false): Promise<TopResult> {
  if (isOnYandex() && isAuthorized()) {
    if (!cache || Date.now() - cache.at > CACHE_MS) {
      const entries = await fetchOnline(limit);
      if (entries) cache = { at: Date.now(), entries };
    }
    if (cache) {
      return {
        entries: cache.entries.filter((e) => (victoryOnly ? e.victory : true)).slice(0, limit),
        online: true,
      };
    }
  }
  return { entries: localEntries(victoryOnly), online: false };
}

async function fetchOnline(limit: number): Promise<ScoreEntry[] | null> {
  const sdk = getSdk();
  if (!sdk) return null;
  try {
    if (!(await sdk.isAvailableMethod('leaderboards.getEntries'))) return null;
    const res = await sdk.leaderboards.getEntries(LEADERBOARD_ID, {
      quantityTop: Math.min(20, Math.max(1, limit)),
      includeUser: true,
      quantityAround: 3,
    });
    return (res.entries ?? []).map((e, i) => ({
      rank: e.rank || i + 1,
      name: e.player?.publicName ?? '—',
      score: e.score ?? 0,
      ...decodeExtra(e.extraData),
      online: true,
    }));
  } catch (err) {
    console.warn('[leaderboard] getEntries не удался:', err);
    return null;
  }
}

/** Можно ли игроку вообще попасть в общий зал (для подсказки в меню). */
export function onlineAvailable(): boolean {
  return isOnYandex() && isAuthorized();
}

/** Сбрасывает кэш и локальные записи. Только для отладочных прогонов. */
export function resetRecords(): void {
  cache = null;
  try {
    window.localStorage.removeItem(LS_RECORDS);
  } catch {
    // игнорируем
  }
}