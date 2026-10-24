// ============ Идл-троттлинг рендера стационарных сцен ============
//
// CDP-профиль меню: ~93% времени кадра — нативный рендер (GL-драйвер +
// композитор), игровой JS — единицы процентов. В статичных сценах достаточно
// 15 fps в простое; любой пользовательский ввод немедленно возвращает 60.
//
// Phaser.Game.loop.setFPSLimit — глобальная настройка цикла, а не отдельной
// сцены. Поэтому все стационарные сцены на странице используют один
// координатор: закрытие одного оверлея не должно отменять экономный режим
// другого активного экрана.
//
// Слушатели стоят на window (не на Phaser-инпуте): Phaser разберёт событие
// только на очередном шаге, а проснуться нужно ДО отрисовки следующего кадра.

import type Phaser from 'phaser';

/** Порог плавности: облака/пульс чипа на 15 fps остаются читаемыми. */
export const IDLE_FPS = 15;
/** Через столько без ввода включается экономия. */
export const IDLE_DELAY_MS = 1500;

const EVENTS = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
const activeScenes = new Set<Phaser.Scene>();

type GameLoop = Pick<Phaser.Game['loop'], 'setFPSLimit'>;

let loop: GameLoop | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let currentLimit: number | undefined;
let listenersAttached = false;

function setLimit(fps: number): void {
  if (!loop || currentLimit === fps) return;
  currentLimit = fps;
  loop.setFPSLimit(fps);
}

function wake(): void {
  if (!loop) return;
  if (idleTimer !== undefined) clearTimeout(idleTimer);
  setLimit(60);
  idleTimer = setTimeout(() => {
    idleTimer = undefined;
    if (activeScenes.size > 0) setLimit(IDLE_FPS);
  }, IDLE_DELAY_MS);
}

function detachListeners(): void {
  if (!listenersAttached) return;
  for (const event of EVENTS) window.removeEventListener(event, wake);
  listenersAttached = false;
}

function releaseCoordinator(): void {
  if (activeScenes.size > 0) return;

  if (idleTimer !== undefined) clearTimeout(idleTimer);
  idleTimer = undefined;
  detachListeners();
  setLimit(60);
  loop = undefined;
  currentLimit = undefined;
}

/**
 * Ставит сцену на экономный рендер в простое.
 *
 * Вызывать только в сценах, где игровой мир остановлен: Menu, Pause,
 * LevelUp, GameOver, Succession, Shop и Meta. Не подключать к GameScene:
 * её симуляция должна сохранять штатный темп во время активного матча.
 *
 * У Phaser.Game один глобальный цикл, поэтому параллельные сцены должны
 * разделять таймер и управление FPS. Пока жива хотя бы одна зарегистрированная
 * сцена, её закрытие не сбрасывает idle-режим остальных.
 */
export function armIdleThrottle(scene: Phaser.Scene): void {
  if (activeScenes.has(scene)) return;

  if (activeScenes.size === 0) {
    loop = scene.game.loop;
    currentLimit = undefined;
    for (const event of EVENTS) window.addEventListener(event, wake, { passive: true });
    listenersAttached = true;
  }

  activeScenes.add(scene);
  wake();

  scene.events.once('shutdown', () => {
    if (!activeScenes.delete(scene)) return;
    releaseCoordinator();
  });
}
