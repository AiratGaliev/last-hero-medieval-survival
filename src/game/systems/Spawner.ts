import Phaser from 'phaser';
import { ENEMY_CAP, WORLD } from '../constants';
import { WAVE_EVENTS, pickRegularKind, hpScale, dmgScale, DIFFICULTIES, type DifficultyId, type DifficultyDef, type EnemyKind } from '../data';
import { audio } from './Audio';

// ============ Директор волн: тайминг, состав, спец-события ============

export interface SpawnerCtx {
  spawn(kind: EnemyKind, x: number, y: number): void;
  spawnElite(kind: EnemyKind): void;
  spawnBoss(): void;
  playerX(): number;
  playerY(): number;
  announce(text: string, color?: string): void;
  spawnRadius(): number;
}

export class Spawner {
  private scene: Phaser.Scene;
  private ctx: SpawnerCtx;
  private timer = 1200;
  private interval = 850;
  private eventIdx = 0;
  private elapsed = 0;
  private diff: DifficultyDef;
  stopped = false;
  activeCount = 0;

  constructor(scene: Phaser.Scene, ctx: SpawnerCtx, difficulty: DifficultyId = 'normal') {
    this.scene = scene;
    this.ctx = ctx;
    this.diff = DIFFICULTIES[difficulty];
    this.interval = 850 * this.diff.rateMult;
    this.timer = 1200 * this.diff.rateMult;
  }

  get minute(): number {
    return this.elapsed / 60;
  }

  update(dtSec: number): void {
    if (this.stopped) return;
    this.elapsed += dtSec;

    // Обработка событий по таймингу
    while (this.eventIdx < WAVE_EVENTS.length && WAVE_EVENTS[this.eventIdx].t <= this.elapsed) {
      const ev = WAVE_EVENTS[this.eventIdx++];
      // Событие может быть привязано к конкретной сложности
      if (ev.diff && ev.diff !== this.diff.id) continue;
      switch (ev.type) {
        case 'rate':
          if (ev.interval) this.interval = ev.interval * this.diff.rateMult;
          break;
        case 'ring':
          if (ev.enemy && ev.count) this.spawnRing(ev.enemy, ev.count);
          break;
        case 'elite':
          if (ev.enemy) {
            audio.play('boss');
            const label = ev.enemy === 'elite-lancer'
              ? 'ЭЛИТА: КОПЕЙЩИК!'
              : ev.enemy === 'midboss'
                ? 'БОСС: ТЁМНЫЙ МОНАХ!'
                : 'ЭЛИТА: ТЁМНЫЙ МОНАХ!';
            this.ctx.announce(label, '#ff5544');
            this.ctx.spawnElite(ev.enemy);
          }
          break;
        case 'boss':
          audio.play('boss');
          this.ctx.announce('БОСС! ЧЁРНЫЙ КОПЕЙЩИК!', '#ff2222');
          this.ctx.spawnBoss();
          this.stopped = true;
          break;
      }
    }

    // Регулярный спавн
    this.timer -= dtSec * 1000;
    if (this.timer <= 0) {
      this.timer += this.interval;
      if (this.activeCount < ENEMY_CAP) {
        const kind = pickRegularKind(this.minute, Math.random);
        this.spawnAtEdge(kind);
      }
    }
  }

  /** Кольцо врагов вокруг игрока */
  spawnRing(kind: EnemyKind, count: number): void {
    const r = this.ctx.spawnRadius();
    const cx = this.ctx.playerX();
    const cy = this.ctx.playerY();
    const m = WORLD.GRASS_MARGIN + 60;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.2;
      let x = cx + Math.cos(a) * r;
      let y = cy + Math.sin(a) * r;
      x = Phaser.Math.Clamp(x, m, WORLD.SIZE - m);
      y = Phaser.Math.Clamp(y, m, WORLD.SIZE - m);
      this.ctx.spawn(kind, x, y);
    }
  }

  /** Спавн за экраном в случайном направлении */
  spawnAtEdge(kind: EnemyKind): void {
    const r = this.ctx.spawnRadius() * (0.85 + Math.random() * 0.3);
    const a = Math.random() * Math.PI * 2;
    const cx = this.ctx.playerX();
    const cy = this.ctx.playerY();
    const m = WORLD.GRASS_MARGIN + 50;
    let x = cx + Math.cos(a) * r;
    let y = cy + Math.sin(a) * r;
    // Если точка за пределами мира — прижимаем внутрь
    if (x < m || x > WORLD.SIZE - m || y < m || y > WORLD.SIZE - m) {
      const toC = Math.atan2(WORLD.SIZE / 2 - cy, WORLD.SIZE / 2 - cx);
      x = cx + Math.cos(toC) * r;
      y = cy + Math.sin(toC) * r;
      x = Phaser.Math.Clamp(x, m, WORLD.SIZE - m);
      y = Phaser.Math.Clamp(y, m, WORLD.SIZE - m);
    }
    this.ctx.spawn(kind, x, y);
  }

  get hpMult(): number { return hpScale(this.minute) * this.diff.hpMult; }
  get dmgMult(): number { return dmgScale(this.minute) * this.diff.dmgMult; }
}
