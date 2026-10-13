import Phaser from 'phaser';
import { DEPTH } from '../constants';
import type { HeroDef } from '../data';

// ============ Игрок ============

export class Player extends Phaser.Physics.Arcade.Sprite {
  hp: number;
  maxHp: number;
  speed: number;
  iframesUntil = 0;
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
    const shadowDy = frame === 320 ? 36 : 6;
    this.shadow = scene.add.image(x, y + shadowDy, 'shadow')
      .setScale(0.22, 0.13)
      .setAlpha(0.35)
      .setDepth(DEPTH.SHADOW);

    // HP-бар (появляется при уроне)
    this.hpBar = scene.add.graphics().setDepth(DEPTH.HUD);

    this.on('animationcomplete', (anim: Phaser.Animations.Animation) => {
      if (anim.key === this.hero.anims.atk1 || anim.key === this.hero.anims.atk2) {
        const body = this.body as Phaser.Physics.Arcade.Body;
        if (body.velocity.length() > 10) this.play(this.hero.anims.run, true);
        else this.play(this.hero.anims.idle, true);
      }
    });
  }

  playAttack(alt: boolean): void {
    const cur = this.anims.currentAnim?.key ?? '';
    if (cur !== this.hero.anims.atk1 && cur !== this.hero.anims.atk2) {
      this.play(alt ? this.hero.anims.atk2 : this.hero.anims.atk1, true);
    }
  }

  setAnimForVelocity(): void {
    const cur = this.anims.currentAnim?.key ?? '';
    if (cur === this.hero.anims.atk1 || cur === this.hero.anims.atk2) return;
    const moving = (this.body as Phaser.Physics.Arcade.Body).velocity.length() > 10;
    const want = moving ? this.hero.anims.run : this.hero.anims.idle;
    if (cur !== want) this.play(want, true);
  }

  damage(amount: number, now: number): boolean {
    if (now < this.iframesUntil) return false;
    this.iframesUntil = now + 500;
    this.hp = Math.max(0, this.hp - amount);
    // Мигание
    this.scene.tweens.add({
      targets: this,
      alpha: { from: 0.25, to: 1 },
      duration: 90,
      repeat: 4,
    });
    this.drawHpBar();
    return this.hp <= 0;
  }

  heal(amount: number): void {
    this.hp = Math.min(this.maxHp, this.hp + amount);
    this.drawHpBar();
    if (this.hp >= this.maxHp) this.hpBar.setVisible(false);
  }

  preUpdate(time: number, delta: number): void {
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
