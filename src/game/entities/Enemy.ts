import Phaser from 'phaser';
import { DEPTH, DESPAWN_DIST } from '../constants';
import { ENEMIES, type EnemyDef, type EnemyKind } from '../data';
import { audio } from '../systems/Audio';

// ============ Враг ============

export interface EnemyContext {
  playerX(): number;
  playerY(): number;
  onArcherShoot(x: number, y: number, tx: number, ty: number): void;
  onBossArrowRing(x: number, y: number): void;
  onMonkHeal(x: number, y: number): void;
  onBossSummon(x: number, y: number): void;
  onBomberExplode(x: number, y: number, self: Enemy, selfDestruct: boolean): void;
  enemiesNear(x: number, y: number, radius: number): Phaser.Physics.Arcade.Sprite[];
  healEnemy(e: Phaser.Physics.Arcade.Sprite, hp: number): void;
}

type AiState = 'chase' | 'windup' | 'charge' | 'recover' | 'flee';

export class Enemy extends Phaser.Physics.Arcade.Sprite {
  readonly def: EnemyDef;
  readonly kind: EnemyKind;
  hp: number;
  maxHp: number;
  speed: number;
  damage: number;
  xpValue: number;
  dead = false;   // защита от повторной обработки смерти
  aiState: AiState = 'chase';
  stateTimer = 0;
  private shootCd = 0;
  private healCd = 0;
  private summonCd = 8;
  private chargeDirX = 0;
  private chargeDirY = 0;
  private chargeCount = 0;
  private spinDir = 1; // направление вращения бочки
  private knockX = 0;
  private knockY = 0;
  private ctx: EnemyContext;
  private hpBar: Phaser.GameObjects.Graphics | null = null;
  private shadow: Phaser.GameObjects.Image;

  constructor(scene: Phaser.Scene, x: number, y: number, kind: EnemyKind, hpMult: number, dmgMult: number, ctx: EnemyContext) {
    const def = ENEMIES[kind];
    const texKey = kind === 'bomber' ? def.texture : `${Enemy.animPrefixOf(kind)}idle`;
    super(scene, x, y, texKey);
    this.def = def;
    this.kind = kind;
    this.ctx = ctx;
    this.maxHp = Math.round(def.hp * (def.isBoss || def.isElite || def.isMidboss ? 1 : hpMult));
    this.hp = this.maxHp;
    this.speed = def.speed;
    this.damage = Math.round(def.damage * (def.isBoss || def.isElite || def.isMidboss ? 1 : dmgMult));
    this.xpValue = def.xp;

    scene.add.existing(this);
    scene.physics.add.existing(this);
    this.setScale(def.scale);
    this.setDepth(DEPTH.ENTITY_BASE + y);
    if (kind === 'bomber') {
      // Бочка-камикадзе: без анимаций ходьбы, крутится при качении
      this.anims.stop();
      this.setFrame(0);
    } else {
      this.play(`${this.animPrefix()}idle`);
    }

    // Круглое тело у ног
    const frame = def.frameW;
    const cx = frame / 2;
    const cy = frame === 320 ? 258 : 150;
    const r = def.bodyRadius / def.scale;
    this.setCircle(r, cx - r, cy - r);
    this.setCollideWorldBounds(false);

    this.shadow = scene.add.image(x, y + 8 * def.scale, 'shadow')
      .setScale(0.2 * def.scale, 0.12 * def.scale)
      .setAlpha(0.3)
      .setDepth(DEPTH.SHADOW);

    if (this.def.isElite || this.def.isBoss || this.def.isMidboss) {
      this.hpBar = scene.add.graphics().setDepth(DEPTH.HUD);
    }
  }

  private static animPrefixOf(kind: EnemyKind): string {
    switch (kind) {
      case 'grunt': return 'grunt-';
      case 'swarm': case 'boss-minion': return 'swarm-';
      case 'brute': return 'brute-';
      case 'archer': return 'archer-';
      case 'bomber': return 'swarm-';
      case 'elite-lancer': return 'lancer-';
      case 'elite-monk': case 'midboss': return 'monk-';
      case 'boss': return 'boss-';
    }
  }

  private animPrefix(): string {
    return Enemy.animPrefixOf(this.kind);
  }

  takeDamage(dmg: number): boolean {
    if (this.dead) return false;
    this.hp -= dmg;
    // Вспышка урона (белая заливка в Phaser 4: setTint + FILL режим)
    this.setTint(0xffffff);
    this.setTintMode(Phaser.TintModes.FILL);
    this.scene.time.delayedCall(60, () => {
      if (this.active) {
        this.clearTint();
        this.setTintMode(Phaser.TintModes.MULTIPLY);
        if (this.kind === 'boss' && this.enraged) this.setTint(0xffb0b0);
      }
    });
    if (this.def.isElite || this.def.isBoss || this.def.isMidboss) this.drawHpBar();
    if (this.hp <= 0) this.dead = true;
    return this.hp <= 0;
  }

