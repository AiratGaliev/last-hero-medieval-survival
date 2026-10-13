import Phaser from 'phaser';
import { DEPTH } from '../constants';
import { audio } from './Audio';

// ============ Снаряды: стрелы, копья, бомбы (игрок) + стрелы врагов ============

export interface Proj extends Phaser.Physics.Arcade.Image {
  dmg: number;
  pierceLeft: number;
  life: number;
  hitSet?: Set<Phaser.GameObjects.Sprite>;
}

interface Bomb {
  img: Phaser.GameObjects.Image;
  from: { x: number; y: number };
  to: { x: number; y: number };
  t: number;
  dur: number;
  dmg: number;
  radius: number;
}

export interface ProjectileCtx {
  onExplode(x: number, y: number, dmg: number, radius: number): void;
}

export class Projectiles {
  private scene: Phaser.Scene;
  private ctx: ProjectileCtx;
  arrows: Phaser.Physics.Arcade.Group;
  spears: Phaser.Physics.Arcade.Group;
  knives: Phaser.Physics.Arcade.Group;
  enemyArrows: Phaser.Physics.Arcade.Group;
  private arrowPool: Proj[] = [];
  private spearPool: Proj[] = [];
  private knifePool: Proj[] = [];
  private enemyArrowPool: Proj[] = [];
  private bombs: Bomb[] = [];

  constructor(scene: Phaser.Scene, ctx: ProjectileCtx) {
    this.scene = scene;
    this.ctx = ctx;
    this.arrows = scene.physics.add.group({ allowGravity: false });
    this.spears = scene.physics.add.group({ allowGravity: false });
    this.knives = scene.physics.add.group({ allowGravity: false });
    this.enemyArrows = scene.physics.add.group({ allowGravity: false });
  }

  // ---------- Стрелы игрока ----------
  fireArrow(x: number, y: number, angle: number, dmg: number, pierce: number): void {
    const p = this.acquire(this.arrowPool, 'arrow', this.arrows);
    const speed = 640;
    p.setPosition(x, y);
    p.setVelocity(Math.cos(angle) * speed, Math.sin(angle) * speed);
    p.setRotation(angle);
    p.dmg = dmg;
    p.pierceLeft = pierce;
    p.life = 1100;
    p.hitSet = new Set();
    p.setDepth(DEPTH.PROJECTILE);
    (p.body as Phaser.Physics.Arcade.Body).setSize(30, 10, true);
    audio.play('shoot');
  }

  // ---------- Копья ----------
  fireSpear(x: number, y: number, angle: number, dmg: number): void {
    const p = this.acquire(this.spearPool, 'spear', this.spears);
    const speed = 760;
    p.setPosition(x, y);
    p.setVelocity(Math.cos(angle) * speed, Math.sin(angle) * speed);
    p.setRotation(angle);
    p.setScale(1);
    p.dmg = dmg;
    p.pierceLeft = 999;
    p.life = 620;
    p.hitSet = new Set();
    p.setDepth(DEPTH.PROJECTILE);
    (p.body as Phaser.Physics.Arcade.Body).setSize(110, 14, true);
    audio.play('shoot');
  }

  // ---------- Ножи ----------
  fireKnife(x: number, y: number, angle: number, dmg: number, pierce: number): void {
    const p = this.acquire(this.knifePool, 'knife', this.knives);
    const speed = 840;
    p.setPosition(x, y);
    p.setVelocity(Math.cos(angle) * speed, Math.sin(angle) * speed);
    p.setRotation(angle);
    p.dmg = dmg;
    p.pierceLeft = pierce;
    p.life = 560;
    p.hitSet = new Set();
    p.setDepth(DEPTH.PROJECTILE);
    (p.body as Phaser.Physics.Arcade.Body).setSize(30, 12, true);
    audio.play('shoot');
  }

  // ---------- Стрелы врагов ----------
  enemyArrow(x: number, y: number, angle: number, dmg: number): void {
    const p = this.acquire(this.enemyArrowPool, 'arrow', this.enemyArrows);
    const speed = 380;
    p.setPosition(x, y);
    p.setVelocity(Math.cos(angle) * speed, Math.sin(angle) * speed);
    p.setRotation(angle);
    p.dmg = dmg;
    p.pierceLeft = 0;
    p.life = 2200;
    p.setDepth(DEPTH.PROJECTILE);
    (p.body as Phaser.Physics.Arcade.Body).setSize(24, 10, true);
    p.setTint(0xffb0a0);
  }

  // ---------- Бомба (навесная) ----------
  throwBomb(x: number, y: number, tx: number, ty: number, dmg: number, radius: number): void {
    const img = this.scene.add.image(x, y, 'barrel').setScale(0.5).setDepth(DEPTH.PROJECTILE);
    this.bombs.push({
      img,
      from: { x, y },
      to: { x: tx, y: ty },
      t: 0,
      dur: 620,
      dmg,
      radius,
    });
    audio.play('shoot');
  }

  update(dtMs: number): void {
    const dt = dtMs / 1000;
    this.updateProjs(this.arrowPool, dtMs);
    this.updateProjs(this.spearPool, dtMs);
    this.updateProjs(this.knifePool, dtMs);
    this.updateProjs(this.enemyArrowPool, dtMs);

    for (let i = this.bombs.length - 1; i >= 0; i--) {
      const b = this.bombs[i];
      b.t += dtMs;
      const k = Math.min(1, b.t / b.dur);
      const x = Phaser.Math.Linear(b.from.x, b.to.x, k);
      const y = Phaser.Math.Linear(b.from.y, b.to.y, k);
      const h = Math.sin(Math.PI * k) * 90; // псевдовысота дуги
      b.img.setPosition(x, y - h);
      b.img.setRotation(b.img.rotation + dt * 7);
      if (k >= 1) {
        b.img.destroy();
        this.bombs.splice(i, 1);
        this.ctx.onExplode(b.to.x, b.to.y, b.dmg, b.radius);
      }
    }
  }

  private updateProjs(pool: Proj[], dtMs: number): void {
    for (const p of pool) {
      if (!p.active) continue;
      p.life -= dtMs;
      if (p.life <= 0) this.release(p);
    }
  }

  private acquire(pool: Proj[], key: string, group: Phaser.Physics.Arcade.Group): Proj {
    let p = pool.find((x) => !x.active);
    if (!p) {
      const img = this.scene.physics.add.image(0, 0, key) as Proj;
      img.setActive(false).setVisible(false);
      group.add(img);
      pool.push(img);
      p = img;
    }
    p.setActive(true).setVisible(true);
    const b = p.body as Phaser.Physics.Arcade.Body;
    b.enable = true;
    b.setAllowGravity(false);
    p.clearTint();
    return p;
  }

  /** Урон по врагу от снаряда; true = снаряд исчерпал пробитие */
  consumePierce(p: Proj): boolean {
    p.pierceLeft -= 1;
    if (p.pierceLeft <= 0) {
      this.release(p);
      return true;
    }
    return false;
  }

  release(p: Proj): void {
    p.setActive(false).setVisible(false);
    (p.body as Phaser.Physics.Arcade.Body).enable = false;
    (p.body as Phaser.Physics.Arcade.Body).stop();
  }

  releaseEnemyArrow(p: Proj): void {
    this.release(p);
  }

  clear(): void {
    for (const p of [...this.arrowPool, ...this.spearPool, ...this.knifePool, ...this.enemyArrowPool]) this.release(p);
    for (const b of this.bombs) b.img.destroy();
    this.bombs = [];
  }
}
