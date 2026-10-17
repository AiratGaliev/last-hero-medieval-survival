// ============ Таблица рекордов ============
// Гибрид по требованиям платформы:
//   • авторизованные игроки попадают в общий зал через ysdk.leaderboards;
//   • гости видят локальную таблицу на своём устройстве.
// Гостей SDK в общий зал не пускает принципиально (метод setScore доступен
// только авторизованным), поэтому локальный список нужен в любом случае —
// он же служит резервом, если запрос к SDK не удался.
//
// Мультиборды (фаза Q): кроме основного зала есть технические таблицы
// «вызов дня» и «бесконечный режим». Все методы параметризованы boardId;
// локальные записи основного борда по-прежнему лежат в 'tss-records'
// (совместимость со старыми сохранениями), остальные — в отдельных ключах.
//
// Частые методы лидерборда ограничены по частоте (getEntries — 20 запросов
// за 5 минут), поэтому ответ кэшируем на короткое время — отдельно на борд.

import { getSdk, isOnYandex } from './sdk';
import { loadJson, saveJson } from '../game/storage';
import { isAuthorized, LEADERBOARD_ID } from './player';

/** Техническое имя таблицы «вызов дня» (создаётся в Консоли Яндекса). */
export const LEADERBOARD_DAILY = 'tss_daily';
/** Техническое имя таблицы «бесконечный режим» (создаётся в Консоли Яндекса). */
export const LEADERBOARD_ENDLESS = 'tss_endless';

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

/** Кэш ответа SDK по каждому борду, чтобы не упираться в лимит частоты. */
const CACHE_MS = 60_000;
const cacheByBoard = new Map<string, { at: number; entries: ScoreEntry[] }>();

/** Локальный ключ таблицы борда: основной сохраняет старый ключ целиком. */
function localKeyFor(boardId: string): string {
  return boardId === LEADERBOARD_ID ? LS_RECORDS : `${LS_RECORDS}-${boardId}`;
}

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

// ---------- Локальная таблица (параметризована бордом) ----------

const int = (v: unknown): number => Math.max(0, Math.floor(Number(v) || 0));
const str = (v: unknown, max: number): string =>
  (typeof v === 'string' ? v : '').slice(0, max);

/** Приводит запись к корректному виду; битые поля заменяет безопасными значениями. */
function sanitizeEntry(x: unknown): NewScore {
  const o = (x ?? {}) as Partial<NewScore>;
  return {
    name: str(o.name, 24) || '—',
    score: int(o.score),
    kills: int(o.kills),
    level: int(o.level),
    timeSurvived: int(o.timeSurvived),
    victory: o.victory === true,
  };
}

function readLocal(key: string): NewScore[] {
  const arr = loadJson<unknown[]>(key);
  if (!Array.isArray(arr)) return [];
  return arr
    // Запись без числового счёта — мусор: её не с чем сортировать
    .filter((x) => !!x && typeof (x as NewScore).score === 'number')
    .map(sanitizeEntry)
    .sort((a, b) => b.score - a.score)
    .slice(0, LOCAL_LIMIT);
}

function writeLocal(list: NewScore[], key: string): void {
  saveJson(key, list.slice(0, LOCAL_LIMIT));
}

/** Всегда держит локальную копию, чтобы зал не пустовал при ошибке сети. */
function pushLocal(score: NewScore, key: string): void {
  const list = readLocal(key);
  const same = list.find(
    (r) => r.score === score.score && r.name === score.name && r.kills === score.kills,
  );
  if (!same) list.push(score);
  writeLocal(list.sort((a, b) => b.score - a.score), key);
}

function localEntries(victoryOnly: boolean, key: string): ScoreEntry[] {
  return readLocal(key)
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
 *
 * boardId отличен от основного — запись уходит в техническую таблицу
 * (вызов дня, бесконечный режим), локальная копия ведётся отдельно.
 */
export async function submitScore(raw: NewScore, boardId: string = LEADERBOARD_ID): Promise<SaveResult> {
  const score: NewScore = {
    ...sanitizeEntry(raw),
    victory: raw.victory === true,
  };
  pushLocal(score, localKeyFor(boardId));
  cacheByBoard.delete(boardId);

  if (!isOnYandex()) return { online: false, reason: 'guest' };
  if (!isAuthorized()) return { online: false, reason: 'guest' };

  const sdk = getSdk();
  if (!sdk) return { online: false, reason: 'guest' };

  try {
    if (await sdk.isAvailableMethod('leaderboards.setScore')) {
      await sdk.leaderboards.setScore(boardId, Math.max(0, Math.floor(score.score)), encodeExtra(score));
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
 * Кэш ведётся отдельно на каждый борд.
 */
export async function topScores(
  limit = LOCAL_LIMIT,
  victoryOnly = false,
  boardId: string = LEADERBOARD_ID,
): Promise<TopResult> {
  if (isOnYandex() && isAuthorized()) {
    const stale = cacheByBoard.get(boardId);
    if (!stale || Date.now() - stale.at > CACHE_MS) {
      const entries = await fetchOnline(limit, boardId);
      if (entries) cacheByBoard.set(boardId, { at: Date.now(), entries });
    }
    const fresh = cacheByBoard.get(boardId);
    if (fresh) {
      return {
        entries: fresh.entries.filter((e) => (victoryOnly ? e.victory : true)).slice(0, limit),
        online: true,
      };
    }
  }
  return { entries: localEntries(victoryOnly, localKeyFor(boardId)), online: false };
}

async function fetchOnline(limit: number, boardId: string): Promise<ScoreEntry[] | null> {
  const sdk = getSdk();
  if (!sdk) return null;
  try {
    if (!(await sdk.isAvailableMethod('leaderboards.getEntries'))) return null;
    const res = await sdk.leaderboards.getEntries(boardId, {
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
/** Сбрасывает кэш и локальные записи. Только для отладочных прогонов. */
