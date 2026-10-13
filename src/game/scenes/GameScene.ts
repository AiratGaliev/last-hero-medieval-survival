import Phaser from 'phaser';
import {
  WORLD, PLAYER_BASE, DEPTH, ENEMY_CAP, SCORE, XP_CURVE,
} from '../constants';
import {
  WEAPONS, PASSIVES, HEROES, ENEMIES, DIFFICULTIES,
  type WeaponId, type PassiveId, type EnemyKind, type UpgradeCard, type HeroId, type HeroDef, type DifficultyId, type DifficultyDef,
} from '../data';
import { Player } from '../entities/Player';
import { Enemy, type EnemyContext } from '../entities/Enemy';
import { audio } from '../systems/Audio';
import { Effects } from '../systems/Effects';
import { Pickups } from '../systems/Pickups';
import { Projectiles } from '../systems/Projectiles';
import { Spawner, type SpawnerCtx } from '../systems/Spawner';
import { WeaponSystem, type WeaponCtx } from '../systems/Weapons';
import { HUD } from '../systems/HUD';
import { Joystick } from '../systems/Joystick';
import { AchTracker, commitMeta } from '../achievements';
import { getShopLevels, type ShopLevels } from '../shop';

type Keys = Record<string, Phaser.Input.Keyboard.Key>;

// ============ Основная игровая сцена ============

export class GameScene extends Phaser.Scene {
  private player!: Player;
  private keys!: Keys;
  private joystick!: Joystick;
  private enemyGroup!: Phaser.Physics.Arcade.Group;
  private effects!: Effects;
  private pickups!: Pickups;
  private projectiles!: Projectiles;
  private spawner!: Spawner;
  private weapons!: WeaponSystem;
  private hud!: HUD;
  private boss: Enemy | null = null;
  private midboss: Enemy | null = null;

  // Состояние матча
  private elapsed = 0;
  private kills = 0;
  private level = 1;
  private xp = 0;
  private xpNext = XP_CURVE(1);
  private gold = 0;
  private score = 0;
  private pendingLevelUps = 0;
  private overlayOpen = false;
  private gameEnded = false;
  /** Босс убит: идёт победный фейерверк — блокируем левел-апы/урон/спавн,
 *  чтобы экран ПОБЕДЫ не перебивался и игрок не мог погибнуть «после победы». */
  private victoryPending = false;
  private started = false;

  // Пассивки
  private passiveLevels = new Map<PassiveId, number>();
  private armorMult: number = 1;
  private magnetRadius: number = PLAYER_BASE.MAGNET_RADIUS;
  private regen: number = 0;
  private mightMult: number = 1;
  private cdMult: number = 1;
  private critChance: number = 0;

  private lastMove = { x: 1, y: 0 };
  private lastHudUpdate = 0;
  private lastDespawn = 0;
  private lastDieSound = 0;
  private sepGrid = new Map<number, Enemy[]>();
  private heroDef: HeroDef = HEROES.warrior;
  private diffDef: DifficultyDef = DIFFICULTIES.normal;
  private xpMult = 1;
  private chestTimer = 40;
  private chestsOpened = 0;
  private elitesSlain = 0;
  private hitstopUntil = 0;
  private ach: AchTracker | null = null;
  private shopLevels: ShopLevels = { might: 0, vitality: 0, speed: 0, magnet: 0, luck: 0 };

  constructor() {
    super('Game');
  }

  create(payload?: { hero?: HeroId; diff?: DifficultyId }): void {
    this.resetState();
    this.initHero(payload?.hero);
    this.initDifficulty(payload?.diff);
    this.shopLevels = getShopLevels();
    this.buildWorld();
    this.buildPlayer();
    // Зум камеры ДО создания HUD: HUD читает зум при постройке и
    // компенсирует его (иначе первый кадр рисует HUD не на месте).
    this.resizeZoom();
    this.scale.on('resize', this.resizeZoom, this);
    this.buildSystems();
    this.recomputeStats();
    this.setupCollisions();
    this.setupInput();
    this.cameras.main.setBackgroundColor('#3a7bd5');
    this.cameras.main.setBounds(0, 0, WORLD.SIZE, WORLD.SIZE);
    this.cameras.main.startFollow(this.player, true, 0.12, 0.1);
    this.events.once('shutdown', () => {
      this.scale.off('resize', this.resizeZoom, this);
      this.weapons?.destroy();
      this.hud?.destroy();
      this.pickups?.destroy();
      audio.stopMusic();
    });

    audio.unlock();
    audio.startMusic();
    this.started = true;
    this.hud.announce(`ВЫЖИВИ 15 МИНУТ, ${this.heroDef.name.toUpperCase()}!`, '#ffe9b0');
    if (this.diffDef.id === 'nightmare') {
      this.time.delayedCall(2100, () => this.hud.announce('⚔ КОШМАР: ВРАГИ СВИРЕПЕЕ, ОЧКИ ×1.6', '#ff8866'));
    }
  }

  private resetState(): void {
    this.elapsed = 0; this.kills = 0; this.level = 1;
    this.xp = 0; this.xpNext = XP_CURVE(1); this.gold = 0; this.score = 0;
    this.pendingLevelUps = 0; this.overlayOpen = false; this.gameEnded = false;
    this.victoryPending = false;
    this.boss = null;
    this.midboss = null;
    this.passiveLevels.clear();
    this.armorMult = 1; this.magnetRadius = PLAYER_BASE.MAGNET_RADIUS;
    this.regen = 0; this.mightMult = 1; this.cdMult = 1; this.critChance = 0;
    this.xpMult = 1;
    this.chestTimer = 40;
    this.chestsOpened = 0;
    this.elitesSlain = 0;
    this.hitstopUntil = 0;
    this.registry.set('tss-freeze', 0);
    this.lastMove = { x: 1, y: 0 };
    this.sepGrid.clear();
  }

