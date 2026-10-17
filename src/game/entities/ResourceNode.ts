import Phaser from 'phaser';
import { DEPTH } from '../constants';
import type { ResourceKind } from '../data';

// ============ Ресурсный узел: дерево / овца / золотая жила (TZ §B.3) ============
//
// Общий класс для всех трёх источников. Узел блокируется за одной пешкой
// (claim/release), добывается тиками (extract), на нуле исчезает. Жила —
// единственный многоразовый источник (4 цикла × 20 руды), пульс гаснет
// после 2-го цикла — индикатор истощения без цифр.

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

  claim(pawn: Phaser.GameObjects.Sprite): boolean {
    if (!this.alive || (this.claimedBy && this.claimedBy !== pawn)) return false;
    this.claimedBy = pawn;
    return true;
  }

  release(pawn: Phaser.GameObjects.Sprite): void {
    if (this.claimedBy === pawn) this.claimedBy = null;
  }

  /** Тик добычи (один цикл работы). false — узел исчерпан и исчез. */
  extract(): boolean {
    if (!this.alive) return false;
    this.remaining--;
    // Пульс гаснет после 2-го цикла жилы — индикатор истощения без цифр (§B.3)
    if (this.kind === 'vein') {
      this.cyclesUsed++;
      if (this.pulse && this.cyclesUsed >= 2 && this.pulse.active) {
        this.pulse.destroy();
        this.pulse = null;
      }
    }
    if (this.remaining <= 0) {
      this.destroy();
      return false;
    }
    return true;
  }

  /** Восстановление жилы — бесконечный режим §H.12 (раз в 5 минут).
   *  Пульс не возвращает: истощение остаётся видимым, заряды — рабочие. */
  recharge(): void {
    if (!this.alive || this.kind !== 'vein') return;
    this.remaining = this.maxRemaining;
    this.cyclesUsed = 0;
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
