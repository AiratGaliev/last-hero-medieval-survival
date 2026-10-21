import Phaser from 'phaser';
import { DEPTH, FONT } from '../constants';
import { t } from '../../i18n';
import { track } from '../../platform/analytics';
import { loadJson, saveJson } from '../storage';
import { readPlayerDataEntry, writePlayerDataValue } from '../../platform/player';
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
/** Возвращает live-координаты цели в экранной системе HUD. */
export type HintTargetResolver = () => { x: number; y: number } | null;

interface HintRequest { id: HintId; target?: HintTargetResolver }

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
  // Ресурсный блок находится в левом верхнем углу: обучающий баннер
  // уходит вниз, чтобы не перекрывать цель, а стрелка ведёт к запасу дерева.
  { id: 'pawns', priority: 4, ui: 'banner', anchor: 'bottom', ttl: 4000 },
  { id: 'house', priority: 3, ui: 'banner', ttl: 4000 },
  { id: 'barracks', priority: 2, ui: 'banner', ttl: 4000 },
  { id: 'orders', priority: 3, ui: 'banner', ttl: 4000 },
  { id: 'monastery', priority: 2, ui: 'banner', ttl: 4000 },
  { id: 'veteran', priority: 1, ui: 'banner', ttl: 4000 },
  // Первая осада — приоритетный обучающий overlay: мир останавливается,
  // цель подсвечивается стрелкой, продолжение подтверждает сам игрок.
  { id: 'siege', priority: 0, ui: 'overlay', anchor: 'center', ttl: 0, urgent: true },
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

export interface HintArrowGeometry {
  startX: number;
  startY: number;
  targetX: number;
  targetY: number;
  leftX: number;
  leftY: number;
  rightX: number;
  rightY: number;
}

/** Чистая геометрия стрелки, доступная для регрессионных тестов без Phaser runtime. */
export function getHintArrowGeometry(
  panel: { x: number; y: number; width: number; height: number },
  target: { x: number; y: number },
  viewport: { width: number; height: number },
): HintArrowGeometry | null {
  if (![panel.x, panel.y, panel.width, panel.height, target.x, target.y, viewport.width, viewport.height]
    .every(Number.isFinite)) return null;

  const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
  const targetX = clamp(target.x, 10, Math.max(10, viewport.width - 10));
  const targetY = clamp(target.y, 10, Math.max(10, viewport.height - 10));
  const dx = targetX - panel.x;
  const dy = targetY - panel.y;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return null;

  const halfW = panel.width / 2 + 8;
  const halfH = panel.height / 2 + 8;
  const scaleX = Math.abs(dx) > 0 ? halfW / Math.abs(dx) : Number.POSITIVE_INFINITY;
  const scaleY = Math.abs(dy) > 0 ? halfH / Math.abs(dy) : Number.POSITIVE_INFINITY;
  const edgeScale = Math.min(scaleX, scaleY);
  if (edgeScale >= 1) return null;

  const startX = panel.x + dx * edgeScale;
  const startY = panel.y + dy * edgeScale;
  const angle = Math.atan2(targetY - startY, targetX - startX);
  const headLength = 9;
  const wing = 4.5;
  const baseX = targetX - Math.cos(angle) * headLength;
  const baseY = targetY - Math.sin(angle) * headLength;
  return {
    startX,
    startY,
    targetX,
    targetY,
    leftX: baseX - Math.sin(angle) * wing,
    leftY: baseY + Math.cos(angle) * wing,
    rightX: baseX + Math.sin(angle) * wing,
    rightY: baseY - Math.cos(angle) * wing,
  };
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

type FtueMarkerId = 'succession' | 'chronicle';

interface HintState {
  shown: HintId[];
  /** Одноразовые учебные блоки, которые рендерятся другими сценами. */
  markers: FtueMarkerId[];
  enabled: boolean;
  /** Версия состояния для выбора актуального переключателя между устройствами. */
  updatedAt: number;
}

const HINTS_PLAYER_DATA_KEY = 'tss-ftue-hints';
let hintsCloudReady = false;

function normalizeHintState(raw: unknown): HintState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { shown: [], markers: [], enabled: true, updatedAt: 0 };
  }
  const value = raw as Partial<HintState>;
  const shown = Array.isArray(value.shown)
    ? value.shown.filter((id): id is HintId => typeof id === 'string' && HINT_BY_ID.has(id as HintId))
    : [];
  const markers = Array.isArray(value.markers)
    ? value.markers.filter((marker): marker is FtueMarkerId =>
      marker === 'succession' || marker === 'chronicle')
    : [];
  return {
    shown: [...new Set(shown)],
    markers: [...new Set(markers)],
    enabled: value.enabled !== false,
    updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
      ? Math.max(0, value.updatedAt)
      : 0,
  };
}

