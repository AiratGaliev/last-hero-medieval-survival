import Phaser from 'phaser';
import { DEPTH, GEM_CAP, WORLD } from '../constants';
import { audio } from './Audio';

// ============ Подбираемые предметы: XP-кристаллы, мясо, сундуки ============

interface Gem {
  img: Phaser.GameObjects.Image;
  value: number;
  xp: number;
  heal: number;
  gold: number;
  pulling: boolean;
  vx: number;
  vy: number;
  phase: number;
  kind: 'gem' | 'meat' | 'chest';
  glow?: Phaser.GameObjects.Sprite;
}

/**
 * Радиус схлопывания дропа (в единицах мира). Два кристалла, упавшие ближе
 * друг к другу, объединяются в один: опыт складывается, но на экране
 * остаётся в разы меньше пятен, и поле боя читается.
 */
const MERGE_RADIUS = 42;

export class Pickups {
  private scene: Phaser.Scene;
  private gems: Gem[] = [];
  private onXp: (v: number) => void;
  private onHeal: (v: number) => void;
  private onChest: (x: number, y: number) => void;
  private onGold: (v: number, x: number, y: number) => void;
  /** Контракт «Пацифист-герой» (§H.9): чистое золото не липнет к магниту —
   *  ценность уходит в отдельный счётчик через onGold при касании. */
  heroCollectsGold = true;

  constructor(
    scene: Phaser.Scene,
    onXp: (v: number) => void,
    onHeal: (v: number) => void,
    onChest: (x: number, y: number) => void,
    onGold: (v: number, x: number, y: number) => void = () => {},
  ) {
    this.scene = scene;
    this.onXp = onXp;
    this.onHeal = onHeal;
    this.onChest = onChest;
    this.onGold = onGold;
  }

  get count(): number {
    return this.gems.length;
  }

  /** Позиция активного сундука (для индикатора направления за экраном) */
  chestPos(): { x: number; y: number } | null {
    const c = this.gems.find((g) => g.kind === 'chest');
    return c ? { x: c.img.x, y: c.img.y } : null;
  }

  /**
   * Ближайший дроп заданного вида в радиусе. Используется при схлопывании,
   * чтобы вместо россыпи одинаковых кристаллов оставался один.
   */
  private nearestGem(x: number, y: number, r: number, kind: Gem['kind']): Gem | null {
    let best: Gem | null = null;
    let bestD = r * r;
    for (const g of this.gems) {
      if (g.kind !== kind) continue;
      const d = (g.img.x - x) ** 2 + (g.img.y - y) ** 2;
      if (d < bestD) { bestD = d; best = g; }
    }
    return best;
  }

  spawnGem(x: number, y: number, texture: string, xp: number): void {
    if (this.gems.length >= GEM_CAP) {
      // Переливаем в ближайший кристалл
      let best: Gem | null = null;
      let bestD = Infinity;
      for (const g of this.gems) {
        if (g.kind !== 'gem') continue;
        const d = (g.img.x - x) ** 2 + (g.img.y - y) ** 2;
        if (d < bestD) { bestD = d; best = g; }
      }
      if (best) best.xp += xp;
      return;
    }
    // Схлопывание: кристаллы, падающие рядом, объединяются в один.
    // Опыт не теряется — он просто переносится на соседний кристалл,
    // а на экране остаётся в разы меньше пятен, и поле боя читается.
    const near = this.nearestGem(x, y, MERGE_RADIUS, 'gem');
    if (near) {
      near.xp += xp;
      return;
    }
    const img = this.scene.add.image(x, y, texture)
      .setScale(texture === 'gem-red' ? 0.24 : 0.2)
      .setDepth(DEPTH.GEM);
    this.gems.push({
      img, value: 0, xp, heal: 0, gold: 0, pulling: false, vx: 0, vy: 0,
      phase: Math.random() * Math.PI * 2, kind: 'gem',
    });
  }

  /** Золотой кристалл: даёт золото при подборе */
  spawnGoldGem(x: number, y: number, gold = 5): void {
    if (this.gems.length >= GEM_CAP) {
      // Переливаем в ближайший кристалл (в виде XP-эквивалента)
      this.spawnGem(x, y, 'gem-blue', 1);
      return;
    }
    const near = this.nearestGem(x, y, MERGE_RADIUS, 'gem');
    if (near) {
      near.gold += gold;
      return;
    }
    const img = this.scene.add.image(x, y, 'gem-gold')
      .setScale(0.24)
      .setDepth(DEPTH.GEM);
    this.gems.push({
      img, value: 0, xp: 0, heal: 0, gold, pulling: false, vx: 0, vy: 0,
      phase: Math.random() * Math.PI * 2, kind: 'gem',
    });
  }

  /**
   * Мясо (лечение). Если кристаллов уже GEM_CAP, новый кусок не создаётся,
   * а лечение переливается в ближайшее мясо на земле — награда не теряется.
   */
  spawnMeat(x: number, y: number): void {
    if (this.gems.length >= GEM_CAP) {
      let best: Gem | null = null;
      let bestD = Infinity;
      for (const g of this.gems) {
        if (g.kind !== 'meat') continue;
        const d = (g.img.x - x) ** 2 + (g.img.y - y) ** 2;
        if (d < bestD) { bestD = d; best = g; }
      }
      if (best) best.heal += 30;
      return;
    }
    const near = this.nearestGem(x, y, MERGE_RADIUS, 'meat');
    if (near) {
      near.heal += 30;
      return;
    }
    const img = this.scene.add.image(x, y, 'meat').setScale(0.45).setDepth(DEPTH.GEM);
    this.gems.push({
      img, value: 0, xp: 0, heal: 30, gold: 0, pulling: false, vx: 0, vy: 0,
      phase: Math.random() * Math.PI * 2, kind: 'meat',
    });
  }

