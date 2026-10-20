// ============ Точка входа «Последний герой: Средневековое выживание» ============
// Нативный Phaser: никакого React/Next. Страница отдаёт контейнер #game,
// здесь мы инициализируем площадку, дожидаемся шрифта, поднимаем игру и
// убираем загрузочный экран из index.html.

import './styles.css';
import Phaser from 'phaser';
import type { createGame as CreateGame } from './game/config';
import { audio } from './game/systems/Audio';
import { installTextDefaults } from './game/systems/Text';
import { initSdk, isOnYandex, getSdk } from './platform/sdk';
import { initPayments } from './platform/payments';
import { initAnalytics, exportBuffer } from './platform/analytics';
import { loadPlayer } from './platform/player';
import { detectLanguage, t } from './i18n';
import { installLifecycle, setLifecycleHandlers, gameplayStop } from './platform/lifecycle';
import type { GameScene } from './game/scenes/GameScene';

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
 * первый кадр уезжает на системный шрифт. Не блокируем запуск дольше 2.5 с.
 *
 * Шрифт нарезан на три подмножества (латиница, кириллица, латиница-расширение),
 * и `document.fonts.load(font)` без образца текста подгружает только то
 * подмножество, в которое попал пробел, — то есть латиницу. Кириллица
 * оставалась незагруженной: Phaser мерял русские строки системным
 * моноширинным шрифтом (уже, чем пиксельный), и подписи вылезали за
 * кнопки, а логотип не влезал в экран телефона. Поэтому образец текста
 * должен покрывать все три диапазона.
 */
const FONT_SAMPLE =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789' +
  'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя' +
  'ĀāĂăŚśŹźŽžŸ€«»—…№';

async function waitForFont(): Promise<void> {
  try {
    if (typeof document !== 'undefined' && document.fonts) {
      await Promise.race([
        Promise.all([
          document.fonts.load('16px "Pixelify Sans"', FONT_SAMPLE),
          document.fonts.load('700 16px "Pixelify Sans"', FONT_SAMPLE),
        ]).then(() => document.fonts.ready),
        new Promise((resolve) => setTimeout(resolve, 2500)),
      ]);
    }
  } catch {
    // document.fonts недоступен — Phaser откатится на fallback из FONT
  }
}

function removeBootScreen(): void {
  document.getElementById(BOOT_ID)?.remove();
}

/**
 * Dev-выгрузка телеметрии (TZ §K.1): `?export` скачивает JSON-буфер событий.
 * Только для dev-сборок — в релизе параметр игнорируется.
 */
function maybeExportTelemetry(): void {
  if (!import.meta.env.DEV) return;
  if (!new URLSearchParams(window.location.search).has('export')) return;
  const blob = new Blob([exportBuffer()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tss-telemetry-${Date.now()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * ID счётчика Яндекс Метрики (§K.1 — единственный канал «в облако»).
 *
 * Берётся из `VITE_YM_ID` на этапе сборки. Без него `track()` писал только
 * в локальный буфер Player Data, а весь раздел §K.2 (воронки FTUE, осады,
 * задания, A/B) оставался недоступным для анализа.
 */
const YM_COUNTER_ID: number = (() => {
  const raw = import.meta.env.VITE_YM_ID;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : NaN;
})();

/**
 * Если игра не смонтировалась за отведённое время, надпись «Загружаем игру...»
 * оставалась на экране навсегда — без причины и без возможности что-то сделать.
 * Показываем, что именно сломалось, и даём перезагрузить страницу.
 */
function showBootError(message: string): void {
  const boot = document.getElementById(BOOT_ID);
  if (!boot || boot.classList.contains('error')) return;
  boot.classList.add('error');
  const text = document.getElementById('boot-text');
  if (text) text.textContent = message;

  const retry = document.createElement('button');
  retry.className = 'retry';
  retry.type = 'button';
  retry.textContent = t('boot.retry');
  retry.addEventListener('click', () => window.location.reload());
  boot.appendChild(retry);
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
  // Страховка: экран загрузки не исчезнет сам по себе, если модуль игры не
  // приедет (медленная сеть, сбой CDN) или BootScene не отрисовался.
  // Таймер ставим ДО динамического импорта: иначе при зависшем импорте
  // игрок висел бы на «Загружаем игру…» бесконечно и без кнопки перезагрузки.
  window.setTimeout(() => {
    const boot = document.getElementById(BOOT_ID);
    if (boot && !boot.classList.contains('error')) {
      showBootError('Загрузка не завершилась — попробуйте перезагрузить страницу');
    }
  }, 45_000);

  const startLang = await detectLanguage();
  document.documentElement.lang = startLang === 'en' ? 'en' : 'ru';

  await initSdk();
  await detectLanguage(getSdk()?.environment.i18n.lang);

  setLifecycleHandlers({
    silence: () => audio.silence(),
    unsilence: () => audio.unsilence(),
    // П. 1.19.4: площадка сворачивает игру — геймплей обязан встать на паузу,
    // а не просто замолчать. Иначе игрок теряет здоровье, пока открыт каталог.
    pause: () => {
      const sc = window.__tss?.scene.getScene('Game') as (GameScene & { platformResume(): void }) | null;
      if (sc && sc.scene.isActive()) { gameplayStop(); sc.scene.pause(); }
    },
    resume: () => {
      const sc = window.__tss?.scene.getScene('Game') as (GameScene & { platformResume(): void }) | null;
      sc?.platformResume?.();
    },
  });
  installLifecycle();

  // T0 аналитики (§K.1): шина поднимается до любых механик — session_start
  // уходит первым, sessionIdx проставляется всем событиям сессии.
  initAnalytics({
    dev: import.meta.env.DEV,
    ymId: Number.isFinite(YM_COUNTER_ID) ? YM_COUNTER_ID : undefined,
  });
  maybeExportTelemetry();
  // §J.6.1 (1.13.1): платёжный слой + консумирование необработанных покупок —
  // ДО первого purchase() и до старта сцен. Вне Яндекса — no-op заглушка.
  if (isOnYandex()) await initPayments();

  if (isOnYandex()) await loadPlayer();

  await waitForFont();

  // Правила типографики (шрифт игры, целый кегль, двойная растеризация)
  // включаются до создания сцен: иначе первые экраны нарисовались бы
  // системным шрифтом и остались бы такими до перезапуска.
  installTextDefaults();

  const { createGame } = await import('./game/config');
  start(createGame);
};

boot().catch((err: unknown) => {
  // Любая ошибка на старте (например, недоступен модуль) раньше просто
  // оставляла надпись «Загружаем игру...» навсегда.
  console.error('[boot] игра не запустилась:', err);
  showBootError('Не удалось запустить игру — обновите страницу');
});

// Dev-сервер: полная перезагрузка страницы при изменении кода игры.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    window.__tss?.destroy(true);
    window.__tss = undefined;
  });
}