/**
 * Восстанавливает состояние FTUE до создания сцен. Показанные подсказки
 * объединяются, а переключатель берётся из более свежей версии состояния.
 * При недоступности облака игра продолжает использовать localStorage.
 */
export async function hydrateHintsFromPlayerData(): Promise<void> {
  const localRaw = loadJson<unknown>('hints');
  const local = normalizeHintState(localRaw);
  const remoteResult = await readPlayerDataEntry(HINTS_PLAYER_DATA_KEY);
  hintsCloudReady = remoteResult.available;
  const remoteRaw = remoteResult.value;
  const remote = normalizeHintState(remoteRaw);
  const remoteExists = !!remoteRaw && typeof remoteRaw === 'object' && !Array.isArray(remoteRaw);
  const localExists = !!localRaw && typeof localRaw === 'object' && !Array.isArray(localRaw);
  const preferRemote = remoteExists && (!localExists || remote.updatedAt > local.updatedAt);
  const merged: HintState = {
    shown: [...new Set([...local.shown, ...remote.shown])],
    markers: [...new Set([...local.markers, ...remote.markers])],
    enabled: preferRemote ? remote.enabled : local.enabled,
    updatedAt: Math.max(Date.now(), local.updatedAt, remote.updatedAt),
  };
  saveJson('hints', merged);
  // Не затираем облачный прогресс после таймаута чтения: сначала требуется
  // подтверждённый ответ Player Data, даже если ответ означает пустое поле.
  if (hintsCloudReady) void writePlayerDataValue(HINTS_PLAYER_DATA_KEY, merged, true);
}

