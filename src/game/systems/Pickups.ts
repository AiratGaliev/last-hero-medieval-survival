import Phaser from 'phaser';
import { DEPTH, GEM_CAP } from '../constants';
import { audio } from './Audio';

// ============ Подбираемые предметы: XP-кристаллы и мясо ============

interface Gem {
  img: Phaser.GameObjects.Image;
  value: number;
  xp: number;
  heal: number;
  pulling: boolean;
  vx: number;
  vy: number;
  phase: number;
}

export class Pickups {
  private scene: Phaser.Scene;
  private gems: Gem[] = [];
  private onXp: (v: number) => void;
  private onHeal: (v: number) => void;

  constructor(scene: Phaser.Scene, onXp: (v: number) => void, onHeal: (v: number) => void) {
    this.scene = scene;
    this.onXp = onXp;
    this.onHeal = onHeal;
  }

  get count(): number {
    return this.gems.length;
  }

  spawnGem(x: number, y: number, texture: string, xp: number): void {
    if (this.gems.length >= GEM_CAP) {
      // Переливаем в ближайший кристалл
      let best: Gem | null = null;
      let bestD = Infinity;
      for (const g of this.gems) {
        const d = (g.img.x - x) ** 2 + (g.img.y - y) ** 2;
        if (d < bestD) { bestD = d; best = g; }
      }
      if (best) best.xp += xp;
      return;
    }
    const img = this.scene.add.image(x, y, texture)
      .setScale(texture === 'gem-red' ? 0.5 : 0.42)
      .setDepth(DEPTH.GEM);
    this.gems.push({
      img, value: 0, xp, heal: 0, pulling: false, vx: 0, vy: 0,
      phase: Math.random() * Math.PI * 2,
    });
  }

  spawnMeat(x: number, y: number): void {
    const img = this.scene.add.image(x, y, 'meat').setScale(0.55).setDepth(DEPTH.GEM);
    this.gems.push({
      img, value: 0, xp: 0, heal: 30, pulling: false, vx: 0, vy: 0,
      phase: Math.random() * Math.PI * 2,
    });
  }

  update(dtMs: number, px: number, py: number, magnetR: number, now: number): void {
    const dt = dtMs / 1000;
    for (let i = this.gems.length - 1; i >= 0; i--) {
      const g = this.gems[i];
      if (!g.img.active) { this.gems.splice(i, 1); continue; }
      const dx = px - g.img.x;
      const dy = py - g.img.y;
      const dist = Math.hypot(dx, dy);

      if (g.pulling) {
        // Притяжение к игроку с ускорением
        const sp = Math.min(900, 420 + (900 - Math.min(900, dist)) * 0.6);
        g.vx = (dx / (dist || 1)) * sp;
        g.vy = (dy / (dist || 1)) * sp;
        g.img.x += g.vx * dt;
        g.img.y += g.vy * dt;
        if (dist < 30) this.collect(i);
        continue;
      }

      if (dist < magnetR) {
        g.pulling = true;
        continue;
      }

      // Лёгкое покачивание
      g.img.y += Math.sin(now / 400 + g.phase) * 0.12;
      if (g.img.x < 0 || g.img.x > 3200 || g.img.y < 0 || g.img.y > 3200) {
        g.img.destroy();
        this.gems.splice(i, 1);
      }
    }
  }

  private collect(index: number): void {
    const g = this.gems[index];
    if (g.xp > 0) {
      this.onXp(g.xp);
      audio.play('pickup');
    }
    if (g.heal > 0) {
      this.onHeal(g.heal);
      audio.play('pickup');
    }
    this.scene.tweens.add({
      targets: g.img,
      scale: g.img.scale * 1.5,
      alpha: 0,
      duration: 130,
      onComplete: () => g.img.destroy(),
    });
    this.gems.splice(index, 1);
  }

  /** Собрать всё (победа/конец игры) */
  vacuumAll(px: number, py: number): void {
    for (const g of this.gems) {
      g.pulling = true;
      g.img.x = Phaser.Math.Linear(g.img.x, px, 0.5);
      g.img.y = Phaser.Math.Linear(g.img.y, py, 0.5);
    }
  }

  destroy(): void {
    for (const g of this.gems) g.img.destroy();
    this.gems = [];
  }
}
