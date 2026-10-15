// ============ Жизненный цикл на площадке ============
// Обязательные точки интеграции Yandex Games:
//   • п. 1.19.2 — LoadingAPI.ready() ровно тогда, когда игрок может начать играть;
//   • п. 1.19.3 — GameplayAPI.start()/stop() вокруг активного геймплея;
//   • п. 1.19.4 — события game_api_pause / game_api_resume;
//   • п. 1.3     — при потере фокуса звук должен замолчать;
//   • п. 1.6.1.8 / 1.6.2.7 — контекстное меню браузера на игровом поле запрещено.
// Всё это работает и вне Яндекса: часть вызовов — no-op, часть нужна в любом
// окружении (звук при потере фокуса, запрет контекстного меню).

import { getSdk, isOnYandex } from './sdk';

/** Что делать при паузе/возобновлении — задаётся игрой через setLifecycleHandlers. */
export interface LifecycleHandlers {
  /** Глушить звук (обязательно при потере фокуса). */
  silence: () => void;
  /** Вернуть звук. */
  unsilence: () => void;
  /** Заморозить игровую логику (сворачивание вкладки, реклама). */
  pause: () => void;
  /** Разморозить. */
  resume: () => void;
}

const noop = (): void => {};

let handlers: LifecycleHandlers = { silence: noop, unsilence: noop, pause: noop, resume: noop };

/** Счётчик пауз площадки: события могут приходить чаще, чем их обрабатывают. */
let platformPaused = 0;

export function setLifecycleHandlers(next: Partial<LifecycleHandlers>): void {
  handlers = { ...handlers, ...next };
}

let readySent = false;
let gameplayRunning = false;

// ---------- Площадка ----------

/**
 * Сообщаем площадке, что игрок уже может нажать «Играть».
 * Требование 1.19.2: вызывать в момент готовности, не раньше и не позже —
 * модерация проверяет этот вызов отдельным пунктом.
 */
export function notifyReady(): void {
  if (readySent) return;
  readySent = true;
  getSdk()?.features.LoadingAPI.ready();
}

/** Начало активного геймплея (бой идёт). */
export function gameplayStart(): void {
  if (gameplayRunning) return;
  gameplayRunning = true;
  getSdk()?.features.GameplayAPI.start();
}

/** Конец активного геймплея (пауза, левел-ап, меню, конец матча). */
export function gameplayStop(): void {
  if (!gameplayRunning) return;
  gameplayRunning = false;
  getSdk()?.features.GameplayAPI.stop();
}

// ---------- Браузерные события ----------

let hidden = false;

/** При уходе вкладки из фокуса игнорируем паузу от самой платформы. */
function syncSilent(): void {
  if (hidden) handlers.silence();
  else handlers.unsilence();
}

/**
 * Вешает слушатели браузера и SDK. Вызывается один раз при старте игры.
 */
export function installLifecycle(): void {
  if (typeof window === 'undefined') return;

  const onHidden = (): void => {
    hidden = document.visibilityState === 'hidden';
    syncSilent();
  };
  const onBlur = (): void => {
    hidden = true;
    syncSilent();
  };
  const onFocus = (): void => {
    hidden = document.visibilityState === 'hidden';
    syncSilent();
  };

  document.addEventListener('visibilitychange', onHidden);
  window.addEventListener('blur', onBlur);
  window.addEventListener('focus', onFocus);

  // Требование 1.6: долгое нажатие / правый клик не должны открывать
  // системное меню поверх игры.
  const killMenu = (e: Event): void => e.preventDefault();
  window.addEventListener('contextmenu', killMenu);
  document.addEventListener('gesturestart', killMenu);

  if (isOnYandex()) bindSdkEvents();
}

function bindSdkEvents(): void {
  const sdk = getSdk();
  if (!sdk) return;

  // Площадка сворачивает игру (например, показывает другой элемент каталога).
  // П. 1.19.4: на это время геймплей обязан быть на паузе, а не просто
  // заглушенным — иначе игрок теряет здоровье, пока смотрит каталог.
  sdk.on('game_api_pause', () => {
    platformPaused++;
    handlers.silence();
    if (platformPaused === 1) handlers.pause();
  });
  sdk.on('game_api_resume', () => {
    if (platformPaused === 0) return;
    platformPaused--;
    if (platformPaused === 0) handlers.resume();
    if (!hidden) handlers.unsilence();
  });
}

/** Идёт ли сейчас активный геймплей (для отладки и тестов). */
export function isGameplayRunning(): boolean {
  return gameplayRunning;
}

/** Запрашивает ли площадка сейчас паузу. */
export function isPlatformPaused(): boolean {
  return platformPaused > 0;
}