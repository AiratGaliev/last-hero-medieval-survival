import Phaser from 'phaser';
import { t } from '../../i18n';
import { track } from '../../platform/analytics';
import { loadJson, saveJson } from '../storage';

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

export interface HintDef {
  id: HintId;
  /**
   * Приоритет очереди (§I.1): «угроза (осада) > возможность (стройка) >
   * знакомство (имена)». Меньше — важнее.
   */
  priority: number;
  ui: HintUi;
  /** Время жизни в мс (§I.1: banner — 4 сек). */
  ttl: number;
  /** Подсказка-исключение: показывается, минуя кулдаун очереди. */
  urgent?: boolean;
}

/**
 * Реестр подсказок (§I.1 «движок данных»). Ключи текста — `hint.{id}`.
 * Значения `priority` кодируют порядок раскрытия из сценария §I.2.
 */
export const HINTS: readonly HintDef[] = [
  { id: 'move', priority: 5, ui: 'overlay', ttl: 4000 },
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

interface HintState { shown: HintId[]; enabled?: boolean }

export class Hints {
  private scene: Phaser.Scene;
  private shown = new Set<HintId>();
  private lastShownAt = 0;
  private current: { id: HintId; text: Phaser.GameObjects.Text; bg: Phaser.GameObjects.Rectangle } | null = null;
  /**
   * Очередь отложенных подсказок (§I.1: «Новая подсказка откладывает
   * непрочитанную»). Раньше новая подсказка просто УНИЧТОЖАЛА текущую —
   * игрок терял половину обучения, и порядок зависел от того, какой триггер
   * сработал последним.
   */
  private queue: HintId[] = [];
  private enabled: boolean;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    const st = loadJson<HintState>('hints') ?? { shown: [] };
    for (const id of st.shown) if (HINT_BY_ID.has(id)) this.shown.add(id);
    this.enabled = st.enabled !== false;
    scene.events.once('shutdown', () => this.save());
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
    const now = this.scene.time.now;
    if (now - this.lastShownAt < COOLDOWN_MS) return;
    const id = this.queue.shift();
    if (!id) return;
    this.present(id);
  }

  private present(id: HintId): void {
    const def = HINT_BY_ID.get(id);
    if (!def) return;
    this.shown.add(id);
    this.lastShownAt = this.scene.time.now;
    this.save();

    const w = this.scene.scale.width;
    const h = this.scene.scale.height;
    const text = t(`hint.${id}` as `hint.${typeof id}`);
    track('hint_shown', { hint_id: id, ui: def.ui });

    // overlay: тонировка мира + объяснение (только 3 раза за игру, §I.1)
    const dim = def.ui === 'overlay'
      ? this.scene.add.rectangle(w / 2, h / 2, w + 8, h + 8, 0x07070d, 0.55)
        .setScrollFactor(0).setDepth(9590)
      : null;

    const bw = Math.min(560, w - 40);
    const bg = this.scene.add.rectangle(w / 2, 92, bw, 40, 0x1a0f08, 0.88)
      .setStrokeStyle(1, 0x8a6d3b)
      .setScrollFactor(0)
      .setDepth(9600)
      .setInteractive({ useHandCursor: true });
    const label = this.scene.add.text(w / 2, 92, text, {
      fontFamily: 'monospace', fontSize: '13px', color: '#ffe9b0', align: 'center',
      wordWrap: { width: Math.min(540, w - 60) },
    }).setOrigin(0.5).setScrollFactor(0).setDepth(9601);
    bg.on('pointerdown', () => this.hide(true));
    this.current = { id, text: label, bg };
    if (dim) dim.on('pointerdown', () => this.hide(true));
    this.extra.push(dim);

    this.scene.time.delayedCall(def.ttl, () => this.hide());
  }

  private extra: Array<Phaser.GameObjects.Rectangle | null> = [];

  private hide(byUser = false): void {
    if (!this.current) return;
    track('hint_dismissed', { hint_id: this.current.id, source: byUser ? 'user' : 'ttl' });
    this.current.text.destroy();
    this.current.bg.destroy();
    this.current = null;
    for (const e of this.extra) e?.destroy();
    this.extra = [];
    this.save();
    // Показать следующую отложенную, когда кулдаун истёк
    this.scene.time.delayedCall(COOLDOWN_MS - 500, () => this.pump());
  }

  /** Сброс при старте нового матча: очередь пуста, но показанные флаги живут. */
  reset(): void {
    this.queue = [];
    this.current = null;
  }
}