export class Hints {
  private scene: Phaser.Scene;
  private shown = new Set<HintId>();
  private markers = new Set<string>();
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
    target?: HintTargetResolver;
    arrow: Phaser.GameObjects.Graphics | null;
  } | null = null;
  private readonly onOverlayChange?: (paused: boolean) => void;
  /** Fallback на уровне сцены: касание overlay должно продолжать игру на mobile. */
  private overlayInputHandler: (() => void) | null = null;
  private readonly resizeHandler = (): void => this.relayoutCurrent();
  private readonly updateHandler = (): void => this.updateAnchor();
  /**
   * Очередь отложенных подсказок (§I.1: «Новая подсказка откладывает
   * непрочитанную»). Раньше новая подсказка просто УНИЧТОЖАЛА текущую —
   * игрок терял половину обучения, и порядок зависел от того, какой триггер
   * сработал последним.
   */
  private queue: HintRequest[] = [];
  private enabled: boolean;

  constructor(scene: Phaser.Scene, onOverlayChange?: (paused: boolean) => void) {
    this.scene = scene;
    this.onOverlayChange = onOverlayChange;
    this.layer = scene.add.container(0, 0).setScrollFactor(0).setDepth(DEPTH.OVERLAY);
    this.applyZoom();
    const st = normalizeHintState(loadJson<unknown>('hints'));
    for (const id of st.shown) this.shown.add(id);
    for (const marker of st.markers) this.markers.add(marker);
    this.enabled = st.enabled;
    scene.scale.on('resize', this.resizeHandler);
    scene.events.on('update', this.updateHandler);
    scene.events.once('shutdown', () => {
      if (this.overlayInputHandler) {
        scene.input.off('pointerdown', this.overlayInputHandler);
        this.overlayInputHandler = null;
      }
      if (this.current?.ui === 'overlay') this.onOverlayChange?.(false);
      this.current?.text.destroy();
      this.current?.bg.destroy();
      this.current?.arrow?.destroy();
      for (const extra of this.extra) extra?.destroy();
      this.current = null;
      this.extra = [];
      this.layer.destroy(true);
      scene.scale.off('resize', this.resizeHandler);
      scene.events.off('update', this.updateHandler);
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
    const state: HintState = {
      shown: [...this.shown], markers: [...this.markers],
      enabled: this.enabled, updatedAt: Date.now(),
    };
    saveJson('hints', state);
    if (hintsCloudReady) void writePlayerDataValue(HINTS_PLAYER_DATA_KEY, state, true);
  }

  hasSeen(id: HintId | FtueMarkerId): boolean {
    return id === 'succession' || id === 'chronicle'
      ? this.markers.has(id)
      : this.shown.has(id);
  }

  /** Отмечает одноразовый обучающий экран, встроенный в другую сцену. */
  markSeen(id: HintId | FtueMarkerId): void {
    if (id === 'succession' || id === 'chronicle') {
      if (this.markers.has(id)) return;
      this.markers.add(id);
      this.save();
      return;
    }
    if (!HINT_BY_ID.has(id) || this.shown.has(id)) return;
    this.shown.add(id);
    this.save();
  }

  /**
   * Поставить подсказку в очередь (§I.1). Показывается немедленно, только
   * если очередь пуста, прошёл кулдаун и нет подсказки важнее.
   */
  show(id: HintId, target?: HintTargetResolver): void {
    if (!this.enabled || this.shown.has(id)) return;
    if (this.queue.some((request) => request.id === id)) return;
    const def = HINT_BY_ID.get(id);
    if (!def) return;
    this.queue.push({ id, target });
    this.queue.sort((a, b) => (HINT_BY_ID.get(a.id)?.priority ?? 9) - (HINT_BY_ID.get(b.id)?.priority ?? 9));
    this.pump();
  }

  /** Отдаёт следующую подсказку из очереди, если это уместно. */
  private pump(): void {
    if (!this.enabled || this.current || this.queue.length === 0) return;
    const request = this.queue[0];
    if (!request) return;
    const def = HINT_BY_ID.get(request.id);
    if (!def) { this.queue.shift(); this.pump(); return; }
    if (!canPresentHintAt(this.scene.time.now, this.lastShownAt, def.urgent)) return;
    this.queue.shift();
    this.present(request);
  }

  private present(request: HintRequest): void {
    const { id, target } = request;
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
    const arrow = target
      ? this.scene.add.graphics().setScrollFactor(0).setDepth(9595)
      : null;
    this.layer.add([dim, arrow, panel, label].filter(Boolean) as Phaser.GameObjects.GameObject[]);
    panel.on('pointerdown', () => this.hide(true));
    this.current = { id, ui: def.ui, text: label, bg: panel, target, arrow };
    this.updateAnchor();
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
    this.updateAnchor();
  }

  /** Перерисовывает стрелку во время движения камеры/цели. */
  private updateAnchor(): void {
    const current = this.current;
    if (!current?.arrow || !current.target) return;
    const graphics = current.arrow;
    graphics.clear();
    const point = current.target();
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;

    const geometry = getHintArrowGeometry(
      {
        x: current.bg.x,
        y: current.bg.y,
        width: current.bg.width,
        height: current.bg.height,
      },
      point,
      { width: this.scene.scale.width, height: this.scene.scale.height },
    );
    if (!geometry) return;

    graphics.lineStyle(2.5, 0xffd76e, 0.95);
    graphics.beginPath();
    graphics.moveTo(geometry.startX, geometry.startY);
    graphics.lineTo(geometry.targetX, geometry.targetY);
    graphics.strokePath();
    graphics.fillStyle(0xffd76e, 0.95);
    graphics.beginPath();
    graphics.moveTo(geometry.targetX, geometry.targetY);
    graphics.lineTo(geometry.leftX, geometry.leftY);
    graphics.lineTo(geometry.rightX, geometry.rightY);
    graphics.closePath();
    graphics.fillPath();
  }

  private hide(byUser = false): void {
    const current = this.current;
    if (!current) return;
    track('hint_dismissed', { hint_id: current.id, source: byUser ? 'user' : 'ttl' });
    current.text.destroy();
    current.bg.destroy();
    current.arrow?.destroy();
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
    const nextIsUrgent = next ? HINT_BY_ID.get(next.id)?.urgent === true : false;
    const remainingCooldown = Math.max(0, COOLDOWN_MS - (this.scene.time.now - this.lastShownAt));
    this.scene.time.delayedCall(nextIsUrgent ? 0 : remainingCooldown, () => this.pump());
  }

  /** Сброс очереди без утечки overlay и без остановленного мира. */
  reset(): void {
    this.queue = [];
    this.hide(false);
  }
}