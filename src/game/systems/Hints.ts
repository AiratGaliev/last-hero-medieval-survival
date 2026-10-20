import Phaser from 'phaser';
import { DEPTH, FONT } from '../constants';
import { t } from '../../i18n';
import { track } from '../../platform/analytics';
import { loadJson, saveJson } from '../storage';
import { makePanel, resizePanel } from './Ui';

// ============ Движок подсказок FTUE (TZ §I.1) ============
//
// Учим действием, не текстом: подсказка появляется в момент мотива.
// Одна подсказка за раз, не чаще одной за 20 сек, скип кликом, одноразовые
// флаги. Форматы: `banner` (сверху, 4 сек) и `overlay` (пауза + объяснение).
// Отдельный tutorial-уровень не вводится.

export type HintId =
  | 'move' | 'pawns' | 'house' | 'barracks' | 'siege'
  | 'monastery' | 'orders' | 'veteran';

/** Формат показа (§I.1): banner — строка сверху, overlay — пауза с объяснением. */
export type HintUi = 'banner' | 'overlay';
export type HintAnchor = 'top' | 'center' | 'bottom';

export interface HintDef {
  id: HintId;
  /**
   * Приоритет очереди (§I.1): «угроза (осада) > возможность (стройка) >
   * знакомство (имена)». Меньше — важнее.
   */
  priority: number;
  ui: HintUi;
  /** Экранная привязка: позиция пересчитывается при resize. */
  anchor?: HintAnchor;
  /** Время жизни в мс (§I.1: banner — 4 сек). Overlay требует явного подтверждения. */
  ttl: number;
  /** Подсказка-исключение: показывается, минуя кулдаун очереди. */
  urgent?: boolean;
}

/**
 * Реестр подсказок (§I.1 «движок данных»). Ключи текста — `hint.{id}`.
 * Значения `priority` кодируют порядок раскрытия из сценария §I.2.
 */
export const HINTS: readonly HintDef[] = [
  { id: 'move', priority: 5, ui: 'overlay', anchor: 'center', ttl: 0 },
  { id: 'pawns', priority: 4, ui: 'banner', ttl: 4000 },
  { id: 'house', priority: 3, ui: 'banner', ttl: 4000 },
  { id: 'barracks', priority: 2, ui: 'banner', ttl: 4000 },
  { id: 'orders', priority: 3, ui: 'banner', ttl: 4000 },
  { id: 'monastery', priority: 2, ui: 'banner', ttl: 4000 },
  { id: 'veteran', priority: 1, ui: 'banner', ttl: 4000 },
  // Осада — единственная «угроза»: показывается первой и минует кулдаун.
  { id: 'siege', priority: 0, ui: 'banner', ttl: 4000, urgent: true },
];

const HINT_BY_ID = new Map<HintId, HintDef>(HINTS.map((h) => [h.id, h]));

/** §I.1: «не чаще одной подсказки за 20 секунд». */
const COOLDOWN_MS = 20000;

export interface HintLayout {
  x: number;
  y: number;
  width: number;
  textWidth: number;
  panelHeight: number;
}

/** Queue policy is exported to make urgency/cooldown behaviour regression-testable. */
export function canPresentHintAt(now: number, lastShownAt: number, urgent = false, cooldownMs = COOLDOWN_MS): boolean {
  return urgent || now - lastShownAt >= cooldownMs;
}

/** Safe, responsive screen-space coordinates shared by desktop and mobile. */
export function getHintLayout(width: number, height: number, ui: HintUi, anchor?: HintAnchor): HintLayout {
  const viewportWidth = Math.max(1, width);
  const viewportHeight = Math.max(1, height);
  const panelWidth = Math.max(160, Math.min(560, viewportWidth - 32));
  const panelHeight = ui === 'overlay' ? 120 : 44;
  const resolvedAnchor = anchor ?? (ui === 'overlay' ? 'center' : 'top');
  const y = resolvedAnchor === 'center'
    ? viewportHeight / 2
    : resolvedAnchor === 'bottom'
      ? Math.max(panelHeight / 2 + 8, viewportHeight - panelHeight / 2 - 24)
      : Math.min(92, Math.max(panelHeight / 2 + 8, viewportHeight / 2 - panelHeight / 2));
  return {
    x: viewportWidth / 2,
    y,
    width: panelWidth,
    textWidth: Math.max(120, panelWidth - 24),
    panelHeight,
  };
}

interface HintState { shown: HintId[]; enabled?: boolean }

