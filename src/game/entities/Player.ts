import Phaser from 'phaser';
import { PLAYER_BASE, DEPTH } from '../constants';

// ============ Игрок — Синий Воин ============

export class Player extends Phaser.Physics.Arcade.Sprite {
  hp: number = PLAYER_BASE.HP;
  maxHp: number = PLAYER_BASE.HP;
  speed: number = PLAYER_BASE.SPEED;
  iframesUntil: number = 0;
  hpBar: Phaser.GameObjects.Graphics;
  private shadow: Phaser.GameObjects.Image;

  constructor(scene: Phaser.Scene, x: number, y: number) {
    super(scene, x, y, 'player-idle');
    scene.add.existing(this);
    scene.physics.add.existing(this);

    this.setScale(PLAYER_BASE.DISPLAY_SCALE);
    this.setCollideWorldBounds(true);
    this.setDepth(DEPTH.ENTITY_BASE + y);
    this.play('player-idle');

    const r = 24;
    this.setCircle(r, this.width / 2 - r, this.height / 2 - r + 12);

    // Тень под ногами
    this.shadow = scene.add.image(x, y + 6, 'shadow')
      .setScale(0.22, 0.13)
      .setAlpha(0.35)
      .setDepth(DEPTH.SHADOW);

    // HP-бар (появляется при уроне)
    this.hpBar = scene.add.graphics().setDepth(DEPTH.HUD);

    this.on('animationcomplete', (anim: Phaser.Animations.Animation) => {
      if (anim.key.startsWith('player-atk')) {
        const body = this.body as Phaser.Physics.Arcade.Body;
        if (body.velocity.length() > 10) this.play('player-run', true);
        else this.play('player-idle', true);
      }
    });
  }

  playAttack(alt: boolean): void {
    if (!this.anims.currentAnim || !this.anims.currentAnim.key.startsWith('player-atk')) {
      this.play(alt ? 'player-atk2' : 'player-atk1', true);
    }
  }

  setAnimForVelocity(): void {
    const cur = this.anims.currentAnim?.key ?? '';
    if (cur.startsWith('player-atk')) return;
    const moving = (this.body as Phaser.Physics.Arcade.Body).velocity.length() > 10;
    const want = moving ? 'player-run' : 'player-idle';
    if (cur !== want) this.play(want, true);
  }

  damage(amount: number, now: number): boolean {
    if (now < this.iframesUntil) return false;
    this.iframesUntil = now + PLAYER_BASE.IFRAMES;
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
    this.shadow.setPosition(this.x, this.y + 6);
    this.setDepth(DEPTH.ENTITY_BASE + this.y);
    if (this.hpBar.visible && this.hp < this.maxHp) this.drawHpBar();
  }

  private drawHpBar(): void {
    if (this.hp >= this.maxHp) {
      this.hpBar.setVisible(false);
      return;
    }
    const w = 64, h = 7;
    const x = this.x - w / 2, y = this.y + 34;
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