  knockback(vx: number, vy: number, force: number): void {
    const len = Math.max(1, Math.hypot(vx, vy));
    if (this.def.isBoss) force *= 0.15;
    else if (this.def.isMidboss) force *= 0.25;
    else if (this.def.isElite) force *= 0.4;
    this.knockX += (vx / len) * force;
    this.knockY += (vy / len) * force;
  }

  /** Лечение (монах) */
  heal(hp: number): void {
    if (this.hp >= this.maxHp) return;
    this.hp = Math.min(this.maxHp, this.hp + hp);
    if (this.def.isElite) this.drawHpBar();
  }

  preUpdate(time: number, delta: number): void {
    super.preUpdate(time, delta);
    if (!this.active) return;

    // Хитстоп: короткая заморозка врагов (реестр пишет GameScene)
    const freezeUntil = (this.scene.registry.get('tss-freeze') as number | undefined) ?? 0;
    if (time < freezeUntil) {
      const b = this.body as Phaser.Physics.Arcade.Body | null;
      if (b) b.setVelocity(0, 0);
      return;
    }

    const dt = delta / 1000;
    const px = this.ctx.playerX();
    const py = this.ctx.playerY();
    const dx = px - this.x;
    const dy = py - this.y;
    const dist = Math.max(1, Math.hypot(dx, dy));
    const nx = dx / dist, ny = dy / dist;

    let vx = 0, vy = 0;
    switch (this.kind) {
      case 'grunt': case 'swarm': case 'brute': case 'boss-minion':
        vx = nx * this.speed; vy = ny * this.speed;
        break;

      case 'bomber': {
        this.stateTimer -= delta;
        if (this.aiState === 'chase') {
          vx = nx * this.speed; vy = ny * this.speed;
          // Качение: вращение пропорционально скорости и направлению
          if (Math.abs(dx) > 12) this.spinDir = Math.sign(dx);
          this.rotation += (this.speed / 26) * dt * this.spinDir;
          if (dist < 115) {
            this.aiState = 'windup';
            this.stateTimer = 620;
            audio.play('slam');
          }
        } else if (this.aiState === 'windup') {
          // Телеграф: мигание + раздувание, затем взрыв
          const blink = Math.floor(this.stateTimer / 90) % 2 === 0;
          this.setTint(blink ? 0xff5540 : 0xffffff);
          this.setTintMode(Phaser.TintModes.FILL);
          const grow = 1 + (1 - Math.max(0, this.stateTimer) / 620) * 0.3;
          this.setScale(this.def.scale * grow);
          if (this.stateTimer <= 0) {
            this.ctx.onBomberExplode(this.x, this.y, this, true);
            return;
          }
        }
        break;
      }

      case 'archer': {
        this.shootCd -= delta;
        const want = 320;
        if (dist > want + 40) { vx = nx * this.speed; vy = ny * this.speed; }
        else if (dist < want - 60) { vx = -nx * this.speed; vy = -ny * this.speed; }
        else {
          // стрейф по касательной
          vx = -ny * this.speed * 0.6;
          vy = nx * this.speed * 0.6;
        }
        if (this.shootCd <= 0 && dist < 560 && this.aiState !== 'windup') {
          this.aiState = 'windup';
          this.play('archer-shoot', true);
          this.once('animationcomplete', (anim: Phaser.Animations.Animation) => {
            if (anim.key === 'archer-shoot' && this.active) {
              this.ctx.onArcherShoot(this.x, this.y, px, py);
              this.shootCd = 2200;
              this.aiState = 'chase';
              this.play('archer-run', true);
            }
          });
        }
        break;
      }

      case 'elite-lancer': {
        this.stateTimer -= delta;
        switch (this.aiState) {
          case 'chase':
            vx = nx * this.speed; vy = ny * this.speed;
            if (dist < 430) { this.aiState = 'windup'; this.stateTimer = 550; }
            break;
          case 'windup':
            // телеграф: дрожь и красный tint
            this.setTint(0xff8888);
            if (this.stateTimer <= 0) {
              this.clearTint();
              this.chargeDirX = nx; this.chargeDirY = ny;
              this.aiState = 'charge'; this.stateTimer = 700;
            }
            break;
          case 'charge':
            vx = this.chargeDirX * 430; vy = this.chargeDirY * 430;
            if (this.stateTimer <= 0) { this.aiState = 'recover'; this.stateTimer = 800; }
            break;
          case 'recover':
            if (this.stateTimer <= 0) this.aiState = 'chase';
            break;
          default: this.aiState = 'chase';
        }
        break;
      }

      case 'elite-monk':
      case 'midboss': {
        const isMid = this.kind === 'midboss';
        this.healCd -= delta;
        this.stateTimer -= delta;
        if (isMid) this.summonCd -= delta;
        const keep = isMid ? 340 : 240;
        if (dist < keep) { vx = -nx * this.speed * 1.3; vy = -ny * this.speed * 1.3; }
        else if (dist > (isMid ? 460 : 420)) { vx = nx * this.speed; vy = ny * this.speed; }
        else {
          vx = -ny * this.speed * 0.4; vy = nx * this.speed * 0.4;
        }
        if (isMid && this.summonCd <= 0 && this.hp < this.maxHp * 0.75) {
          this.ctx.onBossSummon(this.x, this.y);
          this.summonCd = 13;
        }
        if (this.healCd <= 0 && this.aiState !== 'windup') {
          const allies = this.ctx.enemiesNear(this.x, this.y, isMid ? 320 : 260)
            .filter((e) => (e as Enemy).hp < (e as Enemy).maxHp * 0.95);
          if (allies.length >= (isMid ? 1 : 2)) {
            this.aiState = 'windup';
            this.play('monk-heal', true);
            this.once('animationcomplete', (anim: Phaser.Animations.Animation) => {
              if (anim.key === 'monk-heal' && this.active) {
                this.ctx.onMonkHeal(this.x, this.y);
                this.healCd = isMid ? 2600 : 3500;
                this.aiState = 'chase';
                this.play('monk-run', true);
              }
            });
          } else {
            this.healCd = 900;
          }
        }
        break;
      }

      case 'boss': {
        this.updateBoss(dt, delta, dist, nx, ny);
        vx = this.bossVx; vy = this.bossVy;
        break;
      }
    }

    // Затухание отброса
    const decay = Math.pow(0.5, dt / 0.13);
    this.knockX *= decay; this.knockY *= decay;

    const body = this.body as Phaser.Physics.Arcade.Body;
    body.setVelocity(vx + this.knockX, vy + this.knockY);

    // Поворот по направлению движения
    if (Math.abs(body.velocity.x) > 8) this.setFlipX(body.velocity.x < 0);

    this.shadow.setPosition(this.x, this.y + 8 * this.def.scale);
    this.setDepth(DEPTH.ENTITY_BASE + this.y);
  }