export class Hints {
  private scene: Phaser.Scene;
  private shown = new Set<HintId>();
  // A new run's first hint must not inherit an artificial 20-second startup wait.
  private lastShownAt = -COOLDOWN_MS;
  /**
   * Слой подсказок с обратным зумом камеры.
   *
   * Игровая камера на телефоне отдалена (зум 0.55), и подсказка,
   * созданная прямо в сцене, рисовалась вместе с миром — то есть
   * 16-пиксельный текст превращался в 9 пикселей и не читался. Слой
   * компенсирует зум, как это делает HUD (systems/HUD.ts), и подсказка
   * всегда одного размера с экраном.
   */
  private layer!: Phaser.GameObjects.Container;
  private current: {
    id: HintId;
    ui: HintUi;
    text: Phaser.GameObjects.Text;
    bg: Phaser.GameObjects.NineSlice;
  } | null = null;
  private readonly onOverlayChange?: (paused: boolean) => void;
  /** Fallback на уровне сцены: касание overlay должно продолжать игру на mobile. */
  private overlayInputHandler: (() => void) | null = null;
  private readonly resizeHandler = (): void => this.relayoutCurrent();
  /**
   * Очередь отложенных подсказок (§I.1: «Новая подсказка откладывает
   * непрочитанную»). Раньше новая подсказка просто УНИЧТОЖАЛА текущую —
   * игрок терял половину обучения, и порядок зависел от того, какой триггер
   * сработал последним.
   */
  private queue: HintId[] = [];
  private enabled: boolean;

  constructor(scene: Phaser.Scene, onOverlayChange?: (paused: boolean) => void) {
    this.scene = scene;
    this.onOverlayChange = onOverlayChange;
    this.layer = scene.add.container(0, 0).setScrollFactor(0).setDepth(DEPTH.OVERLAY);
    this.applyZoom();
    const st = loadJson<HintState>('hints') ?? { shown: [] };
    for (const id of st.shown) if (HINT_BY_ID.has(id)) this.shown.add(id);
    this.enabled = st.enabled !== false;
    scene.scale.on('resize', this.resizeHandler);
    scene.events.once('shutdown', () => {
      if (this.overlayInputHandler) {
        scene.input.off('pointerdown', this.overlayInputHandler);
        this.overlayInputHandler = null;
      }
      if (this.current?.ui === 'overlay') this.onOverlayChange?.(false);
      this.current?.text.destroy();
      this.current?.bg.destroy();
      for (const extra of this.extra) extra?.destroy();
      this.current = null;
      this.extra = [];
      this.layer.destroy(true);
      scene.scale.off('resize', this.resizeHandler);
      this.save();
    });
  }

  /**
   * Компенсирует зум игровой камеры: содержимое слоя задаётся в экранных
   * координатах и рисуется в них же при любом зуме.
   */
  private applyZoom(): void {
    const z = this.scene.cameras.main.zoom || 1;
    const W = this.scene.scale.width;
    const H = this.scene.scale.height;
    this.layer.setScale(1 / z);
    this.layer.setPosition((W / 2) * (1 - 1 / z), (H / 2) * (1 - 1 / z));
  }

  /** §I.1 п.4: «Все подсказки отключаемы» — переключатель «Обучение: вкл/выкл». */
  setEnabled(v: boolean): void {
    this.enabled = v;
    if (!v) { this.hide(); this.queue = []; }
    this.save();
  }

  isEnabled(): boolean { return this.enabled; }

  private save(): void {
    saveJson('hints', { shown: [...this.shown], enabled: this.enabled } satisfies HintState);
  }

  /**
   * Поставить подсказку в очередь (§I.1). Показывается немедленно, только
   * если очередь пуста, прошёл кулдаун и нет подсказки важнее.
   */
  show(id: HintId): void {
    if (!this.enabled || this.shown.has(id)) return;
    if (this.queue.includes(id)) return;
    const def = HINT_BY_ID.get(id);
    if (!def) return;
    this.queue.push(id);
    this.queue.sort((a, b) => (HINT_BY_ID.get(a)?.priority ?? 9) - (HINT_BY_ID.get(b)?.priority ?? 9));
    this.pump();
  }

  /** Отдаёт следующую подсказку из очереди, если это уместно. */
  private pump(): void {
    if (!this.enabled || this.current || this.queue.length === 0) return;
    const id = this.queue[0];
    if (!id) return;
    const def = HINT_BY_ID.get(id);
    if (!def) { this.queue.shift(); this.pump(); return; }
    if (!canPresentHintAt(this.scene.time.now, this.lastShownAt, def.urgent)) return;
    this.queue.shift();
    this.present(id);
  }