  private initDifficulty(diffId?: DifficultyId): void {
    let id = diffId;
    if (!id && typeof window !== 'undefined') {
      const saved = window.localStorage.getItem('tss-diff');
      if (saved === 'normal' || saved === 'nightmare') id = saved;
    }
    this.diffDef = DIFFICULTIES[id ?? 'normal'];
  }

  private initHero(heroId?: HeroId): void {
    let id = heroId;
    if (!id && typeof window !== 'undefined') {
      const saved = window.localStorage.getItem('tss-hero');
      if (saved === 'warrior' || saved === 'archer' || saved === 'lancer' || saved === 'monk') id = saved;
    }
    this.heroDef = HEROES[id ?? 'warrior'];
  }

  // ================= МИР =================

  private buildWorld(): void {
    const S = WORLD.SIZE;
    const m = WORLD.GRASS_MARGIN;
    // Вода (фон)
    const water = this.add.tileSprite(S / 2, S / 2, S, S, 'water-tile')
      .setDepth(DEPTH.WATER - 20);
    void water;
    // Трава (арена)
    const grass = this.add.tileSprite(S / 2, S / 2, S - m * 2, S - m * 2, 'grass-tile')
      .setDepth(DEPTH.GROUND);
    void grass;

    // Анимированная пена по кромке воды
    const foamStep = 192;
    const foamAnim = this.anims.get('fx-foam');
    const foamRing = (x: number, y: number) => {
      const f = this.add.sprite(x, y, 'fx-foam').setDepth(DEPTH.WATER + 2);
      f.play('fx-foam');
      if (foamAnim) f.anims.setCurrentFrame(foamAnim.frames[Phaser.Math.Between(0, foamAnim.frames.length - 1)]);
    };
    for (let x = m; x < S - m; x += foamStep) {
      foamRing(x + foamStep / 2, m);
      foamRing(x + foamStep / 2, S - m);
    }
    for (let y = m; y < S - m; y += foamStep) {
      foamRing(m, y + foamStep / 2);
      foamRing(S - m, y + foamStep / 2);
    }

    this.physics.world.setBounds(m, m, S - m * 2, S - m * 2);

    // Детерминированный декор
    const rng = new Phaser.Math.RandomDataGenerator(['tiny-sword-survivors']);
    const cx = S / 2, cy = S / 2;
    const placed: { x: number; y: number; r: number }[] = [];
    const canPlace = (x: number, y: number, r: number): boolean => {
      if (Math.hypot(x - cx, y - cy) < 380) return false; // зона спавна
      for (const p of placed) {
        if (Math.hypot(x - p.x, y - p.y) < p.r + r) return false;
      }
      return true;
    };
    const place = (x: number, y: number, r: number) => placed.push({ x, y, r });
    const randPos = (margin = 260): [number, number] => [
      Phaser.Math.Clamp(rng.between(m + 80, S - m - 80), margin, S - margin),
      Phaser.Math.Clamp(rng.between(m + 80, S - m - 80), margin, S - margin),
    ];

    // Замок — дом игрока
    const castle = this.add.image(cx, cy - 460, 'castle').setScale(0.9)
      .setDepth(DEPTH.ENTITY_BASE + cy - 460);
    void castle;
    place(cx, cy - 460, 200);
    this.add.image(cx - 240, cy - 420, 'house2').setScale(0.8).setDepth(DEPTH.ENTITY_BASE + cy - 420);
    this.add.image(cx + 230, cy - 430, 'house1').setScale(0.8).setDepth(DEPTH.ENTITY_BASE + cy - 430);
    this.add.image(cx - 320, cy - 300, 'tower').setScale(0.85).setDepth(DEPTH.ENTITY_BASE + cy - 300);
    this.add.image(cx + 320, cy - 280, 'tower').setScale(0.85).setDepth(DEPTH.ENTITY_BASE + cy - 280);
    this.add.image(cx + 60, cy + 470, 'monastery').setScale(0.8).setDepth(DEPTH.ENTITY_BASE + cy + 470);
    place(cx + 60, cy + 470, 160);

    // Дома и башни по карте
    for (let i = 0; i < 8; i++) {
      const [x, y] = randPos();
      if (canPlace(x, y, 120)) {
        const k = Phaser.Math.RND.pick(['house1', 'house2', 'house3']);
        this.add.image(x, y, k).setScale(0.75).setDepth(DEPTH.ENTITY_BASE + y);
        place(x, y, 120);
      }
    }
    for (let i = 0; i < 6; i++) {
      const [x, y] = randPos();
      if (canPlace(x, y, 110)) {
        this.add.image(x, y, 'tower').setScale(0.8).setDepth(DEPTH.ENTITY_BASE + y);
        place(x, y, 110);
      }
    }
    // Деревья
    for (let i = 0; i < 70; i++) {
      const [x, y] = randPos();
      if (!canPlace(x, y, 80)) continue;
      const key = rng.frac() < 0.6 ? 'tree1' : 'tree3';
      const sc = 0.8 + rng.frac() * 0.35;
      const t = this.add.sprite(x, y, key).setScale(sc);
      t.play(key === 'tree1' ? 'tree1-sway' : 'tree3-sway');
      if (t.anims.currentAnim) t.setFrame(rng.between(0, 7));
      t.setDepth(DEPTH.ENTITY_BASE + y);
      place(x, y, 80);
    }
    // Камни и кусты
    for (let i = 0; i < 30; i++) {
      const [x, y] = randPos();
      if (!canPlace(x, y, 40)) continue;
      this.add.image(x, y, `rock${rng.between(1, 3)}`).setScale(0.8 + rng.frac() * 0.5)
        .setDepth(DEPTH.ENTITY_BASE + y - 4);
      place(x, y, 40);
    }
    for (let i = 0; i < 40; i++) {
      const [x, y] = randPos();
      if (!canPlace(x, y, 40)) continue;
      const b = this.add.sprite(x, y, 'bushe1').setScale(0.7 + rng.frac() * 0.4);
      b.play('bushe1-sway');
      b.setFrame(rng.between(0, 7));
      b.setDepth(DEPTH.ENTITY_BASE + y - 2);
      place(x, y, 40);
    }
    // Овечки
    for (let i = 0; i < 10; i++) {
      const [x, y] = randPos();
      if (!canPlace(x, y, 50)) continue;
      const sh = this.add.sprite(x, y, 'sheep').setScale(0.8);
      sh.play('sheep-idle');
      sh.setDepth(DEPTH.ENTITY_BASE + y);
      place(x, y, 50);
    }
    // Облака (дрейф вправо, относительный твин с переносом)
    for (let i = 0; i < 10; i++) {
      const [x, y] = [rng.between(0, S), rng.between(0, S)];
      const c = this.add.image(x, y, `cloud${rng.between(1, 3)}`)
        .setAlpha(0.5)
        .setDepth(DEPTH.FX + 50);
      this.tweens.add({
        targets: c,
        x: '+=700',
        duration: rng.between(60, 100) * 1000,
        repeat: -1,
        onRepeat: () => { c.x = -320; },
      });
    }
  }

