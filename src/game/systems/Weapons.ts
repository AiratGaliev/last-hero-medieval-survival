import Phaser from 'phaser';
import { DEPTH } from '../constants';
import { WEAPONS, type WeaponId } from '../data';
import type { Enemy } from '../entities/Enemy';
import type { Player } from '../entities/Player';
import type { Projectiles } from './Projectiles';
import type { Effects } from './Effects';
import { audio } from './Audio';

// ============ Система оружия: автоатаки по кулдаунам ============

export interface WeaponCtx {
  player(): Phaser.Physics.Arcade.Sprite;
  enemies(): Enemy[];
  damageEnemy(e: Enemy, dmg: number, kx?: number, ky?: number, force?: number): void;
  projectiles(): Projectiles;
  effects(): Effects;
  moveDir(): { x: number; y: number };
  mightMult(): number;
  cdMult(): number;
}

export class WeaponSystem {
  private scene: Phaser.Scene;
  private ctx: WeaponCtx;
  private levels = new Map<WeaponId, number>();
  private cooldowns = new Map<WeaponId, number>();
  private auraEmitter: Phaser.GameObjects.Particles.ParticleEmitter | null = null;
  private auraRing: Phaser.GameObjects.Arc | null = null;
  private lastMove = { x: 1, y: 0 };

  constructor(scene: Phaser.Scene, ctx: WeaponCtx) {
    this.scene = scene;
    this.ctx = ctx;
  }

  add(id: WeaponId): void {
    if (this.levels.has(id)) return;
    this.levels.set(id, 1);
    this.cooldowns.set(id, 300);
    if (id === 'aura') this.setupAuraVisual();
  }

  upgrade(id: WeaponId): void {
    const lvl = this.levels.get(id);
    if (lvl === undefined || lvl >= 5) return;
    this.levels.set(id, lvl + 1);
    if (id === 'aura') this.setupAuraVisual();
  }

  level(id: WeaponId): number {
    return this.levels.get(id) ?? 0;
  }

  has(id: WeaponId): boolean {
    return this.levels.has(id);
  }

  ownedIds(): WeaponId[] {
    return [...this.levels.keys()];
  }

  /** Кулдаун с учётом Ловкости */
  private effCd(id: WeaponId): number {
    const lvl = this.levels.get(id)!;
    return WEAPONS[id].levels[lvl - 1].cd * this.ctx.cdMult();
  }

  update(dtMs: number): void {
    for (const id of this.levels.keys()) {
      let cd = (this.cooldowns.get(id) ?? 0) - dtMs;
      if (cd <= 0) {
        cd = this.effCd(id);
        this.fire(id);
      }
      this.cooldowns.set(id, cd);
    }
    this.updateAuraVisual();
  }

  private nearestEnemies(count: number): Enemy[] {
    const p = this.ctx.player();
    const list = this.ctx.enemies()
      .map((e) => ({ e, d: (e.x - p.x) ** 2 + (e.y - p.y) ** 2 }))
      .filter((v) => v.d < 620 * 620)
      .sort((a, b) => a.d - b.d)
      .slice(0, count)
      .map((v) => v.e);
    return list;
  }

  private fire(id: WeaponId): void {
    const lvl = this.levels.get(id)!;
    const w = WEAPONS[id].levels[lvl - 1];
    switch (id) {
      case 'sword': this.fireSword(w.dmg, w.count ?? 1); break;
      case 'bow': this.fireBow(w.dmg, w.count ?? 1, w.pierce ?? 1); break;
      case 'spear': this.fireSpear(w.dmg, w.count ?? 1); break;
      case 'hammer': this.fireHammer(w.dmg, w.radius ?? 110, w.count ?? 1); break;
      case 'bomb': this.fireBomb(w.dmg, w.radius ?? 130, w.count ?? 1); break;
      case 'aura': this.fireAura(w.dmg, w.radius ?? 90); break;
    }
  }

  // ---------- МЕЧ: вихрь ----------
  private fireSword(dmg: number, count: number): void {
    const p = this.ctx.player();
    const nearest = this.nearestEnemies(1);
    let angle = this.ctx.moveDir().x !== 0 || this.ctx.moveDir().y !== 0
      ? Math.atan2(this.ctx.moveDir().y, this.ctx.moveDir().x)
      : (p.flipX ? Math.PI : 0);
    if (nearest.length > 0) angle = Math.atan2(nearest[0].y - p.y, nearest[0].x - p.x);
    for (let i = 0; i < count; i++) {
      const a = angle + (i === 1 ? Math.PI : 0);
      this.scene.time.delayedCall(i * 240, () => this.swordSwing(a, dmg));
    }
  }