  private present(id: HintId): void {
    const def = HINT_BY_ID.get(id);
    if (!def) return;
    this.shown.add(id);
    this.lastShownAt = this.scene.time.now;
    this.save();

    // Зум камеры мог измениться после создания подсказок (сцена собирает
    // их до resizeZoom), поэтому компенсацию обновляем каждый раз.
    this.applyZoom();

    const w = this.scene.scale.width;
    const h = this.scene.scale.height;
    const text = t(`hint.${id}` as `hint.${typeof id}`);
    track('hint_shown', { hint_id: id, ui: def.ui });

    // Overlay must pause the actual world and stay until the player explicitly continues.
    const layout = getHintLayout(w, h, def.ui, def.anchor);
    const dim = def.ui === 'overlay'
      ? this.scene.add.rectangle(w / 2, h / 2, w + 8, h + 8, 0x07070d, 0.62)
        .setScrollFactor(0).setDepth(9590)
      : null;

    const displayText = def.ui === 'overlay'
      ? `${text}\n\n${t('hint.tapToContinue')}`
      : text;
    // Подсказка — не «чёрный прямоугольник», а пергамент из набора
    // Tiny Swords: тот же материал, что у панелей и карточек. Ширина
    // подстраивается под текст, чтобы панель не была пустой.
    const label = this.scene.add.text(layout.x, layout.y, displayText, {
      fontFamily: FONT,
      fontSize: def.ui === 'overlay' ? '16px' : '14px',
      color: '#3b2410',
      align: 'center',
      wordWrap: { width: layout.textWidth },
    }).setOrigin(0.5).setDepth(9601);
    const panelW = Math.max(160, Math.min(layout.width, label.width + 40));
    const panelH = Math.max(def.ui === 'overlay' ? 120 : 44, label.height + 24);
    const panel = makePanel(this.scene, layout.x, layout.y, 'paper', panelW, panelH)
      .setScrollFactor(0)
      .setDepth(9600)
      .setInteractive({ useHandCursor: true });
    this.layer.add([dim, panel, label].filter(Boolean) as Phaser.GameObjects.GameObject[]);
    panel.on('pointerdown', () => this.hide(true));
    this.current = { id, ui: def.ui, text: label, bg: panel };
    if (dim) dim.on('pointerdown', () => this.hide(true));
    this.extra.push(dim);
    if (def.ui === 'overlay') {
      // Panel remains the primary target, but scaled container hit-testing may
      // miss a touch on some mobile profiles. Scene fallback closes it once.
      this.overlayInputHandler = () => this.hide(true);
      this.scene.input.on('pointerdown', this.overlayInputHandler);
      this.onOverlayChange?.(true);
    }
    else this.scene.time.delayedCall(def.ttl, () => this.hide());
  }

  private extra: Array<Phaser.GameObjects.Rectangle | null> = [];

  private relayoutCurrent(): void {
    const current = this.current;
    if (!current) return;
    const w = this.scene.scale.width;
    const h = this.scene.scale.height;
    const def = HINT_BY_ID.get(current.id);
    const layout = getHintLayout(w, h, current.ui, def?.anchor);
    this.applyZoom();
    const dim = this.extra[0];
    if (dim && current.ui === 'overlay') {
      dim.setPosition(w / 2, h / 2).setSize(w + 8, h + 8);
    }
    current.text.setPosition(layout.x, layout.y);
    current.text.setStyle({ wordWrap: { width: layout.textWidth } });
    const panelW = Math.max(160, Math.min(layout.width, current.text.width + 40));
    const panelH = Math.max(current.ui === 'overlay' ? 120 : 44, current.text.height + 24);
    current.bg.setPosition(layout.x, layout.y);
    resizePanel(current.bg, panelW, panelH);
  }

  private hide(byUser = false): void {
    const current = this.current;
    if (!current) return;
    track('hint_dismissed', { hint_id: current.id, source: byUser ? 'user' : 'ttl' });
    current.text.destroy();
    current.bg.destroy();
    this.current = null;
    for (const e of this.extra) e?.destroy();
    this.extra = [];
    if (current.ui === 'overlay') {
      if (this.overlayInputHandler) {
        this.scene.input.off('pointerdown', this.overlayInputHandler);
        this.overlayInputHandler = null;
      }
      this.onOverlayChange?.(false);
    }
    this.save();
    const next = this.queue[0];
    const nextIsUrgent = next ? HINT_BY_ID.get(next)?.urgent === true : false;
    const remainingCooldown = Math.max(0, COOLDOWN_MS - (this.scene.time.now - this.lastShownAt));
    this.scene.time.delayedCall(nextIsUrgent ? 0 : remainingCooldown, () => this.pump());
  }

  /** Сброс очереди без утечки overlay и без остановленного мира. */
  reset(): void {
    this.queue = [];
    this.hide(false);
  }
}