  // ---- Фазы босса ----
  private bossVx = 0;
  private bossVy = 0;
  private bossTimer = 2500;
  private enraged = false;

  private updateBoss(dt: number, delta: number, dist: number, nx: number, ny: number): void {
    this.stateTimer -= delta;
    this.bossTimer -= delta;
    this.summonCd -= delta;
    const hpFrac = this.hp / this.maxHp;

    if (hpFrac < 0.3 && !this.enraged) {
      this.enraged = true;
      this.speed *= 1.35;
      this.setTint(0xffb0b0);
    }

    switch (this.aiState) {
      case 'chase':
        this.bossVx = nx * this.speed;
        this.bossVy = ny * this.speed;
        if (this.bossTimer <= 0 && dist < 900) {
          this.aiState = 'windup';
          this.stateTimer = 800;
          this.chargeCount = 3;
          this.setTint(0xff9090);
        }
        break;
      case 'windup':
        this.bossVx = 0; this.bossVy = 0;
        if (this.stateTimer <= 0) {
          this.clearTint();
          if (this.enraged) this.setTint(0xffb0b0);
          this.chargeDirX = nx; this.chargeDirY = ny;
          this.aiState = 'charge';
          this.stateTimer = 850;
          this.scene.cameras.main.shake(200, 0.004);
        }
        break;
      case 'charge':
        this.bossVx = this.chargeDirX * this.speed * 3.6;
        this.bossVy = this.chargeDirY * this.speed * 3.6;
        if (this.stateTimer <= 0) {
          this.chargeCount--;
          if (this.chargeCount > 0) {
            this.aiState = 'windup';
            this.stateTimer = 600;
            this.setTint(0xff9090);
          } else {
            this.aiState = 'recover';
            this.stateTimer = 900;
            if (this.enraged) this.ctx.onBossArrowRing(this.x, this.y);
          }
        }
        break;
      case 'recover':
        this.bossVx = 0; this.bossVy = 0;
        if (this.stateTimer <= 0) {
          this.aiState = 'chase';
          this.bossTimer = this.enraged ? 3500 : 5200;
        }
        break;
      default:
        this.aiState = 'chase';
    }

    // Зов свиты
    if (this.summonCd <= 0 && hpFrac < 0.65) {
      this.ctx.onBossSummon(this.x, this.y);
      this.summonCd = 11;
    }
  }

  private drawHpBar(): void {
    if (!this.hpBar) return;
    const w = this.def.isMidboss ? 90 : 70, h = 6;
    const x = this.x - w / 2, y = this.y - this.def.frameW * this.def.scale * 0.52;
    const g = this.hpBar;
    g.clear();
    g.fillStyle(0x1a0f08, 0.85).fillRoundedRect(x - 1, y - 1, w + 2, h + 2, 2);
    g.fillStyle(0x50120f).fillRect(x, y, w, h);
    const frac = Math.max(0, this.hp / this.maxHp);
    g.fillStyle(this.def.isMidboss ? 0x8a2be2 : 0xd03028).fillRect(x, y, Math.round(w * frac), h);
  }

  tooFar(): boolean {
    return Math.hypot(this.x - this.ctx.playerX(), this.y - this.ctx.playerY()) > DESPAWN_DIST
      && !this.def.isBoss && !this.def.isElite && !this.def.isMidboss;
  }

  destroy(fromScene?: boolean): void {
    this.shadow.destroy();
    this.hpBar?.destroy();
    super.destroy(fromScene);
  }
}