  private swordSwing(angle: number, dmg: number): void {
    const p = this.ctx.player();
    if (!p.active) return;
    // Визуал: полумесяц
    const slash = this.scene.add.image(p.x, p.y, 'slash')
      .setScale(0.85)
      .setRotation(angle)
      .setDepth(DEPTH.FX - 5)
      .setAlpha(0.95);
    this.scene.tweens.add({
      targets: slash,
      scale: 1.1,
      alpha: 0,
      duration: 190,
      ease: 'Quad.easeOut',
      onComplete: () => slash.destroy(),
    });
    // Анимация удара игрока
    (p as Player).playAttack(Math.random() < 0.5);
    // Урон в секторе
    const range = 130;
    const arcHalf = Phaser.Math.DegToRad(75);
    for (const e of this.ctx.enemies()) {
      const dx = e.x - p.x, dy = e.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d > range + e.def.bodyRadius) continue;
      let diff = Math.abs(Phaser.Math.Angle.Wrap(Math.atan2(dy, dx) - angle));
      if (diff <= arcHalf) {
        this.ctx.damageEnemy(e, dmg, dx, dy, 130);
      }
    }
  }

  // ---------- ЛУК: самонаведение ----------
  private fireBow(dmg: number, count: number, pierce: number): void {
    const p = this.ctx.player();
    const targets = this.nearestEnemies(count);
    if (targets.length === 0) return;
    for (let i = 0; i < count; i++) {
      const t = targets[Math.min(i, targets.length - 1)];
      const a = Math.atan2(t.y - p.y, t.x - p.x) + (i - (count - 1) / 2) * 0.14;
      this.ctx.projectiles().fireArrow(p.x, p.y, a, dmg, pierce);
    }
  }

  // ---------- КОПЬЁ: по направлению движения ----------
  private fireSpear(dmg: number, count: number): void {
    const p = this.ctx.player();
    const dir = this.ctx.moveDir();
    const base = Math.atan2(dir.y, dir.x);
    for (let i = 0; i < count; i++) {
      const a = base + (i - (count - 1) / 2) * 0.1;
      this.scene.time.delayedCall(i * 70, () => {
        if (p.active) this.ctx.projectiles().fireSpear(p.x, p.y, a, dmg);
      });
    }
  }

  // ---------- МОЛОТ: AoE слэм ----------
  private fireHammer(dmg: number, radius: number, count: number): void {
    const p = this.ctx.player();
    for (let i = 0; i < count; i++) {
      this.scene.time.delayedCall(i * 260, () => {
        if (!p.active) return;
        const targets = this.nearestEnemies(6);
        if (targets.length === 0) return;
        const t = targets[Phaser.Math.Between(0, Math.min(2, targets.length - 1))];
        this.hammerSlam(t.x, t.y, dmg, radius);
      });
    }
  }

  private hammerSlam(x: number, y: number, dmg: number, radius: number): void {
    const ring = this.scene.add.image(x, y, 'aoe-ring')
      .setScale(radius / 110)
      .setDepth(DEPTH.FX - 10)
      .setAlpha(0.9);
    this.scene.tweens.add({
      targets: ring,
      alpha: 0.25,
      scale: (radius / 110) * 1.15,
      duration: 360,
      yoyo: true,
      onComplete: () => {
        ring.destroy();
        // Удар!
        this.ctx.effects().dust(x, y, 6);
        this.ctx.effects().explosion(x, y, 0.6, 1);
        audio.play('slam');
        this.scene.cameras.main.shake(120, 0.003);
        for (const e of this.ctx.enemies()) {
          const dx = e.x - x, dy = e.y - y;
          if (Math.hypot(dx, dy) <= radius + e.def.bodyRadius) {
            this.ctx.damageEnemy(e, dmg, dx, dy, 260);
          }
        }
      },
    });
  }

  // ---------- БОМБА: навесной бросок ----------
  private fireBomb(dmg: number, radius: number, count: number): void {
    const p = this.ctx.player();
    for (let i = 0; i < count; i++) {
      this.scene.time.delayedCall(i * 300, () => {
        if (!p.active) return;
        const targets = this.nearestEnemies(12);
        if (targets.length === 0) return;
        const t = targets[Phaser.Math.Between(0, targets.length - 1)];
        const body = t.body as Phaser.Physics.Arcade.Body;
        const tx = t.x + body.velocity.x * 0.35;
        const ty = t.y + body.velocity.y * 0.35;
        this.ctx.projectiles().throwBomb(p.x, p.y, tx, ty, dmg, radius);
      });
    }
  }

  // ---------- АУРА: огненное кольцо ----------
  private fireAura(dmg: number, radius: number): void {
    const p = this.ctx.player();
    for (const e of this.ctx.enemies()) {
      const dx = e.x - p.x, dy = e.y - p.y;
      if (Math.hypot(dx, dy) <= radius + e.def.bodyRadius) {
        this.ctx.damageEnemy(e, dmg, 0, 0, 0);
      }
    }
  }

  private setupAuraVisual(): void {
    const p = this.ctx.player();
    if (this.auraEmitter) this.auraEmitter.destroy();
    if (this.auraRing) this.auraRing.destroy();
    const id = 'aura' as WeaponId;
    const lvl = this.levels.get(id) ?? 1;
    const radius = WEAPONS[id].levels[lvl - 1].radius ?? 90;
    this.auraEmitter = this.scene.add.particles(0, 0, 'fx-fire', {
      frame: [0, 1, 2, 3, 4, 5, 6, 7],
      speed: { min: 10, max: 40 },
      scale: { start: 0.55, end: 0.15 },
      alpha: { start: 0.8, end: 0 },
      lifespan: { min: 350, max: 600 },
      frequency: 60,
      blendMode: 'ADD',
      followOffset: { x: 0, y: -8 },
    });
    this.auraEmitter.setDepth(DEPTH.FX - 8);
    this.auraEmitter.startFollow(p);
    this.auraRing = this.scene.add.circle(0, 0, radius)
      .setStrokeStyle(2, 0xff7733, 0.35)
      .setDepth(DEPTH.FX - 9);
    this.auraRing.setPosition(p.x, p.y);
  }

  private updateAuraVisual(): void {
    if (!this.auraRing || !this.levels.has('aura')) return;
    const p = this.ctx.player();
    const lvl = this.levels.get('aura')!;
    const radius = WEAPONS['aura'].levels[lvl - 1].radius ?? 90;
    this.auraRing.setPosition(p.x, p.y);
    this.auraRing.setRadius(radius);
    const pulse = 0.25 + Math.abs(Math.sin(this.scene.time.now / 300)) * 0.2;
    this.auraRing.setStrokeStyle(2, 0xff7733, pulse);
  }

  destroy(): void {
    this.auraEmitter?.destroy();
    this.auraRing?.destroy();
  }
}
