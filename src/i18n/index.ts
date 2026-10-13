// ============ Определение языка и переводы ============
// Требование Yandex Games 2.14: игра обязана сама определять язык при запуске
// и делать это ДО того, как игрок увидит текст. Отдельного ручного
// переключателя нет — площадка рекомендует автоопределение.
//
// Словари грузятся динамическим import: в бандл попадает только текущий
// язык, а второй не тащит игрока на старте. Русский импортируется статически —
// он нужен как запасной вариант (и как источник типов).

import { ru, type TranslationKey } from './ru';

export type Lang = 'ru' | 'en';
type Dict = Record<TranslationKey, string>;

/** Какими языками владеет игра. */
const SUPPORTED: Lang[] = ['ru', 'en'];

let current: Lang = 'ru';
let dict: Dict = ru as unknown as Dict;

/** Нормализует код вида `ru-RU`, `en-GB`, `uk` к нашему набору. */
export function normalize(raw: string | null | undefined): Lang | null {
  if (!raw) return null;
  const base = raw.toLowerCase().split(/[-_]/)[0];
  return (SUPPORTED as string[]).includes(base) ? (base as Lang) : null;
}

function browserLanguage(): Lang | null {
  if (typeof navigator === 'undefined') return null;
  const candidates = [navigator.language, ...(navigator.languages ?? [])];
  for (const c of candidates) {
    const hit = normalize(c);
    if (hit) return hit;
  }
  return null;
}

/**
 * Явный выбор языка через ?lang=en. Нужен для проверки перевода, не для
 * игроков: площадка определяет язык сама, а переключателя в игре нет.
 * Работает и внутри песочницы, и локально.
 */
function overrideLanguage(): Lang | null {
  if (typeof window === 'undefined') return null;
  try {
    return normalize(new URLSearchParams(window.location.search).get('lang'));
  } catch {
    return null;
  }
}

/** Активный язык. */
export function lang(): Lang {
  return current;
}

/** BCP-47 тег для форматирования чисел. */
export function locale(): string {
  return current === 'en' ? 'en-US' : 'ru-RU';
}

async function loadDict(target: Lang): Promise<void> {
  if (target === 'ru') {
    dict = ru as unknown as Dict;
    return;
  }
  const mod = await import('./en');
  dict = (mod.default ?? mod) as Dict;
}

/**
 * Определяет язык и загружает словарь. Вызывается ДО импорта игровых модулей:
 * словари в data.ts вычисляются на этапе импорта, и если язык сменится позже,
 * там останется русский текст.
 *
 * Сначала определяемся по браузеру (быстро, без мигания), затем уточняем по
 * данным SDK, если они пришли.
 */
export async function detectLanguage(sdkLang?: string | null): Promise<Lang> {
  current = overrideLanguage() ?? normalize(sdkLang) ?? browserLanguage() ?? 'ru';
  await loadDict(current);
  return current;
}

export type TranslateParams = Record<string, string | number>;

/**
 * Перевод по ключу с подстановками: t('over.score', { v: 15420 }).
 * Неизвестный ключ не должен ронять игру — возвращаем сам ключ, чтобы его
 * было видно в консоли.
 */
export function t(key: TranslationKey, params?: TranslateParams): string {
  const raw = dict[key] ?? (ru as unknown as Dict)[key] ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

/** Форматирование чисел под язык интерфейса (разделители разрядов). */
export function num(value: number): string {
  return Math.round(value).toLocaleString(locale());
}

/** «M:SS» — таймер матча и колонка времени в таблице рекордов. */
export function clock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export type { TranslationKey };