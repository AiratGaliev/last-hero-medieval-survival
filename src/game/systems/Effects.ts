import Phaser from 'phaser';
import { DEPTH, FONT } from '../constants';
import { audio } from './Audio';

// ============ Пул визуальных эффектов: взрывы, пыль, числа урона ============

interface DmgText extends Phaser.GameObjects.Text {
  busy?: boolean;
}

interface FxSprite extends Phaser.GameObjects.Sprite {
  busy?: boolean;
}

export class Effects {
  private scene: Phaser.Scene;
  private dmgPool: DmgText[] = [];
  private fxPool: FxSprite[] = [];
  private dustEmitter: Phaser.GameObjects.Particles.ParticleEmitter;
  private sparkEmitter: Phaser.GameObjects.Particles.ParticleEmitter;
  private lastHitSound = 0;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.dustEmitter = scene.add.particles(0, 0, 'fx-dust', {
      frame: [0, 1, 2, 3, 4, 5, 6, 7],
      speed: { min: 30, max: 90 },
      angle: { min: 200, max: 340 },
      scale: { start: 0.7, end: 0.2 },
      alpha: { start: 0.75, end: 0 },
      lifespan: { min: 250, max: 450 },
      gravityY: -60,
      emitting: false,
    });
    this.dustEmitter.setDepth(DEPTH.FX);
    // Брызги ударов (тёмно-красные пульс-частицы)
    this.sparkEmitter = scene.add.particles(0, 0, 'fx-dust', {
      frame: [0, 1, 2, 3, 4, 5, 6, 7],
      speed: { min: 60, max: 150 },
      scale: { start: 0.34, end: 0.06 },
      alpha: { start: 0.9, end: 0 },
      lifespan: { min: 170, max: 300 },
      tint: 0xc02830,
      emitting: false,
    });
    this.sparkEmitter.setDepth(DEPTH.FX + 5);
  }

  /** Взрыв (вариант 1 маленький, 2 большой) */
  explosion(x: number, y: number, scale = 1, variant: 1 | 2 = 1): void {
    const s = this.acquireFx(`fx-explosion${variant}`);
    s.setPosition(x, y)
      .setScale(0.7 * scale, 0.7 * scale)
      .setAlpha(1)
      .setDepth(DEPTH.FX)
      .play(`fx-explosion${variant}`, true)
      .once('animationcomplete', () => this.releaseFx(s));
  }

  /** Пыль из-под ног / удара */
  dust(x: number, y: number, count = 3): void {
    this.dustEmitter.explode(count, x, y);
  }

  /** Брызги при попадании по врагу */
  hitSpark(x: number, y: number): void {
    this.sparkEmitter.explode(3, x, y);
  }

  /** Эффект лечения */
  heal(x: number, y: number): void {
    const s = this.acquireFx('fx-heal');
    s.setPosition(x, y).setScale(0.8).setAlpha(0.9).setDepth(DEPTH.FX)
      .play('fx-heal', true)
      .once('animationcomplete', () => this.releaseFx(s));
  }

  /** Всплывающее число урона */
  damage(x: number, y: number, amount: number, crit = false): void {
    const t = this.dmgPool.find((d) => !d.busy);
    if (!t) {
      if (this.dmgPool.length >= 48) return;
      const nt = this.scene.add.text(x, y, '', {
        fontFamily: FONT,
        fontSize: '13px',
        color: '#ffffff',
        stroke: '#1b1008',
        strokeThickness: 4,
      }) as DmgText;
      nt.setOrigin(0.5).setDepth(DEPTH.FX + 10);
      this.dmgPool.push(nt);
      this.showDamage(nt, x, y, amount, crit);
      return;
    }
    this.showDamage(t, x, y, amount, crit);
  }

  private showDamage(t: DmgText, x: number, y: number, amount: number, crit: boolean): void {
    t.busy = true;
    t.setText(crit ? `${amount}!` : `${amount}`);
    t.setPosition(x + Phaser.Math.Between(-8, 8), y - 20);
    t.setColor(crit ? '#ffb020' : '#ffffff');
    t.setFontSize(crit ? 17 : 13);
    t.setAlpha(1).setVisible(true).setScale(crit ? 1.25 : 1);
    this.scene.tweens.add({
      targets: t,
      y: y - 52,
      alpha: 0,
      duration: crit ? 600 : 420,
      ease: 'Quad.easeOut',
      onComplete: () => { t.busy = false; t.setVisible(false); },
    });
  }

  /** Всплывающий текст (золото, бонусы) */
  popup(x: number, y: number, text: string, color = '#ffd76e', size = 15): void {
    const t = this.scene.add.text(x, y, text, {
      fontFamily: FONT,
      fontSize: `${size}px`,
      color,
      stroke: '#1b1008',
      strokeThickness: 4,
    }).setOrigin(0.5).setDepth(DEPTH.FX + 12);
    this.scene.tweens.add({
      targets: t,
      y: y - 50,
      alpha: 0,
      duration: 950,
      ease: 'Quad.easeOut',
      onComplete: () => t.destroy(),
    });
  }

  /** Нова-импульс: расширяющееся золотое кольцо (эволюция ауры/эхо-удары) */
  novaRing(x: number, y: number, radius: number, color = 0xffd76e): void {
    const ring = this.scene.add.circle(x, y, 18)
      .setStrokeStyle(4, color, 0.85)
      .setDepth(DEPTH.FX + 6);
    this.scene.tweens.add({
      targets: ring,
      radius,
      alpha: 0,
      duration: 380,
      ease: 'Cubic.easeOut',
      onComplete: () => ring.destroy(),
    });
    // внутренняя вспышка
    const flash = this.scene.add.circle(x, y, 26)
      .setFillStyle(color, 0.28)
      .setDepth(DEPTH.FX + 5);
    this.scene.tweens.add({
      targets: flash,
      scale: 1.8,
      alpha: 0,
      duration: 240,
      onComplete: () => flash.destroy(),
    });
  }

  /** Молния-цепь: ломаная золотая линия между двумя точками (эволюция меча) */
  chainLightning(x1: number, y1: number, x2: number, y2: number): void {
    const g = this.scene.add.graphics().setDepth(DEPTH.FX + 8).lineStyle(2.5, 0xffe9a0, 0.95);
    g.beginPath();
    g.moveTo(x1, y1);
    // 3 промежуточных звена с поперечным дрожанием — «электрическая» дуга
    const steps = 4;
    const nx = -(y2 - y1), ny = x2 - x1;
    const nLen = Math.hypot(nx, ny) || 1;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const jitter = Phaser.Math.Between(-14, 14);
      g.lineTo(
        Phaser.Math.Linear(x1, x2, t) + (nx / nLen) * jitter,
        Phaser.Math.Linear(y1, y2, t) + (ny / nLen) * jitter,
      );
    }
    g.lineTo(x2, y2);
    g.strokePath();
    this.scene.tweens.add({
      targets: g,
      alpha: 0,
      duration: 160,
      ease: 'Quad.easeIn',
      onComplete: () => g.destroy(),
    });
  }

  /** Взрыв золотых искр (момент эволюции/новы) */
  goldBurst(x: number, y: number, count = 14): void {
    const spark = this.scene.add.particles(x, y, 'fx-dust', {
      frame: [0, 1, 2, 3, 4, 5, 6, 7],
      speed: { min: 90, max: 260 },
      scale: { start: 0.4, end: 0.05 },
      alpha: { start: 1, end: 0 },
      lifespan: { min: 300, max: 550 },
      tint: 0xffd76e,
      blendMode: 'ADD',
      emitting: false,
    }).setDepth(DEPTH.FX + 8);
    spark.explode(count, x, y);
    this.scene.time.delayedCall(700, () => spark.destroy());
  }

  hitSound(now: number): void {
    if (now - this.lastHitSound > 70) {
      this.lastHitSound = now;
      audio.play('hit');
    }
  }

  private acquireFx(animKey: string): FxSprite {
    let s = this.fxPool.find((f) => !f.busy);
    if (!s) {
      s = this.scene.add.sprite(0, 0, animKey) as FxSprite;
      this.fxPool.push(s);
    }
    s.busy = true;
    s.setVisible(true).setActive(true);
    return s;
  }

  private releaseFx(s: FxSprite): void {
    s.busy = false;
    s.setVisible(false).setActive(false);
  }
}
