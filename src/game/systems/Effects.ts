import Phaser from 'phaser';
import { DEPTH, FONT } from '../constants';
import { audio } from './Audio';

// ============ Пул визуальных эффектов: взрывы, пыль, числа урона ============

interface DmgText extends Phaser.GameObjects.Text {
  busy?: boolean;
  /** Момент захвата текста — по нему ищем самый старый для переиспользования. */
  busyAt?: number;
}

/** Предел пула всплывающих чисел урона. */
const DMG_POOL_MAX = 48;

interface FxSprite extends Phaser.GameObjects.Sprite {
  busy?: boolean;
}

/**
 * Предел пула спрайтов эффектов. Выше него эффект просто не рисуется:
 * на кадре не появляется сотня новых объектов из-за одного взрыва.
 */
const FX_POOL_MAX = 40;

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
    if (!s) return;
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

  /** Облако щепок/пыли при разрушении здания (§H.13 №5). */
  splinters(x: number, y: number, count = 16): void {
    if (!this.scene.textures.exists('fx-dust')) return;
    const emitter = this.scene.add.particles(x, y, 'fx-dust', {
      frame: [0, 1, 2, 3, 4, 5, 6, 7],
      speed: { min: 80, max: 230 },
      angle: { min: 205, max: 335 },
      gravityY: 220,
      scale: { start: 0.42, end: 0.06 },
      alpha: { start: 0.95, end: 0 },
      lifespan: { min: 300, max: 620 },
      tint: [0xcfa16b, 0x9c6b3e, 0xe6c48c],
      emitting: false,
    }).setDepth(DEPTH.FX + 4);
    emitter.explode(Math.max(1, Math.min(32, Math.round(count))), x, y);
    this.scene.time.delayedCall(800, () => emitter.destroy());
  }

  /** Короткое поднятие знамени по завершении постройки (§H.13 №3). */
  buildFlag(x: number, y: number): void {
    const flag = this.scene.add.container(x, y - 10).setDepth(DEPTH.FX + 6)
      .setAlpha(0).setScale(0.72);
    const pole = this.scene.add.rectangle(-2, 1, 2.5, 27, 0x4b2c1b, 1);
    const pennant = this.scene.add.graphics();
    pennant.fillStyle(0xd9a520, 1).fillTriangle(0, -12, 20, -6, 0, 1);
    pennant.lineStyle(1.5, 0x4b2c1b, 1).strokeTriangle(0, -12, 20, -6, 0, 1);
    pennant.fillStyle(0xffe9a6, 0.9).fillTriangle(2, -10, 13, -6, 2, -2);
    flag.add([pole, pennant]);

    this.scene.tweens.add({
      targets: flag,
      y: y - 28,
      alpha: 1,
      scale: 1,
      duration: 230,
      ease: 'Back.Out',
      onComplete: () => {
        this.scene.time.delayedCall(430, () => {
          if (!flag.active) return;
          this.scene.tweens.add({
            targets: flag,
            y: y - 34,
            alpha: 0,
            duration: 220,
            ease: 'Quad.easeIn',
            onComplete: () => flag.destroy(),
          });
        });
      },
    });
  }

  /** Брызги при попадании по врагу */
  hitSpark(x: number, y: number): void {
    this.sparkEmitter.explode(3, x, y);
  }

  /** Красный знак + над раненой пешкой (§H.13 №6). */
  woundMark(x: number, y: number): void {
    const mark = this.scene.add.container(x, y - 26).setDepth(DEPTH.FX + 12);
    const disc = this.scene.add.circle(0, 0, 8, 0xb92335, 0.96)
      .setStrokeStyle(1.5, 0xffe0c4, 0.95);
    const horizontal = this.scene.add.rectangle(0, 0, 10, 2.5, 0xffffff, 1);
    const vertical = this.scene.add.rectangle(0, 0, 2.5, 10, 0xffffff, 1);
    mark.add([disc, horizontal, vertical]);
    this.scene.tweens.add({
      targets: mark,
      y: y - 58,
      alpha: 0,
      scale: { from: 0.8, to: 1.1 },
      duration: 850,
      ease: 'Quad.easeOut',
      onComplete: () => mark.destroy(),
    });
  }

  /** Эффект лечения */
  heal(x: number, y: number): void {
    const s = this.acquireFx('fx-heal');
    if (!s) return;
    s.setPosition(x, y).setScale(0.8).setAlpha(0.9).setDepth(DEPTH.FX)
      .play('fx-heal', true)
      .once('animationcomplete', () => this.releaseFx(s));
  }

  /** Взрыв магического шара шамана при попадании (кадры из пака enemies/) */
  hexBlast(x: number, y: number): void {
    const s = this.acquireFx('fx-hex');
    if (!s) return;
    s.setPosition(x, y).setScale(1).setAlpha(1).setDepth(DEPTH.FX)
      .play('fx-hex', true)
      .once('animationcomplete', () => this.releaseFx(s));
  }

  /** Текст, который дольше всех занят: его можно переиспользовать. */
  private oldestDmg(): DmgText | undefined {
    let best: DmgText | undefined;
    for (const d of this.dmgPool) {
      if (!d.busy) return d;
      // busyAt проставляется при захвате; undefined считаем самым старым
      if (!best || (d.busyAt ?? -1) < (best.busyAt ?? -1)) best = d;
    }
    return best;
  }

  /** Всплывающее число урона */
  damage(x: number, y: number, amount: number, crit = false): void {
    // Свободного текста может не оказаться — берём тот, который
    // освободился раньше всех. Раньше в этом месте число просто
    // выбрасывалось, и в плотной толпе, где цифры нужнее всего,
    // игрок их не видел.
    let t = this.dmgPool.find((d) => !d.busy);
    if (!t && this.dmgPool.length >= DMG_POOL_MAX) t = this.oldestDmg();
    if (!t) {
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
    this.scene.tweens.killTweensOf(t);
    this.showDamage(t, x, y, amount, crit);
  }

  private showDamage(t: DmgText, x: number, y: number, amount: number, crit: boolean): void {
    t.busy = true;
    t.busyAt = this.scene.time.now;
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

  /** Дождь монет из ассетов UI при победе над боссом (§H.13 №10). */
  goldRain(count = 28): void {
    if (!this.scene.textures.exists('icon-coin')) return;
    const view = this.scene.cameras.main.worldView;
    const safeCount = Math.max(1, Math.min(40, Math.round(count)));
    for (let i = 0; i < safeCount; i++) {
      const startX = Phaser.Math.Between(
        Math.round(view.x + 12),
        Math.round(view.x + Math.max(13, view.width - 12)),
      );
      const startY = view.y + Phaser.Math.Between(0, Math.max(1, Math.round(view.height * 0.18)));
      const coin = this.scene.add.image(startX, startY, 'icon-coin')
        .setDisplaySize(15, 15)
        .setTint(0xffdf72)
        .setAlpha(0)
        .setDepth(DEPTH.FX + 12);
      const endY = startY + Phaser.Math.Between(90, Math.max(91, Math.round(view.height * 0.42)));
      this.scene.tweens.add({
        targets: coin,
        x: startX + Phaser.Math.Between(-28, 28),
        y: endY,
        angle: Phaser.Math.Between(-240, 240),
        scale: { from: 0.75, to: 0.24 },
        alpha: { from: 0, to: 1 },
        duration: Phaser.Math.Between(520, 1_000),
        delay: i * 24,
        ease: 'Sine.In',
        onComplete: () => {
          this.scene.tweens.add({
            targets: coin,
            alpha: 0,
            duration: 180,
            onComplete: () => coin.destroy(),
          });
        },
      });
    }
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
    // Ищем свободный спрайт ИМЕННО с нужной текстурой: пул общий для
    // fx-explosion1/2 и fx-heal, а анимация привязана к текстуре.
    let s = this.fxPool.find((f) => !f.busy && f.texture.key === animKey);
    if (!s) {
      // Пул не растёт бесконечно: выше предела эффект просто не показывается,
      // зато на кадре не появляется сотня новых спрайтов.
      if (this.fxPool.length >= FX_POOL_MAX) {
        const spare = this.fxPool.find((f) => !f.busy);
        if (!spare) return null as unknown as FxSprite;
        spare.texture = this.scene.textures.get(animKey);
        s = spare;
      } else {
        s = this.scene.add.sprite(0, 0, animKey) as FxSprite;
        this.fxPool.push(s);
      }
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
