// ============ Безопасный доступ к localStorage ============
//
// localStorage бросает исключения в приватном режиме Safari и когда
// хранилище запрещено политикой браузера. Раньше чтение выбора героя и,
// что хуже, запись в обработчике кнопки «Играть» шли напрямую — при
// заблокированном хранилище исключение вылетало из create() или из
// обработчика, и игру было невозможно запустить вообще.
//
// Здесь каждая операция обёрнута, а чтение всегда возвращает строку
// либо null — вызывающему не нужно знать про try/catch.

const PREFIX = 'tss-';

let available: boolean | null = null;

/** Есть ли доступ к хранилищу (проверяется один раз, результат кэшируется). */
export function storageAvailable(): boolean {
  if (available !== null) return available;
  try {
    const probe = `${PREFIX}probe`;
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    available = true;
  } catch {
    available = false;
  }
  return available;
}

function full(key: string): string {
  return key.startsWith(PREFIX) ? key : PREFIX + key;
}

/** Читает строку; при любой ошибке возвращает null (игра продолжает работать). */
export function loadText(key: string): string | null {
  try {
    return window.localStorage.getItem(full(key));
  } catch {
    return null;
  }
}

/** Пишет строку; при ошибке молча возвращает false. */
export function saveText(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(full(key), value);
    return true;
  } catch {
    return false;
  }
}

/** Читает и разбирает JSON; битое или отсутствующее значение даёт null. */
export function loadJson<T>(key: string): T | null {
  const raw = loadText(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Повреждённое значение не должно ломать игру: молча начинаем с нуля.
    return null;
  }
}

/** Сериализует и пишет JSON; при ошибке возвращает false. */
export function saveJson(key: string, value: unknown): boolean {
  try {
    return saveText(key, JSON.stringify(value));
  } catch {
    return false;
  }
}

/** Удаляет ключ; при ошибке ничего не делает. */
export function removeKey(key: string): void {
  try {
    window.localStorage.removeItem(full(key));
  } catch {
    // ключ не существует или хранилище недоступно — не критично
  }
}