  private buildPlayer(): void {
    this.player = new Player(this, WORLD.SIZE / 2, WORLD.SIZE / 2 + 260, this.heroDef);
  }

  private buildSystems(): void {
    this.effects = new Effects(this);
    this.pickups = new Pickups(
      this,
      (v) => this.addXp(v),
      (v) => this.player.heal(v),
      (x, y) => this.openChest(x, y),
      (v, x, y) => this.addGold(v, x, y),
    );
    this.projectiles = new Projectiles(this, {
      onExplode: (x, y, dmg, radius) => this.explode(x, y, dmg, radius),
    });
    this.enemyGroup = this.physics.add.group();
    this.enemyCtxStore = this.makeEnemyCtx();

    const spawnCtx: SpawnerCtx = {
      spawn: (kind, x, y) => this.spawnEnemy(kind, x, y),
      spawnElite: (kind) => {
        const a = Math.random() * Math.PI * 2;
        this.spawnEnemy(kind, this.player.x + Math.cos(a) * 700, this.player.y + Math.sin(a) * 700);
      },
      spawnBoss: () => this.spawnBoss(),
      playerX: () => this.player.x,
      playerY: () => this.player.y,
      announce: (t, c) => this.hud.announce(t, c),
      spawnRadius: () => {
        const cam = this.cameras.main;
        return Math.hypot(cam.width, cam.height) / (2 * cam.zoom) + 80;
      },
    };
    this.spawner = new Spawner(this, spawnCtx, this.diffDef.id);

    const weaponCtx: WeaponCtx = {
      player: () => this.player,
      enemies: () => this.activeEnemies(),
      damageEnemy: (e, dmg, kx, ky, force) => this.damageEnemy(e, dmg, kx, ky, force),
      projectiles: () => this.projectiles,
      effects: () => this.effects,
      moveDir: () => this.lastMove,
      mightMult: () => this.mightMult,
      cdMult: () => this.cdMult,
    };
    this.weapons = new WeaponSystem(this, weaponCtx);
    this.weapons.add(this.heroDef.startWeapon);
    const startId = this.heroDef.startWeapon;

    this.hud = new HUD(this, () => this.openPause(), {
      scoreMult: this.diffDef.scoreMult,
      diffName: this.diffDef.name.toUpperCase(),
    });
    this.hud.setIcon(startId, WEAPONS[startId].icon, 1, false);
    this.ach = new AchTracker((a) => this.hud.achievementToast(a));
  }

  private setupCollisions(): void {
    this.physics.add.overlap(this.player, this.enemyGroup, (_p, e) => {
      const enemy = e as Enemy;
      this.hurtPlayer(enemy.damage);
    });

    this.physics.add.overlap(this.projectiles.arrows, this.enemyGroup, (proj, e) => {
      const p = proj as unknown as import('../systems/Projectiles').Proj;
      const enemy = e as Enemy;
      if (!p.active || !enemy.active) return;
      if (p.hitSet?.has(enemy)) return;
      p.hitSet?.add(enemy);
      this.damageEnemy(enemy, p.dmg, enemy.x - this.player.x, enemy.y - this.player.y, 90);
      this.projectiles.consumePierce(p);
    });

    this.physics.add.overlap(this.projectiles.spears, this.enemyGroup, (proj, e) => {
      const p = proj as unknown as import('../systems/Projectiles').Proj;
      const enemy = e as Enemy;
      if (!p.active || !enemy.active) return;
      if (p.hitSet?.has(enemy)) return;
      p.hitSet?.add(enemy);
      this.damageEnemy(enemy, p.dmg, 0, 0, 40);
      this.projectiles.consumePierce(p);
    });

    this.physics.add.overlap(this.projectiles.knives, this.enemyGroup, (proj, e) => {
      const p = proj as unknown as import('../systems/Projectiles').Proj;
      const enemy = e as Enemy;
      if (!p.active || !enemy.active) return;
      if (p.hitSet?.has(enemy)) return;
      p.hitSet?.add(enemy);
      this.damageEnemy(enemy, p.dmg, enemy.x - this.player.x, enemy.y - this.player.y, 70);
      this.projectiles.consumePierce(p);
    });

    this.physics.add.overlap(this.player, this.projectiles.enemyArrows, (_p, proj) => {
      const p = proj as unknown as import('../systems/Projectiles').Proj;
      if (!p.active) return;
      this.projectiles.releaseEnemyArrow(p);
      this.hurtPlayer(p.dmg);
    });
  }

