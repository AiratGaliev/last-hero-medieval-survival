import Phaser from 'phaser';
import { Cursor } from '../systems/Cursor';
import {
  WORLD, PLAYER_BASE, DEPTH, ENEMY_CAP, SCORE, XP_CURVE, COMBO, MAX_LEVEL,
} from '../constants';
import {
  WEAPONS, PASSIVES, HEROES, ENEMIES, DIFFICULTIES, EVOLUTIONS,
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
import { t } from '../../i18n';
import { loadText } from '../storage';
import { gameplayStart, gameplayStop } from '../../platform/lifecycle';

type Keys = Record<string, Phaser.Input.Keyboard.Key>;

/** Статистика оружия за матч (для экрана результатов) */
export interface WeaponStat {
  id: WeaponId;
  icon: string;
  name: string;
  dmg: number;
  kills: number;
  /** Оружие прошло эволюцию — золотое имя с ★ */
  evolved?: boolean;
}

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
  private lastIndicatorUpdate = 0;
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
  // Новые типы врагов: счётчики для достижений
  private guardsSlain = 0;
  private taskmastersSlain = 0;
  /** Статистика урона/убийств по оружию */
  private weaponStats = new Map<WeaponId, { dmg: number; kills: number }>();
  /** Амбиентная тонировка суток (MULTIPLY-прямоугольник на весь экран) */
  private ambientRect: Phaser.GameObjects.Rectangle | null = null;
  private lastAmbientUpdate = -1;
  // Серия убийств (комбо): множитель очков + HUD-счётчик
  private combo = 0;
  private comboTimer = 0;
  private bestCombo = 0;

  constructor() {
    super('Game');
  }

  /** Курсор в стиле Tiny Swords: следит за наведением и переключает
   *  состояние. В CSS у курсора !important — он перебивает инлайновый
   *  cursor, который Phaser ставит через useHandCursor. */
  private cursor!: Cursor;

  create(payload?: { hero?: HeroId; diff?: DifficultyId }): void {
    this.cursor = new Cursor(this);
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
    // Амбиент суток: MULTIPLY-прямоугольник над миром, но ПОД HUD — смена
    // освещения от полудня к ночи за 15 минут (финальный босс — ночью)
    this.ambientRect = this.add.rectangle(
      this.scale.width / 2, this.scale.height / 2,
      this.scale.width + 4, this.scale.height + 4, 0xffffff,
    ).setScrollFactor(0).setDepth(DEPTH.HUD - 50).setBlendMode(Phaser.BlendModes.MULTIPLY);
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
    gameplayStart();
    this.hud.announce(t('game.survive', { v: this.heroDef.name.toUpperCase() }), '#ffe9b0');
    if (this.diffDef.id === 'nightmare') {
      this.time.delayedCall(2100, () => this.hud.announce(t('game.nightmareIntro'), '#ff8866'));
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
    this.guardsSlain = 0;
    this.taskmastersSlain = 0;
    this.weaponStats.clear();
    this.ambientRect?.destroy();
    this.ambientRect = null;
    this.lastAmbientUpdate = -1;
    this.combo = 0;
    this.comboTimer = 0;
    this.bestCombo = 0;
    this.registry.set('tss-freeze', 0);
    this.lastMove = { x: 1, y: 0 };
    this.sepGrid.clear();
  }

  private initDifficulty(diffId?: DifficultyId): void {
    let id = diffId;
    if (!id) {
      const saved = loadText('tss-diff');
      if (saved === 'normal' || saved === 'nightmare') id = saved;
    }
    this.diffDef = DIFFICULTIES[id ?? 'normal'];
  }

  private initHero(heroId?: HeroId): void {
    let id = heroId;
    if (!id) {
      const saved = loadText('tss-hero');
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
    // Трава (арена). Кадр 'grass-tile' зарегистрирован в 'grass-source'
    const grass = this.add.tileSprite(S / 2, S / 2, S - m * 2, S - m * 2, 'grass-source', 'grass-tile')
      .setDepth(DEPTH.GROUND);
    void grass;

    // Кромка арены: трава с обрывом вместо резкого прямоугольника.
    // Тайл «трава сверху + камень снизу» повёрнут на четыре стороны.
    const shoreFrame = 5 * 9 + 6; // строка 6, колонка 7 тайлсета 9×6
    const shoreLen = S - m * 2;
    const shore = (x: number, y: number, rot: number): void => {
      const t = this.add.tileSprite(x, y, shoreLen, 64, 'arena-tiles', shoreFrame)
        .setOrigin(0.5, 0.5)
        .setRotation(rot)
        .setDepth(DEPTH.GROUND + 1);
      void t;
    };
    shore(S / 2, m, Math.PI);          // верх: трава вниз, обрыв вверх
    shore(S / 2, S - m, 0);           // низ: трава вверх, обрыв вниз
    shore(m, S / 2, Math.PI / 2);      // слева
    shore(S - m, S / 2, -Math.PI / 2); // справа

    // Пена на воде: разбросанные пятна разного размера и поворота.
    // Сетка 192 px вплотную читалась как бледные квадраты по кромке.
    const foamAnim = this.anims.get('fx-foam');
    const foamRng = new Phaser.Math.RandomDataGenerator(['tiny-sword-foam']);
    const foamBand = m + 30;
    for (let i = 0; i < 130; i++) {
      const side = foamRng.pick([0, 1, 2, 3]);
      const along = foamRng.between(0, S);
      const across = foamRng.between(4, foamBand);
      let fx: number;
      let fy: number;
      if (side === 0) { fx = across; fy = along; }
      else if (side === 1) { fx = S - across; fy = along; }
      else if (side === 2) { fx = along; fy = across; }
      else { fx = along; fy = S - across; }
      // Совсем у самого края пена не нужна — там должен быть виден синий
      if ((side === 0 || side === 1 ? fx : fy) > m) continue;

      const f = this.add.sprite(fx, fy, 'fx-foam')
        .setDepth(DEPTH.WATER + 2)
        .setScale(foamRng.realInRange(0.35, 0.95))
        .setRotation(foamRng.realInRange(0, Math.PI * 2))
        .setAlpha(foamRng.realInRange(0.7, 1));
      f.play('fx-foam');
      if (foamAnim) f.anims.setCurrentFrame(foamAnim.frames[foamRng.between(0, foamAnim.frames.length - 1)]);
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
    // ---- Деревья: четыре породы разной высоты ----
    // Раньше выбор был из двух видов, и карта читалась как копия
    // одного объекта. tree2/tree4 отличаются силуэтом и высотой.
    const TREE_KEYS = ['tree1', 'tree2', 'tree3', 'tree4'] as const;
    for (let i = 0; i < 96; i++) {
      const [x, y] = randPos();
      if (!canPlace(x, y, 80)) continue;
      const key = TREE_KEYS[rng.between(0, TREE_KEYS.length - 1)];
      const sc = 0.75 + rng.frac() * 0.4;
      const t = this.add.sprite(x, y, key).setScale(sc);
      t.play(key + '-sway');
      if (t.anims.currentAnim) t.setFrame(rng.between(0, 7));
      t.setDepth(DEPTH.ENTITY_BASE + y);
      place(x, y, 80);
    }
    // Пни у опушек: закрывают пустоты, где полноценное дерево не влезает
    for (let i = 0; i < 22; i++) {
      const [x, y] = randPos();
      if (!canPlace(x, y, 34)) continue;
      this.add.image(x, y, `stump${rng.between(1, 4)}`)
        .setScale(0.6 + rng.frac() * 0.35)
        .setDepth(DEPTH.ENTITY_BASE + y - 4);
      place(x, y, 34);
    }
    // ---- Камни: четыре вида вместо трёх ----
    for (let i = 0; i < 38; i++) {
      const [x, y] = randPos();
      if (!canPlace(x, y, 40)) continue;
      this.add.image(x, y, `rock${rng.between(1, 4)}`).setScale(0.8 + rng.frac() * 0.5)
        .setDepth(DEPTH.ENTITY_BASE + y - 4);
      place(x, y, 40);
    }
    // ---- Кусты: четыре вида с покачиванием ----
    const BUSH_KEYS = ['bushe1', 'bushe2', 'bushe3', 'bushe4'] as const;
    for (let i = 0; i < 56; i++) {
      const [x, y] = randPos();
      if (!canPlace(x, y, 40)) continue;
      const key = BUSH_KEYS[rng.between(0, BUSH_KEYS.length - 1)];
      const b = this.add.sprite(x, y, key).setScale(0.7 + rng.frac() * 0.4);
      b.play(key + '-sway');
      b.setFrame(rng.between(0, 7));
      b.setDepth(DEPTH.ENTITY_BASE + y - 2);
      place(x, y, 40);
    }
    // ---- Камни в воде: берег вместо пустой полосы ----
    const wrockKeys = ['waterrock1', 'waterrock2', 'waterrock3', 'waterrock4'] as const;
    for (let i = 0; i < 72; i++) {
      const side = rng.between(0, 3);
      const along = rng.between(20, S - 20);
      const across = rng.between(6, m - 10);
      const x = side === 0 ? across : side === 1 ? S - across : along;
      const y = side === 2 ? across : side === 3 ? S - across : along;
      const key = wrockKeys[rng.between(0, wrockKeys.length - 1)];
      const w = this.add.sprite(x, y, key).setScale(0.38 + rng.frac() * 0.38);
      w.play(key + '-sway');
      w.setFrame(rng.between(0, 7));
      w.setDepth(DEPTH.WATER + 3);
    }

    // ---- Резиновая уточка: одна, в северо-западном углу канала ----
    // Пасхалка. Она не влияет на игру, но карта перестаёт быть
    // бесконечной ровной травой с одинаковыми деревьями.
    const duck = this.add.image(m - 70, m + 150, 'duck')
      .setScale(1.2)
      .setDepth(DEPTH.WATER + 4)
      .setAlpha(0.95);
    this.tweens.add({
      targets: duck,
      x: duck.x + 26,
      duration: 2600,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
    this.tweens.add({
      targets: duck,
      angle: { from: -4, to: 4 },
      duration: 1300,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });

    // ---- Жители: крестьяне, которые работают у ресурсов ----
    // Арена была пустошей: кроме овец, никого. Крестьяне с анимацией
    // труда делают карту обжитой и объясняют, откуда на ней мясо и золото.
    //
    // Две фракции (синяя и жёлтая), чтобы толпа не была одного цвета.
    const WORK_TOOLS = ['axe', 'hammer', 'knife', 'pickaxe'] as const;
    for (let i = 0; i < 16; i++) {
      const [x, y] = randPos();
      if (!canPlace(x, y, 44)) continue;
      const prefix = i % 2 === 0 ? 'pawn' : 'pawny';
      const work = prefix + '-work-' + WORK_TOOLS[rng.between(0, WORK_TOOLS.length - 1)];

      const v = this.add.sprite(x, y, prefix + '-idle').setScale(0.42);
      v.play(prefix + '-idle');
      v.setFrame(rng.between(0, 7));
      v.setDepth(DEPTH.ENTITY_BASE + y - 1);
      place(x, y, 44);

      // Цикл «работает — отдыхает». Планировщик — time.delayedCall,
      // а не твин с задержкой: твин без анимации отрабатывает onComplete
      // в том же кадре, и рекурсия вешает браузер насмерть.
      const workMs = 2400 + rng.between(0, 2600);
      const restMs = 900 + rng.between(0, 1800);
      const cycle = (): void => {
        if (!v.scene) return;
        v.play(work);
        this.time.delayedCall(workMs, () => {
          if (!v.scene) return;
          v.play(prefix + '-idle');
          this.time.delayedCall(restMs, cycle);
        });
      };
      this.time.delayedCall(rng.between(600, 3200), cycle);
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
      const c = this.add.image(x, y, `cloud${rng.between(1, 8)}`)
        .setAlpha(0.42)
        // Дальний план: выше воды и обрыва, но ниже теней и сущностей.
        // На DEPTH.FX + 50 облака накрывали врагов в бою.
        .setDepth(DEPTH.DECOR_BACK);
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
      onExplode: (x, y, dmg, radius, mini) => {
        this.explode(x, y, dmg, radius, 'bomb', mini !== true);
      },
      playerPos: () => ({ x: this.player.x, y: this.player.y }),
    });
    this.enemyGroup = this.physics.add.group();
    this.enemyCtxStore = this.makeEnemyCtx();

    const spawnCtx: SpawnerCtx = {
      spawn: (kind, x, y) => this.spawnEnemy(kind, x, y),
      spawnElite: (kind) => {
        // За пределами видимой области: радиус берём от камеры, а не
        // фиксированный. На широком экране 700 px попадали в кадр —
        // элита возникала перед глазами без предупреждения.
        // Игрок узнаёт о ней по объявлению, звуку и указателю за краем.
        const cam = this.cameras.main;
        const r = Math.hypot(cam.width, cam.height) / (2 * cam.zoom) + 140;
        const a = Math.random() * Math.PI * 2;
        const x = this.player.x + Math.cos(a) * r;
        const y = this.player.y + Math.sin(a) * r;
        if (this.spawnEnemy(kind, x, y)) {
          audio.play('boss');
          this.cameras.main.shake(220, 0.004);
        }
      },
      spawnBoss: () => this.spawnBoss(),
      playerX: () => this.player.x,
      playerY: () => this.player.y,
      announce: (t, c) => this.hud.announce(t, c),
      spawnRadius: () => {
        const cam = this.cameras.main;
        return Math.hypot(cam.width, cam.height) / (2 * cam.zoom) + 80;
      },
      // Точка у края экрана для добора отложенной волны
      randomSpawnX: () => {
        const cam = this.cameras.main;
        const r = Math.hypot(cam.width, cam.height) / (2 * cam.zoom) + 80;
        const a = Math.random() * Math.PI * 2;
        return Phaser.Math.Clamp(
          this.player.x + Math.cos(a) * r,
          WORLD.GRASS_MARGIN + 60,
          WORLD.SIZE - WORLD.GRASS_MARGIN - 60,
        );
      },
      randomSpawnY: () => {
        const cam = this.cameras.main;
        const r = Math.hypot(cam.width, cam.height) / (2 * cam.zoom) + 80;
        const a = Math.random() * Math.PI * 2;
        return Phaser.Math.Clamp(
          this.player.y + Math.sin(a) * r,
          WORLD.GRASS_MARGIN + 60,
          WORLD.SIZE - WORLD.GRASS_MARGIN - 60,
        );
      },
    };
    this.spawner = new Spawner(this, spawnCtx, this.diffDef.id);

    const weaponCtx: WeaponCtx = {
      player: () => this.player,
      enemies: () => this.activeEnemies(),
      damageEnemy: (e, dmg, kx, ky, force, src) => this.damageEnemy(e, dmg, kx, ky, force, src),
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
      this.damageEnemy(enemy, p.dmg, enemy.x - this.player.x, enemy.y - this.player.y, 90, 'bow');
      this.projectiles.consumePierce(p);
    });

    this.physics.add.overlap(this.projectiles.spears, this.enemyGroup, (proj, e) => {
      const p = proj as unknown as import('../systems/Projectiles').Proj;
      const enemy = e as Enemy;
      if (!p.active || !enemy.active) return;
      if (p.hitSet?.has(enemy)) return;
      p.hitSet?.add(enemy);
      this.damageEnemy(enemy, p.dmg, 0, 0, 40, 'spear');
      this.projectiles.consumePierce(p);
    });

    this.physics.add.overlap(this.projectiles.knives, this.enemyGroup, (proj, e) => {
      const p = proj as unknown as import('../systems/Projectiles').Proj;
      const enemy = e as Enemy;
      if (!p.active || !enemy.active) return;
      if (p.hitSet?.has(enemy)) return;
      p.hitSet?.add(enemy);
      this.damageEnemy(enemy, p.dmg, enemy.x - this.player.x, enemy.y - this.player.y, 70, 'knives');
      const spent = this.projectiles.consumePierce(p);
      // «Танец клинков»: рикошет — летящий нож доворачивает на нового врага
      if (!spent && this.weapons.isEvolved('knives') && p.active) {
        let best: Enemy | null = null;
        let bestD = 300 * 300;
        for (const t of this.activeEnemies()) {
          if (t === enemy || p.hitSet?.has(t)) continue;
          const d = (t.x - p.x) ** 2 + (t.y - p.y) ** 2;
          if (d < bestD) { bestD = d; best = t; }
        }
        if (best) {
          const a = Math.atan2(best.y - p.y, best.x - p.x);
          const body = p.body as Phaser.Physics.Arcade.Body;
          body.setVelocity(Math.cos(a) * 840, Math.sin(a) * 840);
          p.setRotation(a);
          p.life = Math.max(p.life, 420);
          this.effects.hitSpark(p.x, p.y);
        }
      }
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
    // Решение о поражении принимается здесь — после всей физики кадра.
    // Если тем же тиком погиб босс, победа уже объявлена и урон не считается.
    if (this.confirmDefeat()) return;
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
      this.hud.announce(muted ? t('hud.soundOff') : t('hud.soundOn'), '#ffe9b0');
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
        this.hud.updateBossBar(this.boss.hp / this.boss.maxHp, this.boss.hp, this.boss.maxHp);
      } else {
        this.boss = null;
        if (this.midboss && this.midboss.active) this.hud.showBossBar(ENEMIES.midboss.name);
        else this.hud.hideBossBar();
      }
    } else if (this.midboss) {
      if (this.midboss.active) {
        this.hud.updateBossBar(this.midboss.hp / this.midboss.maxHp, this.midboss.hp, this.midboss.maxHp);
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

    // Смена освещения (троттлировано внутри)
    this.updateAmbient();

    // Серия убийств: окно 3с без убийств — серия сбрасывается
    if (this.combo > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) {
        this.hud.breakCombo(this.combo);
        this.combo = 0;
      }
    }
    this.hud.updateCombo(this.combo, this.comboTimer / COMBO.WINDOW);

    // Индикаторы целей за экраном: сундук (золото) и крупные враги (красный)
    if (time - this.lastIndicatorUpdate > 120) {
      this.lastIndicatorUpdate = time;
      this.updateIndicators();
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

  private damageEnemy(e: Enemy, dmg: number, kx = 0, ky = 0, force = 0, src?: WeaponId): void {
    if (!e.active || e.dead) return;
    let final = dmg * this.mightMult;
    const crit = Math.random() < this.critChance;
    if (crit) final *= 2;
    final = Math.max(1, Math.round(final));
    this.effects.damage(e.x, e.y - 40 * e.def.scale, final, crit);
    if (Math.random() < 0.6) this.effects.hitSpark(e.x, e.y - 26 * e.def.scale);
    if (force > 0) e.knockback(kx, ky, force);
    this.effects.hitSound(this.time.now);
    const died = e.takeDamage(final);
    if (src) {
      const st = this.weaponStats.get(src) ?? { dmg: 0, kills: 0 };
      st.dmg += final;
      if (died) st.kills++;
      this.weaponStats.set(src, st);
    }
    if (died) {
      this.onEnemyDeath(e, src);
    }
  }

  private explode(x: number, y: number, dmg: number, radius: number, src?: WeaponId, allowCluster = true): void {
    this.effects.explosion(x, y, 1.1, 2);
    audio.play('explosion');
    this.cameras.main.shake(160, 0.004);
    for (const e of this.activeEnemies()) {
      const dx = e.x - x, dy = e.y - y;
      if (Math.hypot(dx, dy) <= radius + e.def.bodyRadius) {
        this.damageEnemy(e, dmg, dx, dy, 320, src);
      }
    }
    // «Кластерный залп»: основной взрыв рождает 4 мини-бомбы
    // (мини-бомбы сами кластеры не порождают — без рекурсии)
    if (allowCluster && src === 'bomb' && this.weapons.isEvolved('bomb')) {
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.random() * 0.7;
        const dist = 90 + Math.random() * 70;
        const tx = Phaser.Math.Clamp(x + Math.cos(a) * dist, WORLD.GRASS_MARGIN + 20, WORLD.SIZE - WORLD.GRASS_MARGIN - 20);
        const ty = Phaser.Math.Clamp(y + Math.sin(a) * dist, WORLD.GRASS_MARGIN + 20, WORLD.SIZE - WORLD.GRASS_MARGIN - 20);
        this.projectiles.throwBomb(x, y, tx, ty, Math.round(dmg * 0.45), 90, true);
      }
    }
  }

  private hurtPlayer(amount: number): void {
    if (this.gameEnded || this.victoryPending || this.defeatPending) return;
    // Эффекты урона (звук/тряска/хитстоп) — только когда удар реально прошёл
    if (this.time.now < this.player.iframesUntil) return;
    const dmg = Math.max(1, Math.round(amount * this.armorMult));
    const dead = this.player.damage(dmg, this.time.now);
    audio.play('hurt');
    this.cameras.main.shake(120, 0.0035);
    this.cameras.main.flash(110, 190, 40, 30, false);
    this.hitstop(80);
    // Не завершаем матч сразу: событие урона приходит из физики, а убийство
    // босса может произойти тем же тиком позже по порядку обработки.
    // Решение принимается в update() — там уже известен исход боя с боссом.
    if (dead) this.defeatPending = true;
  }

  /**
   * Подтверждение поражения. Вызывается первым же обновлением после
   * смертельного удара: к этому моменту известно, погиб ли босс.
   */
  private confirmDefeat(): boolean {
    if (this.defeatPending && !this.gameEnded && !this.victoryPending) {
      this.defeatPending = false;
      this.gameOver(false);
      return true;
    }
    this.defeatPending = false;
    return false;
  }

  private onEnemyDeath(e: Enemy, src?: WeaponId): void {
    if (!e.active) return;
    // Убираем из мира СРАЗУ: цепные взрывы не должны повторно бить погибающего
    const x = e.x, y = e.y;
    this.enemyGroup.remove(e, true, true);

    this.kills++;
    // Серия убийств: множитель растёт с каждым убийством без паузы
    this.combo++;
    this.comboTimer = COMBO.WINDOW;
    if (this.combo > this.bestCombo) this.bestCombo = this.combo;
    const comboMult = 1 + Math.min(COMBO.BONUS_CAP - 1, this.combo * COMBO.BONUS_STEP);
    this.score += Math.round(SCORE.KILL * comboMult);
    if ((COMBO.MILESTONES as readonly number[]).includes(this.combo)) {
      this.effects.popup(x, y - 30, t('game.combo', { v: this.combo }), '#ffd76e', 16);
      if (this.combo >= 50) {
        this.hud.announce(t('game.unstoppable', { v: this.combo }), '#ffd700');
        audio.play('ach');
      } else {
        audio.play('levelup');
      }
    }
    this.ach?.event({ type: 'kills', value: this.kills });
    // Счётчики новых врагов → достижения
    if (e.kind === 'guard') {
      this.guardsSlain++;
      this.ach?.event({ type: 'guards', value: this.guardsSlain });
    } else if (e.kind === 'taskmaster') {
      this.taskmastersSlain++;
      this.ach?.event({ type: 'taskmasters', value: this.taskmastersSlain });
    }
    const big = e.def.isElite || e.def.isBoss || e.def.isMidboss;

    // Бочка-камикадзе, убитая оружием: взрыв бьёт врагов (цепная реакция!)
    if (e.def.kind === 'bomber') {
      this.bomberExplosion(x, y, false, src);
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
      this.hud.announce(t('game.eliteDown'), '#7CFC00');
      this.elitesSlain++;
      this.ach?.event({ type: 'elites', value: this.elitesSlain });
    }
    // Золотые кристаллы: теперь дают золото
    if (Math.random() < 0.03) this.pickups.spawnGoldGem(x, y, Phaser.Math.Between(3, 8));
    if (e.def.kind === 'midboss') {
      this.score += 1500;
      this.pickups.spawnGoldGem(x + 24, y, 40);
      this.pickups.spawnGoldGem(x - 24, y, 40);
      // Опыт мидбосса приходит общим дропом выше: он разбит на три
      // кристалла из def.xp. Раньше здесь был второй дроп тех же 36 XP.
      this.hud.announce(t('game.midbossDown'), '#ffd700');
    }
    if (e.def.isBoss) {
      // Награда за весь матч. Очки (SCORE.BOSS) начисляет victory(),
      // здесь — золото в лавку и meat для восстановления после боя.
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        this.pickups.spawnGoldGem(x + Math.cos(a) * 70, y + Math.sin(a) * 70, 60);
      }
      for (let i = 0; i < 4; i++) {
        this.pickups.spawnMeat(x + Phaser.Math.Between(-80, 80), y + Phaser.Math.Between(-80, 80));
      }
    }

    if (e === this.boss) {
      this.victory();
    }
  }

  /** Взрыв бочки-камикадзе. selfDestruct=true — сама доехала до игрока. */
  private bomberExplosion(x: number, y: number, selfDestruct: boolean, src?: WeaponId): void {
    const def = ENEMIES.bomber;
    const dmg = Math.round((def.explodeDmg ?? 24) * this.spawner.dmgMult);
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
      this.damageEnemy(e, dmg * 0.8, e.x - x, e.y - y, 260, src);
    }
  }

  private spawnChest(): void {
    const a = Math.random() * Math.PI * 2;
    const r = Phaser.Math.Between(320, 520);
    const m = WORLD.GRASS_MARGIN + 120;
    const x = Phaser.Math.Clamp(this.player.x + Math.cos(a) * r, m, WORLD.SIZE - m);
    const y = Phaser.Math.Clamp(this.player.y + Math.sin(a) * r, m, WORLD.SIZE - m);
    this.pickups.spawnChest(x, y);
    // Подсказка направления: игроку проще найти сокровище
    // atan2: 0 = восток, π/2 = юг (ось Y вниз)
    const octants = ['east', 'southeast', 'south', 'southwest', 'west', 'northwest', 'north', 'northeast'];
    const ang = (Math.atan2(y - this.player.y, x - this.player.x) + Math.PI * 2) % (Math.PI * 2);
    const dir = octants[Math.round(ang / (Math.PI / 4)) % 8] as
      | 'east' | 'southeast' | 'south' | 'southwest' | 'west' | 'northwest' | 'north' | 'northeast';
    this.hud.announce(t('game.chestHidden', { v: t(`game.chestDir.${dir}`) }), '#ffd76e');
  }

  private openChest(x: number, y: number): void {
    audio.play('levelup');
    audio.play('explosion');
    this.effects.explosion(x, y, 0.9, 2);
    this.cameras.main.shake(180, 0.004);
    this.hud.announce(t('game.chestFound'), '#ffd700');
    this.gold += 75;
    this.score += 250;
    this.chestsOpened++;
    this.ach?.event({ type: 'chests', value: this.chestsOpened });
    this.ach?.event({ type: 'gold', value: this.gold });
    this.effects.popup(x, y - 14, t('game.goldPopup', { v: 75 }), '#ffd76e', 15);
    this.effects.popup(x, y + 8, t('game.scorePopup', { v: 250 }), '#ffffff', 12);
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

  /** true — враг создан; false — упёрлись в лимит толпы. */
  private spawnEnemy(kind: EnemyKind, x: number, y: number): boolean {
    const def = ENEMIES[kind];
    // Элиты/боссы не подпадают под лимит толпы
    if (!def.isElite && !def.isBoss && !def.isMidboss && this.enemyGroup.getLength() >= ENEMY_CAP) return false;
    const m = WORLD.GRASS_MARGIN + 40;
    x = Phaser.Math.Clamp(x, m, WORLD.SIZE - m);
    y = Phaser.Math.Clamp(y, m, WORLD.SIZE - m);
    const e = new Enemy(this, x, y, kind, this.spawner.hpMult, this.spawner.dmgMult, this.enemyCtxStore!);
    if (this.diffDef.speedMult !== 1) e.speed = Math.round(e.speed * this.diffDef.speedMult);
    this.enemyGroup.add(e);
    if (def.isMidboss) {
      this.midboss = e;
      this.hud.showBossBar(def.name);
      this.hud.bossIntro(def.name, t('hud.bossSubtitleGuardian'));
      this.cameras.main.shake(350, 0.007);
    }
    return true;
  }

  private enemyCtxStore: EnemyContext | null = null;

  private spawnBoss(): void {
    const a = Math.random() * Math.PI * 2;
    const cam = this.cameras.main;
    const r = Math.hypot(cam.width, cam.height) / (2 * cam.zoom) + 160;
    const x = Phaser.Math.Clamp(this.player.x + Math.cos(a) * r, 400, WORLD.SIZE - 400);
    const y = Phaser.Math.Clamp(this.player.y + Math.sin(a) * r, 400, WORLD.SIZE - 400);
    this.boss = new Enemy(this, x, y, 'boss', 1, 1, this.enemyCtxStore!);
    this.boss.speed = Math.round(this.boss.speed * this.diffDef.speedMult);
    this.enemyGroup.add(this.boss);
    this.hud.showBossBar(ENEMIES.boss.name);
    this.hud.bossIntro(
      ENEMIES.boss.name,
      this.diffDef.id === 'nightmare' ? t('hud.bossSubtitleNightmare') : t('hud.bossSubtitleFinal'),
    );
    this.cameras.main.shake(400, 0.008);
  }

  /**
   * Убирает одного самого далёкого обычного врага, чтобы освободить место
   * под элиту, босса или волну. Возвращает false, если убирать нечего.
   */
  private makeRoomForSummon(): boolean {
    let worst: Enemy | null = null;
    let worstD = 0;
    for (const e of this.activeEnemies()) {
      if (e.def.isElite || e.def.isBoss || e.def.isMidboss) continue;
      const d = (e.x - this.player.x) ** 2 + (e.y - this.player.y) ** 2;
      if (d > worstD) { worstD = d; worst = e; }
    }
    if (!worst) return false;
    this.enemyGroup.remove(worst, true, true);
    return true;
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
      if (this.level >= MAX_LEVEL) {
        // Потолок достигнут: опыт больше не даёт карточек и переводится
        // в золото. Раньше он просто копился в невидимой полосе.
        this.addGold(Math.floor(this.xp));
        this.xp = 0;
        return;
      }
      this.xp -= this.xpNext;
      this.level++;
      this.xpNext = XP_CURVE(this.level);
      this.pendingLevelUps++;
      this.ach?.event({ type: 'level', value: this.level });
      // Достигнут потолок — один раз сообщаем, чтобы игрок знал,
      // почему уровни больше не идут.
      if (this.level === MAX_LEVEL) {
        this.hud.announce(t('game.maxLevel', { v: MAX_LEVEL }), '#ffd76e');
      }
    }
  }

  /** Пополнение золота (кристаллы/сокровища) с всплывающим текстом */
  private addGold(v: number, x?: number, y?: number): void {
    this.gold += v;
    this.ach?.event({ type: 'gold', value: this.gold });
    if (x !== undefined && y !== undefined) {
      this.effects.popup(x, y - 12, t('game.goldPopup', { v }), '#ffd76e', 12);
    }
  }

  private generateChoices(): UpgradeCard[] {
    const pool: UpgradeCard[] = [];
    // Карточки эволюций — приоритетные: всегда попадают в выдачу
    const evolutions: UpgradeCard[] = [];
    for (const w of Object.values(WEAPONS)) {
      const lvl = this.weapons.level(w.id);
      if (lvl === 0 && this.weapons.ownedIds().length < 7) {
        pool.push({
          kind: 'weapon-new', id: w.id, title: w.name, subtitle: t('levelup.newWeapon'),
          desc: w.desc, icon: w.icon, levelFrom: 0, levelTo: 1,
        });
      } else if (lvl > 0 && lvl < 5) {
        const next = w.levels[lvl];
        pool.push({
          kind: 'weapon-up', id: w.id, title: w.name, subtitle: t('levelup.levelTo', { a: lvl, b: lvl + 1 }),
          desc: this.weaponUpgradeDesc(w.id, lvl), icon: w.icon, levelFrom: lvl, levelTo: lvl + 1,
        });
        void next;
      } else if (lvl === 5) {
        // Эволюция: 5-й уровень + пассивка-партнёр в инвентаре
        const evo = EVOLUTIONS[w.id];
        if ((this.passiveLevels.get(evo.partner) ?? 0) > 0) {
          evolutions.push({
            kind: 'weapon-evolve', id: w.id, title: evo.name, subtitle: t('levelup.evolution'),
            desc: `${evo.desc}\n(${WEAPONS[w.id].name} + ${PASSIVES[evo.partner].name})`,
            icon: w.icon, levelFrom: 5, levelTo: 6,
          });
        }
      }
    }
    for (const p of Object.values(PASSIVES)) {
      const lvl = this.passiveLevels.get(p.id) ?? 0;
      if (lvl < p.max) {
        pool.push({
          kind: 'passive', id: p.id, title: p.name, subtitle: lvl === 0 ? t('levelup.newBonus') : t('levelup.levelTo', { a: lvl, b: lvl + 1 }),
          desc: p.desc(lvl + 1), icon: p.icon, levelFrom: lvl, levelTo: lvl + 1,
        });
      }
    }
    Phaser.Utils.Array.Shuffle(pool);
    // Эволюции — в начало выдачи (не больше 3 карточек всего)
    const picked = [...evolutions.slice(0, 3), ...pool.slice(0, Math.max(0, 3 - evolutions.length))];

    // Добиваем выдачу только теми наградами, которые реально что-то дают.
    // Раньше добивали карточками «мясо +40 HP», которые при полном здоровье
    // не делали ничего, и двумя одинаковыми карточками подряд — игрок
    // не мог отличить варианты.
    const canHeal = this.player.hp < this.player.maxHp - 1;
    const filler: UpgradeCard[] = [];
    if (canHeal) {
      filler.push({
        kind: 'heal', title: t('levelup.cardHealTitle'), subtitle: t('levelup.cardHealSub'),
        desc: t('levelup.cardHealDesc'), icon: 'icon-meat',
      });
    }
    filler.push({
      kind: 'gold', title: t('levelup.cardGoldTitle'), subtitle: t('levelup.cardGoldSub'),
      desc: t('levelup.cardGoldDesc'), icon: 'icon-coin',
    });

    let i = 0;
    while (picked.length < 3) {
      picked.push(filler[i % filler.length]);
      i++;
    }
    return picked;
  }

  private weaponUpgradeDesc(id: WeaponId, lvl: number): string {
    const w = WEAPONS[id];
    const cur = w.levels[lvl - 1];
    const next = w.levels[lvl];
    const parts: string[] = [t('levelup.statDamage', { a: cur.dmg, b: next.dmg })];
    if (next.count && next.count !== cur.count) parts.push(t('levelup.statCount', { v: next.count }));
    if (next.radius && cur.radius && next.radius !== cur.radius) parts.push(t('levelup.statRadius', { v: next.radius }));
    if (next.pierce && cur.pierce && next.pierce !== cur.pierce) parts.push(t('levelup.statPierce', { v: next.pierce }));
    // Перезарядка показывается всегда: у части стволов (лук, копьё)
    // частота выстрела — полноценная характеристика, а не деталь.
    if (next.cd !== cur.cd) {
      parts.push(t('levelup.statCooldown', { a: (next.cd / 1000).toFixed(2), b: (cur.cd / 1000).toFixed(2) }));
    }
    return parts.join(', ');
  }

  private openLevelUp(): void {
    this.overlayOpen = true;
    gameplayStop();
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
          gameplayStart();
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
      case 'weapon-evolve': {
        const id = card.id as WeaponId;
        this.weapons.evolve(id);
        // Уровень читаем из системы: константа 6 расходилась с реальным
        // состоянием, если эволюция не сработала бы.
        this.hud.setIcon(id, WEAPONS[id].icon, this.weapons.level(id), false);
        const evo = EVOLUTIONS[id];
        // Праздничный момент: золотая вспышка, искры, объявление, звук
        this.cameras.main.flash(220, 255, 215, 120, false);
        this.effects.goldBurst(this.player.x, this.player.y - 20, 22);
        this.effects.popup(this.player.x, this.player.y - 70, `★ ${evo.name.toUpperCase()} ★`, '#ffd700', 18);
        this.hud.announce(t('game.evolution', { v: evo.name.toUpperCase() }), '#ffd700');
        this.hud.clearEvolutionReady(id);
        audio.play('evolve');
        this.ach?.event({ type: 'evolution' });
        break;
      }
      case 'passive': {
        const id = card.id as PassiveId;
        const lvl = (this.passiveLevels.get(id) ?? 0) + 1;
        this.passiveLevels.set(id, lvl);
        this.hud.setIcon(id, PASSIVES[id].icon, lvl, true);
        this.recomputeStats();
        if (id === 'vitality') this.player.heal(25);
        this.announceEvolutionReady();
        break;
      }
      case 'heal': this.player.heal(40); break;
      case 'gold':
        this.gold += 100;
        this.ach?.event({ type: 'gold', value: this.gold });
        break;
    }
  }

  /**
   * Сообщает, если взятая пассивка открыла эволюцию ствола.
   *
   * Партнёры не выглядят связанными со своим стволом: «Пир» звучит как
   * обычный бонус, а на деле завершает копьё. Без подсказки игрок
   * узнавал об эволюции только на следующем левел-апе — или не узнавал.
   */
  private announceEvolutionReady(): void {
    let any = false;
    for (const w of Object.values(WEAPONS)) {
      const partner = EVOLUTIONS[w.id]?.partner;
      if (!partner) continue;
      if (!this.weapons.evolutionReady(w.id, (this.passiveLevels.get(partner) ?? 0) > 0)) continue;
      this.hud.markEvolutionReady(w.id);
      any = true;
    }
    if (any) {
      this.hud.announce(t('game.evoReady'), '#ffd700');
      audio.play('evolve');
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

  /** Индикаторы за экраном: конверсия мир→экран + список целей */
  private updateIndicators(): void {
    const cam = this.cameras.main;
    const view = cam.worldView;
    const z = cam.zoom;
    const toScreen = (wx: number, wy: number) => ({
      x: (wx - view.x) * z,
      y: (wy - view.y) * z,
    });
    const targets: Array<{ x: number; y: number; kind: 'chest' | 'boss' | 'elite' }> = [];
    const chest = this.pickups.chestPos();
    if (chest) targets.push({ x: chest.x, y: chest.y, kind: 'chest' });
    if (this.boss?.active) targets.push({ x: this.boss.x, y: this.boss.y, kind: 'boss' });
    else if (this.midboss?.active) targets.push({ x: this.midboss.x, y: this.midboss.y, kind: 'boss' });
    if (targets.filter((t) => t.kind === 'boss').length === 0) {
      // ближайшая элита (если босса нет)
      let best: Enemy | null = null;
      let bestD = Infinity;
      for (const e of this.activeEnemies()) {
        if (!e.def.isElite) continue;
        const d = (e.x - this.player.x) ** 2 + (e.y - this.player.y) ** 2;
        if (d < bestD) { bestD = d; best = e; }
      }
      if (best) targets.push({ x: best.x, y: best.y, kind: 'elite' });
    }
    this.hud.updateIndicators(targets, toScreen);
  }

  // ================= ПАУЗА / КОНЕЦ =================

  /** Вызывается площадкой при game_api_resume. Не резumes сцену, если на ней
     * открыт оверлей (Pause/LevelUp/GameOver) — иначе бой пойдёт под ним. */
  platformResume(): void {
    if (this.overlayOpen || this.gameEnded) this.scene.resume();
    gameplayStart();
  }

  private openPause(): void {
    // Во время финального фейерверка пауза ломала экран победы: сцена
    // замирала вместе с таймером, который должен был показать результат.
    if (this.overlayOpen || this.gameEnded || this.victoryPending) return;
    this.overlayOpen = true;
    gameplayStop();
    this.scene.pause();
    // Снаряжение для панели паузы: оружия и пассивки с уровнями
    const loadout = {
      weapons: this.weapons.ownedIds().map((id) => ({
        icon: WEAPONS[id].icon,
        name: this.weapons.isEvolved(id) ? EVOLUTIONS[id].name : WEAPONS[id].name,
        level: this.weapons.level(id),
        evolved: this.weapons.isEvolved(id),
      })),
      passives: [...this.passiveLevels.entries()]
        .filter(([, lvl]) => lvl > 0)
        .map(([id, lvl]) => ({ icon: PASSIVES[id].icon, name: PASSIVES[id].name, level: lvl })),
      hero: { name: this.heroDef.name, hp: Math.round(this.player.hp), maxHp: this.player.maxHp },
      stats: { kills: this.kills, elapsed: this.elapsed, gold: this.gold, level: this.level },
    };
    this.scene.launch('Pause', {
      onResume: () => {
        this.scene.resume();
        this.overlayOpen = false;
        gameplayStart();
      },
      muted: audio.muted,
      onToggleMute: () => audio.toggleMute(),
      loadout,
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
    this.hud.announce(t('game.victory'), '#ffd700');
    audio.play('victory');
    this.cameras.main.shake(500, 0.006);
    this.hitstop(200);
    this.ach?.event({ type: 'victory', difficulty: this.diffDef.id });
    // Толпа отступает: враги мягко растворяются (без AI и физики)
    for (const e of this.activeEnemies()) {
      if (e.def.isBoss) continue; // босс уже погиб
      this.enemyGroup.remove(e, false);
      e.setActive(false);
      const b = e.body as Phaser.Physics.Arcade.Body | null;
      if (b) b.enable = false;
      this.tweens.add({
        targets: e,
        alpha: 0,
        scale: e.def.scale * 0.55,
        duration: 420 + Math.random() * 380,
        ease: 'Quad.easeOut',
        onComplete: () => e.destroy(),
      });
    }
    // Финальный фейерверк
    for (let i = 0; i < 8; i++) {
      this.time.delayedCall(i * 160, () => {
        this.effects.explosion(
          this.player.x + Phaser.Math.Between(-300, 300),
          this.player.y + Phaser.Math.Between(-300, 300), 1.6, 2,
        );
      });
    }
    // Собрать все кристаллы — ПО-НАСТОЯЩЕМУ: золото/лечение начисляются,
    // опыт конвертируется в очки (левел-апы в финале уже не выдаются)
    // Стрелы и бомбы в воздухе замирали на 1.9 с финальной анимации:
    // update() выходил по victoryPending, и они висели неподвижно.
    this.projectiles.clear();
    this.pickups.finaleVacuum(this.player.x, this.player.y, (g) => {
      if (g.gold > 0) {
        this.gold += g.gold;
        this.ach?.event({ type: 'gold', value: this.gold });
      }
      if (g.heal > 0) this.player.heal(g.heal);
      if (g.xp > 0) this.score += g.xp * 2;
    });
    this.time.delayedCall(1900, () => this.gameOver(true));
  }

  /** Смертельный удар получен, но исход матча ещё не решён. */
  private defeatPending = false;
  /** Приращения мета-статистики, уже записанные в хранилище. */
  private metaCommitted = false;
  private metaVictory = false;
  private metaKills = 0;
  private metaGold = 0;
  private metaTime = 0;

  private gameOver(victory: boolean): void {
    if (this.gameEnded) return;
    this.gameEnded = true;
    this.defeatPending = false;
    // Снаряды в полёте замирали на весь экран результата: сцену ставили на
    // паузу, а projectiles.update() переставал вызываться.
    this.projectiles.clear();
    this.spawner.stopped = true;
    this.player.setVelocity(0, 0);
    if (!victory) audio.play('gameover');
    audio.stopMusic();
    // HUD матча прячем: сцена ставится на паузу, но продолжает рисоваться,
    // и полосы с тостами светились поверх затемнения экрана результата.
    this.hud.setVisible(false);

    const finalScore = this.currentScore();
    // Статистика оружия: сортировка по суммарному урону; эволюционные формы — с ★
    const weapons: WeaponStat[] = [...this.weaponStats.entries()]
      .map(([id, st]) => {
        const evolved = this.weapons.isEvolved(id);
        return {
          id, icon: WEAPONS[id].icon,
          name: evolved ? `★ ${EVOLUTIONS[id].name}` : WEAPONS[id].name,
          dmg: st.dmg, kills: st.kills, evolved,
        };
      })
      .sort((a, b) => b.dmg - a.dmg);
    const stats = {
      victory,
      time: Math.floor(this.elapsed),
      kills: this.kills,
      level: this.level,
      gold: this.gold,
      score: finalScore,
      hero: this.heroDef.name,
      difficulty: this.diffDef.name,
      difficultyId: this.diffDef.id,
      bestCombo: this.bestCombo,
      weapons,
      newAch: (this.ach?.consumeNewly() ?? []).map((a) => ({ name: a.name, emoji: a.emoji })),
    };
    this.commitMatchMeta(victory, finalScore);
    this.scene.launch('GameOver', { stats });
    this.scene.pause();
  }

  /**
   * Записывает результат матча в мета-статистику ровно один раз.
   *
   * После воскрешения за rewarded-ролик игрок может умереть снова, и тогда
   * gameOver() вызывается второй раз. Поэтому здесь считаются приращения
   * с момента прошлой записи: первый вызов вносит факт участия в матче,
   * последующие дописывают только разницу. Иначе один матч засчитывался бы
   * дважды — и золото дважды падало бы в кошелёк лавки.
   */
  private commitMatchMeta(victory: boolean, finalScore: number): void {
    const time = Math.floor(this.elapsed);
    const first = !this.metaCommitted;
    commitMeta({
      matches: first ? 1 : 0,
      victories: victory && !this.metaVictory ? 1 : 0,
      kills: Math.max(0, this.kills - this.metaKills),
      gold: Math.max(0, this.gold - this.metaGold),
      score: finalScore,
      playTime: Math.max(0, time - this.metaTime),
    });
    this.metaCommitted = true;
    this.metaVictory = victory;
    this.metaKills = this.kills;
    this.metaGold = this.gold;
    this.metaTime = time;
  }

  /**
   * Воскрешение за rewarded-ролик (механика монетизации на Yandex Games).
   *
   * Сознательно слабое: 40% HP, серия обнуляется, спавн возобновляется с
   * текущей сложности. Иначе бесплатные «жизни» ломали бы баланс и игрок
   * получал бесконечное преимущество за просмотр рекламы.
   *
   * Вызывается из GameOverScene ДО scene.resume(): сцена на паузе, но прямые
   * вызовы методов работают.
   */
  revive(): boolean {
    if (!this.gameEnded) return false;
    this.gameEnded = false;
    this.defeatPending = false;
    this.spawner.stopped = false;

    // Серия сбрасывается — награда за рекламу не должна идти в счёт очков
    this.combo = 0;
    this.comboTimer = 0;

    this.player.hp = Math.round(this.player.maxHp * 0.4);
    // Короткая неуязвимость, чтобы не погибнуть сразу тем же уроном
    this.player.iframesUntil = this.time.now + 1500;

    audio.startMusic();
    gameplayStart();
    this.hud.setVisible(true);
    this.hud.announce(t('over.revived'), '#7dc95e');
    return true;
  }

  private resizeZoom(): void {
    const w = this.scale.width;
    const h = this.scale.height;
    const z = Math.min(w / 1152, h / 700);
    this.cameras.main.setZoom(Phaser.Math.Clamp(z, 0.55, 1.25));
    if (this.ambientRect) {
      this.ambientRect.setPosition(w / 2, h / 2).setSize(w + 4, h + 4);
    }
  }

  /** Плавная смена освещения: полдень → закат → ночь (к боссу в 15:00) */
  private updateAmbient(): void {
    if (!this.ambientRect) return;
    // Троттлинг: цвет меняется медленно, хватит обновления раз в 0.5с
    if (this.lastAmbientUpdate >= 0 && this.elapsed - this.lastAmbientUpdate < 0.5) return;
    this.lastAmbientUpdate = this.elapsed;
    // Ключевые точки: [секунды, цвет]
    const keys: Array<[number, number]> = [
      [0, 0xffffff],
      [300, 0xfff3da],   // тёплый день
      [540, 0xffd9ae],   // предзакат
      [720, 0xd8b8c0],   // сумерки
      [840, 0xa8b0d8],   // ранний вечер
      [900, 0x93a0c8],   // ночь — битва с боссом
    ];
    let color = keys[keys.length - 1][1];
    for (let i = 0; i < keys.length - 1; i++) {
      const [t0, c0] = keys[i];
      const [t1, c1] = keys[i + 1];
      if (this.elapsed >= t0 && this.elapsed <= t1) {
        const f = (this.elapsed - t0) / (t1 - t0);
        const lerpCh = (a: number, b: number) => Math.round(a + (b - a) * f);
        color = Phaser.Display.Color.GetColor(
          lerpCh((c0 >> 16) & 0xff, (c1 >> 16) & 0xff),
          lerpCh((c0 >> 8) & 0xff, (c1 >> 8) & 0xff),
          lerpCh(c0 & 0xff, c1 & 0xff),
        );
        break;
      }
    }
    this.ambientRect.setFillStyle(color);
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
          const dmg = Math.round(14 * this.spawner.dmgMult);
          this.projectiles.enemyArrow(x, y, (i / 14) * Math.PI * 2, dmg);
        }
      },
      onMonkHeal: (x, y) => {
        this.effects.heal(x, y);
        for (const e of this.enemiesNear(x, y, 220)) {
          if (e !== this.boss) (e as Enemy).heal(34);
        }
      },
      onBossSummon: (x, y) => {
        // Если толпа упёрлась в лимит, свита сначала расступается:
        // уходим от игрока, кто дальше — того и выкидываем. Иначе призыв
        // босса при полной толпе не вызывал ничего, и игрок его не замечал.
        let summoned = 0;
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2 + Math.random();
          const ok = this.spawnEnemy('boss-minion', x + Math.cos(a) * 170, y + Math.sin(a) * 170);
          if (!ok && !this.makeRoomForSummon()) continue;
          if (ok) summoned++;
        }
        if (summoned > 0) this.hud.announce(t('game.bossSummon'), '#ff8866');
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
