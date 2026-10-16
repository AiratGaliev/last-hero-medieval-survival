import Phaser from 'phaser';
import { DEPTH, PROJECTILE_CAP } from '../constants';
import { audio } from './Audio';

// ============ Снаряды: стрелы, копья, бомбы (игрок) + стрелы врагов ============

export interface Proj extends Phaser.Physics.Arcade.Image {
  dmg: number;
  pierceLeft: number;
  life: number;
  hitSet?: Set<Phaser.GameObjects.Sprite>;
  /** Гунгнир: фаза возвращения (копьё разворачивается к игроку) */
  gungnir?: boolean;
  returned?: boolean;
}

interface Bomb {
  img: Phaser.GameObjects.Image;
  from: { x: number; y: number };
  to: { x: number; y: number };
  t: number;
  dur: number;
  dmg: number;
  radius: number;
  /** Мини-бомба кластера: не порождает новых мини-бомб */
  mini?: boolean;
}

export interface ProjectileCtx {
  onExplode(x: number, y: number, dmg: number, radius: number, mini?: boolean): void;
  /** Позиция игрока — для возврата Гунгнира */
  playerPos(): { x: number; y: number };
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
    if (!p) return;
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
    if (!p) return;
    const speed = 760;
    p.setPosition(x, y);
    p.setVelocity(Math.cos(angle) * speed, Math.sin(angle) * speed);
    p.setRotation(angle);
    p.setScale(1);
    p.dmg = dmg;
    p.pierceLeft = 999;
    p.life = 620;
    p.hitSet = new Set();
    p.gungnir = false;
    p.returned = false;
    p.setDepth(DEPTH.PROJECTILE);
    (p.body as Phaser.Physics.Arcade.Body).setSize(110, 14, true);
    audio.play('shoot');
  }

  // ---------- Гунгнир (эволюция копья): гигантское возвращающееся копьё ----------
  fireGungnir(x: number, y: number, angle: number, dmg: number): void {
    const p = this.acquire(this.spearPool, 'spear', this.spears);
    if (!p) return;
    const speed = 950;
    p.setPosition(x, y);
    p.setVelocity(Math.cos(angle) * speed, Math.sin(angle) * speed);
    p.setRotation(angle);
    p.setScale(1.9);
    p.setTint(0xffe9a0); // золотое свечение
    p.dmg = dmg;
    p.pierceLeft = 999;
    p.life = 1500;
    p.hitSet = new Set();
    p.gungnir = true;
    p.returned = false;
    p.setDepth(DEPTH.PROJECTILE);
    (p.body as Phaser.Physics.Arcade.Body).setSize(200, 26, true);
    audio.play('shoot');
  }

  // ---------- Ножи ----------
  fireKnife(x: number, y: number, angle: number, dmg: number, pierce: number, golden = false): void {
    const p = this.acquire(this.knifePool, 'knife', this.knives);
    if (!p) return;
    const speed = 840;
    p.setPosition(x, y);
    p.setVelocity(Math.cos(angle) * speed, Math.sin(angle) * speed);
    p.setRotation(angle);
    p.dmg = dmg;
    p.pierceLeft = pierce;
    p.life = 560;
    p.hitSet = new Set();
    p.setDepth(DEPTH.PROJECTILE);
    if (golden) p.setTint(0xffe9a0); // «Танец клинков»
    (p.body as Phaser.Physics.Arcade.Body).setSize(30, 12, true);
    audio.play('shoot');
  }

  // ---------- Стрелы врагов ----------
  enemyArrow(x: number, y: number, angle: number, dmg: number): void {
    const p = this.acquire(this.enemyArrowPool, 'arrow', this.enemyArrows);
    if (!p) return;
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
  throwBomb(x: number, y: number, tx: number, ty: number, dmg: number, radius: number, mini = false): void {
    // Динамит с горящим фитилём: снаряд — спрайт из того же спрайт-листа,
    // что и враг-камикадзе (ключ 'barrel' переиспользуется).
    const img = this.scene.add.sprite(x, y, 'barrel', 0)
      .setScale(mini ? 0.3 : 0.5)
      .setDepth(DEPTH.PROJECTILE)
      .setTint(mini ? 0xffc080 : 0xffffff)
      .play('barrel-burn');
    this.bombs.push({
      img,
      from: { x, y },
      to: { x: tx, y: ty },
      t: 0,
      dur: mini ? 340 : 620,
      dmg,
      radius,
      mini,
    });
    audio.play('shoot');
  }

  update(dtMs: number): void {
    const dt = dtMs / 1000;
    this.updateProjs(this.arrowPool, dtMs);
    this.updateSpears(dtMs);
    this.updateProjs(this.knifePool, dtMs);
    this.updateProjs(this.enemyArrowPool, dtMs);

    for (let i = this.bombs.length - 1; i >= 0; i--) {
      const b = this.bombs[i];
      b.t += dtMs;
      const k = Math.min(1, b.t / b.dur);
      const x = Phaser.Math.Linear(b.from.x, b.to.x, k);
      const y = Phaser.Math.Linear(b.from.y, b.to.y, k);
      const h = Math.sin(Math.PI * k) * (b.mini ? 46 : 90); // псевдовысота дуги
      b.img.setPosition(x, y - h);
      b.img.setRotation(b.img.rotation + dt * 7);
      if (k >= 1) {
        b.img.destroy();
        this.bombs.splice(i, 1);
        this.ctx.onExplode(b.to.x, b.to.y, b.dmg, b.radius, b.mini);
      }
    }
  }

  /** Копья: обычные живут 620мс; Гунгнир на полёте разворачивается к игроку
   *  и с чистым hitSet проходит сквозь врагов второй раз */
  private updateSpears(dtMs: number): void {
    const half = 700;
    for (const p of this.spearPool) {
      if (!p.active) continue;
      p.life -= dtMs;
      if (p.gungnir && !p.returned && p.life <= 1500 - half) {
        p.returned = true;
        p.hitSet = new Set();
        const pp = this.ctx.playerPos();
        const a = Math.atan2(pp.y - p.y, pp.x - p.x);
        p.setVelocity(Math.cos(a) * 900, Math.sin(a) * 900);
        p.setRotation(a);
      }
      if (p.life <= 0) this.release(p);
    }
  }

  private updateProjs(pool: Proj[], dtMs: number): void {
    for (const p of pool) {
      if (!p.active) continue;
      p.life -= dtMs;
      if (p.life <= 0) this.release(p);
    }
  }

  private acquire(pool: Proj[], key: string, group: Phaser.Physics.Arcade.Group): Proj | null {
    let p = pool.find((x) => !x.active);
    if (!p) {
      // Предел общего числа снарядов: иначе при высокой скоростре пул
      // рос бы неограниченно (PROJECTILE_CAP был объявлен, но не проверялся)
      if (!this.hasRoom) return null;
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
    p.setScale(1);
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

  /**
   * Убирает все снаряды с поля. Вызывается при победе и при поражении:
   * сцена ставится на паузу, projectiles.update() перестаёт вызываться,
   * и висящие в воздухе стрелы и бомбы оставались на экране результата.
   */
  /**
   * Сколько снарядов сейчас в обороте. Пулы растут до пиковой нагрузки и
   * держатся — это нормально, но общий размер ограничен, иначе при
   * долгом залпе пул вырос бы без предела.
   */
  get size(): number {
    return this.arrowPool.length + this.spearPool.length
      + this.knifePool.length + this.enemyArrowPool.length;
  }

  /** Есть ли свободный слот в общем пуле снарядов. */
  get hasRoom(): boolean {
    return this.size < PROJECTILE_CAP;
  }

  clear(): void {
    const pools = [this.arrowPool, this.spearPool, this.knifePool, this.enemyArrowPool];
    const done = new Set<Phaser.GameObjects.GameObject>();
    for (const pool of pools) {
      for (const p of pool) {
        if (done.has(p)) continue;
        done.add(p);
        this.release(p);
      }
    }
    for (const b of this.bombs) b.img.destroy();
    this.bombs = [];
  }
}
