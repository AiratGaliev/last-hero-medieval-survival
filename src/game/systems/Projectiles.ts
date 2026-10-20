import Phaser from 'phaser';
import { DEPTH, PROJECTILE_CAP } from '../constants';
import { audio } from './Audio';
import type { EnemyShotKind } from '../entities/Enemy';

// ============ Снаряды: стрелы, копья, бомбы (игрок) + снаряды существ ============

export interface Proj extends Phaser.Physics.Arcade.Image {
  dmg: number;
  pierceLeft: number;
  life: number;
  hitSet?: Set<Phaser.GameObjects.Sprite>;
  /** Гунгнир: фаза возвращения (копьё разворачивается к игроку) */
  gungnir?: boolean;
  returned?: boolean;
  /** Стрела NPC-лучника — бьёт врагов, дружественная (§M) */
  friendly?: boolean;
}

/** Анимированный снаряд существа (кость гнолла / шар шамана) */
interface EnemyShot extends Phaser.Physics.Arcade.Sprite {
  dmg: number;
  pierceLeft: number;
  life: number;
  shotKind?: EnemyShotKind;
  /** Цель-здание осады (§E.4): снаряд летит к точке и наносит урон */
  targetB?: { x: number; y: number } | null;
  fire?: boolean;
  onArrive?: (s: EnemyShot) => void;
  /** Переиспользуемые спрайты пламени позади огненной стрелы. */
  trailSprites?: Phaser.GameObjects.Sprite[];
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

/** Параметры снарядов существ: кость, магический шар и гарпун. */
const ENEMY_SHOTS: Record<EnemyShotKind, { tex: string; anim?: string; speed: number; life: number; body: number; scale: number }> = {
  bone:    { tex: 'proj-bone', anim: 'proj-bone-spin', speed: 340, life: 2200, body: 26, scale: 1 },
  hex:     { tex: 'proj-hex',  anim: 'proj-hex-orb',  speed: 300, life: 2600, body: 30, scale: 1 },
  harpoon: { tex: 'proj-harpoon', speed: 320, life: 2400, body: 22, scale: 0.72 },
};

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
  /** Снаряды врагов: вращающаяся кость и магический шар (спрайты с анимацией) */
  enemyShots: Phaser.Physics.Arcade.Group;
  /** Стрелы NPC-лучника (гарнизон) — не путать с enemyShots (§M) */
  friendlyArrows: Phaser.Physics.Arcade.Group;
  private arrowPool: Proj[] = [];
  private spearPool: Proj[] = [];
  private knifePool: Proj[] = [];
  private enemyShotPool: EnemyShot[] = [];
  /** Осада: отдельный пул стрелы и повторно используемый шлейф пламени (§K). */
  private fireArrowPool: EnemyShot[] = [];
  private friendlyArrowPool: Proj[] = [];
  private bombs: Bomb[] = [];