  private setupInput(): void {
    const kb = this.input.keyboard!;
    this.keys = kb.addKeys({
      w: Phaser.Input.Keyboard.KeyCodes.W,
      a: Phaser.Input.Keyboard.KeyCodes.A,
      s: Phaser.Input.Keyboard.KeyCodes.S,
      d: Phaser.Input.Keyboard.KeyCodes.D,
      up: Phaser.Input.Keyboard.KeyCodes.UP,
      down: Phaser.Input.Keyboard.KeyCodes.DOWN,
      left: Phaser.Input.Keyboard.KeyCodes.LEFT,
      right: Phaser.Input.Keyboard.KeyCodes.RIGHT,
      esc: Phaser.Input.Keyboard.KeyCodes.ESC,
      p: Phaser.Input.Keyboard.KeyCodes.P,
      m: Phaser.Input.Keyboard.KeyCodes.M,
    }) as Keys;
    kb.addCapture('UP,DOWN,LEFT,RIGHT,SPACE');
    this.joystick = new Joystick(this);
  }

  // ================= ЦИКЛ =================

  update(time: number, delta: number): void {
    if (!this.started || this.gameEnded || this.victoryPending) return;

    // Хитстоп: короткая заморозка мира (после убийств элит/взрывов/урона)
    if (time < this.hitstopUntil) {
      this.player.setVelocity(0, 0);
      return;
    }

    const dt = Math.min(delta, 50) / 1000;

    // Пауза
    if (Phaser.Input.Keyboard.JustDown(this.keys.esc) || Phaser.Input.Keyboard.JustDown(this.keys.p)) {
      this.openPause();
      return;
    }
    if (Phaser.Input.Keyboard.JustDown(this.keys.m)) {
      const muted = audio.toggleMute();
      this.hud.announce(muted ? 'ЗВУК ВЫКЛ' : 'ЗВУК ВКЛ', '#ffe9b0');
    }

    this.elapsed += dt;

    // Движение игрока
    let vx = 0, vy = 0;
    if (this.keys.a.isDown || this.keys.left.isDown) vx -= 1;
    if (this.keys.d.isDown || this.keys.right.isDown) vx += 1;
    if (this.keys.w.isDown || this.keys.up.isDown) vy -= 1;
    if (this.keys.s.isDown || this.keys.down.isDown) vy += 1;
    const jv = this.joystick.vector;
    vx += jv.x; vy += jv.y;
    const len = Math.hypot(vx, vy);
    if (len > 1) { vx /= len; vy /= len; }
    this.player.setVelocity(vx * this.player.speed, vy * this.player.speed);
    this.player.setAnimForVelocity();
    if (len > 0.1) this.lastMove = { x: vx / Math.max(0.001, len), y: vy / Math.max(0.001, len) };
    if (Math.abs(vx) > 0.05) this.player.setFlipX(vx < 0);

    // Пыль под ногами
    if (len > 0.5 && Math.random() < dt * 6) {
      this.effects.dust(this.player.x, this.player.y + 14, 1);
    }

    // Системы
    this.weapons.update(delta);
    this.projectiles.update(delta);
    this.spawner.update(dt);

    // Сундуки с сокровищами
    if (!this.gameEnded) {
      this.chestTimer -= dt;
      if (this.chestTimer <= 0) {
        this.chestTimer = 75;
        this.spawnChest();
      }
    }
    this.pickups.update(delta, this.player.x, this.player.y, this.magnetRadius, time);

    // Регенерация
    if (this.regen > 0 && this.player.hp < this.player.maxHp) {
      this.player.heal(this.regen * dt);
    }

    // Сепарация врагов
    this.separateEnemies();

    // Деспавн далёких
    if (time - this.lastDespawn > 700) {
      this.lastDespawn = time;
      this.despawnFar();
    }

    // Босс / мидбосс — приоритет полосе HP: сначала финальный босс
    if (this.boss) {
      if (this.boss.active) {
        this.hud.updateBossBar(this.boss.hp / this.boss.maxHp);
      } else {
        this.boss = null;
        if (this.midboss && this.midboss.active) this.hud.showBossBar(ENEMIES.midboss.name);
        else this.hud.hideBossBar();
      }
    } else if (this.midboss) {
      if (this.midboss.active) {
        this.hud.updateBossBar(this.midboss.hp / this.midboss.maxHp);
      } else {
        this.midboss = null;
        this.hud.hideBossBar();
      }
    }

    // HUD
    if (time - this.lastHudUpdate > 150) {
      this.lastHudUpdate = time;
      this.hud.update({
        hp: this.player.hp, maxHp: this.player.maxHp,
        level: this.level, xp: this.xp, xpNext: this.xpNext,
        kills: this.kills, score: this.currentScore(), elapsed: this.elapsed, gold: this.gold,
      });
    }

    // Левел-ап
    if (this.pendingLevelUps > 0 && !this.overlayOpen && !this.gameEnded && !this.victoryPending) {
      this.openLevelUp();
    }
  }

  // ================= БОЙ =================

  private activeEnemies(): Enemy[] {
    return this.enemyGroup.getChildren().filter((e) => e.active) as Enemy[];
  }

