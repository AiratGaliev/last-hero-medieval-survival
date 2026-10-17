import Phaser from 'phaser';
import { t } from '../../i18n';
import { track } from '../../platform/analytics';
import { loadJson, saveJson } from '../storage';

// ============ Движок подсказок FTUE (TZ §I.1) ============
//
// Учим действием, не текстом: подсказка появляется в момент мотива.
// Одна подсказка за раз, не чаще одной за 20 сек, скип кликом, одноразовые
// флаги (hint.{id}.shown). Формат — banner сверху (4 сек). Отдельный
// tutorial-уровень не вводится.

type HintId =
  | 'move' | 'pawns' | 'house' | 'barracks' | 'siege'
  | 'monastery' | 'orders' | 'veteran';

const COOLDOWN_MS = 20000;

interface HintState { shown: HintId[] }

export class Hints {
  private scene: Phaser.Scene;
  private shown = new Set<HintId>();
  private lastShownAt = 0;
  private current: { id: HintId; text: Phaser.GameObjects.Text; bg: Phaser.GameObjects.Rectangle; ttl: Phaser.Math.Vector2 } | null = null;
  private enabled = true;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    const st = loadJson<HintState>('hints') ?? { shown: [] };
    for (const id of st.shown) this.shown.add(id);
    scene.events.once('shutdown', () => this.save());
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
  }

  private save(): void {
    saveJson('hints', { shown: [...this.shown] } satisfies HintState);
  }

  /** Показать подсказку, если она ещё не показывалась и кулдаун прошёл. */
  show(id: HintId): void {
    if (!this.enabled || this.shown.has(id)) return;
    const now = this.scene.time.now;
    if (now - this.lastShownAt < COOLDOWN_MS) return;
    if (this.current) this.hide();
    this.shown.add(id);
    this.lastShownAt = now;

    const w = this.scene.scale.width;
    const text = t(`hint.${id}` as `hint.${typeof id}`);
    // Телеметрия §K.2: показ подсказки
    track('hint_shown', { hint_id: id });
    const bg = this.scene.add.rectangle(w / 2, 92, Math.min(560, w - 40), 40, 0x1a0f08, 0.88)
      .setStrokeStyle(1, 0x8a6d3b)
      .setScrollFactor(0)
      .setDepth(9600)
      .setInteractive({ useHandCursor: true });
    const label = this.scene.add.text(w / 2, 92, text, {
      fontFamily: 'monospace', fontSize: '13px', color: '#ffe9b0', align: 'center', wordWrap: { width: Math.min(540, w - 60) },
    }).setOrigin(0.5).setScrollFactor(0).setDepth(9601);
    bg.on('pointerdown', () => this.hide(true));
    this.current = { id, text: label, bg, ttl: new Phaser.Math.Vector2(0, 0) };
    this.scene.time.delayedCall(6000, () => this.hide());
  }

  private hide(byUser = false): void {
    if (!this.current) return;
    // Телеметрия §K.2: скрытие (тап игрока или TTL)
    track('hint_dismissed', { hint_id: this.current.id, source: byUser ? 'user' : 'ttl' });
    this.current.text.destroy();
    this.current.bg.destroy();
    this.current = null;
    this.save();
  }
}
