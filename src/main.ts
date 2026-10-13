// ============ Точка входа Tiny Sword Survivors ============
// Нативный Phaser: никакого React/Next. Страница отдаёт контейнер #game,
// здесь мы инициализируем площадку, дожидаемся шрифта, поднимаем игру и
// убираем загрузочный экран из index.html.

import './styles.css';
import Phaser from 'phaser';
import type { createGame as CreateGame } from './game/config';
import { audio } from './game/systems/Audio';
import { initSdk, isOnYandex, getSdk } from './platform/sdk';
import { loadPlayer } from './platform/player';
import { detectLanguage } from './i18n';
import { installLifecycle, setLifecycleHandlers } from './platform/lifecycle';

/** Контейнер канваса — см. index.html */
const HOST_ID = 'game';
/** Загрузочный экран из index.html, удаляется после старта игры */
const BOOT_ID = 'boot';

declare global {
  interface Window {
    /** Debug-хук для автоматического тестирования (agent-browser QA) */
    __tss?: Phaser.Game;
  }
}

/**
 * Ждём загрузку пиксельного шрифта: Phaser рисует им весь UI, и без этого
 * первый кадр уезжает на системный шрифт. Не блокируем запуск дольше 1.2 с.
 */
async function waitForFont(): Promise<void> {
  try {
    await Promise.race([
      document.fonts.load('16px "Pixelify Sans"'),
      new Promise((resolve) => setTimeout(resolve, 1200)),
    ]);
  } catch {
    // document.fonts недоступен — Phaser откатится на fallback из FONT
  }
}

function removeBootScreen(): void {
  document.getElementById(BOOT_ID)?.remove();
}

function start(createGame: typeof CreateGame): void {
  const host = document.getElementById(HOST_ID);
  if (!host) throw new Error(`#${HOST_ID} не найден в index.html`);

  const game = createGame(host);
  window.__tss = game;

  // Экран загрузки снимаем, когда BootScene реально отрисовал первый кадр:
  // раньше на его месте мигает пустой синий фон.
  game.events.once(Phaser.Core.Events.READY, removeBootScreen);
}

/**
 * Порядок старта важен для модерации Yandex Games:
 *   1. определить язык по браузеру — п. 2.14 требует автоопределения при
 *      запуске, до того как игрок увидит текст;
 *   2. поднять SDK и уточнить язык по данным площадки;
 *   3. ТОЛЬКО ПОТОМ импортировать игру: словари в data.ts вычисляются на этапе
 *      импорта, и при поздней смене языка там остался бы русский текст;
 *   4. повесить обработчики потери фокуса — п. 1.3, звук должен замолкать
 *      даже если игрок уйдёт со страницы загрузки.
 */
const boot = async (): Promise<void> => {
  await detectLanguage();

  await initSdk();
  await detectLanguage(getSdk()?.environment.i18n.lang);

  setLifecycleHandlers({
    silence: () => audio.silence(),
    unsilence: () => audio.unsilence(),
  });
  installLifecycle();

  if (isOnYandex()) await loadPlayer();

  await waitForFont();

  const { createGame } = await import('./game/config');
  start(createGame);
};

void boot();

// Dev-сервер: полная перезагрузка страницы при изменении кода игры.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    window.__tss?.destroy(true);
    window.__tss = undefined;
  });
}