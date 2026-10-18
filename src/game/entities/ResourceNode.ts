import Phaser from 'phaser';
import { DEPTH } from '../constants';
import type { ResourceKind } from '../data';

// ============ Ресурсный узел: дерево / овца / золотая жила (TZ §B.3) ============
//
// Общий класс для всех трёх источников. Узел блокируется за одной пешкой
// (claim/release) и добывается тиками. Деревья и овцы исчезают на нуле;
// жила остаётся на карте истощённой и становится доступна после recharge()
// в бесконечном режиме. Пульс гаснет после 2-го цикла (§B.3, §H.12).

export type NodeKind = 'tree' | 'sheep' | 'vein';

export class ResourceNode {
  readonly kind: NodeKind;
  readonly res: ResourceKind;
  readonly x: number;
  readonly y: number;
  /** Осталось тиков добычи (дерево 5, овца 4, жила 4 цикла × 4 тика...). */
  remaining: number;
  /** Стартовый запас — для восстановления жил в бесконечном режиме (§H.12). */
  readonly maxRemaining: number;
  claimedBy: Phaser.GameObjects.Sprite | null = null;
  alive = true;
  private sprite: Phaser.GameObjects.Sprite | Phaser.GameObjects.Image;
  /** Пульс золотой жилы (гаснет после 2-го цикла). */
  private pulse: Phaser.GameObjects.Sprite | null = null;
  private cyclesUsed = 0;
  private readonly scene: Phaser.Scene;

  constructor(
    scene: Phaser.Scene,
    kind: NodeKind,
    res: ResourceKind,
    x: number,
    y: number,
    remaining: number,
    sprite: Phaser.GameObjects.Sprite | Phaser.GameObjects.Image,
    pulse?: Phaser.GameObjects.Sprite,
  ) {
    this.scene = scene;
    this.kind = kind;
    this.res = res;
    this.x = x;
    this.y = y;
    this.remaining = remaining;
    this.maxRemaining = remaining;
    this.sprite = sprite;
    this.pulse = pulse ?? null;
  }

  /** Можно ли начать новый цикл добычи прямо сейчас. */
  get available(): boolean {
    return this.alive && this.remaining > 0;
  }

  claim(pawn: Phaser.GameObjects.Sprite): boolean {
    if (!this.available || (this.claimedBy && this.claimedBy !== pawn)) return false;
    this.claimedBy = pawn;
    return true;
  }

  release(pawn: Phaser.GameObjects.Sprite): void {
    if (this.claimedBy === pawn) this.claimedBy = null;
  }

  /** Тик добычи одного цикла. false означает, что источник исчерпан. */
  extract(): boolean {
    if (!this.available) return false;
    this.remaining = Math.max(0, this.remaining - 1);

    if (this.kind === 'vein') {
      this.cyclesUsed++;
      // Сохраняем объект пульса скрытым, чтобы вернуть его при восстановлении.
      if (this.pulse && this.cyclesUsed >= 2 && this.pulse.active) {
        this.pulse.setVisible(false);
      }
    }

    if (this.remaining <= 0) {
      if (this.kind === 'vein') {
        // Жила остаётся на карте, но не может быть собрана до восстановления.
        this.claimedBy = null;
        this.sprite.setAlpha(0.48);
        this.pulse?.setVisible(false);
      } else {
        this.destroy();
      }
      return false;
    }
    return true;
  }

  /** Восстановление жилы — бесконечный режим §H.12 (раз в 5 минут). */
  recharge(): void {
    if (!this.alive || this.kind !== 'vein') return;
    this.remaining = this.maxRemaining;
    this.cyclesUsed = 0;
    this.sprite.setAlpha(1);
    this.pulse?.setVisible(true);
  }

  destroy(): void {
    this.alive = false;
    this.claimedBy = null;
    // Дерево/овца исчезают без пня; жила — с дымком частиц (§B.3)
    if (this.kind === 'vein') {
      const puff = this.scene.add.sprite(this.x, this.y, 'fx-dust')
        .setDepth(DEPTH.FX - 10).setScale(1.4).setAlpha(0.7);
      puff.play('fx-dust');
      puff.once('animationcomplete', () => puff.destroy());
    }
    this.pulse?.destroy();
    this.pulse = null;
    this.sprite.destroy();
  }
}