  constructor(scene: Phaser.Scene, ctx: ProjectileCtx) {
    this.scene = scene;
    this.ctx = ctx;
    this.arrows = scene.physics.add.group({ allowGravity: false });
    this.spears = scene.physics.add.group({ allowGravity: false });
    this.knives = scene.physics.add.group({ allowGravity: false });
    this.enemyShots = scene.physics.add.group({ allowGravity: false });
    this.friendlyArrows = scene.physics.add.group({ allowGravity: false });
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

  // ---------- Снаряды врагов: кость гнолла / шар шамана ----------
  shootEnemy(kind: EnemyShotKind, x: number, y: number, angle: number, dmg: number): void {
    const p = this.acquireShot(kind);
    if (!p) return;
    const cfg = ENEMY_SHOTS[kind];
    p.shotKind = kind;
    p.targetB = null;
    p.onArrive = undefined;
    p.fire = false;
    p.setPosition(x, y);
    p.setVelocity(Math.cos(angle) * cfg.speed, Math.sin(angle) * cfg.speed);
    p.setRotation(angle);
    p.dmg = dmg;
    p.pierceLeft = 0;
    p.life = cfg.life;
    p.setDepth(DEPTH.PROJECTILE);
    p.setScale(cfg.scale);
    const body = p.body as Phaser.Physics.Arcade.Body;
    body.setSize(cfg.body, cfg.body, true);
    audio.play('shoot');
  }

  /** Бросок по зданию осады (§E.4.1): снаряд летит к точке и наносит урон. */
  shootAtBuilding(
    kind: EnemyShotKind, x: number, y: number, tx: number, ty: number,
    dmg: number, fire: boolean, onArrive: (s: EnemyShot) => void,
  ): void {
    const p = fire ? this.acquireFireArrow() : this.acquireShot(kind);
    if (!p) return;
    const cfg = ENEMY_SHOTS[kind];
    p.shotKind = kind;
    p.fire = fire;
    p.onArrive = onArrive;
    p.targetB = { x: tx, y: ty };
    p.setPosition(x, y);
    const a = Math.atan2(ty - y, tx - x);
    p.setVelocity(Math.cos(a) * cfg.speed, Math.sin(a) * cfg.speed);
    p.setRotation(a);
    p.dmg = dmg;
    p.pierceLeft = 0;
    p.life = cfg.life;
    p.setDepth(DEPTH.PROJECTILE);
    const body = p.body as Phaser.Physics.Arcade.Body;
    if (fire) {
      // Исходная разноцветная arrow.png не окрашивается tint-ом: она летит
      // вместе со шлейфом частиц fire-01, как отдельный огненный снаряд.
      p.setScale(0.7);
      body.setSize(34, 10, true);
    } else {
      p.setScale(cfg.scale);
      body.setSize(cfg.body, cfg.body, true);
    }
    audio.play('shoot');
  }

  /** Стрела NPC-лучника (§M): отдельный пул с флагом friendly. */
  fireFriendlyArrow(x: number, y: number, angle: number, dmg: number): void {
    let p = this.friendlyArrowPool.find((q) => !q.active);
    if (!p) {
      if (!this.hasRoom) return;
      p = this.scene.physics.add.image(0, 0, 'arrow') as Proj;
      p.setActive(false).setVisible(false);
      this.friendlyArrows.add(p);
      this.friendlyArrowPool.push(p);
    }
    p.setActive(true).setVisible(true);
    p.friendly = true;
    p.clearTint();
    p.setScale(1);
    p.setRotation(0);
    p.setPosition(x, y);
    p.setVelocity(Math.cos(angle) * 620, Math.sin(angle) * 620);
    p.setRotation(angle);
    p.dmg = dmg;
    p.pierceLeft = 0;
    p.life = 1200;
    p.hitSet = new Set();
    p.setDepth(DEPTH.PROJECTILE);
    (p.body as Phaser.Physics.Arcade.Body).setSize(30, 10, true);
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
    this.updateProjs(this.friendlyArrowPool, dtMs);
    this.updateEnemyShots(dtMs);

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

  /** Снаряды врагов: у броска по зданию — прибытие к цели (§E.4.1). */
  private updateEnemyShots(dtMs: number): void {
    this.updateEnemyShotPool(this.enemyShotPool, dtMs);
    this.updateEnemyShotPool(this.fireArrowPool, dtMs);
  }

  private updateEnemyShotPool(pool: EnemyShot[], dtMs: number): void {
    for (const p of pool) {
      if (!p.active) continue;
      p.life -= dtMs;
      if (p.fire) this.updateFireTrail(p);
      if (p.targetB) {
        const d = Math.hypot(p.x - p.targetB.x, p.y - p.targetB.y);
        if (d < 48) {
          const cb = p.onArrive;
          this.release(p as unknown as Proj);
          cb?.(p);
          continue;
        }
      }
      if (p.life <= 0) this.release(p as unknown as Proj);
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
    p.setRotation(0);
    return p;
  }

  /** Спрайтовый пул снарядов врагов: у кости и шара свои анимации */
  private acquireShot(kind: EnemyShotKind): EnemyShot | null {
    const cfg = ENEMY_SHOTS[kind];
    let p = this.enemyShotPool.find((x) => !x.active && x.shotKind === kind);
    if (!p) {
      if (!this.hasRoom) return null;
      const spr = this.scene.physics.add.sprite(0, 0, cfg.tex) as EnemyShot;
      spr.setActive(false).setVisible(false);
      this.enemyShots.add(spr);
      this.enemyShotPool.push(spr);
      p = spr;
    }
    p.setActive(true).setVisible(true);
    const b = p.body as Phaser.Physics.Arcade.Body;
    b.enable = true;
    b.setAllowGravity(false);
    p.clearTint();
    p.setScale(cfg.scale);
    if (cfg.anim) p.play(cfg.anim, true);
    else p.stop();
    return p;
  }

  /** Получить огненную стрелу из отдельного ограниченного пула. */
  private acquireFireArrow(): EnemyShot | null {
    let p = this.fireArrowPool.find((shot) => !shot.active);
    if (!p) {
      if (!this.hasRoom) return null;
      p = this.scene.physics.add.sprite(0, 0, 'arrow') as EnemyShot;
      p.setActive(false).setVisible(false);
      p.trailSprites = Array.from({ length: 3 }, (_, index) => {
        const flame = this.scene.add.sprite(0, 0, 'fx-fire')
          .setScale(0.36 - index * 0.04)
          .setDepth(DEPTH.PROJECTILE - 1);
        flame.setActive(false).setVisible(false);
        return flame;
      });
      this.enemyShots.add(p);
      this.fireArrowPool.push(p);
    }
    p.setActive(true).setVisible(true);
    const body = p.body as Phaser.Physics.Arcade.Body;
    body.enable = true;
    body.setAllowGravity(false);
    p.clearTint();
    p.setTexture('arrow');
    p.setScale(0.7);
    p.setDepth(DEPTH.PROJECTILE);
    for (const [index, flame] of (p.trailSprites ?? []).entries()) {
      flame.setActive(true).setVisible(true).setAlpha(0.85 - index * 0.18);
      flame.play('fire-arrow-trail', true);
    }
    return p;
  }

  /** Переставить частицы за стрелой по её текущему вектору скорости. */
  private updateFireTrail(p: EnemyShot): void {
    if (!p.active || !p.trailSprites?.length) return;
    const velocity = (p.body as Phaser.Physics.Arcade.Body).velocity;
    const angle = Math.atan2(velocity.y, velocity.x);
    p.trailSprites.forEach((flame, index) => {
      const distance = 20 + index * 17;
      flame.setPosition(
        p.x - Math.cos(angle) * distance,
        p.y - Math.sin(angle) * distance,
      );
      flame.setRotation(angle);
    });
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
    const shot = p as unknown as EnemyShot;
    shot.targetB = null;
    shot.onArrive = undefined;
    shot.fire = false;
    for (const flame of shot.trailSprites ?? []) {
      flame.setActive(false).setVisible(false);
    }
  }

  releaseEnemyShot(p: Proj): void {
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
      + this.knifePool.length + this.enemyShotPool.length
      + this.fireArrowPool.length + this.friendlyArrowPool.length;
  }

  /** Есть ли свободный слот в общем пуле снарядов. */
  get hasRoom(): boolean {
    return this.size < PROJECTILE_CAP;
  }

  clear(): void {
    const pools: Array<Array<Proj>> = [
      this.arrowPool, this.spearPool, this.knifePool,
      this.enemyShotPool as unknown as Proj[],
      this.fireArrowPool as unknown as Proj[], this.friendlyArrowPool,
    ];
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