  /** Сундук-сокровище: подбирается касанием, вызывают onChest */
  spawnChest(x: number, y: number): void {
    // Только один активный сундук
    if (this.gems.some((g) => g.kind === 'chest')) return;
    const img = this.scene.add.image(x, y, 'treasure')
      .setScale(0.8)
      .setDepth(DEPTH.GEM);
    const glow = this.scene.add.sprite(x, y, 'fx-treasure')
      .setScale(1.15)
      .setDepth(DEPTH.GEM - 1)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setAlpha(0.9);
    glow.play('fx-treasure');
    // Мягкое покачивание
    this.scene.tweens.add({
      targets: [img, glow],
      y: y - 7,
      duration: 900,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
    this.gems.push({
      img, value: 0, xp: 0, heal: 0, gold: 0, pulling: false, vx: 0, vy: 0,
      phase: 0, kind: 'chest', glow,
    });
  }

  update(dtMs: number, px: number, py: number, magnetR: number, now: number): void {
    const dt = dtMs / 1000;
    for (let i = this.gems.length - 1; i >= 0; i--) {
      const g = this.gems[i];
      if (!g.img.active) { this.gems.splice(i, 1); continue; }
      const dx = px - g.img.x;
      const dy = py - g.img.y;
      const distSq = dx * dx + dy * dy;

      if (g.kind === 'chest') {
        if (distSq < 58 * 58) this.collectChest(i);
        continue;
      }

      // «Пацифист-герой» (§H.9): чисто золотые кристаллы не притягиваются
      // магнитом; герой наступил — ценность уходит через onGold (в отдельный
      // счётчик GameScene, не в золото матча)
      if (!this.heroCollectsGold && g.gold > 0 && g.xp === 0 && g.heal === 0) {
        if (distSq < 34 * 34) this.collect(i);
        continue;
      }

      if (g.pulling) {
        // Корень нужен только предметам, которые уже движутся к герою.
        const dist = Math.sqrt(distSq);
        const sp = Math.min(900, 420 + (900 - Math.min(900, dist)) * 0.6);
        g.vx = (dx / (dist || 1)) * sp;
        g.vy = (dy / (dist || 1)) * sp;
        g.img.x += g.vx * dt;
        g.img.y += g.vy * dt;
        if (distSq < 30 * 30) this.collect(i);
        continue;
      }

      if (distSq < magnetR * magnetR) {
        g.pulling = true;
        continue;
      }

      // Лёгкое покачивание
      g.img.y += Math.sin(now / 400 + g.phase) * 0.12;
      if (g.img.x < 0 || g.img.x > WORLD.SIZE || g.img.y < 0 || g.img.y > WORLD.SIZE) {
        this.destroyGem(g, i);
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
    if (g.gold > 0) {
      this.onGold(g.gold, g.img.x, g.img.y);
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

  private collectChest(index: number): void {
    const g = this.gems[index];
    this.scene.tweens.killTweensOf(g.img);
    if (g.glow) this.scene.tweens.killTweensOf(g.glow);
    const x = g.img.x;
    const y = g.img.y;
    g.glow?.destroy();
    this.scene.tweens.add({
      targets: g.img,
      scale: 1.3,
      alpha: 0,
      duration: 200,
      onComplete: () => g.img.destroy(),
    });
    this.gems.splice(index, 1);
    this.onChest(x, y);
  }

  private destroyGem(g: Gem, index: number): void {
    g.glow?.destroy();
    g.img.destroy();
    this.gems.splice(index, 1);
  }

  /** Собрать всё (победа/конец игры) */
  /**
   * Финальный вакуум при ПОБЕДЕ: кристаллы по-настоящему долетают до игрока
   * (tween), а их ценность выдаётся колбэком — золото/лечение/очки не теряются.
   * Вызывается ДО gameOver(): твины (~650 мс) успевают завершиться до паузы
   * сцены на экране статистики (gameOver ставит сцену на pause через 1900 мс).
   */
  finaleVacuum(px: number, py: number, onCollect: (g: { xp: number; gold: number; heal: number }) => void): void {
    for (let i = this.gems.length - 1; i >= 0; i--) {
      const g = this.gems[i];
      if (g.kind === 'chest') continue; // сундуки не собираем автоматом
      this.gems.splice(i, 1); // сразу исключаем из игровой логики
      const img = g.img;
      const d = Math.hypot(img.x - px, img.y - py);
      this.scene.tweens.add({
        targets: img,
        x: px,
        y: py,
        scale: img.scale * 0.35,
        duration: Math.min(620, 180 + d * 0.32),
        ease: 'Quad.easeIn',
        onComplete: () => {
          img.destroy();
          onCollect(g);
        },
      });
    }
  }

  destroy(): void {
    for (const g of this.gems) {
      g.glow?.destroy();
      g.img.destroy();
    }
    this.gems = [];
  }
}