  private enemiesNear(x: number, y: number, r: number): Phaser.Physics.Arcade.Sprite[] {
    const out: Phaser.Physics.Arcade.Sprite[] = [];
    for (const e of this.enemyGroup.getChildren() as Enemy[]) {
      if (e.active && Math.hypot(e.x - x, e.y - y) <= r) out.push(e);
    }
    return out;
  }

  /** Хитстоп: заморозить врагов на ms миллисекунд */
  private hitstop(ms: number): void {
    this.hitstopUntil = Math.max(this.hitstopUntil, this.time.now + ms);
    this.registry.set('tss-freeze', this.hitstopUntil);
  }

  private damageEnemy(e: Enemy, dmg: number, kx = 0, ky = 0, force = 0): void {
    if (!e.active || e.dead) return;
    let final = dmg * this.mightMult;
    const crit = Math.random() < this.critChance;
    if (crit) final *= 2;
    final = Math.max(1, Math.round(final));
    this.effects.damage(e.x, e.y - 40 * e.def.scale, final, crit);
    if (Math.random() < 0.6) this.effects.hitSpark(e.x, e.y - 26 * e.def.scale);
    if (force > 0) e.knockback(kx, ky, force);
    this.effects.hitSound(this.time.now);
    if (e.takeDamage(final)) {
      this.onEnemyDeath(e);
    }
  }

  private explode(x: number, y: number, dmg: number, radius: number): void {
    this.effects.explosion(x, y, 1.1, 2);
    audio.play('explosion');
    this.cameras.main.shake(160, 0.004);
    for (const e of this.activeEnemies()) {
      const dx = e.x - x, dy = e.y - y;
      if (Math.hypot(dx, dy) <= radius + e.def.bodyRadius) {
        this.damageEnemy(e, dmg, dx, dy, 320);
      }
    }
  }

  private hurtPlayer(amount: number): void {
    if (this.gameEnded || this.victoryPending) return;
    // Эффекты урона (звук/тряска/хитстоп) — только когда удар реально прошёл
    if (this.time.now < this.player.iframesUntil) return;
    const dmg = Math.max(1, Math.round(amount * this.armorMult));
    const dead = this.player.damage(dmg, this.time.now);
    audio.play('hurt');
    this.cameras.main.shake(120, 0.0035);
    this.cameras.main.flash(110, 190, 40, 30, false);
    this.hitstop(80);
    if (dead) this.gameOver(false);
  }

  private onEnemyDeath(e: Enemy): void {
    if (!e.active) return;
    // Убираем из мира СРАЗУ: цепные взрывы не должны повторно бить погибающего
    const x = e.x, y = e.y;
    this.enemyGroup.remove(e, true, true);

    this.kills++;
    this.score += SCORE.KILL;
    this.ach?.event({ type: 'kills', value: this.kills });
    const big = e.def.isElite || e.def.isBoss || e.def.isMidboss;

    // Бочка-камикадзе, убитая оружием: взрыв бьёт врагов (цепная реакция!)
    if (e.def.kind === 'bomber') {
      this.bomberExplosion(x, y, false);
    }

    this.effects.explosion(x, y, big ? 1.7 : e.def.scale * 1.15, big ? 2 : 1);
    if (big) this.hitstop(110);
    if (this.time.now - this.lastDieSound > 120) {
      this.lastDieSound = this.time.now;
      audio.play('die');
    }
    // Дроп
    if (e.def.gem && e.xpValue > 0) {
      const n = big ? 3 : 1;
      for (let i = 0; i < n; i++) {
        const ox = big ? Phaser.Math.Between(-40, 40) : 0;
        const oy = big ? Phaser.Math.Between(-40, 40) : 0;
        this.pickups.spawnGem(x + ox, y + oy, e.def.gem, Math.ceil(e.xpValue / n));
      }
    }
    if (e.def.kind === 'brute' && Math.random() < 0.04) this.pickups.spawnMeat(x, y);
    if (e.def.isElite) {
      this.pickups.spawnMeat(x + 30, y);
      this.pickups.spawnMeat(x - 30, y);
      this.hud.announce('ЭЛИТА ПОВЕРЖЕНА! +25 XP', '#7CFC00');
      this.elitesSlain++;
      this.ach?.event({ type: 'elites', value: this.elitesSlain });
    }
    // Золотые кристаллы: теперь дают золото
    if (Math.random() < 0.03) this.pickups.spawnGoldGem(x, y, Phaser.Math.Between(3, 8));
    if (e.def.kind === 'midboss') {
      this.score += 1500;
      this.pickups.spawnGoldGem(x + 24, y, 40);
      this.pickups.spawnGoldGem(x - 24, y, 40);
      for (let i = 0; i < 3; i++) {
        this.pickups.spawnGem(x + Phaser.Math.Between(-50, 50), y + Phaser.Math.Between(-50, 50), 'gem-red', 12);
      }
      this.hud.announce('ТЁМНЫЙ МОНАХ ПОВЕРЖЕН! +1500 ОЧКОВ', '#ffd700');
    }

    if (e === this.boss) {
      this.victory();
    }
  }

  /** Взрыв бочки-камикадзе. selfDestruct=true — сама доехала до игрока. */
  private bomberExplosion(x: number, y: number, selfDestruct: boolean): void {
    const def = ENEMIES.bomber;
    const dmg = def.explodeDmg ?? 24;
    const R = def.explodeRadius ?? 150;
    this.effects.explosion(x, y, 1.05, 2);
    audio.play('explosion');
    this.cameras.main.shake(170, 0.0045);
    this.hitstop(70);
    // Урон игроку — только если бочка дошла сама
    if (selfDestruct && Math.hypot(this.player.x - x, this.player.y - y) < R) {
      this.hurtPlayer(dmg);
    }
    // Урон толпе врагов (в т.ч. другие бочки → цепная реакция)
    for (const s of this.enemiesNear(x, y, R + 40)) {
      const e = s as Enemy;
      if (!e.active || e.def.isBoss) continue;
      this.damageEnemy(e, dmg * 0.8, e.x - x, e.y - y, 260);
    }
  }

