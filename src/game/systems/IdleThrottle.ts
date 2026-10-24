// ============ Идл-троттлинг рендера стационарных сцен ============
//
// CDP-профиль меню: ~93% времени кадра — нативный рендер (GL-драйвер +
// композитор), игровой JS — единицы процентов. Работу делает сам факт
// отрисовки полного кадра 60 раз в секунду. В статичных сценах (меню, пауза,
// оверлеи-карточки) достаточно 15 fps в простое — экономия ~75% кадров;
// любой ввод мгновенно возвращает 60.
//
// Слушатели стоят на window (не на Phaser-инпуте): Phaser разберёт событие
// только на очередном шаге, а проснуться нужно ДО отрисовки следующего кадра.

import Phaser from 'phaser';

/** Порог плавности: облака/пульс чипа на 15 fps остаются читаемыми. */
export const IDLE_FPS = 15;
/** Через столько без ввода включается экономия. */
export const IDLE_DELAY_MS = 1500;

const EVENTS = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

/**
 * Ставит сцену на экономный рендер в простое.
 *
 * Важно: сцены-оверлеи живут поверх paused GameScene, которая продолжает
 * рендериться. Троттлинг нельзя ставить на сам GameScene — он должен тикать
 * 60 fps всё время матча. Ставить только на те сцены, где геймплей остановлен:
 * Menu, Pause, LevelUp, GameOver, Succession, Shop, Meta.
 */
export function armIdleThrottle(scene: Phaser.Scene): void {
  const loop = scene.game.loop;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastLimit = 0;
  const limit = (fps: number): void => {
    if (lastLimit === fps) return;
    lastLimit = fps;
    loop.setFPSLimit(fps);
  };
  const wake = (): void => {
    clearTimeout(timer);
    limit(60);
    timer = setTimeout(() => limit(IDLE_FPS), IDLE_DELAY_MS);
  };
  for (const ev of EVENTS) window.addEventListener(ev, wake, { passive: true });
  wake();
  scene.events.once('shutdown', () => {
    clearTimeout(timer);
    for (const ev of EVENTS) window.removeEventListener(ev, wake);
    limit(60);
  });
}
