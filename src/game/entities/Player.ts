import Phaser from 'phaser';
import { DEPTH, SHADOW_SCALE, SHADOW_BOX, SHADOW_SRC } from '../constants';
import type { HeroDef } from '../data';
import { COMBAT_TIMING, isFrontalHit } from '../systems/Combat';

// ============ Игрок ============
export class Player extends Phaser.Physics.Arcade.Sprite {
  hp: number;
  maxHp: number;
  speed: number;
  iframesUntil = 0;
  lastDamageWasGuarded = false;
  readonly hero: HeroDef;
  hpBar: Phaser.GameObjects.Graphics;
  private shadow: Phaser.GameObjects.Image;

  constructor(scene: Phaser.Scene, x: number, y: number, hero: HeroDef) {
    super(scene, x, y, hero.anims.idle);
    this.hero = hero;
    this.hp = hero.maxHp;
    this.maxHp = hero.maxHp;
    this.speed = hero.speed;

    scene.add.existing(this);
    scene.physics.add.existing(this);

    this.setScale(hero.scale);
    this.setCollideWorldBounds(true);
    this.setDepth(DEPTH.ENTITY_BASE + y);
    this.play(hero.anims.idle);

    // Круглое тело у ног (кадры 192 или 320)
    const frame = hero.frameW;
    const cx = frame / 2;
    const cy = frame === 320 ? 266 : 150;
    const r = 24 / hero.scale;
    this.setCircle(r, cx - r, cy - r);

        // Тень под ногами
    // Исходник Shadow.png 192×192, персонаж лежит в рамке SHADOW_BOX —
    // origin ставится в её центр, чтобы пустые поля не сдвигали тень.
    const shadowDy = frame === 320 ? 36 : 6;
    this.shadow = scene.add.image(x, y + shadowDy, 'shadow')
      .setOrigin((SHADOW_BOX.x + SHADOW_BOX.w / 2) / SHADOW_SRC, (SHADOW_BOX.y + SHADOW_BOX.h / 2) / SHADOW_SRC)
      .setScale(SHADOW_SCALE * 1.1, SHADOW_SCALE * 0.65)
      .setAlpha(0.35)
      .setDepth(DEPTH.SHADOW);

    // HP-бар (появляется при уроне); слой HPBAR — над всеми сущностями,
    // но под снарядами/FX/HUD (мир-координаты, не экран)
    this.hpBar = scene.add.graphics().setDepth(DEPTH.HPBAR);

    this.on('animationcomplete', (anim: Phaser.Animations.Animation) => {
      const body = this.body as Phaser.Physics.Arcade.Body;
      if (anim.key === this.hero.anims.guard) {
        if (body.velocity.length() > 10) this.play(this.hero.anims.run, true);
        else this.play(this.hero.anims.idle, true);
        return;
      }
      if (anim.key === this.hero.anims.atk1 || anim.key === this.hero.anims.atk2) {
        if (body.velocity.length() > 10) this.play(this.hero.anims.run, true);
        else this.play(this.hero.anims.idle, true);
      }
    });
  }

  playAttack(alt: boolean): void {
    const cur = this.anims.currentAnim?.key ?? '';
    if (this.hero.anims.guard && cur === this.hero.anims.guard) return;
    if (alt) {
      // Добивающий взмах должен запускать attack2 даже если attack1 ещё играет.
      if (cur !== this.hero.anims.atk2) this.play(this.hero.anims.atk2, true);
      return;
    }
    if (cur !== this.hero.anims.atk1 && cur !== this.hero.anims.atk2) {
      this.play(this.hero.anims.atk1, true);
    }
  }

  setAnimForVelocity(): void {
    const cur = this.anims.currentAnim?.key ?? '';
    if (cur === this.hero.anims.guard || cur === this.hero.anims.atk1 || cur === this.hero.anims.atk2) return;
    const moving = (this.body as Phaser.Physics.Arcade.Body).velocity.length() > 10;
    const want = moving ? this.hero.anims.run : this.hero.anims.idle;
    if (cur !== want) this.play(want, true);
  }

  damage(amount: number, now: number, sourceX?: number): boolean {
    if (now < this.iframesUntil) return false;
    const guard = this.hero.anims.guard;
    const frontal = typeof sourceX === 'number' && isFrontalHit(this.flipX, this.x, sourceX);
    this.lastDamageWasGuarded = !!guard && frontal;
    const multiplier = this.lastDamageWasGuarded ? COMBAT_TIMING.FRONT_GUARD_DAMAGE_MULTIPLIER : 1;
    this.iframesUntil = now + 500;
    this.hp = Math.max(0, this.hp - Math.max(1, Math.round(amount * multiplier)));
    if (this.lastDamageWasGuarded && guard) {
      this.play(guard, true);
    } else {
      this.scene.tweens.add({
        targets: this,
        alpha: { from: 0.25, to: 1 },
        duration: 90,
        repeat: 4,
      });
    }
    this.drawHpBar();
    return this.hp <= 0;
  }

  heal(amount: number): void {
    this.hp = Math.min(this.maxHp, this.hp + amount);
    this.drawHpBar();
    if (this.hp >= this.maxHp) this.hpBar.setVisible(false);
  }

  preUpdate(time: number, delta: number): void {
    if (this.scene.registry.get('tss-hint-overlay-paused') === true) return;
    super.preUpdate(time, delta);
    this.shadow.setPosition(this.x, this.y + (this.hero.frameW === 320 ? 36 : 6));
    this.setDepth(DEPTH.ENTITY_BASE + this.y);
    if (this.hpBar.visible && this.hp < this.maxHp) this.drawHpBar();
  }

  private drawHpBar(): void {
    if (this.hp >= this.maxHp) {
      this.hpBar.setVisible(false);
      return;
    }
    const w = 64, h = 7;
    const x = this.x - w / 2, y = this.y + 38;
    const g = this.hpBar.setVisible(true);
    g.clear();
    g.fillStyle(0x1a0f08, 0.85).fillRoundedRect(x - 1, y - 1, w + 2, h + 2, 3);
    g.fillStyle(0x8c1d18).fillRect(x, y, w, h);
    const frac = Math.max(0, this.hp / this.maxHp);
    g.fillStyle(frac > 0.5 ? 0x53b44a : frac > 0.25 ? 0xe0a030 : 0xd03028)
      .fillRect(x, y, Math.round(w * frac), h);
  }

  destroy(fromScene?: boolean): void {
    this.shadow.destroy();
    this.hpBar.destroy();
    super.destroy(fromScene);
  }
}