  private spawnChest(): void {
    const a = Math.random() * Math.PI * 2;
    const r = Phaser.Math.Between(320, 520);
    const m = WORLD.GRASS_MARGIN + 120;
    const x = Phaser.Math.Clamp(this.player.x + Math.cos(a) * r, m, WORLD.SIZE - m);
    const y = Phaser.Math.Clamp(this.player.y + Math.sin(a) * r, m, WORLD.SIZE - m);
    this.pickups.spawnChest(x, y);
    this.hud.announce('ГДЕ-ТО СПРЯТАНО СОКРОВИЩЕ...', '#ffd76e');
  }

  private openChest(x: number, y: number): void {
    audio.play('levelup');
    audio.play('explosion');
    this.effects.explosion(x, y, 0.9, 2);
    this.cameras.main.shake(180, 0.004);
    this.hud.announce('СОКРОВИЩЕ ОБРЕТЕНО!', '#ffd700');
    this.gold += 75;
    this.score += 250;
    this.chestsOpened++;
    this.ach?.event({ type: 'chests', value: this.chestsOpened });
    this.ach?.event({ type: 'gold', value: this.gold });
    this.effects.popup(x, y - 14, '+75 ЗОЛОТА', '#ffd76e', 15);
    this.effects.popup(x, y + 8, '+250 ОЧКОВ', '#ffffff', 12);
    // Золотой дождь из кристаллов
    const minute = this.elapsed / 60;
    const tier = minute > 8 ? 'gem-green' : 'gem-blue';
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = Phaser.Math.Between(20, 110);
      this.pickups.spawnGem(x + Math.cos(a) * d, y + Math.sin(a) * d, tier, 1);
    }
    if (minute >= 3) {
      this.pickups.spawnGem(x, y - 20, 'gem-red', 10);
    }
    this.pickups.spawnMeat(x + 26, y);
    this.pickups.spawnMeat(x - 26, y);
  }

  private spawnEnemy(kind: EnemyKind, x: number, y: number): void {
    const def = ENEMIES[kind];
    // Элиты/боссы не подпадают под лимит толпы
    if (!def.isElite && !def.isBoss && !def.isMidboss && this.enemyGroup.getLength() >= ENEMY_CAP) return;
    const m = WORLD.GRASS_MARGIN + 40;
    x = Phaser.Math.Clamp(x, m, WORLD.SIZE - m);
    y = Phaser.Math.Clamp(y, m, WORLD.SIZE - m);
    const e = new Enemy(this, x, y, kind, this.spawner.hpMult, this.spawner.dmgMult, this.enemyCtxStore!);
    if (this.diffDef.speedMult !== 1) e.speed = Math.round(e.speed * this.diffDef.speedMult);
    this.enemyGroup.add(e);
    if (def.isMidboss) {
      this.midboss = e;
      this.hud.showBossBar(def.name);
      this.cameras.main.shake(350, 0.007);
    }
  }

  private enemyCtxStore: EnemyContext | null = null;

  private spawnBoss(): void {
    const a = Math.random() * Math.PI * 2;
    const x = Phaser.Math.Clamp(this.player.x + Math.cos(a) * 640, 400, WORLD.SIZE - 400);
    const y = Phaser.Math.Clamp(this.player.y + Math.sin(a) * 640, 400, WORLD.SIZE - 400);
    this.boss = new Enemy(this, x, y, 'boss', 1, 1, this.enemyCtxStore!);
    this.boss.speed = Math.round(this.boss.speed * this.diffDef.speedMult);
    this.enemyGroup.add(this.boss);
    this.hud.showBossBar(ENEMIES.boss.name);
    this.cameras.main.shake(400, 0.008);
  }

  private separateEnemies(): void {
    this.sepGrid.clear();
    const cell = 64;
    const px = this.player.x, py = this.player.y;
    const near: Enemy[] = [];
    for (const e of this.enemyGroup.getChildren() as Enemy[]) {
      if (!e.active) continue;
      if (Math.abs(e.x - px) > 900 || Math.abs(e.y - py) > 700) continue;
      near.push(e);
      const key = (Math.floor(e.x / cell) << 16) ^ Math.floor(e.y / cell);
      const arr = this.sepGrid.get(key);
      if (arr) arr.push(e);
      else this.sepGrid.set(key, [e]);
    }
    for (const e of near) {
      const cx = Math.floor(e.x / cell), cy = Math.floor(e.y / cell);
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          const arr = this.sepGrid.get((gx << 16) ^ gy);
          if (!arr) continue;
          for (const o of arr) {
            if (o === e || o.x < e.x) continue; // каждая пара один раз
            const dx = o.x - e.x, dy = o.y - e.y;
            const d = Math.hypot(dx, dy);
            const min = (e.def.bodyRadius + o.def.bodyRadius) * 0.85;
            if (d > 0.001 && d < min) {
              const push = (min - d) / 2;
              const nx = dx / d, ny = dy / d;
              e.x -= nx * push; e.y -= ny * push;
              o.x += nx * push; o.y += ny * push;
            }
          }
        }
      }
    }
  }

  private despawnFar(): void {
    for (const e of this.activeEnemies()) {
      if (e.tooFar()) {
        this.enemyGroup.remove(e, true, true);
      }
    }
  }

  // ================= XP / ЛЕВЕЛ-АП =================

  private addXp(v: number): void {
    if (this.gameEnded || this.victoryPending) return;
    this.xp += Math.max(1, Math.round(v * this.xpMult));
    while (this.xp >= this.xpNext) {
      this.xp -= this.xpNext;
      this.level++;
      this.xpNext = XP_CURVE(this.level);
      this.pendingLevelUps++;
      this.ach?.event({ type: 'level', value: this.level });
    }
  }

  /** Пополнение золота (кристаллы/сокровища) с всплывающим текстом */
  private addGold(v: number, x?: number, y?: number): void {
    this.gold += v;
    this.ach?.event({ type: 'gold', value: this.gold });
    if (x !== undefined && y !== undefined) {
      this.effects.popup(x, y - 12, `+${v} ЗОЛОТА`, '#ffd76e', 12);
    }
  }

  private generateChoices(): UpgradeCard[] {
    const pool: UpgradeCard[] = [];
    for (const w of Object.values(WEAPONS)) {
      const lvl = this.weapons.level(w.id);
      if (lvl === 0 && this.weapons.ownedIds().length < 7) {
        pool.push({
          kind: 'weapon-new', id: w.id, title: w.name, subtitle: 'НОВОЕ ОРУЖИЕ',
          desc: w.desc, icon: w.icon, levelFrom: 0, levelTo: 1,
        });
      } else if (lvl > 0 && lvl < 5) {
        const next = w.levels[lvl];
        pool.push({
          kind: 'weapon-up', id: w.id, title: w.name, subtitle: `УРОВЕНЬ ${lvl} → ${lvl + 1}`,
          desc: this.weaponUpgradeDesc(w.id, lvl), icon: w.icon, levelFrom: lvl, levelTo: lvl + 1,
        });
        void next;
      }
    }
    for (const p of Object.values(PASSIVES)) {
      const lvl = this.passiveLevels.get(p.id) ?? 0;
      if (lvl < p.max) {
        pool.push({
          kind: 'passive', id: p.id, title: p.name, subtitle: lvl === 0 ? 'НОВЫЙ БОНУС' : `УРОВЕНЬ ${lvl} → ${lvl + 1}`,
          desc: p.desc(lvl + 1), icon: p.icon, levelFrom: lvl, levelTo: lvl + 1,
        });
      }
    }
    Phaser.Utils.Array.Shuffle(pool);
    const picked = pool.slice(0, 3);
    if (picked.length === 0) {
      picked.push(
        { kind: 'heal', title: 'Жареное мясо', subtitle: 'ЛЕЧЕНИЕ', desc: 'Восстановить 40 HP', icon: 'icon-meat' },
        { kind: 'gold', title: 'Кошель золота', subtitle: 'ЗОЛОТО', desc: '+100 золота к счёту', icon: 'icon-coin' },
        { kind: 'heal', title: 'Жареное мясо', subtitle: 'ЛЕЧЕНИЕ', desc: 'Восстановить 40 HP', icon: 'icon-meat' },
      );
    }
    while (picked.length < 3) {
      picked.push({ kind: 'heal', title: 'Жареное мясо', subtitle: 'ЛЕЧЕНИЕ', desc: 'Восстановить 40 HP', icon: 'icon-meat' });
    }
    return picked;
  }

  private weaponUpgradeDesc(id: WeaponId, lvl: number): string {
    const w = WEAPONS[id];
    const cur = w.levels[lvl - 1];
    const next = w.levels[lvl];
    const parts: string[] = [`Урон ${cur.dmg} → ${next.dmg}`];
    if (next.count && next.count !== cur.count) parts.push(`Количество: ${next.count}`);
    if (next.radius && cur.radius && next.radius !== cur.radius) parts.push(`Радиус: ${next.radius}`);
    if (next.pierce && cur.pierce && next.pierce !== cur.pierce) parts.push(`Пробитие: ${next.pierce}`);
    return parts.join(', ');
  }

  private openLevelUp(): void {
    this.overlayOpen = true;
    audio.play('levelup');
    this.scene.pause();
    this.scene.launch('LevelUp', {
      getChoices: () => this.generateChoices(),
      onChoose: (card: UpgradeCard) => {
        this.applyCard(card);
        this.pendingLevelUps--;
        if (this.pendingLevelUps <= 0) {
          this.scene.resume();
          this.overlayOpen = false;
          return true; // готово
        }
        return false; // показать следующий выбор
      },
    });
  }

  private applyCard(card: UpgradeCard): void {
    switch (card.kind) {
      case 'weapon-new': {
        const id = card.id as WeaponId;
        this.weapons.add(id);
        this.hud.setIcon(id, WEAPONS[id].icon, this.weapons.level(id), false);
        break;
      }
      case 'weapon-up': {
        const id = card.id as WeaponId;
        this.weapons.upgrade(id);
        this.hud.setIcon(id, WEAPONS[id].icon, this.weapons.level(id), false);
        break;
      }
      case 'passive': {
        const id = card.id as PassiveId;
        const lvl = (this.passiveLevels.get(id) ?? 0) + 1;
        this.passiveLevels.set(id, lvl);
        this.hud.setIcon(id, PASSIVES[id].icon, lvl, true);
        this.recomputeStats();
        if (id === 'vitality') this.player.heal(25);
        break;
      }
      case 'heal': this.player.heal(40); break;
      case 'gold':
        this.gold += 100;
        this.ach?.event({ type: 'gold', value: this.gold });
        break;
    }
  }

  private recomputeStats(): void {
    const lvl = (id: PassiveId) => this.passiveLevels.get(id) ?? 0;
    const shop = this.shopLevels;
    this.player.speed = this.heroDef.speed * (1 + 0.04 * shop.speed + 0.1 * lvl('boots'));
    this.armorMult = 1 - 0.08 * lvl('armor');
    this.magnetRadius = PLAYER_BASE.MAGNET_RADIUS * (1 + 0.2 * shop.magnet + 0.3 * lvl('magnet'));
    this.regen = this.heroDef.baseRegen + 0.5 * lvl('regen');
    this.mightMult = 1 + 0.06 * shop.might + 0.12 * lvl('might');
    this.cdMult = Math.max(0.6, 1 - 0.08 * lvl('haste'));
    this.critChance = 0.05 * shop.luck + 0.15 * lvl('luck');
    this.xpMult = 1 + 0.15 * lvl('wisdom');
    const newMax = this.heroDef.maxHp + 15 * shop.vitality + 25 * lvl('vitality');
    if (newMax !== this.player.maxHp) {
      const diff = newMax - this.player.maxHp;
      this.player.maxHp = newMax;
      this.player.hp = Math.min(newMax, this.player.hp + Math.max(0, diff));
    }
  }

  // ================= ПАУЗА / КОНЕЦ =================

  private openPause(): void {
    if (this.overlayOpen || this.gameEnded) return;
    this.overlayOpen = true;
    this.scene.pause();
    this.scene.launch('Pause', {
      onResume: () => {
        this.scene.resume();
        this.overlayOpen = false;
      },
      muted: audio.muted,
      onToggleMute: () => audio.toggleMute(),
    });
  }

  private currentScore(): number {
    const base = this.score
      + Math.floor(this.elapsed / 60) * SCORE.MINUTE
      + this.level * SCORE.LEVEL
      + this.gold;
    return Math.round(base * this.diffDef.scoreMult);
  }

  private victory(): void {
    if (this.gameEnded || this.victoryPending) return;
    this.victoryPending = true;
    this.spawner.stopped = true;
    this.player.setVelocity(0, 0);
    this.score += SCORE.BOSS;
    this.hud.hideBossBar();
    this.hud.announce('ПОБЕДА!!! БОСС ПОВЕРЖЕН!', '#ffd700');
    audio.play('victory');
    this.cameras.main.shake(500, 0.006);
    this.hitstop(200);
    this.ach?.event({ type: 'victory', difficulty: this.diffDef.id });
    // Финальный фейерверк
    for (let i = 0; i < 8; i++) {
      this.time.delayedCall(i * 160, () => {
        this.effects.explosion(
          this.player.x + Phaser.Math.Between(-300, 300),
          this.player.y + Phaser.Math.Between(-300, 300), 1.6, 2,
        );
      });
    }
    // Собрать все кристаллы
    this.pickups.vacuumAll(this.player.x, this.player.y);
    this.time.delayedCall(1900, () => this.gameOver(true));
  }

  private gameOver(victory: boolean): void {
    if (this.gameEnded) return;
    this.gameEnded = true;
    this.spawner.stopped = true;
    this.player.setVelocity(0, 0);
    if (!victory) audio.play('gameover');
    audio.stopMusic();

    const finalScore = this.currentScore();
    const stats = {
      victory,
      time: Math.floor(this.elapsed),
      kills: this.kills,
      level: this.level,
      gold: this.gold,
      score: finalScore,
      hero: this.heroDef.name,
      difficulty: this.diffDef.name,
      newAch: (this.ach?.newlyUnlocked ?? []).map((a) => ({ name: a.name, emoji: a.emoji })),
    };
    // Мета-статистика (localStorage) для React-сайдбара
    commitMeta({
      victory,
      kills: this.kills,
      gold: this.gold,
      score: finalScore,
      playTime: Math.floor(this.elapsed),
    });
    this.scene.launch('GameOver', { stats });
    this.scene.pause();
  }

  private resizeZoom(): void {
    const w = this.scale.width;
    const h = this.scale.height;
    const z = Math.min(w / 1152, h / 700);
    this.cameras.main.setZoom(Phaser.Math.Clamp(z, 0.55, 1.25));
  }

  private makeEnemyCtx(): EnemyContext {
    return {
      playerX: () => this.player.x,
      playerY: () => this.player.y,
      onArcherShoot: (x, y, tx, ty) => {
        const a = Math.atan2(ty - y, tx - x);
        this.projectiles.enemyArrow(x, y, a, Math.round(ENEMIES.archer.damage * this.spawner.dmgMult));
      },
      onBossArrowRing: (x, y) => {
        for (let i = 0; i < 14; i++) {
          this.projectiles.enemyArrow(x, y, (i / 14) * Math.PI * 2, 14);
        }
      },
      onMonkHeal: (x, y) => {
        this.effects.heal(x, y);
        for (const e of this.enemiesNear(x, y, 220)) {
          if (e !== this.boss) (e as Enemy).heal(34);
        }
      },
      onBossSummon: (x, y) => {
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2 + Math.random();
          this.spawnEnemy('boss-minion', x + Math.cos(a) * 170, y + Math.sin(a) * 170);
        }
        this.hud.announce('БОСС ЗОВЁТ СВИТУ!', '#ff8866');
      },
      onBomberExplode: (x, y, self, selfDestruct) => {
        // Уничтожаем бочку ДО взрыва: взрыв не должен бить саму бочку (иначе рекурсия)
        this.enemyGroup.remove(self, true, true);
        this.bomberExplosion(x, y, selfDestruct);
      },
      enemiesNear: (x, y, r) => this.enemiesNear(x, y, r),
      healEnemy: (e, hp) => (e as Enemy).heal(hp),
    };
  }
}
