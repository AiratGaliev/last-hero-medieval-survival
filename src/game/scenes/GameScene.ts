import Phaser from 'phaser';
import { Cursor } from '../systems/Cursor';
import {
  WORLD, PLAYER_BASE, DEPTH, ENEMY_CAP, SCORE, XP_CURVE, COMBO, MAX_LEVEL,
  AGGRO, SIEGE, LONGPRESS_MS, VEIN_COUNT, VEIN_CHARGES, VEIN_YIELD,
  TOWER, BOSS_GOLD, HEAL_HP_PER_SEC, GARRISON_DPS_CAP, SETTLEMENT_CORE,
} from '../constants';
import {
  WEAPONS, PASSIVES, HEROES, ENEMIES, DIFFICULTIES, EVOLUTIONS,
  SETTLEMENT_CARDS, BUILD_SPOTS, pickDailyPool,
  type WeaponId, type PassiveId, type EnemyKind, type UpgradeCard, type HeroId, type HeroDef, type DifficultyId, type DifficultyDef,
  type SiegeProfile, type BuildingKind, type PawnWeapon,
} from '../data';
import { Player } from '../entities/Player';
import { Enemy, type EnemyContext } from '../entities/Enemy';
import { Pawn } from '../entities/Pawn';
import { Building } from '../entities/Building';
import { ResourceNode } from '../entities/ResourceNode';
import { Economy } from '../systems/Economy';
import { Settlement, type LoseCause } from '../systems/Settlement';
import { calculateSiegeSpawnAngles } from '../systems/SiegeFormation';
import { Succession } from '../systems/Succession';
import { Speedup } from '../systems/Speedup';
import { Hints, type HintTargetResolver } from '../systems/Hints';
import { OrderMenu } from '../systems/OrderMenu';
import { audio } from '../systems/Audio';
import { Effects } from '../systems/Effects';
import { JuicePolicy } from '../systems/Juice';
import { Pickups } from '../systems/Pickups';
import { Projectiles } from '../systems/Projectiles';
import { Spawner, resolveSpawnRateFactor, type SpawnerCtx } from '../systems/Spawner';
import { WeaponSystem, type WeaponCtx } from '../systems/Weapons';
import { GarrisonDpsBudget } from '../systems/GarrisonDpsBudget';
import { HUD } from '../systems/HUD';
import { Joystick } from '../systems/Joystick';
import { AchTracker, commitMeta } from '../achievements';
import { depositGold, getShopLevels, loadShop, type ShopLevels } from '../shop';
import { t } from '../../i18n';
import { loadText } from '../storage';
import { gameplayStart, gameplayStop } from '../../platform/lifecycle';
import { placementAvailable, resetPlacementLimits, hideStickyBanner } from '../../platform/ads';
import { track, beginRun, flushRunTelemetry, detectDeviceClass } from '../../platform/analytics';
import { analyticsIdentity } from '../../platform/player';
import {
  consumeRunConfig, loadMetaState, rollMetaDay, nodeEffects, seasonDef,
  takeConsumables, applyRunToMeta, contractDef, contractScoreForRun, QUEST_POOL, markCodex,
  heroSkinTint, buildingSkinTint, trailSkinTint, activeBanner, matchesPlayed,
  type RunModifiers, type NodeEffects, type SeasonModifier, type RunSummary,
  type QuestMetric,
  getOrAssignExperimentVariant,
} from '../meta';

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

/** Длина ogre-boss/dead: 10 кадров при 8 FPS (CREATURE_SHEETS в BootScene). */
const BOSS_DEATH_ANIMATION_MS = 1_250;

export class GameScene extends Phaser.Scene {
  private player!: Player;
  private keys!: Keys;
  private joystick!: Joystick;
  private enemyGroup!: Phaser.Physics.Arcade.Group;
  private effects!: Effects;
  /** Единая политика тряски и частоты hitstop для Phase P. */
  private readonly juicePolicy = new JuicePolicy();
  private pickups!: Pickups;
  private projectiles!: Projectiles;
  private spawner!: Spawner;
  private weapons!: WeaponSystem;
  private hud!: HUD;
  private boss: Enemy | null = null;

  // ---- Поселение (TZ §B, §E, §F, §G) ----
  private economy!: Economy;
  private settlement!: Settlement;
  private succession!: Succession;
  private speedup!: Speedup;
  private hints!: Hints;
  private hintOverlayPaused = false;
  private orderMenu!: OrderMenu;
  /** Shared per-second damage budget for every garrison unit. */
  private readonly garrisonDpsBudget = new GarrisonDpsBudget(GARRISON_DPS_CAP);
  /** Frozen theoretical hero DPS baseline captured at game time 10:00. */
  private heroDpsAtTenMinutes: number | null = null;
  /** Диагностика потолка урона гарнизона включается только в dev с ?debug. */
  private dpsDebugText: Phaser.GameObjects.Text | null = null;
  private lastDpsDebugUpdate = 0;
  private dpsDebugRawDamage = 0;
  private dpsDebugAppliedDamage = 0;
  /** Замок стоит в центре-севере арены (как декор раньше). */
  private readonly castleX = WORLD.SIZE / 2;
  private readonly castleY = WORLD.SIZE / 2 - 460;
  /** Активная осада: состав, цель, окно (§E.4). */
  private siegeAlive = false;
  private activeSiegeProfile: string | null = null;
  private siegeDestroyed = 0;
  /** Сколько юнитов в текущей осаде и сколько из них убито — для исхода (§E.8). */
  private siegeTotal = 0;
  private siegeKills = 0;
  /** Причина поражения для экрана и телеметрии (§E.3). */
  private loseCause: LoseCause = 'hero';
  /** Сдача на экране преемственности — для cause='surrender' в run_end (§K.2). */
  private surrendered = false;
  /** Тик башни: следующий выстрел по времени сцены (фаза M). */
  private towerNextShot = 0;
  /** Long-press приказов (§B.6). */
  private pressState: { x: number; y: number; screenX: number; screenY: number; t: number; pointer: Phaser.Input.Pointer; pawn: Pawn | null; building: Building | null } | null = null;

  // Состояние матча
  private elapsed = 0;
  private kills = 0;
  /**
   * Временный магнит XP от комбо-вехи 200 (§H.4: «большое лечение + магнит
   * XP 10 сек»). Множитель радиуса, а не сам радиус: базовый считается в
   * recomputeStats(), иначе веха затирала бы уровень пассивки «Магнит».
   */
  private xpMagnetUntil = 0;
  /**
   * ГПСЧ рана (mulberry32). Нужен для ВОСПРОИЗВОДИМОСТИ: §K.4 и гейт §H.15
   * п.7 требуют «фиксированный сид-прогон — расхождение счёта ≤ 5%».
   * Math.random() в механиках, влияющих на награду (комбо-вехи 25/50 с
   * разбросом «ресурсы или лечение»), делал такой прогон невозможным.
   */
  private rngState = 0;
  private runSeed = 0;
  /** [0, 1) из rng рана. */
  private runRng(): number {
    this.rngState = (this.rngState + 0x6d2b79f5) | 0;
    let t = this.rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
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
  private lastSettleHud = 0;
  private lastDespawn = 0;
  private lastDieSound = 0;
  private lastIndicatorUpdate = 0;
  private extinctAt: number | null = null;
  private sepGrid = new Map<number, Enemy[]>();
  private heroDef: HeroDef = HEROES.warrior;
  private diffDef: DifficultyDef = DIFFICULTIES.normal;
  private xpMult = 1;
  private chestTimer = 40;
  private chestsOpened = 0;
  private elitesSlain = 0;
  /** Монотонное время активной симуляции: не расходуется под блокирующим overlay. */
  private activeTimeMs = 0;
  private hitstopUntil = 0;
  private juiceSlowFactor = 1;
  private juiceSlowRestoreEvent: Phaser.Time.TimerEvent | null = null;
  private juiceSlowOriginalScales: { physics: number; clock: number; tweens: number } | null = null;
  private buildingMusicResumeEvent: Phaser.Time.TimerEvent | null = null;
  private ach: AchTracker | null = null;
  private shopLevels: ShopLevels = { might: 0, vitality: 0, speed: 0, magnet: 0, luck: 0 };
  // Существа: счётчики для достижений (TZ §A.6)
  private skullsSlain = 0;
  private shamansSlain = 0;
  /** Статистика урона/убийств по оружию */
  private weaponStats = new Map<WeaponId, { dmg: number; kills: number }>();
  /** Амбиентная тонировка суток (MULTIPLY-прямоугольник на весь экран) */
  private ambientRect: Phaser.GameObjects.Rectangle | null = null;
  private lastAmbientUpdate = -1;
  // Серия убийств (комбо): множитель очков + HUD-счётчик
  private combo = 0;
  private comboTimer = 0;
  private bestCombo = 0;

  // ============ Мета-модификаторы рана (фазы Q/S, TZ §H.7–H.18, §J) ============
  /** Конфиг рана: контракт/указ/вызов/благословение/расходники/бесконечный. */
  private mods: RunModifiers = {
    contract: null, ukaz: null, challenge: null, blessing: null,
    consumables: [], endless: false, weeklyChallenge: false,
  };
  /** Эффекты дерева «Хроника Долины» (§H.16). */
  private fx!: NodeEffects;
  /** Сезонный модификатор мира (§H.18). */
  private seasonMod: SeasonModifier | null = null;
  private contractId: string | null = null;
  private challengeMods = new Set<string>();
  private consumableSet = new Set<string>();
  /** Узел m8 «Клятва долины»: стартовый мечник получает +20 HP. */
  private oathM8 = false;
  /** applyRunToMeta вызывается ровно один раз за ран (§K.2). */
  private metaApplied = false;
  /** Волны бесконечного режима (счётчик осад, §H.12). */
  private wave = 0;
  // ---- Сводка рана (RunSummary §K.2) ----
  private killsByKind: Record<string, number> = {};
  private buildingsBuilt = 0;
  private builtBarracks = 0;
  private builtMonastery = 0;
  private builtArchery = 0;
  /** Время (минуты) первой постройки дома — задание «Новый дом» §H.17. */
  private firstHouseMin = 0;
  private hires = 0;
  private successions = 0;
  private bossKilled = false;
  private cardsPicked: string[] = [];
  /** Контракт «Пацифист-герой» (§H.9): золото мимо сводки → в кошелёк лавки. */
  private pacifistGold = 0;
  /** Золото за убийства: «Чёрный рынок» ×1.5, «Туман» ×1.2 (§H.9, A2). */
  private killGoldMult = 1;
  /** «Кровавая луна»/«Подкова удачи»: множитель XP поверх пассивок (A2, §J.6.2). */
  private xpEventMult = 1;
  /** QA-хук (?qa_hero_hp=N): бонус к HP героя, применяется в recomputeStats. */
  private qaHeroHpBonus = 0;
  /** «Кровавая луна»: скорость врагов ×1.1 (A2). */
  private enemySpeedMult = 1;
  /** Благословение «Комбо» (A2): вехи 20/40/80 вместо 25/50/100/200. */
  private comboMilestones: readonly number[] = COMBO.MILESTONES;
  /** Контракт «Ночь»/«Туман»: затемнение ambient (светлого пятна в сцене нет). */
  private ambientDarkMult = 1;
  /** Скин построек (§J.6.2): tint для замка и всех построек. */
  private bldTint: number | null = null;
  /** Шлейф героя (§J.6.2): эмиттер частиц за спрайтом. */
  private trailEmitter: Phaser.GameObjects.Particles.ParticleEmitter | null = null;
  /** Тосты заданий дня: одноразовость внутри рана (§H.17). */
  private questToastDone = new Set<string>();
  private questCheckAcc = 0;
  /** FTUE (§I.2): тепличный первый матч — плотность волн −20% первые 3 минуты. */
  private ftueSoftStart = false;
  /** Первый раненый гражданский может ждать включения обучения в текущем забеге. */
  private monasteryHintPending = false;
  /** FPS-сэмплы примерно раз в секунду агрегируются в конце рана. */
  private perfSampleAccMs = 0;
  private perfFpsSamples: number[] = [];
  private enemiesPeak = 0;
  private perfTelemetrySent = false;

  constructor() {
    super('Game');
  }

  /** Курсор в стиле Tiny Swords: следит за наведением и переключает
   *  состояние. В CSS у курсора !important — он перебивает инлайновый
   *  cursor, который Phaser ставит через useHandCursor. */
  private cursor!: Cursor;

  create(payload?: { hero?: HeroId; diff?: DifficultyId }): void {
    this.cursor = new Cursor(this);
    this.restoreJuiceSlowMotion();
    this.resetState();
    this.juicePolicy.resetBudget();
    this.initHero(payload?.hero);
    this.initDifficulty(payload?.diff);
    this.shopLevels = getShopLevels();
    // Т0 аналитики: реестр плейсментов и метка рана — до любых механик (§K.1)
    resetPlacementLimits();
    beginRun();
    const firstMatch = matchesPlayed() === 0;
    const ftueVariant = firstMatch
      ? getOrAssignExperimentVariant('ftueSoftStart', analyticsIdentity(), ['control', 'soft'])
      : null;
    this.ftueSoftStart = firstMatch && ftueVariant === 'soft';
    // §K.2: фиксируем фактический seed и параметры, необходимые для анализа рана.
    track('run_start', {
      hero: this.heroDef.id,
      difficulty: this.diffDef.id,
      seed: this.runSeed,
      contract: this.contractId,
      ukaz: this.mods.ukaz ?? null,
      blessing: this.mods.blessing ?? null,
      experiment: firstMatch ? 'ftueSoftStart' : null,
      experiment_variant: ftueVariant,
      ftue_soft_start: this.ftueSoftStart,
      endless: this.mods.endless,
      challenge: this.mods.challenge ? [...this.mods.challenge.mods] : null,
    });
    // Стики-баннер (§J.5) показывается только вне рана — в бою гасим
    hideStickyBanner();
    // Зум камеры ДО сборки мира: от него зависят и HUD, и слой подсказок —
    // они компенсируют зум обратным масштабом (см. systems/HUD.ts и
    // systems/Hints.ts). Раньше зум выставлялся после buildWorld(), и
    // подсказки на телефоне рисовались в полтора раза мельче.
    this.resizeZoom();
    this.buildWorld();
    this.buildPlayer();
    // «Первый урок» (§H.16): +1 стартовый уровень героя (единственный
    // узел дерева, дающий силу — правило честности §H.16)
    if (this.fx.startLevelBonus > 0) {
      this.level = 1 + this.fx.startLevelBonus;
      this.xpNext = XP_CURVE(this.level);
    }
    // Скин героя (§J.6.2): setTint палитры тира — без новых ассетов
    const heroTint = heroSkinTint();
    if (heroTint !== null) this.player.setTint(heroTint);
    // «Вторые ворота» (§H.16): щит героя на 5 сек в начале матча
    if (this.fx.heroShieldMs > 0) this.player.iframesUntil = this.activeTimeMs + this.fx.heroShieldMs;
    // Зум камеры выставлен выше (до сборки мира) — HUD и подсказки
    // компенсируют его обратным масштабом.
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
      this.trailEmitter?.destroy();
      this.trailEmitter = null;
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
    this.activeTimeMs = 0;
    this.heroDpsAtTenMinutes = null;
    this.garrisonDpsBudget.reset();
    this.dpsDebugText?.destroy();
    this.dpsDebugText = null;
    this.lastDpsDebugUpdate = 0;
    this.dpsDebugRawDamage = 0;
    this.dpsDebugAppliedDamage = 0;
    this.hintOverlayPaused = false;
    this.registry.set('tss-hint-overlay-paused', false);
    this.registry.set('tss-active-time-ms', 0);
    this.time.paused = false;
    this.monasteryHintPending = false;
    this.elapsed = 0; this.kills = 0; this.level = 1;
    this.xp = 0; this.xpNext = XP_CURVE(1); this.gold = 0; this.score = 0;
    this.pendingLevelUps = 0; this.overlayOpen = false; this.gameEnded = false;
    this.victoryPending = false;
    this.boss = null;
    this.siegeAlive = false;
    this.activeSiegeProfile = null;
    this.siegeDestroyed = 0;
    this.siegeTotal = 0;
    this.siegeKills = 0;
    this.loseCause = 'hero';
    this.surrendered = false;
    this.towerNextShot = 0;
    this.pressState = null;
    this.passiveLevels.clear();
    this.armorMult = 1; this.magnetRadius = PLAYER_BASE.MAGNET_RADIUS;
    this.regen = 0; this.mightMult = 1; this.cdMult = 1; this.critChance = 0;
    this.xpMult = 1;
    this.chestTimer = 40;
    this.chestsOpened = 0;
    this.elitesSlain = 0;
    this.hitstopUntil = 0;
    this.skullsSlain = 0;
    this.shamansSlain = 0;
    this.extinctAt = null;
    this.lastSettleHud = 0;
    this.weaponStats.clear();
    this.ambientRect?.destroy();
    this.ambientRect = null;
    this.lastAmbientUpdate = -1;
    // Счётчики коммита мета-статистики живут на экземпляре сцены, а Phaser
    // переиспользует один и тот же экземпляр для всех ранов. Без сброса
    // второй ран в сессии считался бы «продолжением» первого: matches не
    // росли бы никогда, а дельта убийств/золота считалась бы от чужого
    // итога — в кошелёк лавки падало бы 0 вместо заработанного (§J.8).
    this.metaCommitted = false;
    this.metaVictory = false;
    this.metaKills = 0;
    this.metaGold = 0;
    this.metaTime = 0;
    this.defeatPending = false;
    this.combo = 0;
    this.comboTimer = 0;
    this.bestCombo = 0;
    this.xpMagnetUntil = 0;
    // Числовой seed RNG совпадает с передаваемым в событии run_start.
    this.runSeed = (Date.now() ^ Math.floor(Math.random() * 0x1_0000_0000)) >>> 0;
    this.rngState = this.runSeed | 0;
    this.registry.set('tss-freeze', 0);
    this.lastMove = { x: 1, y: 0 };
    this.sepGrid.clear();
    this.trailEmitter?.destroy();
    this.trailEmitter = null;

    // ---- Конфиг рана (фазы Q/S): читается и гасится один раз (§H.7–H.18, §J) ----
    this.mods = consumeRunConfig();
    if (this.mods.endless) track('endless_start', {});
    takeConsumables(this.mods.consumables);
    const meta = loadMetaState();
    this.fx = nodeEffects(meta.nodes);
    // «Дозорные» (узел d3, §H.16): +2 сек к анонсу осады — Spawner читает реестр
    if (this.fx.siegeWarnBonus > 0) this.registry.set('tss-siege-warn', this.fx.siegeWarnBonus);
    this.seasonMod = seasonDef().modifier;
    this.contractId = contractDef(this.mods.contract)?.id ?? null;
    this.challengeMods = new Set<string>(this.mods.challenge?.mods ?? []);
    this.consumableSet = new Set<string>(this.mods.consumables);
    this.oathM8 = meta.nodes.includes('m8');
    this.metaApplied = false;
    this.wave = 0;
    this.killsByKind = {};
    this.buildingsBuilt = 0; this.builtBarracks = 0; this.builtMonastery = 0; this.builtArchery = 0;
    this.firstHouseMin = 0;
    this.hires = 0;
    this.successions = 0;
    this.bossKilled = false;
    this.cardsPicked = [];
    this.pacifistGold = 0;
    // Множители из модов вызова/контрактов/расходников (§H.9, A2, §J.6.2)
    this.killGoldMult = (this.contractId === 'c_black_market' ? 1.5 : 1)
      * (this.challengeMods.has('cm_fog') ? 1.2 : 1);
    this.xpEventMult = (this.challengeMods.has('cm_blood_moon') ? 1.15 : 1)
      * (this.consumableSet.has('cs_horseshoe') ? 1.25 : 1);
    this.enemySpeedMult = this.challengeMods.has('cm_blood_moon') ? 1.1 : 1;
    // Благословение «Комбо» (A2): вехи чаще
    this.comboMilestones = this.mods.blessing === 'bl_combo' ? [20, 40, 80] : COMBO.MILESTONES;
    // «Ночь» −25% / «Туман» −20%: затемняем ambient (радиус обзора условно)
    this.ambientDarkMult = this.contractId === 'c_night' ? 0.75
      : this.challengeMods.has('cm_fog') ? 0.8 : 1;
    this.questToastDone = new Set();
    this.questCheckAcc = 0;
    this.ftueSoftStart = false; // назначается из сохранённого A/B-флага при старте рана
    this.monasteryHintPending = false;
    this.perfSampleAccMs = 0;
    this.perfFpsSamples = [];
    this.enemiesPeak = 0;
    this.perfTelemetrySent = false;
    this.bldTint = buildingSkinTint();
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
      // ⚠️ Чистая зона — вокруг ЗАМКА, а не вокруг центра карты. Раньше
      // центр был зоной спавна героя (до появления поселения); теперь там
      // стоит база, и запрет на 380 px выкашивал полкарты — деревьев
      // оставалось 26, а половина рабочего радиуса была пустой.
      if (Math.hypot(x - this.castleX, y - this.castleY) < 200) return false;
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
    /** Дерево-узел: спрайт + ResourceNode (§B.3). */
    const TREE_KEYS = ['tree1', 'tree2', 'tree3', 'tree4'] as const;
    const addTree = (x: number, y: number, radius = 70): void => {
      const key = TREE_KEYS[rng.between(0, TREE_KEYS.length - 1)];
      const sc = 0.75 + rng.frac() * 0.4;
      const t = this.add.sprite(x, y, key).setScale(sc);
      t.play(key + '-sway');
      if (t.anims.currentAnim) t.setFrame(rng.between(0, 7));
      t.setDepth(DEPTH.ENTITY_BASE + y);
      place(x, y, radius);
      this.economy.registerNode(new ResourceNode(this, 'tree', 'wood', x, y, 1, t));
    };
    /** Овца-узел: 3 мяса за цикл (§B.3). */
    const addSheep = (x: number, y: number): void => {
      const sh = this.add.sprite(x, y, 'sheep').setScale(0.8);
      sh.play('sheep-idle');
      sh.setDepth(DEPTH.ENTITY_BASE + y);
      place(x, y, 50);
      if (this.contractId !== 'c_hunger') {
        this.economy.registerNode(new ResourceNode(this, 'sheep', 'meat', x, y, 1, sh));
      }
    };

    // ---- Экономика и поселение (TZ §B): до декора, чтобы узлы
    // ресурсов регистрировались сразу. Замок — Building с HP (§E). ----
    this.economy = new Economy(this, {
      castleX: this.castleX,
      castleY: this.castleY,
      onBuildComplete: (kind, x, y) => this.onBuildComplete(kind, x, y),
      onRepairComplete: () => {},
      onBurnDamage: (b, amount) => this.settlement.damageBuilding(b, amount, b.lastSiegeIdx, false),
      onBuildingDestroyed: (b) => this.settlement.onBuildingDestroyed(b),
      onMonasteryFalling: (_building, victims) => {
        this.hud?.announce(t('siege.monasteryFalling', { v: victims }), '#ff5544');
        track('monastery_falling', { victims_n: victims });
      },
      // ---- Мета-эффекты рана (§H.16 дерево, §H.17 указы, §H.9 контракты, A2, §J.6.2) ----
      pawnSpeedMult: this.fx.pawnSpeedMult
        * (this.mods.blessing === 'bl_pawn_speed' ? 1.10 : 1)
        * (this.challengeMods.has('cm_winter') ? 0.85 : 1),
      workSpeedMult: this.fx.workSpeedMult * (this.consumableSet.has('cs_forester') ? 1.25 : 1),
      buildCostMult: this.fx.buildCostMult * (this.contractId === 'c_black_market' ? 1.5 : 1),
      houseCostMult: this.challengeMods.has('cm_winter') ? 0.8 : 1,
      buildTimeMult: this.challengeMods.has('cm_stone') ? 1.3 : 1,
      hireCostMult: this.fx.hireCostMult,
      bowMonkCostMult: this.fx.bowMonkCostMult,
      hireTimeMult: this.fx.hireTimeMult,
      veinYieldMult: this.fx.veinYieldMult * (this.seasonMod === 'gold_rush_world' ? 1.5 : 1),
      sheepYieldMult: this.fx.sheepYieldMult,
      woodYieldMult: this.mods.ukaz === 'ukaz_drought' ? 0.7 : 1,
      garrisonHpMult: this.consumableSet.has('cs_horn') ? 1.25 : 1,
      garrisonSlotsBonus: this.fx.garrisonSlotsBonus,
      barracksSlotsBonus: this.fx.barracksSlotsBonus,
      buildingHpMult: this.fx.buildingHpMult
        * (this.challengeMods.has('cm_stone') ? 1.3 : 1)
        * (this.mods.ukaz === 'ukaz_fragile' ? 0.75 : 1),
      houseHpMult: this.fx.houseHpMult,
      healHpsBonus: this.fx.healHpsBonus,
      monkHpsBonus: this.fx.monkHpsBonus,
      healWoodMult: this.fx.healWoodMult
        * (this.mods.blessing === 'bl_heal_wood' ? 0.75 : 1)
        * (this.challengeMods.has('cm_plague') ? 2 : 1),
      repairCostMult: this.fx.repairCostMult,
      meatDisabled: this.contractId === 'c_hunger',
      hireDisabled: this.mods.ukaz === 'ukaz_lone',
      repairDisabled: this.contractId === 'c_no_repair',
      monasterySlots: this.mods.ukaz === 'ukaz_silent_monastery' ? 5 : undefined,
      extraHouseSpots: this.fx.extraBuildSpots + (this.mods.endless ? 4 : 0),
      endless: this.mods.endless,
      veinCharges: this.challengeMods.has('cm_gold_rush') ? VEIN_CHARGES * 2 : VEIN_CHARGES,
    });
    // «Стартовые припасы» (§H.16) + благословение «Старт +20 дерева» (A2)
    if (this.fx.startWood > 0 || this.mods.blessing === 'bl_wood_start') {
      this.economy.resources.wood += this.fx.startWood + (this.mods.blessing === 'bl_wood_start' ? 20 : 0);
      this.economy.emit('change');
    }
    if (this.fx.startOre > 0) this.economy.resources.ore += this.fx.startOre;
    this.settlement = new Settlement(this, this.economy, {
      onFeed: (text, color) => this.hud?.feed(text, color),
      onDefeat: (cause) => this.onSettlementDefeat(cause),
      onVeteran: (pawn) => {
        // Микро-награды ветеранства: +100 очков, +25 XP (§E.8, §H.6)
        this.score += 100;
        this.addXp(25);
        this.effects.popup(pawn.x, pawn.y - 60, '+100', '#ffd76e', 14);
        // §I.2 требует подсказку о ветеранах; ключ `hint.veteran` был
        // заведён в обоих словарях, но ни разу не показывался.
        this.hints?.show('veteran', this.worldHintTarget(() =>
          pawn.active && !pawn.dead ? { x: pawn.x, y: pawn.y } : null,
        ));
      },
      onMonasteryCollapsed: (victims, building) => {
        const names = victims.map((pawn) => `${this.pawnTitle(pawn)} ${pawn.name}`);
        this.hud?.announce(t('siege.monasteryCollapsed', { v: victims.length }), '#ff5544');
        if (names.length > 0) {
          this.hud?.feed(t('siege.monasteryCollapsedNames', { names: names.join(', ') }), '#ff5544');
        }
        this.effects.explosion(building.x, building.y, 1.4, 2);
        this.shakeCamera(400, 0.006);
        audio.play('slam');
        this.applyJuiceSlowMotion(1_000, 0.5);
        track('monastery_collapsed', { victims_n: victims.length, names: names.join(', ') });
      },
      onBuildingDestroyed: (b) => this.onBuildingDestroyed(b),
      onSiegeScore: (outcome, index) => this.onSiegeScore(outcome, index),
      heroX: () => this.player.x,
      heroY: () => this.player.y,
    });
    this.succession = new Succession(this.economy, this.settlement, {
      // Контракт «Один в поле» (§H.9): ветвь «за ресурсы» недоступна
      resourcesBranchDisabled: this.contractId === 'c_lone_hero',
      // «Дорога героя» (узел m2, §H.16): цена преемства ×0.90
      successionCostMult: this.fx.successionCostMult,
    });
    this.speedup = new Speedup(this.economy);
    this.hints = new Hints(this, (paused) => {
      this.hintOverlayPaused = paused;
      this.registry.set('tss-hint-overlay-paused', paused);
      // Заморозить Timer Events: иначе delayedCall (например fallback гарпуна)
      // может сработать под overlay, а абсолютные дедлайны продолжат истекать.
      this.time.paused = paused;
      if (paused) this.physics.world.pause();
      else this.physics.world.resume();
    });
    // The movement lesson is the first FTUE step. Present it before update()
    // can enqueue the house banner; otherwise that banner can occupy the
    // queue/current slot and postpone the blocking tutorial for 20 seconds.
    this.hints.show('move');
    this.orderMenu = new OrderMenu(this);
    void cx; void cy;

    // Замок — база поселения (Building с HP, создаётся в Settlement).
    // Радиус занятости 150 px: замок 288×230 (scale 0.9), и больше места
    // занимать нельзя — иначе рабочий пояс у базы не помещается.
    place(this.castleX, this.castleY, 150);
    // ---- Рабочий пояс поселения (§B.3, §B.9) ----
    //
    // Собственный лес, пастбище и две жилы у самой базы. Пояс ставится
    // ДО точек стройки (в промежутках между ними) и лежит ВНУТРИ ядра
    // поселения (SETTLEMENT_CORE), поэтому сбор идёт без паники: иначе
    // рабочим приходилось бегать через полкарты за каждым куском, и первый
    // дом не появлялся даже за 3,5 минуты матча (гейт фазы E).
    const belt = this.spawnSettlementBelt(rng, canPlace, place, addTree, addSheep);
    // Пятна стройки: мягкие маркеры на земле (§I.2 — игрок видит, где будет дом)
    for (const spot of BUILD_SPOTS) {
      const sx = this.castleX + spot.dx, sy = this.castleY + spot.dy;
      this.add.image(sx, sy, 'aoe-ring')
        .setScale(0.85).setAlpha(0.16).setDepth(DEPTH.GEM);
      place(sx, sy, 96);
    }
    // ---- Декоративные постройки других поселений ----
    // ⚠️ Раньше они ставились относительно центра карты (±240…470 от него),
    // то есть в 230–360 px от ЗАМКА — прямо на пятна стройки и на рабочий
    // пояс. Теперь они отнесены на 900+ px от базы: это чужие деревни на
    // карте, а не деталь, растущая сквозь казармы.
    const decor: Array<[string, number, number, number]> = [
      ['house2', -620, 700, 0.8],
      ['house1', 640, 690, 0.8],
      ['tower', -900, 260, 0.85],
      ['tower', 880, -240, 0.85],
      ['monastery', 120, 1150, 0.8],
    ];
    for (const [key, dx, dy, scale] of decor) {
      const x = this.castleX + dx, y = this.castleY + dy;
      if (x < m + 120 || x > S - m - 120 || y < m + 120 || y > S - m - 120) continue;
      this.add.image(x, y, key).setScale(scale).setDepth(DEPTH.ENTITY_BASE + y);
      place(x, y, key === 'monastery' ? 160 : 120);
    }

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
    // ---- Овечки: ресурс мяса — 3 за цикл, овца исчезает (§B.3) ----
    // «Дефицит» (A2): овец ×2; контракт «Голодный год» (§H.9): овцы не доятся
    //
    // ⚠️ Овцы ставятся ДО деревьев, камней и кустов: раньше они шли
    // последними и почти всегда попадали в уже занятое canPlace() место —
    // на карте оказывалось 2 овцы вместо 10, то есть 6 мяса вместо 30
    // (§B.5: «мясо — стоковый кран, ~30 мяса на матч, максимум ~6
    // наймов/жителей»). Мясо — жёсткий лимит найма, его нельзя терять.
    const sheepCount = (this.challengeMods.has('cm_scarcity') ? 20 : 10) - belt.sheep;
    let sheepPlaced = 0;
    for (let attempt = 0; attempt < 60 && sheepPlaced < sheepCount; attempt++) {
      // Овцы — в рабочем радиусе: мясо нужно пешкам, а не декорации (§B.3).
      const a = rng.realInRange(0, Math.PI * 2);
      const r = rng.realInRange(230, 980);
      const x = this.castleX + Math.cos(a) * r;
      const y = this.castleY + Math.sin(a) * r;
      if (x < m + 80 || x > S - m - 80 || y < m + 80 || y > S - m - 80) continue;
      if (!canPlace(x, y, 50)) continue;
      addSheep(x, y);
      sheepPlaced++;
    }
    // ---- Золотые жилы: 10 штук, 4 цикла × 20 руды (§B.3) ----
    // Благословение «+1 жила» (A2) добавляет одиннадцатую.
    // Жилы ставятся ДО деревьев: одна жила — 80 руды, это треть плана
    // поселения по руде, и терять её из-за переполнения лесом нельзя.
    this.spawnVeins(
      rng, canPlace, place,
      VEIN_COUNT - belt.veins + (this.mods.blessing === 'bl_vein' ? 1 : 0),
    );
    // ---- Деревья: четыре породы разной высоты ----
    // Каждое дерево — ResourceNode: пешка рубит его и уносит 5 дерева (§B.3).
    //
    // ⚠️ Деревья сеются В РАБОЧЕМ РАДИУСЕ (220…980 px от замка) решёткой
    // с разбросом: пешки дальше 1000 px не ходят (§B.3), а раньше лес
    // высыпался по всей карте и большая часть его была недостижима. Случайная
    // выборка давала 26 деревьев (130 дерева на матч — на дом и казармы едва
    // хватало), решётка с шагом 190 px и разбросом ±30 даёт ~40 деревьев
    // (~200 дерева) — ровно под план поселения (§B.4) и ровно столько,
    // сколько нужно, чтобы лес не выглядел полем с кустами.
    const TREE_STEP = 190;
    const TREE_JITTER = 30;
    for (let gx = this.castleX - 980; gx <= this.castleX + 980; gx += TREE_STEP) {
      for (let gy = this.castleY - 980; gy <= this.castleY + 980; gy += TREE_STEP) {
        const x = gx + rng.realInRange(-TREE_JITTER, TREE_JITTER);
        const y = gy + rng.realInRange(-TREE_JITTER, TREE_JITTER);
        if (x < m + 80 || x > S - m - 80 || y < m + 80 || y > S - m - 80) continue;
        const d = Math.hypot(x - this.castleX, y - this.castleY);
        if (d < 220 || d > 980) continue;
        if (!canPlace(x, y, 70)) continue;
        addTree(x, y, 70);
      }
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

    // ---- Стартовые пешки поселения: 2 сборщика, строитель, ремонтник (§B.2) ----
    // Блок декоративных 16 жителей удалён — его роль у настоящих пешек.
    this.economy.spawnInitial();
    // «Дополнительный сборщик» (§H.16): старт 3 сборщика вместо 2
    for (let i = 0; i < this.fx.extraCollector; i++) this.economy.spawnPawn('collector');
    // «Гарнизон долины» (§H.16): стартовый мечник у замка — без казарм,
    // бесплатно, слот не расходует; «Клятва долины» (m8) даёт ему +20 HP
    if (this.fx.startSword) {
      const sword = this.economy.spawnFighter('sword');
      if (sword && this.oathM8) {
        sword.maxHp += 20;
        sword.hp = sword.maxHp;
      }
    }
    // Скин построек (§J.6.2): tint на замок сразу (дальнейшие — по 'built')
    this.tintAllBuildings();
    // Знамя поселения (§J.6.2): над замком с первой секунды матча
    const banner = activeBanner();
    if (banner) {
      // Слайсы banner9 крупнее полотна 46×64 — ограничиваем половиной,
      // как это делает Ui.fitSlices для панелей
      const ns = this.add.nineslice(
        this.castleX, this.castleY - 150, 'banner9', undefined, 46, 64,
        Math.min(100, 23), Math.min(84, 23), Math.min(68, 32), Math.min(111, 32),
      );
      ns.setTint(banner.tint).setDepth(DEPTH.HPBAR);
    }
    // Благословение «Замок +50 HP» (A2)
    if (this.mods.blessing === 'bl_castle_hp') {
      this.settlement.castle.maxHp += 50;
      this.settlement.castle.hp += 50;
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
    // ⚠️ Герой начинает У ЗАМКА, а не в стороне от поселения (§0.1, §B.9).
    // Раньше старт был на 720 px южнее базы: камера открывала пустую траву,
    // поселение было за экраном, а волны, спавнящиеся кольцом вокруг героя,
    // проходили прямо сквозь базу. Теперь первый экран матча — это дом,
    // пешки и точки стройки, а игрок сразу видит, что защищает.
    this.player = new Player(this, this.castleX, this.castleY + 150, this.heroDef);
    // QA-хук (?qa_hero_hp=N, dev-сборки): увеличенное HP героя — чтобы
    // проверять осады/волны/поражение поселения E2E без смерти героя.
    // Бонус применяется в recomputeStats — иначе он перетирался бы heroDef.
    try {
      if (import.meta.env.DEV) {
        const v = parseInt(new URLSearchParams(window.location.search).get('qa_hero_hp') ?? '', 10);
        if (Number.isFinite(v) && v > 0) this.qaHeroHpBonus = v - this.heroDef.maxHp;
      }
    } catch {
      // вне браузера — хук не нужен
    }
  }

  /** Золотые жилы: 10 точек, не ближе 200 px к замку (§B.3).
   *  Заряды — через Economy: «Золотая лихорадка» ×2 + карта «Глубокие шахты». */
  private spawnVeins(
    rng: Phaser.Math.RandomDataGenerator,
    canPlace: (x: number, y: number, r: number) => boolean,
    place: (x: number, y: number, r: number) => void,
    count: number,
  ): void {
    let created = 0;
    let attempts = 0;
    while (created < count && attempts < 300) {
      attempts++;
      const x = rng.between(WORLD.GRASS_MARGIN + 120, WORLD.SIZE - WORLD.GRASS_MARGIN - 120);
      const y = rng.between(WORLD.GRASS_MARGIN + 120, WORLD.SIZE - WORLD.GRASS_MARGIN - 120);
      const castleDistance = Math.hypot(x - this.castleX, y - this.castleY);
      // PawnAI ignores resources beyond 1000 px: keep veins in that work radius.
      if (castleDistance < 200 || castleDistance > 1000) continue;
      if (!canPlace(x, y, 70)) continue;
      const variant = rng.between(1, 5);
      const img = this.add.sprite(x, y, `gold-vein-${variant}`).setScale(0.9)
        .setDepth(DEPTH.ENTITY_BASE + y);
      const pulse = this.add.sprite(x, y, `gold-vein-pulse-${variant}`)
        .setScale(0.9).setDepth(DEPTH.GEM + 1).setBlendMode(Phaser.BlendModes.ADD);
      pulse.play(`gold-vein-pulse-${variant}`);
      place(x, y, 70);
      // Заряды жилы: 4 цикла (+1 карта «Глубокие шахты», ×2 «Золотая лихорадка» — §B.3, A2)
      this.economy.registerNode(new ResourceNode(this, 'vein', 'ore', x, y, this.economy.veinCharges(), img, pulse));
      created++;
    }
    void VEIN_YIELD;
  }

  /**
   * Рабочий пояс поселения (§B.3, §B.9).
   *
   *  Собственный лес, пастбище и две жилы у самой базы. Пояс лежит ВНУТРИ
   *  ядра поселения (SETTLEMENT_CORE) и в промежутках между точками стройки,
   *  поэтому:
   *  • сбор идёт без паники — рабочему не нужно бегать через полкарты;
   *  • первый дом появляется в первую минуту матча (гейт фазы E);
   *  • пояс не пересекается с будущими постройками.
   *
   *  Числа подобраны под план расхода: 10 деревьев — это 50 дерева, а
   *  дом + казармы стоят 70 дерева; три овцы — 9 мяса (найм воина — 5),
   *  две жилы — 160 руды (казармы нужны 15, обитель — 40). Фактические
   *  количества возвращаются наружу: общий сток карты обязан остаться
   *  ровно 10 овец и 10 жил (§B.3), иначе мясо перестаёт быть стоковым
   *  краном найма (§B.5).
   */
  private spawnSettlementBelt(
    rng: Phaser.Math.RandomDataGenerator,
    canPlace: (x: number, y: number, r: number) => boolean,
    place: (x: number, y: number, r: number) => void,
    addTree: (x: number, y: number, radius?: number) => void,
    addSheep: (x: number, y: number) => void,
  ): { sheep: number; veins: number } {
    const R_MIN = 250;
    const R_MAX = SETTLEMENT_CORE - 60;
    /** Точка пояса: угол + радиус, с проверкой занятости и точек стройки. */
    const beltSpot = (radius: number, attempts = 60): { x: number; y: number } | null => {
      for (let i = 0; i < attempts; i++) {
        const a = rng.realInRange(0, Math.PI * 2);
        const r = rng.realInRange(R_MIN, R_MAX);
        const x = this.castleX + Math.cos(a) * r;
        const y = this.castleY + Math.sin(a) * r;
        if (x < WORLD.GRASS_MARGIN + 80 || x > WORLD.SIZE - WORLD.GRASS_MARGIN - 80) continue;
        if (y < WORLD.GRASS_MARGIN + 80 || y > WORLD.SIZE - WORLD.GRASS_MARGIN - 80) continue;
        if (!canPlace(x, y, radius)) continue;
        // Точки стройки: пояс не должен лезть под будущую постройку.
        let clear = true;
        for (const spot of BUILD_SPOTS) {
          const sx = this.castleX + spot.dx, sy = this.castleY + spot.dy;
          if (Math.hypot(x - sx, y - sy) < 96 + radius) { clear = false; break; }
        }
        if (!clear) continue;
        return { x, y };
      }
      return null;
    };
    // Лес поселения
    for (let i = 0; i < 16; i++) {
      const spot = beltSpot(70);
      if (!spot) break;
      addTree(spot.x, spot.y, 70);
    }
    // Пастбище
    let sheep = 0;
    for (let i = 0; i < 4; i++) {
      const spot = beltSpot(50);
      if (!spot) break;
      addSheep(spot.x, spot.y);
      sheep++;
    }
    // Две жилы у базы: руда под казармы и обитель добывается рядом с домом
    let veins = 0;
    for (let i = 0; i < 3; i++) {
      const spot = beltSpot(70);
      if (!spot) break;
      const variant = rng.between(1, 5);
      const img = this.add.sprite(spot.x, spot.y, `gold-vein-${variant}`).setScale(0.9)
        .setDepth(DEPTH.ENTITY_BASE + spot.y);
      const pulse = this.add.sprite(spot.x, spot.y, `gold-vein-pulse-${variant}`)
        .setScale(0.9).setDepth(DEPTH.GEM + 1).setBlendMode(Phaser.BlendModes.ADD);
      pulse.play(`gold-vein-pulse-${variant}`);
      place(spot.x, spot.y, 70);
      this.economy.registerNode(
        new ResourceNode(this, 'vein', 'ore', spot.x, spot.y, this.economy.veinCharges(), img, pulse),
      );
      veins++;
    }
    return { sheep, veins };
  }

  /** Скин построек (§J.6.2): setTint на замок и все здания. */
  private tintAllBuildings(): void {
    if (this.bldTint === null) return;
    for (const b of this.economy.buildings) b.setTint(this.bldTint);
  }

  private buildSystems(): void {
    this.effects = new Effects(this);
    this.pickups = new Pickups(
      this,
      (v) => this.addXp(v),
      (v) => this.player.heal(v),
      (x, y) => this.openChest(x, y),
      (v, x, y) => this.addGold(Math.round(v * this.killGoldMult), x, y),
    );
    // Контракт «Пацифист-герой» (§H.9): чистое золото не липнет к магниту
    this.pickups.heroCollectsGold = this.contractId !== 'c_pacifist';
    this.projectiles = new Projectiles(this, {
      onExplode: (x, y, dmg, radius, mini) => {
        this.explode(x, y, dmg, radius, 'bomb', mini !== true);
      },
      playerPos: () => ({ x: this.player.x, y: this.player.y }),
    });
    this.enemyGroup = this.physics.add.group();
    this.enemyCtxStore = this.makeEnemyCtx();

    // Контекст AI пешек (создаётся с Economy — контекст подкидывается сюда)
    this.registry.set('tss-pawnai-ctx', {
      enemies: () => this.activeEnemies(),
      playerX: () => this.player.x,
      playerY: () => this.player.y,
      pawnAttackEnemy: (e: Enemy, dmg: number, weapon: string) => this.damageEnemyByPawn(e, dmg, weapon),
      shootArrow: (from: Pawn, target: Enemy) => {
        const a = Math.atan2(target.y - from.y, target.x - from.x);
        this.projectiles.fireFriendlyArrow(from.x, from.y, a, 10);
        audio.play('shoot');
      },
      besiegedBuilding: () => this.settlement.siegeIdx >= 0
        ? this.economy.buildings.find((b) => b.lastSiegeIdx === this.settlement.siegeIdx) ?? null
        : null,
      // Герой — цель полевого лечения монаха (§B.7.2, §B.6 «СЛЕДОВАТЬ»)
      hero: () => this.player
        ? { hp: this.player.hp, maxHp: this.player.maxHp, x: this.player.x, y: this.player.y }
        : null,
    });
    // Выбор цели врагом §A.5: гарнизон приоритетнее гражданских.
    // Гражданские в ядре поселения — вне досягаемости: у разбега нет
    // гарнизона, и без этого первая же волна вычищает экономику за минуту.
    // Осада — единственный механизм угрозы базе (§D.1).
    this.registry.set('tss-picktarget', (e: Enemy): Pawn | null => {
      let nearestGarrison: Pawn | null = null;
      let nearestCivilian: Pawn | null = null;
      let garrisonDistance = Infinity;
      let civilianDistance = Infinity;
      for (const p of this.economy.pawns) {
        if (p.dead || !p.active) continue;
        if (p.state === 'wounded' || p.state === 'bleeding') continue;
        const d = Math.hypot(p.x - e.x, p.y - e.y);
        if (d > AGGRO.NPC) continue;
        // Ядро поселения (TZ §A.5): обычные волны не выбирают гражданских
        // в защищённой зоне — замок (560 px) плюс пояс вокруг точек стройки
        // и построенных зданий; у осад отдельный путь.
        if (p.cls === 'civilian' && this.economy.isSettlementCore(p.x, p.y)) continue;
        // Приоритет категорий строгий: гарнизон важнее гражданских независимо
        // от расстояния; внутри категории выбирается ближайшая доступная цель.
        if (p.cls === 'garrison') {
          if (d < garrisonDistance) {
            garrisonDistance = d;
            nearestGarrison = p;
          }
        } else if (d < civilianDistance) {
          civilianDistance = d;
          nearestCivilian = p;
        }
      }
      return nearestGarrison ?? nearestCivilian;
    });

    const spawnCtx: SpawnerCtx = {
      spawn: (kind, x, y) => this.spawnEnemy(kind, x, y),
      spawnElite: (kind) => {
        // Кодекс (§H.10): элита засчитана фактом встречи
        if (kind === 'bear') markCodex('boss_bear');
        else if (kind === 'minotaur') markCodex('boss_minotaur');
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
          this.shakeCamera(220, 0.004);
          const def = ENEMIES[kind];
          this.hud.bossIntro(
            def.name,
            this.diffDef.id === 'nightmare' ? t('hud.bossSubtitleEliteNightmare') : t('hud.bossSubtitleElite'),
            `face-${kind}`,
          );
        }
      },
      spawnBoss: (hpMult) => this.spawnBoss(hpMult ?? 1),
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
      beginSiege: (profile, index) => this.startSiege(profile, index),
    };
    this.spawner = new Spawner(this, spawnCtx, this.diffDef.id, {
      // ---- Мета-режимы директора волн (§H.9, §H.12, §H.17, §H.18, A2) ----
      endless: this.mods.endless,
      // Осады каждые 180 с: контракт «Осадное положение», указ «Двойные осады»
      // и мод «Осадное положение» не суммируются; сезон «Долгая осада» — 270 с
      siegeIntervalSec: this.mods.endless ? null
        : (this.contractId === 'c_siege_state' || this.mods.ukaz === 'ukaz_double_siege'
          || this.challengeMods.has('cm_martial')) ? 180
        : this.seasonMod === 'long_siege' ? 270 : null,
      rateMultFactor: resolveSpawnRateFactor(
        this.mods.ukaz,
        this.challengeMods.has('cm_horde'),
      ),
      season: this.seasonMod,
      contractQuiet: this.contractId === 'c_quiet',
      bloodMoon: this.challengeMods.has('cm_blood_moon'),
      redValley: this.seasonMod === 'red_valley',
      firstSiegeTrim: this.mods.blessing === 'bl_first_siege' ? 1 : 0,
      extraSiege: this.challengeMods.has('cm_gold_rush'),
      // FTUE (§I.2): первый матч аккаунта — плотность волн −20% первые 3 минуты
      ftueSoftStart: this.ftueSoftStart,
      // Вызов дня использует повторяемый пул по дате — обычные и бесконечные
      // матчи не меняют свой состав врагов.
      dailyPool: this.mods.challenge ? pickDailyPool(rollMetaDay().quests.date) : undefined,
      alarmLevel: () => this.economy.card('alarm'),
    });

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
    this.setupDpsDebug();

    // ---- Подписки HUD на экономику (обновление по событию, §B.8) ----
    this.economy.on('change', () => {
      this.hud.updateResources(this.economy.resources);
      this.hud.updateSettlement(
        this.settlement.castle.hp / Math.max(1, this.settlement.castle.maxHp),
        this.settlement.infrastructureHp / this.settlement.infrastructureMax,
        this.economy.pawns.length / Math.max(1, this.economy.pawnLimit),
        this.garrisonHudLabel(),
      );
    });
    this.economy.on('built', ({ kind, first, firstPawn }) => {
      // Сводка рана (§K.2): постройки, время первого дома (§H.17)
      this.buildingsBuilt++;
      if (kind === 'barracks') this.builtBarracks++;
      else if (kind === 'monastery') this.builtMonastery++;
      else if (kind === 'archery') this.builtArchery++;
      if (kind === 'house' && this.firstHouseMin === 0) {
        this.firstHouseMin = this.elapsed / 60;
        // Телеметрия §K.2: первый дом (гейт фазы E)
        track('first_house', { t_sec: Math.floor(this.elapsed) });
      }
      if (kind === 'barracks' && this.builtBarracks === 1) {
        // Телеметрия §K.2: первые казармы
        track('first_barracks', { t_sec: Math.floor(this.elapsed) });
      }
      // Скин построек (§J.6.2): новая постройка тоже под tint
      if (this.bldTint !== null) this.tintAllBuildings();
      this.hud.announce(t('building.built', { v: t(`building.${kind}.name` as Parameters<typeof t>[0]) }), '#7dc95e');
      // Баннер первого жителя называет реальную пешку вместо фиктивного «…».
      if (first && firstPawn) {
        this.hud.announce(
          t('pawn.arrived', { v: `${this.pawnTitle(firstPawn)} ${firstPawn.name}` }),
          '#ffe9b0',
        );
      }
      audio.play('levelup');
    });
    this.economy.on('pawnArrived', ({ pawn }) => {
      this.hud.feed(t('pawn.arrived', { v: `${this.pawnTitle(pawn)} ${pawn.name}` }), '#9fd8ff');
    });
    this.economy.on('pawnWounded', ({ pawn, cause }) => {
      this.hud.feed(t('pawn.wounded', { v: `${this.pawnTitle(pawn)} ${pawn.name}` }), '#ffb090');
      this.effects.woundMark(pawn.x, pawn.y);
      audio.play('hurt');
      track('pawn_wounded', {
        name_role: `${pawn.kind}:${pawn.name}`,
        cause,
        monastery_exists: this.economy.nearestMonastery(pawn) !== null,
        slots_free: this.economy.freeMonasterySlots(),
      });
      if (pawn.cls === 'civilian'
        && !this.economy.buildings.some((building) =>
          building.kind === 'monastery' && building.alive && !building.underConstruction,
        )) {
        this.monasteryHintPending = true;
      }
    });
    this.economy.on('pawnSaved', ({ pawn, inMonastery }) => {
      const savedLabel = t('pawn.saved', { v: `${this.pawnTitle(pawn)} ${pawn.name}` });
      this.hud.feed(savedLabel, '#7dc95e');
      this.hud.announce(savedLabel, '#7dc95e');
      this.effects.heal(pawn.x, pawn.y);
      audio.play('pickup');
      track('pawn_saved', {
        name_role: `${pawn.kind}:${pawn.name}`,
        cause: 'healed',
        monastery_exists: this.economy.nearestMonastery(pawn) !== null,
        slots_free: this.economy.freeMonasterySlots(),
        in_monastery: inMonastery === true,
      });
    });
    this.economy.on('hireDone', ({ weapon, cost }) => {
      this.hires++; // сводка рана (§K.2): наём дружины (§H.17)
      track('garrison_hired', { weapon, cost, cause: 'player' });
      this.hud.feed(t('hire.started', { v: t(`hire.${weapon}` as Parameters<typeof t>[0]) }), '#9fd8ff');
      this.economy.emit('change');
    });
    this.economy.on('pawnDied', ({ pawn }) => {
      // Near-miss «истёк кровью» (§H.3): имя павшего и сколько секунд не хватило
      // до ближайшего освобождённого места обители (для хроники на end-экране)
      if (pawn.state === 'bleeding' && !this.settlement.facts.bledOutName) {
        let short: number | null = null;
        for (const b of this.economy.buildings) {
          if (!b.alive || b.kind !== 'monastery' || b.underConstruction) continue;
          for (const unit of b.healSlots) {
            const u = unit as import('../entities/Pawn').Pawn | null;
            if (!u || !u.active) continue;
            const remain = (u.maxHp - u.hp) / Math.max(1, HEAL_HP_PER_SEC);
            short = short === null ? remain : Math.min(short, remain);
          }
        }
        if (short !== null) {
          this.settlement.facts.bledOutName = pawn.name;
          this.settlement.facts.bledOutShort = Math.max(1, Math.ceil(short));
        }
      }
      const monasteryExists = this.economy.nearestMonastery(pawn) !== null;
      track('pawn_died', {
        name_role: `${pawn.kind}:${pawn.name}`,
        cause: pawn.state === 'bleeding' ? 'bleedout' : 'direct',
        monastery_exists: monasteryExists,
        slots_free: this.economy.freeMonasterySlots(),
      });
      // Телеметрия §K.2: потеря гарнизона (невосполнима без найма, §B.7.1)
      if (pawn.cls === 'garrison') {
        track('garrison_lost', {
          weapon: pawn.weapon ?? 'sword',
          cause: pawn.state === 'bleeding' ? 'bleedout' : 'collapse',
        });
      }
      // «Чума» (A2): павшая пешка оставляет сундук; если сундук уже лежит —
      // роняем золотые кристаллы, чтобы ценность не потерялась
      if (this.challengeMods.has('cm_plague') && !this.gameEnded) {
        if (this.pickups.chestPos()) {
          for (let i = 0; i < 3; i++) {
            this.pickups.spawnGoldGem(
              pawn.x + Phaser.Math.Between(-30, 30),
              pawn.y + Phaser.Math.Between(-20, 20), 12,
            );
          }
        } else {
          this.pickups.spawnChest(pawn.x, pawn.y);
        }
      }
    });
    this.economy.on('repairDone', () => {
      this.addXp(8);
      // Скин построек (§J.6.2): ремонт снимает tint руин — возвращаем скин
      if (this.bldTint !== null) this.tintAllBuildings();
      this.economy.emit('change');
    });
    // Шлейф героя (§J.6.2): эмиттер частиц за спрайтом, tint скина
    const trailTint = trailSkinTint();
    if (trailTint !== null) {
      this.trailEmitter = this.add.particles(0, 0, 'fx-heal', {
        frame: [0],
        speed: { min: 4, max: 22 },
        lifespan: 480,
        scale: { start: 0.4, end: 0 },
        alpha: { start: 0.75, end: 0 },
        tint: trailTint,
        frequency: 55,
        emitting: false,
      }).setDepth(DEPTH.FX);
      this.trailEmitter.startFollow(this.player, 0, 16);
    }
    const announceSpeedupResult = (reason: string): void => {
      const key = reason === 'storage'
        ? 'speedup.storageUnavailable'
        : reason === 'noTarget'
          ? 'speedup.noTarget'
          : reason === 'poor'
            ? 'speedup.poor'
            : 'speedup.adUnavailable';
      this.hud.announce(t(key as Parameters<typeof t>[0]), '#ff8866');
    };
    const useCurrency = (kind: 'repair' | 'heal'): void => {
      // Контракт «Без ремонта» (§H.9): запрет действует для обеих валют.
      if (kind === 'repair' && this.contractId === 'c_no_repair') {
        this.hud.feed(t('contract.no_repair.name'), '#ff8866');
        return;
      }
      // Наградной жетон — бесплатный приоритет; рекламный показ никогда не
      // запускается автоматически из кнопки списания валюты.
      const token = this.speedup.buyWithToken(kind);
      if (token.ok) {
        this.hud.announce(t('speedup.done'), '#7dc95e');
        return;
      }
      if (token.reason === 'storage' || token.reason === 'noTarget') {
        announceSpeedupResult(token.reason);
        return;
      }
      const wallet = this.speedup.buyWithGold(kind);
      if (wallet.ok) this.hud.announce(t('speedup.done'), '#7dc95e');
      else announceSpeedupResult(wallet.reason ?? 'poor');
    };
    const useAd = (kind: 'repair' | 'heal'): void => {
      if (kind === 'repair' && this.contractId === 'c_no_repair') {
        this.hud.feed(t('contract.no_repair.name'), '#ff8866');
        return;
      }
      // Реклама доступна только по явному нажатию кнопки «Видео».
      void this.speedup.buyWithAd(kind).then((result) => {
        if (result.ok) this.hud.announce(t('speedup.done'), '#7dc95e');
        else announceSpeedupResult(result.reason);
      });
    };
    this.hud.setSpeedupHandlers({
      repairCurrency: () => useCurrency('repair'),
      repairAd: () => useAd('repair'),
      healCurrency: () => useCurrency('heal'),
      healAd: () => useAd('heal'),
    });
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

    this.physics.add.overlap(this.player, this.projectiles.enemyShots, (_p, proj) => {
      const p = proj as unknown as import('../systems/Projectiles').Proj & { shotKind?: import('../entities/Enemy').EnemyShotKind };
      if (!p.active) return;
      if (p.shotKind === 'hex') this.effects.hexBlast(p.x, p.y);
      this.projectiles.releaseEnemyShot(p);
      this.hurtPlayer(p.dmg);
    });

    // Стрелы NPC-лучника бьют врагов: KILL растёт, комбо игрока — нет (§B.7.1)
    this.physics.add.overlap(this.projectiles.friendlyArrows, this.enemyGroup, (proj, e) => {
      const p = proj as unknown as import('../systems/Projectiles').Proj;
      const enemy = e as Enemy;
      if (!p.active || !enemy.active) return;
      if (p.hitSet?.has(enemy)) return;
      p.hitSet?.add(enemy);
      this.damageEnemyByPawn(enemy, p.dmg, 'bow');
      this.projectiles.release(p);
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
      shift: Phaser.Input.Keyboard.KeyCodes.SHIFT,
    }) as Keys;
    kb.addCapture('UP,DOWN,LEFT,RIGHT,SPACE');
    this.joystick = new Joystick(this);

    // ---- Приказы пешкам: Shift+ЛКМ (десктоп) / лонг-пресс 500 мс (тач) (§B.6) ----
    this.input.on('pointerdown', (
      pointer: Phaser.Input.Pointer,
      currentlyOver: Phaser.GameObjects.GameObject[] = [],
    ) => {
      // UI должен потреблять pointerdown до геймплейного слоя, даже если его
      // callback закрыл меню на том же событии. Это исключает повторное открытие.
      const hitsOrderMenu = currentlyOver.some((target) => (
        (target as Phaser.GameObjects.GameObject & { __tssOrderMenuTarget?: boolean }).__tssOrderMenuTarget === true
      ));
      if (hitsOrderMenu) return;
      // FTUE-overlay имеет собственный pointerdown для закрытия; игровой ввод
      // не должен начинать long-press/приказ на том же касании, пока overlay активен.
      if (this.gameEnded || this.overlayOpen || this.hintOverlayPaused) return;
      // Нативный MouseEvent — основной источник, Phaser Keyboard — резерв:
      // часть браузеров/сценариев передаёт pointer.event уже после keyup Shift.
      const nativeShift = (pointer.event as unknown as { shiftKey?: boolean })?.shiftKey === true;
      const shift = !pointer.wasTouch && (nativeShift || this.keys.shift.isDown);

      // Повторный Shift+ЛКМ закрывает меню. Обычное удержание мыши не запускает
      // long-press: на desktop требуется явный Shift.
      if (this.orderMenu.isOpen) {
        if (shift) this.orderMenu.close();
        return;
      }
      if (!pointer.wasTouch && !shift) return;

      const wp = pointer.worldX, wy = pointer.worldY;
      const hitPawn = this.findPawnAt(wp, wy, pointer.wasTouch);
      const hitBuilding = hitPawn ? null : this.findBuildingAt(wp, wy);
      if (!hitPawn && !hitBuilding) return;
      this.pressState = {
        x: wp, y: wy, screenX: pointer.x, screenY: pointer.y,
        t: this.activeTimeMs, pointer, pawn: hitPawn, building: hitBuilding,
      };
      if (shift && hitPawn) {
        this.openOrderMenu(hitPawn, wp, wy);
        this.pressState = null;
      } else if (shift && hitBuilding) {
        this.openHireMenu(hitBuilding, wp, wy);
        this.pressState = null;
      }
      // Touch: ждём 500 мс; отпускание раньше порога отменяет жест.
    });
    const clearPress = (pointer: Phaser.Input.Pointer): void => {
      // Вторая точка касания не должна отменять long-press первой.
      if (this.pressState && this.pressState.pointer.id !== pointer.id) return;
      this.pressState = null;
      this.orderMenu.hideRing();
    };
    this.input.on('pointerup', clearPress);
    this.input.on('pointerupoutside', clearPress);
  }

  private findPawnAt(x: number, y: number, touch: boolean): Pawn | null {
    // Радиус пересчитывается из экранных CSS-пикселей в мир с учётом зума камеры.
    // При zoom=0.55 прежние 40 world units превращались лишь в 22 px.
    const canvasWidth = this.game.canvas.getBoundingClientRect().width;
    const gameUnitsPerCssPx = this.scale.width / Math.max(1, canvasWidth);
    const worldUnitsPerCssPx = gameUnitsPerCssPx / Math.max(0.01, this.cameras.main.zoom);
    const r = touch ? Math.max(40, 32 * worldUnitsPerCssPx) : 26;
    let best: Pawn | null = null;
    let bestD = r * r;
    for (const p of this.economy.pawns) {
      if (p.dead || !p.active) continue;
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  private findBuildingAt(x: number, y: number): Building | null {
    let best: Building | null = null;
    let bestD = Infinity;
    for (const b of this.economy.buildings) {
      if (!b.alive || b.underConstruction) continue;
      if (b.kind !== 'barracks' && b.kind !== 'archery' && b.kind !== 'monastery') continue;
      const d = Math.hypot(b.x - x, b.y - y);
      if (d < 110 && d < bestD) { bestD = d; best = b; }
    }
    return best;
  }

  /**
 * Прогрессивное раскрытие приказов (§I.3): «Приказы рабочим → ПОСЛЕ 2-го
 * дома в матче. После одного дома ещё не ясно, что это не декорация».
 *
 * ⚠️ Условие по СОСТОЯНИЮ поселения сильнее условия по номеру матча (§I.3) —
 * проверяется счётчиком построенных домов, а не matchesPlayed.
 */
private ordersUnlocked(): boolean {
    return this.economy.houses >= 2;
  }

  private openOrderMenu(pawn: Pawn, wx: number, wy: number): void {
    if (!this.ordersUnlocked()) {
      // Не заблокируем интерфейс молча (§I.1 — учим действием): короткое
      // объяснение в ленту поселения.
      this.hud?.feed(t('orders.locked'), '#ffd76e');
      return;
    }
    this.orderMenu.open(pawn, wx, wy, (key) => {
      if (!this.orderMenu.openPawn) return;
      // Сброс — возврат к автоповедению, а не новый игровой приказ.
      if (key === 'reset') {
        pawn.order = null;
        pawn.orderTarget = null;
        return;
      }
      // Приказ не перебивает carry-фазу — PawnAI применит после сдачи (§B.6).
      // Точка нужна только HOLD: у FOLLOW/POST/MONASTERY старую координату
      // нельзя хранить после смены режима.
      pawn.order = key;
      pawn.orderTarget = key === 'hold' ? { x: wx, y: wy } : null;
      track('first_order_used', { order: key });
    });
  }

  /** Меню найма гарнизона на здании (§B.9.1): казармы/тир/обитель. */
  private openHireMenu(b: Building, wx: number, wy: number): void {
    const weapons: Array<import('../data').PawnWeapon> =
      b.kind === 'barracks' ? ['sword', 'lance'] : b.kind === 'archery' ? ['bow'] : ['staff'];
    const entries = weapons.map((w) => ({
      key: w,
      label: t(`hire.${w}` as Parameters<typeof t>[0]),
      disabled: !this.economy.canHire(w),
    }));
    this.orderMenu.openCustom(entries, wx, wy, (key) => {
      const w = key as import('../data').PawnWeapon;
      if (this.economy.hire(w, b)) {
        this.hud.feed(t('hire.started', { v: t(`hire.${w}` as Parameters<typeof t>[0]) }), '#9fd8ff');
        this.economy.emit('change');
      } else {
        this.hud.announce(t('building.cannot'), '#ff8866');
      }
    });
  }

  /** Короткая строка состояния дружины и раненых для поселкового HUD. */
  private garrisonHudLabel(): string {
    const wounded = this.economy.pawns.filter((p) => p.state === 'wounded' || p.state === 'bleeding').length;
    const retreating = this.economy.garrison.filter((p) => p.state === 'retreat').length;
    const base = t('hud.garrison', { a: this.economy.garrison.length, b: this.economy.totalGarrisonSlots() });
    return wounded + retreating > 0
      ? `${base} · ${t('hud.garrisonStatus', { w: wounded, r: retreating })}`
      : base;
  }

  /**
   * В dev (?debug) выводит измеренный урон гарнизона за последнее окно и
   * теоретический потолок в 25% от базового DPS героя на отметке 10:00.
   * В обычной сборке диагностический текст не создаётся.
   */
  private setupDpsDebug(): void {
    if (!import.meta.env.DEV || typeof window === 'undefined'
      || !new URLSearchParams(window.location.search).has('debug')) return;
    this.dpsDebugText = this.add.text(8, 82, '', {
      fontFamily: 'monospace',
      fontSize: '11px',
      color: '#baf7ff',
      backgroundColor: '#111923',
      padding: { x: 6, y: 4 },
      lineSpacing: 2,
    }).setScrollFactor(0).setDepth(90_000);
    this.lastDpsDebugUpdate = this.activeTimeMs;
  }

  private updateDpsDebug(time: number): void {
    if (!this.dpsDebugText || time - this.lastDpsDebugUpdate < 1_000) return;
    const windowMs = Math.max(1, time - this.lastDpsDebugUpdate);
    const rawDps = this.dpsDebugRawDamage * 1_000 / windowMs;
    const appliedDps = this.dpsDebugAppliedDamage * 1_000 / windowMs;
    const heroDps = this.heroDpsAtTenMinutes;
    const capDps = heroDps === null ? null : heroDps * GARRISON_DPS_CAP;
    const rawShare = heroDps !== null && heroDps > 0 ? rawDps / heroDps * 100 : null;
    const appliedShare = heroDps !== null && heroDps > 0 ? appliedDps / heroDps * 100 : null;
    this.dpsDebugText.setText([
      'DPS QA · window 1s',
      `hero@10m: ${heroDps === null ? 'not captured' : heroDps.toFixed(1)} /s`,
      `garrison: ${rawDps.toFixed(1)} → ${appliedDps.toFixed(1)} /s`,
      `share of hero DPS: raw ${rawShare === null ? 'n/a' : rawShare.toFixed(1) + '%'} → applied ${appliedShare === null ? 'n/a' : appliedShare.toFixed(1) + '%'}`,
      `cap: ${capDps === null ? 'not active' : capDps.toFixed(1) + ' /s (' + (GARRISON_DPS_CAP * 100).toFixed(0) + '% hero)'} · bank ${this.garrisonDpsBudget.availableDamage.toFixed(1)}`,
    ].join('\n'));
    this.dpsDebugRawDamage = 0;
    this.dpsDebugAppliedDamage = 0;
    this.lastDpsDebugUpdate = time;
  }

  // ================= ЦИКЛ =================

  update(time: number, delta: number): void {
    // Решение о поражении принимается здесь — после всей физики кадра.
    // Если тем же тиком погиб босс, победа уже объявлена и урон не считается.
    if (this.confirmDefeat()) return;
    if (!this.started || this.gameEnded || this.victoryPending || this.hintOverlayPaused) return;

    // Scene Clock.now и параметр update(time) продолжают расти под Clock.pause().
    // Отдельные часы симуляции останавливаются вместе с блокирующим FTUE overlay.
    const dtMs = Math.min(Math.max(0, delta * this.juiceSlowFactor), 50);
    this.activeTimeMs += dtMs;
    this.registry.set('tss-active-time-ms', this.activeTimeMs);
    this.updateDpsDebug(this.activeTimeMs);

    // Хитстоп замораживает движение, но не собственный короткий таймер.
    if (this.activeTimeMs < this.hitstopUntil) {
      this.player.setVelocity(0, 0);
      return;
    }

    const dt = dtMs / 1000;
    this.samplePerformance(dtMs);

    // Escape закрывает меню приказов, не создавая поверх него окно паузы.
    const escapePressed = Phaser.Input.Keyboard.JustDown(this.keys.esc);
    const pausePressed = Phaser.Input.Keyboard.JustDown(this.keys.p);
    if (escapePressed && this.orderMenu.isOpen) {
      this.orderMenu.close();
      this.pressState = null;
      return;
    }
    if (escapePressed || pausePressed) {
      this.orderMenu.close();
      this.pressState = null;
      this.openPause();
      return;
    }
    if (Phaser.Input.Keyboard.JustDown(this.keys.m)) {
      const muted = audio.toggleMute();
      this.hud.announce(muted ? t('hud.soundOff') : t('hud.soundOn'), '#ffe9b0');
    }

    this.elapsed += dt;
    // Фиксируем единый theoretical single-target DPS героя на отметке 10:00.
    // Все атаки гарнизона после этого момента расходуют общий токен-бакет.
    if (this.elapsed >= 600 && this.heroDpsAtTenMinutes === null) {
      this.heroDpsAtTenMinutes = this.weapons.estimateTheoreticalDps();
      this.garrisonDpsBudget.reset(this.activeTimeMs);
    }

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
    // Шлейф скина (§J.6.2): частицы только в движении
    if (this.trailEmitter) {
      if (len > 0.4 && !this.trailEmitter.emitting) this.trailEmitter.start();
      else if (len <= 0.4 && this.trailEmitter.emitting) this.trailEmitter.stop();
    }

    // Системы
    this.weapons.update(dtMs);
    this.projectiles.update(dtMs);
    this.spawner.update(dt);

    // Экономика поселения: пешки, стройка, ремонт, найм, обитель (TZ §B)
    this.economy.tick(dtMs, this.activeTimeMs);
    this.economy.monasteryHealTick(dtMs);

    // Осада: таймер отступления 60 сек и исход (§E.4.2)
    this.siegeTick();

    // Условие поражения №3 — вымирание, пересчёт раз в 60 сек (§E.3)
    if (this.settlement.checkExtinction(this.activeTimeMs) && this.extinctAt === null) {
      this.extinctAt = this.activeTimeMs;
      this.hud.announce(t('over.extinct'), '#ff5544');
    }
    if (this.extinctAt !== null && this.activeTimeMs - this.extinctAt > 3000) {
      // 3-секундный экран перед GameOverScene (§E.3)
      this.loseCause = 'population';
      this.gameOver(false);
      return;
    }

    // Лонг-пресс приказа: кольцо заполнения → меню (§B.6)
    if (this.pressState && !this.orderMenu.isOpen) {
      // §B.6: «свайп от пальца = отмена». Палец, который уехал с пешки при
      // удержании, не хотел открывать меню — он двигал героя. Без проверки
      // приказная система на тач-свайпе срабатывала бы постоянно.
      const ptr = this.pressState.pointer;
      if (ptr.isDown) {
        // Phaser pointer.x/y — логические координаты canvas; пересчитываем в CSS px,
        // чтобы порог 12 px не менялся при FIT/масштабировании холста.
        const canvas = this.game.canvas.getBoundingClientRect();
        const cssDx = (ptr.x - this.pressState.screenX) * canvas.width / Math.max(1, this.scale.width);
        const cssDy = (ptr.y - this.pressState.screenY) * canvas.height / Math.max(1, this.scale.height);
        const drift = Math.hypot(cssDx, cssDy);
        if (drift > 12) {
          this.orderMenu.hideRing();
          this.pressState = null;
        }
      }
    }
    if (this.pressState && !this.orderMenu.isOpen) {
      const held = this.activeTimeMs - this.pressState.t;
      if (held >= LONGPRESS_MS) {
        this.orderMenu.hideRing();
        if (this.pressState.pawn) this.openOrderMenu(this.pressState.pawn, this.pressState.x, this.pressState.y);
        else if (this.pressState.building) this.openHireMenu(this.pressState.building, this.pressState.x, this.pressState.y);
        this.pressState = null;
      } else if (held > 120) {
        this.orderMenu.showRing(this.pressState.x, this.pressState.y, this.pressState.t);
        this.orderMenu.updateRing(this.activeTimeMs, LONGPRESS_MS);
      }
    }

    // Фаза 2 босса идёт на замок (§E.6)
    this.bossPhaseCheck();

    // Башни поселения стреляют по осаде/толпе (фаза M ROADMAP)
    this.towerTick(this.activeTimeMs);

    // Сундуки с сокровищами
    if (!this.gameEnded) {
      this.chestTimer -= dt;
      if (this.chestTimer <= 0) {
        this.chestTimer = 75;
        this.spawnChest();
      }
    }
    // Магнит комбо-вехи 200 живёт 10 секунд (§H.4) — радиус пересчитываем
    // каждый кадр, потому что он не входит в recomputeStats (там он был бы
    // перетёрт снятием пассивки).
    const magnetNow = this.activeTimeMs < this.xpMagnetUntil
      ? this.magnetRadius * 6
      : this.magnetRadius;
    // Подбор кристаллов — часть игровой симуляции, поэтому slow-motion
    // должен замедлять их движение и притяжение так же, как оружие и снаряды.
    this.pickups.update(dtMs, this.player.x, this.player.y, magnetNow, this.activeTimeMs);

    // Регенерация
    if (this.regen > 0 && this.player.hp < this.player.maxHp) {
      this.player.heal(this.regen * dt);
    }

    // Сепарация врагов
    this.separateEnemies();

    // Деспавн далёких (осадные враги — по таймеру 60 сек, см. siegeTick)
    if (time - this.lastDespawn > 700) {
      this.lastDespawn = time;
      this.despawnFar();
    }

    // Босс — приоритет полосе HP
    if (this.boss) {
      if (this.boss.active) {
        this.hud.updateBossBar(this.boss.hp / this.boss.maxHp, this.boss.hp, this.boss.maxHp);
      } else {
        this.boss = null;
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
    // Поселение и ускорения — реже: события/кнопки не критичны к кадру
    if (time - this.lastSettleHud > 700) {
      this.lastSettleHud = time;
      this.hud.updateSettlement(
        this.settlement.castle.hp / Math.max(1, this.settlement.castle.maxHp),
        this.settlement.infrastructureHp / this.settlement.infrastructureMax,
        this.economy.pawns.length / Math.max(1, this.economy.pawnLimit),
        this.garrisonHudLabel(),
      );
      this.hud.updateSpeedups(
        this.speedup.hasTarget('repair'),
        this.speedup.hasTarget('heal'),
        loadShop().balance,
        this.speedup.hasToken(),
        placementAvailable('repair-speedup'),
        placementAvailable('heal-speedup'),
      );
      this.hud.updateResources(this.economy.resources);
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

    // Подсказки FTUE (§I.2–I.3) проверяют текущее состояние каждый кадр.
    // Событие не потребляется, пока обучение выключено: игрок может включить
    // его в паузе и всё ещё получить подсказки для доступных механик.
    if (this.hints.isEnabled()) {
      if (this.economy.resources.wood >= 30 && !this.hints.hasSeen('house')) {
        this.hints.show('house', this.buildingHintTarget('house'));
      }
      if (this.elapsed >= 20 && !this.hints.hasSeen('pawns')) {
        this.hints.show('pawns', () => this.hud.resourceHintPoint());
      }
      const hasLivingBarracks = this.economy.buildings.some((building) =>
        building.kind === 'barracks' && building.alive,
      );
      if (this.economy.houses > 0
        && !hasLivingBarracks
        && this.economy.canAfford(this.economy.buildingCost('barracks'))
        && !this.hints.hasSeen('barracks')) {
        this.hints.show('barracks', this.buildingHintTarget('barracks'));
      }
      if (this.economy.houses >= 2 && !this.hints.hasSeen('orders')) {
        this.hints.show('orders', this.worldHintTarget(() => {
          const pawn = this.economy.pawns.find((candidate) =>
            candidate.cls === 'civilian' && candidate.active && !candidate.dead,
          );
          return pawn ? { x: pawn.x, y: pawn.y } : null;
        }));
      }
      const monastery = this.economy.buildings.find((building) =>
        building.kind === 'monastery' && building.alive && !building.underConstruction,
      );
      if (monastery && !this.hints.hasSeen('monasteryBuilt')) {
        this.hints.show('monasteryBuilt', this.worldHintTarget(() => {
          const target = this.economy.buildings.find((building) =>
            building.kind === 'monastery' && building.alive && !building.underConstruction,
          );
          return target ? { x: target.x, y: target.y } : null;
        }));
      }
      if (this.settlement.facts.monasteryFallenAt && !this.hints.hasSeen('monasteryLoss')) {
        this.hints.show('monasteryLoss');
      }
    }

    const hasMonastery = this.economy.buildings.some((building) =>
      building.kind === 'monastery' && building.alive && !building.underConstruction,
    );
    if (this.monasteryHintPending) {
      if (hasMonastery || this.hints.hasSeen('monastery')) {
        this.monasteryHintPending = false;
      } else if (this.hints.isEnabled()) {
        this.hints.show('monastery', this.buildingHintTarget('monastery'));
      }
    }

    // Тосты заданий дня (§H.17): проверка раз в 5 сек, бой не прерывается
    this.questCheckAcc += dt;
    if (this.questCheckAcc >= 5) {
      this.questCheckAcc = 0;
      this.checkQuestToasts();
    }

    // Левел-ап
    if (this.pendingLevelUps > 0 && !this.overlayOpen && !this.gameEnded && !this.victoryPending) {
      this.openLevelUp();
    }
  }

  // ================= БОЙ =================

  /** Снимает FPS-сэмпл раз в секунду и отслеживает пик активных врагов. */
  private samplePerformance(dtMs: number): void {
    this.perfSampleAccMs += dtMs;
    if (this.perfSampleAccMs < 1_000) return;
    this.perfSampleAccMs %= 1_000;
    const fps = this.game.loop.actualFps;
    if (Number.isFinite(fps) && fps > 0) this.perfFpsSamples.push(fps);
    this.enemiesPeak = Math.max(this.enemiesPeak, this.activeEnemies().length);
  }

  /** Одно событие perf_fps на ран с процентилями, классом устройства и пиком врагов. */
  private flushPerformanceTelemetry(): void {
    if (this.perfTelemetrySent) return;
    this.perfTelemetrySent = true;
    const samples = this.perfFpsSamples
      .filter((fps) => Number.isFinite(fps) && fps > 0)
      .sort((a, b) => a - b);
    if (samples.length === 0) return;
    const percentile = (p: number): number => {
      const index = Math.min(samples.length - 1, Math.max(0, Math.ceil(p * samples.length) - 1));
      return Math.round(samples[index] ?? 0);
    };
    track('perf_fps', {
      p50: percentile(0.5),
      p10: percentile(0.1),
      device_class: detectDeviceClass(),
      enemies_peak: this.enemiesPeak,
      samples: samples.length,
      duration_s: Math.floor(this.elapsed),
    });
  }

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

  /** На 300 мс гасим музыку разрушения; повторный взрыв продлевает паузу. */
  private pauseMusicForBuildingDestruction(): void {
    audio.stopMusic();
    if (this.buildingMusicResumeEvent) this.time.removeEvent(this.buildingMusicResumeEvent);
    this.buildingMusicResumeEvent = this.time.delayedCall(300, () => {
      this.buildingMusicResumeEvent = null;
      if (!this.gameEnded && !this.victoryPending) audio.startMusic();
    });
  }

  /** Управляет slow-motion и возвращает исходные шкалы времени по окончании. */
  private applyJuiceSlowMotion(durationMs: number, factor: number, essential = false): void {
    if (!Number.isFinite(durationMs) || durationMs <= 0
      || !Number.isFinite(factor) || factor <= 0 || factor >= 1
      || !this.juicePolicy.allowTimeEffect(this.activeTimeMs, essential)) return;

    if (!this.juiceSlowOriginalScales) {
      this.juiceSlowOriginalScales = {
        physics: this.physics.world.timeScale,
        clock: this.time.timeScale,
        tweens: this.tweens.timeScale,
      };
    }
    if (this.juiceSlowRestoreEvent) this.time.removeEvent(this.juiceSlowRestoreEvent);
    this.juiceSlowFactor = Math.min(this.juiceSlowFactor, factor);
    this.physics.world.timeScale = this.juiceSlowOriginalScales.physics / this.juiceSlowFactor;
    this.time.timeScale = this.juiceSlowOriginalScales.clock * this.juiceSlowFactor;
    this.tweens.timeScale = this.juiceSlowOriginalScales.tweens * this.juiceSlowFactor;
    // Timer Events сами подчиняются Clock.timeScale. Компенсируем текущий
    // scale, чтобы durationMs оставался фактической длительностью эффекта:
    // при 0.5× Clock для 1 500 мс достаточно 750 мс его собственного времени.
    const clockScale = Math.max(Number.EPSILON, this.time.timeScale);
    this.juiceSlowRestoreEvent = this.time.delayedCall(
      durationMs * clockScale,
      () => this.restoreJuiceSlowMotion(),
    );
  }

  private restoreJuiceSlowMotion(): void {
    if (this.juiceSlowRestoreEvent) {
      this.time.removeEvent(this.juiceSlowRestoreEvent);
      this.juiceSlowRestoreEvent = null;
    }
    if (this.juiceSlowOriginalScales) {
      this.physics.world.timeScale = this.juiceSlowOriginalScales.physics;
      this.time.timeScale = this.juiceSlowOriginalScales.clock;
      this.tweens.timeScale = this.juiceSlowOriginalScales.tweens;
      this.juiceSlowOriginalScales = null;
    }
    this.juiceSlowFactor = 1;
  }

  /** Камерная тряска отключена на low-профиле (телефоны/reduced motion). */
  private shakeCamera(duration: number, intensity: number): void {
    if (this.juicePolicy.canShake()) this.cameras.main.shake(duration, intensity);
  }

  /**
   * Короткие time-effects ограничены общим бюджетом 1/3 сек активной игры.
   * Essential зарезервирован только для кульминаций босса и победы (§H.13 №9–10).
   */
  private hitstop(ms: number, essential = false): void {
    if (!this.juicePolicy.allowTimeEffect(this.activeTimeMs, essential)) return;
    this.hitstopUntil = Math.max(this.hitstopUntil, this.activeTimeMs + ms);
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
    this.effects.hitSound(this.activeTimeMs);
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
    this.shakeCamera(160, 0.004);
    for (const e of this.activeEnemies()) {
      const dx = e.x - x, dy = e.y - y;
      if (Math.hypot(dx, dy) <= radius + e.def.body.r) {
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
    if (this.activeTimeMs < this.player.iframesUntil) return;
    const dmg = Math.max(1, Math.round(amount * this.armorMult));
    const dead = this.player.damage(dmg, this.activeTimeMs);
    audio.play('hurt');
    this.shakeCamera(120, 0.0035);
    this.cameras.main.flash(110, 190, 40, 30, false);
    this.hitstop(80);
    // §H.4: «Серия сбрасывается пропущенным ударом по герою (как сейчас) —
    // вехи достижимы только скиллом». Без этого сундучки вех сыпались за
    // безнаказанное стояние на месте.
    this.combo = 0;
    this.comboTimer = 0;
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
      this.onHeroDeath();
      return true;
    }
    this.defeatPending = false;
    return false;
  }

  // ================= ПОСЕЛЕНИЕ: осады, поражения, стройка =================

  /** Осада стартует: анонс уже прозвучал (Spawner). Отряд спавнится у базы. */
  private startSiege(profile: SiegeProfile, index: number): void {
    audio.play('boss');
    this.hud.showSiegeVignette(2_000);
    this.applyJuiceSlowMotion(500, 0.7);
    this.cameras.main.flash(200, 190, 40, 30, false);
    const enemies: Enemy[] = [];
    // Обычные осады подходят с одной стороны; «Клещи» делят отряд
    // на два противоположных фланга (TZ §E.4.3).
    const baseA = Math.random() * Math.PI * 2;
    const unitCount = profile.squad.reduce((total, part) => total + part.n, 0);
    const spawnAngles = calculateSiegeSpawnAngles(profile.formation ?? 'single', unitCount, baseA);
    let unitIdx = 0;
    for (const part of profile.squad) {
      for (let i = 0; i < part.n; i++) {
        const a = spawnAngles[unitIdx] ?? baseA;
        unitIdx++;
        const r = 760 + Math.random() * 220;
        const x = Phaser.Math.Clamp(this.castleX + Math.cos(a) * r, WORLD.GRASS_MARGIN + 60, WORLD.SIZE - WORLD.GRASS_MARGIN - 60);
        const y = Phaser.Math.Clamp(this.castleY + Math.sin(a) * r, WORLD.GRASS_MARGIN + 60, WORLD.SIZE - WORLD.GRASS_MARGIN - 60);
        const e = this.spawnSiegeUnit(part.kind, x, y, part.firer === true);
        if (e) enemies.push(e);
      }
    }
    this.assignSiegeTarget(profile, enemies);
    this.showSiegeTargetIndicators(enemies);
    this.settlement.beginSiege(index, profile.woundCap, enemies);
    this.activeSiegeProfile = profile.name;
    this.siegeAlive = true;
    this.siegeDestroyed = 0;
    this.siegeTotal = enemies.length;
    this.siegeKills = 0;
    // Бесконечный (§H.12): волна = счётчик осад; HUD-таймер не трогаем —
    // минимальный маркер волны через анонс (index с нуля → волна с 1)
    if (this.mods.endless) {
      this.wave = index + 1;
      this.hud.announce(t('endless.wave', { v: this.wave }), '#ffd76e');
    }
    this.hints?.show('siege', this.worldHintTarget(() => {
      const target = enemies.find((enemy) => enemy.active && !enemy.dead);
      return target ? { x: target.x, y: target.y } : null;
    }));
    track('siege_start', { index, profile: profile.name });
  }

  /**
   * На 3 секунды показывает направление осадного отряда к его текущей цели.
   * Это короткая подсказка поверх карты, а не постоянный навигационный слой.
   */
  private siegeArrowDurationMs(): number {
    return 3_000 + 2_000 * this.economy.card('alarm');
  }

  private showSiegeTargetIndicators(enemies: Enemy[]): void {
    if (enemies.length === 0) return;
    const marker = this.add.graphics().setDepth(DEPTH.FX + 1);
    marker.lineStyle(2, 0xff5544, 0.78);
    marker.fillStyle(0xff5544, 0.92);
    for (const enemy of enemies) {
      const target = (enemy.buildingTarget as { x: number; y: number } | null) ?? this.settlement.castle;
      const dx = target.x - enemy.x;
      const dy = target.y - enemy.y;
      const length = Math.hypot(dx, dy);
      if (length < 1) continue;
      const ux = dx / length;
      const uy = dy / length;
      const tipX = target.x - ux * 46;
      const tipY = target.y - uy * 46;
      marker.beginPath();
      marker.moveTo(enemy.x, enemy.y);
      marker.lineTo(tipX, tipY);
      marker.strokePath();
      const baseX = tipX - ux * 17;
      const baseY = tipY - uy * 17;
      const px = -uy * 8;
      const py = ux * 8;
      marker.fillTriangle(tipX, tipY, baseX + px, baseY + py, baseX - px, baseY - py);
    }
    this.time.delayedCall(this.siegeArrowDurationMs(), () => {
      if (marker.active) marker.destroy();
    });
  }

  /** Осадный юнит: флаг siege, вне лимита толпы не считается (это волна события). */
  private spawnSiegeUnit(kind: EnemyKind, x: number, y: number, firer: boolean): Enemy | null {
    const m = WORLD.GRASS_MARGIN + 40;
    x = Phaser.Math.Clamp(x, m, WORLD.SIZE - m);
    y = Phaser.Math.Clamp(y, m, WORLD.SIZE - m);
    const e = new Enemy(this, x, y, kind, this.spawner.hpMult, this.spawner.dmgMult, this.enemyCtxStore!);
    if (this.diffDef.speedMult !== 1) e.speed = Math.round(e.speed * this.diffDef.speedMult);
    // «Кровавая луна» (A2): скорость врагов ×1.1
    if (this.enemySpeedMult !== 1) e.speed = Math.round(e.speed * this.enemySpeedMult);
    e.siege = true;
    e.firer = firer;
    e.spawnedAt = this.activeTimeMs;
    this.enemyGroup.add(e);
    return e;
  }

  /** Цель профиля осады с фолбэком §G.7; в профилях с двумя целями отряды разделяются. */
  private assignSiegeTarget(profile: SiegeProfile, enemies: Enemy[]): void {
    const pick = (kind: BuildingKind): Building | null =>
      this.economy.buildings.find((b) => b.alive && b.kind === kind && !b.underConstruction) ?? null;
    const outerHouse = (exclude?: Building | null): Building | null => {
      const houses = this.economy.buildings
        .filter((b) => b.kind === 'house' && b.alive && !b.underConstruction && b !== exclude)
        .sort((a, b) =>
          Math.hypot(b.x - this.castleX, b.y - this.castleY)
          - Math.hypot(a.x - this.castleX, a.y - this.castleY));
      return houses[0] ?? null;
    };
    const directTarget = (kind: SiegeProfile['target'], exclude?: Building | null): Building | null =>
      kind === 'houses' ? outerHouse(exclude) : pick(kind);
    const priorityOrder: BuildingKind[] = ['castle', 'monastery', 'barracks', 'house', 'tower', 'archery'];
    let target = directTarget(profile.target);
    if (!target && profile.target === 'houses') {
      // Домашние профили предпочитают не-замковые здания, чтобы первая осада
      // обучала защите поселения без немедленного давления на замок.
      for (const k of ['monastery', 'barracks', 'house', 'tower', 'archery'] as BuildingKind[]) {
        target = pick(k);
        if (target) break;
      }
    } else if (!target && profile.target === 'monastery') {
      // «Поджигатели»: если обители нет, сначала атакуют внешний дом.
      target = outerHouse();
      if (!target) {
        for (const k of ['barracks', 'house', 'tower', 'archery'] as BuildingKind[]) {
          target = pick(k);
          if (target) break;
        }
      }
    }
    if (!target) {
      for (const k of priorityOrder) {
        target = pick(k);
        if (target) break;
      }
    }

    // Для «Налёта» и «Клещей» цель по умолчанию — внешний дом,
    // вторичный объект — казармы. У «Клещей» чередование в массиве совпадает
    // с чередованием флангов SiegeFormation (baseAngle / baseAngle + PI).
    const secondary = profile.secondaryTarget
      ? directTarget(profile.secondaryTarget, target)
      : null;
    const splitTargets = secondary !== null && target !== null && secondary !== target;
    for (const [index, enemy] of enemies.entries()) {
      enemy.buildingTarget = splitTargets && index % 2 === 1
        ? secondary
        : target ?? this.settlement.castle;
    }
    if (target?.kind === 'monastery' || secondary?.kind === 'monastery') {
      this.hud.announce(t('siege.monastery'), '#ff5544');
    }
  }

  /** Тик осады: окно атаки 10 сек у стены, отступление и исход (§E.4.2). */
  private siegeTick(): void {
    const now = this.activeTimeMs;
    if (!this.siegeAlive || this.settlement.siegeIdx < 0) return;
    const members = this.settlement.siegeMembers();
    for (const e of members) {
      if (!e.siege) continue;
      // Окно атаки открывается, когда осада дошла до цели (§E.4.2: путь
      // 8–15 сек без урона, затем РОВНО 10 секунд боя у стены). Все числа
      // §E.4.1/§E.4.3 выведены именно из этого окна, поэтому без него
      // фактический урон по базе в разы выше расчётного.
      if (e.attackWindowEnds === 0) {
        const b = e.buildingTarget as { x: number; y: number } | null;
        const ranged = e.kind === 'gnoll' || e.kind === 'shaman';
        // updateSiege() halts ranged units at ~330px (300 + 30), melee at ~140px.
        // If this radius is smaller than the AI's stop distance, ranged sieges never
        // open the 10-second window and can attack for their entire 60-second lifetime.
        const firingRadius = ranged ? 330 : 220;
        if (b && Math.hypot(e.x - b.x, e.y - b.y) < firingRadius) {
          e.attackWindowEnds = now + SIEGE.ATTACK_WINDOW * 1000;
        }
      }
      // Отступление: каждый осадный враг живёт 60 сек с момента появления
      if (now - e.spawnedAt > SIEGE.LIFETIME * 1000) {
        this.enemyGroup.remove(e, true, true);
      }
    }
    const left = this.settlement.siegeMembers();
    if (left.length === 0) {
      // §E.8: «Осада отбита (все враги осады убиты до истечения окна)».
      // Раньше outcome считался по факту «отряд закончился», а это верно и
      // для осады, которую просто переждали: она получала +150 очков и
      // статус «отбита», а телеметрия не могла отличить «defended» от
      // «ignored» — гейт §E.4.2 (доля defended ≥ 50%) становился бессмысленным.
      const outcome = this.siegeDestroyed > 0 ? 'partial'
        : this.siegeKills >= this.siegeTotal ? 'defended'
          : 'ignored';
      const siegeTelemetry = {
        index: this.settlement.siegeIdx,
        profile: this.activeSiegeProfile,
        dmg_taken: this.settlement.siegeDamageTaken,
        cap_applied: this.settlement.capApplied,
        pawns_wounded: this.settlement.siegeWoundsCount,
      };
      this.settlement.endSiege(outcome);
      track('siege_result', { ...siegeTelemetry, outcome });
      this.activeSiegeProfile = null;
      this.siegeAlive = false;
    }
  }

  /**
   * Башни (фаза M ROADMAP): стреляют по ближайшему врагу, приоритет — осада.
   * Строительство башни — прямой ответ на осады: перехватывает их до стен.
   * Матч после смерти героя башня не продлевает (не в SUCCESSION_SOURCES).
   */
  private towerTick(now: number): void {
    if (now < this.towerNextShot) return;
    const towers = this.economy.buildings.filter((b) => b.alive && b.kind === 'tower' && !b.underConstruction);
    if (towers.length === 0) return;
    this.towerNextShot = now + TOWER.PERIOD_MS;
    for (const tw of towers) {
      // Цель: осадный враг в радиусе (приоритет), иначе ближайший к башне
      let target: Enemy | null = null;
      let bestD = Infinity;
      let siegeTarget: Enemy | null = null;
      let siegeD = Infinity;
      for (const e of this.activeEnemies()) {
        const d = Math.hypot(e.x - tw.x, e.y - tw.y);
        if (d > TOWER.RANGE) continue;
        if (e.siege && d < siegeD) { siegeD = d; siegeTarget = e; }
        if (d < bestD) { bestD = d; target = e; }
      }
      const shot = siegeTarget ?? target;
      if (!shot) continue;
      const a = Math.atan2(shot.y - (tw.y - 40), shot.x - tw.x);
      this.projectiles.fireFriendlyArrow(tw.x, tw.y - 40, a, TOWER.DMG);
      this.effects.hitSpark(tw.x, tw.y - 46);
      audio.play('shoot');
    }
  }

  /** Микро-очки и XP за осаду (§E.8, §H.6). */
  private onSiegeScore(outcome: 'defended' | 'partial', index: number): void {
    const n = index + 1;
    if (outcome === 'defended') {
      this.score += 150 * n;
      this.addXp(40 * n);
      this.hud.announce(t('siege.defended', { v: 150 * n }), '#7dc95e');
    } else {
      this.score += 75 * n;
      this.addXp(20 * n);
      this.hud.announce(t('siege.partial'), '#e0a030');
    }
  }

  /** Здание разрушено: телеметрия + лента + счётчик осады. */
  private onBuildingDestroyed(b: Building): void {
    if (import.meta.env.DEV) {
      // QA-инструментация: поиск источника мгновенного разрушения при рестарте
      console.warn('[qa] building destroyed:', b.kind, 'alive=', b.alive, 'hp=', b.hp, 'scene=', this.scene.key, new Error('trace').stack?.split('\n').slice(1, 8).join(' | '));
    }
    if (this.settlement.siegeIdx >= 0) this.siegeDestroyed++;
    this.effects.explosion(b.x, b.y, 1.2, 2);
    this.effects.splinters(b.x, b.y, b.kind === 'castle' ? 28 : 18);
    this.pauseMusicForBuildingDestruction();
    this.hud.feed(t('building.destroyed', { v: t(`building.${b.kind}.name` as Parameters<typeof t>[0]) }), '#ff6655');
    this.hud.announce(t('building.destroyed', { v: t(`building.${b.kind}.name` as Parameters<typeof t>[0]) }), '#ff6655');
    audio.play('explosion');
    // Источник: фаза 2 босса или осада (§K.2 building_destroyed.source)
    const destroySource = b.lastDamageSource ?? (this.boss?.active && this.boss.siege ? 'boss' : 'siege');
    track('building_destroyed', {
      kind: b.kind,
      hp_before: Math.round(b.hpBeforeLastDamage),
      source: destroySource,
    });
    if (b === this.settlement.castle) {
      // Условие №2: замок разрушен (§E.3)
      this.loseCause = 'castle';
      this.hud.announce(t('over.castleFell'), '#ff5544');
      this.time.delayedCall(1600, () => {
        if (!this.gameEnded) this.gameOver(false);
      });
    }
  }

  /** Сообщение о поражении от Settlement (замок/вымирание). */
  private onSettlementDefeat(cause: LoseCause): void {
    this.loseCause = cause;
  }

  /** Стройка завершена: XP +15, очки +50 и короткий визуальный акцент (§H.13). */
  private onBuildComplete(kind: BuildingKind, x: number, y: number): void {
    this.addXp(15);
    this.score += 50;
    this.economy.emit('change');
    audio.play('levelup'); // Короткая fanfare завершения постройки (§H.13 №3).
    this.effects.dust(x, y - 18, 8);
    this.effects.buildFlag(x, y - 18);
    for (const pawn of this.economy.pawns) {
      if (!pawn.dead && Math.hypot(pawn.x - x, pawn.y - y) < 240) pawn.faceToward(x);
    }
    // Подсказки о доступных постройках запускает update() по текущей цене и
    // состоянию поселения, а не в XP-callback завершения первого дома.
  }

  /** Мировую точку переводим в логические экранные координаты слоя HUD/FTUE. */
  private worldHintTarget(resolveWorldPoint: () => { x: number; y: number } | null): HintTargetResolver {
    return () => {
      const point = resolveWorldPoint();
      if (!point) return null;
      const camera = this.cameras.main;
      const zoom = camera.zoom || 1;
      const view = camera.worldView;
      return {
        x: camera.x + (point.x - view.x) * zoom,
        y: camera.y + (point.y - view.y) * zoom,
      };
    };
  }

  /** Указывает свободное пятно строительства, а если занято — само здание. */
  private buildingHintTarget(kind: BuildingKind): HintTargetResolver {
    return this.worldHintTarget(() => {
      const spot = this.economy.spotFor(kind);
      if (spot) return spot;
      const building = this.economy.buildings.find((item) => item.kind === kind && item.alive);
      return building ? { x: building.x, y: building.y } : null;
    });
  }

  private pawnTitle(pawn: Pawn): string {
    // Титул с родом: «каменщица Агата» (Приложение A1)
    return t(`pawn.titled.${pawn.kind}${pawn.female ? 'F' : ''}` as Parameters<typeof t>[0]);
  }

  /** Фаза 2 босса: HP < 50% → идёт на замок (§E.6). */
  private bossPhaseCheck(): void {
    if (!this.boss?.active || this.boss.dead) return;
    if (this.boss.aiState !== 'bossPhase2' && this.boss.hp < this.boss.maxHp * 0.5 && !this.boss.siege) {
      this.boss.siege = true;
      this.boss.buildingTarget = this.settlement.castle;
      this.boss.aiState = 'bossPhase2';
      this.hud.announce(t('boss.siege'), '#ff5544');
      audio.play('boss');
      this.shakeCamera(300, 0.006);
      const cameraZoom = this.cameras.main.zoom;
      this.cameras.main.zoomTo(Math.min(1.5, cameraZoom * 1.12), 240, 'Sine.Out');
      this.time.delayedCall(800, () => this.cameras.main.zoomTo(cameraZoom, 260, 'Sine.Out'));
      // Кинематографичный бит: time-freeze 0.8 с + краткий zoom (§H.13 №9, §E.6)
      this.hitstop(800, true);
      track('siege_start', { index: -1, profile: 'boss-phase2' });
    }
  }

  private onEnemyDeath(e: Enemy, src?: WeaponId, byPawn = false): void {
    if (!e.active) return;
    // Смерть босса визуально доигрывается вне группы/физики; обычные враги
    // по-прежнему уничтожаются немедленно, в том числе при цепных взрывах.
    const bossDeathDelay = e.def.isBoss && this.bossDeathSequence(e)
      ? BOSS_DEATH_ANIMATION_MS
      : 0;
    const x = e.x, y = e.y;
    if (bossDeathDelay > 0) {
      this.enemyGroup.remove(e, false, false);
      // Завершение связано с фактической одноразовой анимацией, а не только
      // wall-clock таймером. Watchdog оставляет защиту на случай потерянного
      // animationcomplete в throttled/background вкладке.
      let deathFinished = false;
      let wallClockWatchdog: number | null = null;
      const finishBossDeath = (): void => {
        if (deathFinished) return;
        deathFinished = true;
        if (wallClockWatchdog !== null) {
          window.clearTimeout(wallClockWatchdog);
          wallClockWatchdog = null;
        }
        e.clearDeathCleanupTimer();
        if (e.active) e.destroy();
        if (e === this.boss && !this.mods.endless && !this.gameEnded && this.sys.isActive()) {
          this.victoryPending = false;
          this.victory();
        }
      };
      // Prefer the actual one-shot clip when it completes.
      e.once('animationcomplete', (anim: Phaser.Animations.Animation) => {
        if (anim.key === 'boss-dead') finishBossDeath();
      });
      // Frame-delta fallback handles a paused Scene Clock. The native browser timer
      // is an independent last resort if the display-list update path is suspended.
      e.setDeathCleanupTimer(BOSS_DEATH_ANIMATION_MS + 500, finishBossDeath);
      wallClockWatchdog = window.setTimeout(finishBossDeath, BOSS_DEATH_ANIMATION_MS + 500);
    } else {
      this.enemyGroup.remove(e, true, true);
    }

    this.kills++;
    // Кодекс (§H.10): счётчик встречи по видам — уходит в applyRunToMeta
    this.killsByKind[e.kind] = (this.killsByKind[e.kind] ?? 0) + 1;
    // Серия убийств: растёт только от оружия героя — убийство гарнизоном
    // комбо игрока не поднимает (§B.7.1)
    if (!byPawn) {
      this.combo++;
      this.comboTimer = COMBO.WINDOW;
      if (this.combo > this.bestCombo) this.bestCombo = this.combo;
      const comboMult = 1 + Math.min(COMBO.BONUS_CAP - 1, this.combo * COMBO.BONUS_STEP);
      this.score += Math.round(SCORE.KILL * comboMult);
      // Комбо-вехи §H.4 (благословение «Комбо» — 20/40/80, A2):
      // сундучок ресурсов у героя, очков не дают
      if ((this.comboMilestones as readonly number[]).includes(this.combo)) {
        this.comboMilestone(this.combo, x, y);
      }
      this.ach?.event({ type: 'kills', value: this.kills });
    } else {
      this.score += SCORE.KILL;
      track('ally_kill', { weapon: src ?? 'unknown', target_kind: e.kind, player_combo_grew: false });
    }
    // Счётчики существ → достижения (TZ §A.6)
    if (e.kind === 'skull') {
      this.skullsSlain++;
      this.ach?.event({ type: 'skulls', value: this.skullsSlain });
    } else if (e.kind === 'shaman') {
      this.shamansSlain++;
      this.ach?.event({ type: 'shamans', value: this.shamansSlain });
    }
    const big = e.def.isElite || e.def.isBoss;

    // Убийство в рамках текущей осады: нужно для исхода «defended» (§E.8).
    if (e.siege) this.siegeKills++;

    // Рыба-бомба, убитая оружием: взрыв бьёт врагов (цепная реакция!)
    if (e.def.kind === 'bomb-fish') {
      this.fishBombExplode(x, y, false, src);
    }

    this.effects.explosion(x, y, big ? 1.7 : e.def.scale * 1.15, big ? 2 : 1);
    if (e.def.isElite) {
      this.shakeCamera(220, 0.004);
      this.hitstop(40);
    } else if (e.def.isBoss) {
      this.hitstop(110);
    }
    if (this.activeTimeMs - this.lastDieSound > 120) {
      this.lastDieSound = this.activeTimeMs;
      audio.play('die');
    }
    // Дроп. Крупные роняют несколько кристаллов вместо одного (крупный дроп
    // читается на земле), но суммарный опыт обязан совпасть с таблицей §A.4:
    // `Math.ceil(xp / 3)` давал медведю 27 вместо 25 и боссу 201 вместо 200.
    // Поэтому делим нацело, а остаток кладём в первые кристаллы.
    if (e.def.gem && e.xpValue > 0) {
      const n = big ? 3 : 1;
      const per = Math.floor(e.xpValue / n);
      let rest = e.xpValue - per * n;
      for (let i = 0; i < n; i++) {
        const ox = big ? Phaser.Math.Between(-40, 40) : 0;
        const oy = big ? Phaser.Math.Between(-40, 40) : 0;
        const amount = per + (rest > 0 ? 1 : 0);
        rest -= amount - per;
        if (amount > 0) this.pickups.spawnGem(x + ox, y + oy, e.def.gem, amount);
      }
    }
    if (e.def.isElite) {
      this.pickups.spawnMeat(x + 30, y);
      this.pickups.spawnMeat(x - 30, y);
      this.hud.announce(t('game.eliteDown'), '#7CFC00');
      this.elitesSlain++;
      this.ach?.event({ type: 'elites', value: this.elitesSlain });
    }
    // Золотые кристаллы: теперь дают золото
    if (Math.random() < 0.03) this.pickups.spawnGoldGem(x, y, Phaser.Math.Between(3, 8));
    if (e.def.isBoss) {
      // Награда за весь матч: BOSS_GOLD кристаллами по кругу (TZ §A.4).
      // Очки (SCORE.BOSS) начисляет victory(), здесь — золото в лавку
      // и meat для восстановления после боя.
      const per = Math.round(BOSS_GOLD / 5);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        this.pickups.spawnGoldGem(x + Math.cos(a) * 70, y + Math.sin(a) * 70, per);
      }
      for (let i = 0; i < 4; i++) {
        this.pickups.spawnMeat(x + Phaser.Math.Between(-80, 80), y + Phaser.Math.Between(-80, 80));
      }
    }

    if (e === this.boss) {
      this.bossKilled = true;
      if (this.mods.endless) {
        // Бесконечный (§H.12): босс НЕ заканчивает матч — очки и праздник,
        // спавн продолжается (новый босс придёт через 300 с)
        this.boss = null;
        this.hud.hideBossBar();
        this.score += SCORE.BOSS;
        this.hitstop(200);
        this.shakeCamera(400, 0.006);
        for (let i = 0; i < 6; i++) {
          this.time.delayedCall(i * 140, () => {
            if (this.gameEnded) return;
            this.effects.explosion(
              this.player.x + Phaser.Math.Between(-260, 260),
              this.player.y + Phaser.Math.Between(-260, 260), 1.5, 2,
            );
          });
        }
      } else if (bossDeathDelay > 0) {
        // Боевая логика останавливается до фактического animationcomplete;
        // finishBossDeath() запустит штатный сценарий победы один раз.
        this.victoryPending = true;
        this.spawner.stopped = true;
        this.player.setVelocity(0, 0);
        this.projectiles.clear();
      } else {
        this.victory();
      }
    }
  }

  /** Комбо-веха: дроп ресурсов у героя (лепестки летят к замку, §H.4).
   *  Благословение «Комбо» (A2) сдвигает вехи на 20/40/80 — награда по индексу. */
  private comboMilestone(combo: number, x: number, y: number): void {
    const tier = Math.max(0, (this.comboMilestones as readonly number[]).indexOf(combo));
    this.effects.popup(x, y - 30, t('game.combo', { v: combo }), '#ffd76e', 16);
    audio.play('ach');
    this.hud.announce(t('game.unstoppable', { v: combo }), '#ffd700');
    track('combo_milestone', { tier: combo });
    // Сундук летит к замку — carry-визуал (§H.4)
    const chest = this.add.image(x, y, 'treasure').setScale(0.5).setDepth(DEPTH.FX);
    // 50/50 по rng сида (§H.4): Math.random() ломал воспроизводимость
    // фиксированного сида, на которой держатся все A/B-гейты (§K.4).
    const coin = this.runRng() < 0.5;
    this.tweens.add({
      targets: chest,
      x: this.castleX, y: this.castleY,
      duration: 900,
      delay: 250,
      ease: 'Quad.easeIn',
      onComplete: () => {
        chest.destroy();
        if (tier === 0) {
          if (coin) this.economy.deposit('wood', 10);
          else this.player.heal(25);
        } else if (tier === 1) {
          if (coin) {
            this.economy.deposit('wood', 10);
            this.economy.deposit('ore', 10);
          } else this.player.heal(999);
        } else if (tier === 2) {
          this.economy.deposit('wood', 25);
          this.economy.deposit('ore', 15);
          this.economy.deposit('meat', 15);
        } else {
          // §H.4, веха 200: «большое лечение + магнит XP 10 сек + ресурсы».
          // Магнит даём временным расширением радиуса — иначе игрок,
          // доведший серию до 200, должен был вручную собирать кристаллы.
          this.player.heal(999);
          this.xpMagnetUntil = this.activeTimeMs + 10_000;
          this.economy.deposit('wood', 25);
          this.economy.deposit('ore', 15);
          this.economy.deposit('meat', 15);
        }
      },
    });
  }

  /**
 * Анимация смерти босса (§A.2, `ogre-boss/dead`, 10 кадров).
 *
 * Спрайт-тень остаётся на месте и доигрывает цикл; логика босса при этом
 * уже отключена (`deactivateBossBody`), поэтому на анимацию это не влияет.
 */
private bossDeathSequence(e: Enemy): boolean {
    e.deactivateBossBody();
    if (!this.anims.exists('boss-dead')) return false;
    e.play('boss-dead', true);
    e.setFlipX(false);
    this.hitstop(140);
    return true;
  }

  /** Убийство врага гарнизоном: KILL растёт, комбо игрока — нет (§B.7.1). */
  private damageEnemyByPawn(e: Enemy, dmg: number, weapon: string): void {
    if (!e.active || e.dead) return;
    const rawDamage = Math.max(1, Math.round(dmg * (1 + 0.25 * this.economy.card('militia'))));
    const final = this.heroDpsAtTenMinutes === null
      ? rawDamage
      : this.garrisonDpsBudget.apply(rawDamage, this.activeTimeMs, this.heroDpsAtTenMinutes);
    if (this.dpsDebugText) {
      this.dpsDebugRawDamage += rawDamage;
      this.dpsDebugAppliedDamage += final;
    }
    if (final <= 0) return;
    this.effects.damage(e.x, e.y - 40 * e.def.scale, final, false);
    const died = e.takeDamage(final);
    if (died) this.onEnemyDeath(e, undefined, true);
    void weapon;
  }

  // ================= ПРЕЕМСТВЕННОСТЬ (TZ §F) =================

  /** Герой пал: есть здание-источник? Преемственность или поражение. */
  private onHeroDeath(): void {
    if (this.succession.canSucceed()) {
      this.openSuccession();
      return;
    }
    this.loseCause = 'hero';
    this.gameOver(false);
  }

  /** Экран преемственности: часы на паузе, игрок решает (§F.5). */
  private openSuccession(): void {
    this.overlayOpen = true;
    gameplayStop();
    this.scene.pause();
    const options = this.succession.options();
    const living = this.succession.findLivingWarrior();
    const hints = this.hints;
    const firstTutorial = hints?.isEnabled() === true && !hints.hasSeen('succession');
    if (firstTutorial) hints?.markSeen('succession');
    track('succession_shown', {
      branch_available: [
        living ? 1 : 0,
        this.succession.resourcesBranchAvailable()
          && (this.succession.isFirstLifetimeFree() || this.succession.canAffordResources()) ? 2 : 0,
        this.succession.isFirstLifetimeFree() || this.gold >= this.succession.goldCost() ? 3 : 0,
      ],
      buildings: this.settlement.aliveBuildings.map((b) => b.kind).join(','),
    });
    this.scene.launch('Succession', {
      options,
      livingCount: living ? 1 : 0,
      livingKind: living?.weapon ?? null,
      resourceCost: this.succession.resourceCost(),
      goldCost: this.succession.goldCost(),
      firstFree: this.succession.isFirstLifetimeFree(),
      firstTutorial,
      showResources: this.succession.resourcesBranchAvailable(),
      resourcesAffordable: this.succession.resourcesBranchAvailable()
        && (this.succession.isFirstLifetimeFree() || this.succession.canAffordResources()),
      goldAffordable: this.succession.isFirstLifetimeFree()
        || this.gold >= this.succession.goldCost(),
      // Ветка 1: живой воин — бесплатно и мгновенно
      onTakeWarrior: () => {
        const w = this.succession.findLivingWarrior();
        if (!w) return false;
        this.succession.promoteWarrior(w);
        // ⚠️ Герой определяется ПОДТИПОМ воина (§F.6, гейт §F.13 п.12):
        // лучник из тира становится «арчером», монах из обители — «монахом».
        // Раньше всё сводилось к `lance ? lancer : warrior`, и гарнизонный
        // лучник получал мечника.
        this.applyHero(this.succession.heroFor(w.weapon ?? 'sword'), w.weapon ?? 'sword');
        this.afterSuccession('warrior', false, 0, w.name);
        return true;
      },
      // Ветка 2: ресурсы — новый воин из здания.
      // Первая преемственность аккаунта бесплатна (§F.4/§I.4): ничего не
      // списываем, только гасим lifetime-флаг.
      onTakeResources: (weapon: string) => {
        // Повторная проверка защищает и от прямого вызова callback: контракт
        // «Один в поле» и исчерпание ресурсных ступеней не обходятся бесплатной веткой.
        if (!this.succession.resourcesBranchAvailable()
          || !this.succession.typeAvailable(weapon as PawnWeapon)) return false;
        const firstLifetimeFree = this.succession.isFirstLifetimeFree();
        const resourceCost = firstLifetimeFree ? 0 : this.succession.resourceCost();
        if (firstLifetimeFree) {
          this.succession.payFree();
        } else if (!this.succession.payResources()) return false;
        this.applyHero(this.succession.heroFor(weapon as PawnWeapon), weapon);
        this.afterSuccession('resources', firstLifetimeFree, resourceCost, this.heroDef.name);
        return true;
      },
      // Ветка 3: реклама
      onTakeAd: (weapon: string) => {
        if (!this.succession.typeAvailable(weapon as PawnWeapon)) return false;
        this.succession.payAd();
        this.applyHero(this.succession.heroFor(weapon as PawnWeapon), weapon);
        this.afterSuccession('ad', false, { ad: 1 }, this.heroDef.name);
        return true;
      },
      // Ветка 3: золото матча (тоже бесплатно при первом показе, §F.4)
      onTakeGold: (weapon: string) => {
        if (!this.succession.typeAvailable(weapon as PawnWeapon)) return false;
        const firstLifetimeFree = this.succession.isFirstLifetimeFree();
        const cost = firstLifetimeFree ? 0 : this.succession.goldCost();
        if (firstLifetimeFree) {
          this.succession.payFree();
        } else {
          if (this.gold < cost) return false;
          this.gold -= cost;
          this.succession.payGold();
        }
        this.applyHero(this.succession.heroFor(weapon as PawnWeapon), weapon);
        this.afterSuccession('gold', firstLifetimeFree, cost, this.heroDef.name);
        return true;
      },
      onSurrender: () => {
        track('succession_refused');
        this.surrendered = true;
        this.loseCause = 'hero';
        this.scene.resume();
        this.overlayOpen = false;
        this.gameOver(false);
      },
    });
  }

  private afterSuccession(
    branch: string,
    firstLifetimeFree = false,
    cost: number | { wood?: number; ore?: number; meat?: number; ad?: number } | null = null,
    successorName?: string,
  ): void {
    this.successions++; // сводка рана (§K.2): преемственность (§H.11, §H.17)
    track('succession_taken', { branch, cost, first_lifetime: firstLifetimeFree });
    this.scene.resume();
    this.overlayOpen = false;
    gameplayStart();
    // Имя преемника получает отдельную крупную заставку; событие не маскируется
    // короткой лентой поверх боя. Для живого воина используется его имя, для
    // призванного — локализованное имя выбранного типа героя.
    this.hud.successorIntro(successorName?.trim() || this.heroDef.name, this.heroDef.title);
    this.hud.feed(t('succession.took'), '#7dc95e');
    this.hud.setVisible(true);
    audio.startMusic();
  }

  /**
   * Создаёт нового Player по HEROES[id] (преемник §F.9): уровень 1,
   * стартовое оружие, HP 100%, 3 сек неуязвимости, спавн у врат замка.
   * Поселение не трогаем, часы матча не сбрасываем.
   */
  private applyHero(heroId: HeroId, weapon: string): void {
    const old = this.player;
    const pos = { x: this.castleX, y: this.castleY + 120 };
    old.destroy();
    this.heroDef = HEROES[heroId];
    this.player = new Player(this, pos.x, pos.y, this.heroDef);
    // Скин героя (§J.6.2): преемник тоже под tint
    const heroTint = heroSkinTint();
    if (heroTint !== null) this.player.setTint(heroTint);
    // Полный сброс личного: уровень 1, билд пуст, серия сброшена (§F.9).
    // «Крепкая память I/II» (узлы m3/m7, §H.16): преемник сохраняет 25/50% опыта
    const keptXp = Math.round((this.xp + this.xpNext) * Math.min(0.5, Math.max(0, this.fx.xpKeep)));
    this.level = 1;
    this.xp = 0;
    this.xpNext = XP_CURVE(1);
    this.pendingLevelUps = 0;
    // «Наследие мастера» (узел m9, §H.16): преемник хранит одну пассивку I ур.
    const keptPassive = this.fx.successionPassiveKeep
      ? [...this.passiveLevels.keys()][0]
      : undefined;
    this.passiveLevels.clear();
    // У преемника нет старого билда: убираем иконки оружия/пассивок, после
    // чего восстанавливаем только разрешённую мета-пассивку и стартовое оружие.
    this.hud.resetBuildoutIcons();
    if (keptPassive) {
      this.passiveLevels.set(keptPassive, 1);
      this.hud.setIcon(keptPassive, PASSIVES[keptPassive].icon, 1, true);
    }
    this.combo = 0;
    this.comboTimer = 0;
    this.kills = 0;
    this.weapons.destroy();
    this.weaponStats.clear();
    this.weapons = new WeaponSystem(this, {
      player: () => this.player,
      enemies: () => this.activeEnemies(),
      damageEnemy: (e, dmg, kx, ky, force, src) => this.damageEnemy(e, dmg, kx, ky, force, src),
      projectiles: () => this.projectiles,
      effects: () => this.effects,
      moveDir: () => this.lastMove,
      mightMult: () => this.mightMult,
      cdMult: () => this.cdMult,
    });
    this.weapons.add(this.heroDef.startWeapon);
    this.hud.setIcon(this.heroDef.startWeapon, WEAPONS[this.heroDef.startWeapon].icon, 1, false);
    this.recomputeStats();
    this.player.iframesUntil = this.activeTimeMs + 3000; // ровно 3 сек (§F.9)
    // Сохранённый опыт возвращается после сброса (может сразу дать карточки)
    if (keptXp > 0) {
      this.xp += keptXp;
      while (this.xp >= this.xpNext && this.level < MAX_LEVEL) {
        this.xp -= this.xpNext;
        this.level++;
        this.xpNext = XP_CURVE(this.level);
        this.pendingLevelUps++;
      }
    }
    // Вспышка у врат (juice №12 §H.13); на low-профиле без вспышки камеры.
    if (this.juicePolicy.canShake()) this.cameras.main.flash(180, 255, 239, 180);
    this.effects.goldBurst(pos.x, pos.y - 20, 18);
    this.cameras.main.startFollow(this.player, true, 0.12, 0.1);
    void weapon;
  }

  /** Взрыв рыбы-бомбы. selfDestruct=true — сама доехала до игрока. */
  private fishBombExplode(x: number, y: number, selfDestruct: boolean, src?: WeaponId): void {
    const def = ENEMIES['bomb-fish'];
    const dmg = Math.round((def.explodeDmg ?? 24) * this.spawner.dmgMult);
    const R = def.explodeRadius ?? 150;
    this.effects.explosion(x, y, 1.05, 2);
    audio.play('explosion');
    this.shakeCamera(170, 0.0045);
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
    this.shakeCamera(180, 0.004);
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
    if (!def.isElite && !def.isBoss && this.enemyGroup.getLength() >= ENEMY_CAP) return false;
    const m = WORLD.GRASS_MARGIN + 40;
    x = Phaser.Math.Clamp(x, m, WORLD.SIZE - m);
    y = Phaser.Math.Clamp(y, m, WORLD.SIZE - m);
    const e = new Enemy(this, x, y, kind, this.spawner.hpMult, this.spawner.dmgMult, this.enemyCtxStore!);
    if (this.diffDef.speedMult !== 1) e.speed = Math.round(e.speed * this.diffDef.speedMult);
    // «Кровавая луна» (A2): скорость врагов ×1.1
    if (this.enemySpeedMult !== 1) e.speed = Math.round(e.speed * this.enemySpeedMult);
    this.enemyGroup.add(e);
    return true;
  }

  private enemyCtxStore: EnemyContext | null = null;

  private spawnBoss(hpMult = 1): void {
    const a = Math.random() * Math.PI * 2;
    const cam = this.cameras.main;
    const r = Math.hypot(cam.width, cam.height) / (2 * cam.zoom) + 160;
    const x = Phaser.Math.Clamp(this.player.x + Math.cos(a) * r, 400, WORLD.SIZE - 400);
    const y = Phaser.Math.Clamp(this.player.y + Math.sin(a) * r, 400, WORLD.SIZE - 400);
    // hpMult — эскалация боссов бесконечного режима (§H.12): ×1.5 за каждого.
    // dmgMult — масштаб минуты и сложности (§C.3): контактный урон Огра на
    // 15-й минуте 40 → 112, на «Кошмаре» → 140. Раньше сюда передавался 1,
    // и финальный бойс был одинаковым на любой сложности.
    this.boss = new Enemy(
      this, x, y, 'boss',
      hpMult * this.spawner.hpMult,
      this.spawner.dmgMult,
      this.enemyCtxStore!,
    );
    this.boss.speed = Math.round(this.boss.speed * this.diffDef.speedMult * this.enemySpeedMult);
    this.enemyGroup.add(this.boss);
    this.hud.showBossBar(ENEMIES.boss.name);
    this.hud.bossIntro(
      ENEMIES.boss.name,
      this.diffDef.id === 'nightmare' ? t('hud.bossSubtitleNightmare') : t('hud.bossSubtitleFinal'),
      'face-boss',
    );
    this.shakeCamera(400, 0.008);
  }

  /**
   * Убирает одного самого далёкого обычного врага, чтобы освободить место
   * под элиту, босса или волну. Возвращает false, если убирать нечего.
   */
  private makeRoomForSummon(): boolean {
    let worst: Enemy | null = null;
    let worstD = 0;
    for (const e of this.activeEnemies()) {
      if (e.def.isElite || e.def.isBoss) continue;
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
            const min = (e.def.body.r + o.def.body.r) * 0.85;
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

  /** Пополнение золота (кристаллы/сокровища) с всплывающим текстом.
   *  Контракт «Пацифист-герой» (§H.9): золото копится в отдельном счётчике
   *  и уходит в кошелёк лавки в конце рана — в сводку матча не попадает. */
  private addGold(v: number, x?: number, y?: number): void {
    if (this.contractId === 'c_pacifist') {
      this.pacifistGold += v;
      if (x !== undefined && y !== undefined) {
        this.effects.popup(x, y - 12, t('game.goldPopup', { v }), '#ffd76e', 12);
      }
      return;
    }
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

    // Карты поселения (§H.5): в пул после первого дома, ранг II после I
    if (this.economy.houses > 0) {
      const cards: UpgradeCard[] = [];
      for (const def of SETTLEMENT_CARDS) {
        const lvl = this.economy.card(def.id);
        if (lvl >= 2) continue;
        cards.push({
          kind: 'settlement', id: def.id, icon: def.icon, rarity: def.rarity,
          title: t(`settle.${def.id}.name` as Parameters<typeof t>[0]),
          subtitle: lvl === 0 ? t('settle.subtitle') : t('settle.subtitle') + ' II',
          desc: t(`settle.${def.id}.desc` as Parameters<typeof t>[0]),
        });
      }
      Phaser.Utils.Array.Shuffle(cards);
      // Одна карта поселения на выдачу — не вытесняет боевую прокачку
      if (cards[0]) picked.splice(Phaser.Math.Between(0, Math.min(2, picked.length - 1)), 0, cards[0]);
      if (picked.length > 3) picked.length = 3;
    }

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
    audio.play('bell');
    // Убираем подсказки перед запуском оверлея.
    //
    // Раньше здесь ничего не сбрасывалось, и обучающий баннер («Двигайся и
    // атакуй») оставался висеть ПОД карточками выбора. Он и сам по себе
    // держался на пергаменте, и сквозь затемнение LevelUp просвечивал
    // серыми полосами в промежутках между карточками — на скриншоте это
    // читалось как мусор в вёрстке. На паузе и в игре-овере подсказки
    // сбрасывались, а на этом экране забыли.
    this.hints.reset();
    const heroScreen = this.worldHintTarget(() => ({ x: this.player.x, y: this.player.y }))();
    const heroPoint = heroScreen && this.scale.width > 0 && this.scale.height > 0
      ? { x: heroScreen.x / this.scale.width, y: heroScreen.y / this.scale.height }
      : { x: 0.5, y: 0.6 };
    this.scene.pause();
    this.scene.launch('LevelUp', {
      // Луч левел-апа использует нормализованную screen-space точку героя;
      // сама сцена выбора анимирует его на своих работающих часах.
      heroPoint,
      // Заголовок окна опускается ниже верхней полосы HUD: полоса босса
      // стоит ровно на той же высоте, и лента ложилась прямо на неё.
      topInset: this.hud.overlayTopInset(),
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
      case 'settlement': {
        // Карточки поселения (§H.5): эффекты применяются в Economy/сценах
        const id = String(card.id);
        this.economy.applySettlementCard(id);
        this.cardsPicked.push(id); // кодекс/сводка рана (§H.10, §K.2)
        this.hud.announce(`${t('settle.subtitle')}: ${card.title}`, '#9fd8ff');
        track('levelup_card_picked', { card_id: id, settlement_card: true });
        break;
      }
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
    // Множители рана поверх пассивок: «Кровавая луна» ×1.15,
    // расходник «Подкова удачи» ×1.25 (A2, §J.6.2)
    this.xpMult = (1 + 0.15 * lvl('wisdom')) * this.xpEventMult;
    const newMax = this.heroDef.maxHp + 15 * shop.vitality + 25 * lvl('vitality') + this.qaHeroHpBonus;
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

  /** Вызывается площадкой при game_api_resume / возврате вкладки.
   *  Возвращаем ход ТОЛЬКО если на сцене нет оверлея и матч не кончен —
   *  иначе бой пойдёт под Pause/LevelUp/GameOver. Прежняя инвертированная
   *  логика (resume при открытом оверлее) навсегда оставляла сцену на паузе
   *  после alt-tab: overlayOpen=false → resume не вызывался никогда. */
  platformResume(): void {
    if (!this.started || this.overlayOpen || this.gameEnded || this.victoryPending) return;
    if (this.scene.isPaused()) this.scene.resume();
    // A fullscreen ad can close while the player is on the menu. Never report
    // gameplay as running unless this scene has actually started and resumed.
    if (!this.scene.isActive()) return;
    gameplayStart();
  }

  private openPause(): void {
    // Во время финального фейерверка пауза ломала экран победы: сцена
    // замирала вместе с таймером, который должен был показать результат.
    if (this.overlayOpen || this.gameEnded || this.victoryPending) return;
    this.overlayOpen = true;
    gameplayStop();
    this.scene.pause();
    // Подсказки FTUE гасим: их слой лежит выше мира, и текст «Нажми, чтобы
    // продолжить» просвечивал сквозь панель паузы.
    this.hints.reset();
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
      // Окно не должно наезжать на верхнюю полосу HUD (полосу босса).
      topInset: this.hud.overlayTopInset(),
      onResume: () => {
        this.scene.resume();
        this.overlayOpen = false;
        gameplayStart();
      },
      muted: audio.muted,
      onToggleMute: () => audio.toggleMute(),
      hintsEnabled: this.hints.isEnabled(),
      onToggleHints: () => {
        const enabled = !(this.hints?.isEnabled() ?? true);
        this.hints?.setEnabled(enabled);
        return enabled;
      },
      loadout,
    });
  }

  /**
   * Счёт без множителя сложности: KILL×комбо + MIN×100 + LVL×50.
   *
   * Золото матча в очки не входит — оно конвертируется в кошелёк лавки на
   * end-экране (§J.2 валюты не мешаются).
   *
   * `scoreMult` применяется ровно один раз, ко всей сумме (§E.8), поэтому
   * итоговый счёт строится из этого «сырого» значения, а не из
   * `currentScore()`, который уже умножен — иначе на «Кошмаре» получалось бы
   * 1.6 × 1.6 = 2.56.
   */
  private rawScore(): number {
    return this.score
      + Math.floor(this.elapsed / 60) * SCORE.MINUTE
      + this.level * SCORE.LEVEL;
  }

  /** Счёт для HUD: множитель сложности уже применён. */
  private currentScore(): number {
    return Math.round(this.rawScore() * this.diffDef.scoreMult);
  }

  private victory(): void {
    if (this.gameEnded || this.victoryPending) return;
    this.victoryPending = true;
    this.spawner.stopped = true;
    this.player.setVelocity(0, 0);
    this.score += SCORE.BOSS;
    this.hud.hideBossBar();
    this.hud.announceTypewriter(t('game.victory'), '#ffd700', 65);
    audio.play('victory');
    this.shakeCamera(500, 0.006);
    this.effects.goldBurst(this.player.x, this.player.y - 24, 32);
    this.effects.goldRain(32);
    // Кульминация победы разрешена даже на low и обходит общий budget (§H.13 №10).
    this.applyJuiceSlowMotion(1_500, 0.5, true);
    this.hitstop(200, true);
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
    // Подсказки FTUE тоже гасим: их слой лежит выше игрового мира, и
    // текст «Нажми, чтобы продолжить» просвечивал сквозь экран итогов.
    this.hints.reset();
    // Обучение хронике показывается в самом end-screen, где находится цель.
    // Маркер отмечается только после того, как GameOverScene реально разместила
    // подсказку рядом с хроникой (на компактном экране блок может не поместиться).
    const showChronicleTutorial = this.hints.isEnabled() && !this.hints.hasSeen('chronicle');

    const settlementScore = this.settlement.settlementScore();
    const ideal = this.settlement.isIdealVictory(victory);
    // §H.6: идеальная победа (слой 3) даёт +150 XP. Строка таблицы §H.6 была
    // единственной нереализованной — остальные пять начислялись.
    if (ideal) this.addXp(150);
    // §E.8: scoreMult применяется ко всей сумме ровно один раз, а РЕЙТИНГ
    // входит в неё наравне с ЗАЩИТОЙ и НАСЕЛЕНИЕМ (раньше он прибавлялся к
    // this.score ПОСЛЕ расчёта finalScore и в итоговый счёт не попадал).
    // ЗАЩИТА/НАСЕЛЕНИЕ платятся и при поражении — §F.13 п.10 запрещает их
    // обнулять при смене героя, но не при поражении, а §E.8 не делает
    // победного условия: «забросил — получил минимум», не «ноль».
    const score = Math.round((
      this.rawScore()
      + settlementScore.defence
      + settlementScore.population
      + (ideal ? SCORE.RATING : 0)
    ) * this.diffDef.scoreMult);
    // Контрактный множитель не меняет primary leaderboard score (§E.9-A):
    // сохраняем базовый SCORE и отдельно рассчитываем контрактный результат (§H.9).
    const contractScoreResult = contractScoreForRun(score, this.mods.contract);
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
    // meta (итоги applyRunToMeta) дописывается ниже — тип из GameOverStats
    const stats: import('./GameOverScene').GameOverStats = {
      victory,
      time: Math.floor(this.elapsed),
      kills: this.kills,
      level: this.level,
      gold: this.gold,
      score,
      contractScore: contractScoreResult.contract ? {
        id: contractScoreResult.contract,
        multiplier: contractScoreResult.multiplier,
        baseScore: contractScoreResult.baseScore,
        adjustedScore: contractScoreResult.adjustedScore,
      } : undefined,
      hero: this.heroDef.name,
      difficulty: this.diffDef.name,
      difficultyId: this.diffDef.id,
      bestCombo: this.bestCombo,
      weapons,
      newAch: (this.ach?.consumeNewly() ?? []).map((a) => ({ name: a.name, emoji: a.emoji })),
      // Поселение (§E.8, §H.3): ставки, хроника и near-miss
      loseCause: this.loseCause,
      ideal,
      settlement: {
        ...settlementScore,
        // Показываем те же величины, что входят в итоговый счёт, — иначе
        // экран сообщает «ЗАЩИТА: 1800», которой в счёте нет (§E.8).
        defence: Math.round(settlementScore.defence * this.diffDef.scoreMult),
        population: Math.round(settlementScore.population * this.diffDef.scoreMult),
        castleHp: Math.max(0, Math.round(this.settlement.castle.hp)),
        siegesTotal: this.settlement.facts.siegesTotal,
        siegesDefended: this.settlement.facts.siegesDefended,
        monasteryFallenAt: this.settlement.facts.monasteryFallenAt,
        monasteryVictims: this.settlement.facts.monasteryVictims,
        bledOutName: this.settlement.facts.bledOutName,
        bledOutShort: this.settlement.facts.bledOutShort,
      },
      veterans: this.economy.pawns.filter((p) => p.veteranStars > 0).slice(0, 2).map((p) => ({ name: p.name, stars: p.veteranStars })),
    };
    this.flushPerformanceTelemetry();
    const endCause: 'victory' | 'hero' | 'castle' | 'population' | 'surrender' =
      victory ? 'victory' : this.surrendered ? 'surrender' : this.loseCause;
    track('run_end', {
      cause: endCause,
      duration_s: Math.floor(this.elapsed),
      score,
      ...(contractScoreResult.contract ? {
        contract_id: contractScoreResult.contract,
        contract_multiplier: contractScoreResult.multiplier,
        contract_score: contractScoreResult.adjustedScore,
      } : {}),
      kills: this.kills,
      level: this.level,
      buildings: settlementScore.buildings,
      population: this.economy.pawns.length,
      sieges_defended: this.settlement.facts.siegesDefended,
      ideal,
      // Отдельные события по §K.2: без них таблица «Бесконечный» (§H.12)
      // и «Вызов дня» (§H.8) остаются без результата — в буфере лежит только
      // факт старта.
      ...(this.mods.endless ? { endless_wave: this.wave } : {}),
      ...(this.mods.challenge ? { challenge_mods: [...this.mods.challenge.mods] } : {}),
    });
    if (this.mods.endless && !victory) {
      track('endless_death', { wave: this.wave, score });
    }
    if (this.mods.challenge) {
      track('challenge_result', { victory, ideal, score, wave: this.wave });
    }
    this.commitMatchMeta(victory, score);
    // Мета фаз Q/S (§K.2): сводка рана → applyRunToMeta ровно один раз,
    // результат прикрепляется к payload stats.meta
    const meta = this.applyRunMeta(victory, score, ideal);
    if (meta) stats.meta = meta;
    // Персистентный буфер телеметрии (§K.1). ВАЖНО: сброс идёт ПОСЛЕ
    // applyRunMeta — иначе glory_earned/quest_done/pass_level попадали
    // в буфер СЛЕДУЮЩЕГО рана, и группировка событий по ранам сдвигалась.
    flushRunTelemetry();
    this.scene.launch('GameOver', {
      stats,
      showChronicleTutorial,
      onChronicleTutorialShown: () => this.hints?.markSeen('chronicle'),
    });
    this.scene.pause();
  }

  /**
   * Собирает RunSummary (§K.2, все поля) и применяет его к мета-состоянию
   * РОВНО ОДИН РАЗ (guard this.metaApplied — после воскрешения gameOver
   * может вызваться повторно). Кодекс-отметки оружия/эволюций — ДО вызова.
   */
  private applyRunMeta(victory: boolean, score: number, ideal: boolean): NonNullable<import('./GameOverScene').GameOverStats['meta']> | undefined {
    // Кодекс (§H.10): использованное оружие (dmg > 0) и эволюции
    for (const id of this.weapons.ownedIds()) {
      if ((WEAPONS[id].levels[0]?.dmg ?? 0) > 0) markCodex(`w_${id}`);
      if (this.weapons.isEvolved(id)) markCodex(`e_${id}`);
    }
    if (this.metaApplied) return undefined;
    this.metaApplied = true;
    // Контракт «Пацифист-герой» (§H.9): золото героя уходит в кошелёк лавки
    // (depositGold из '../shop'), минуя сводку матча — без задвоения
    if (this.pacifistGold > 0) depositGold(Math.floor(this.pacifistGold));
    const wave = this.mods.endless ? this.spawner.wave : 0;
    const summary: RunSummary = {
      victory,
      ideal,
      endless: this.mods.endless,
      wave,
      time: Math.floor(this.elapsed),
      kills: this.kills,
      level: this.level,
      gold: this.gold,
      score,
      difficulty: this.diffDef.id,
      buildingsBuilt: this.buildingsBuilt,
      pawnsAlive: this.economy.pawns.length,
      siegesDefended: this.settlement.facts.siegesDefended,
      siegesTotal: this.settlement.facts.siegesTotal,
      monasteryHealed: this.economy.monasteryHealed,
      healHp: this.economy.healHpTotal,
      hires: this.hires,
      successions: this.successions,
      veterans: this.economy.pawns.filter((p) => p.veteranStars >= 3).length,
      firstHouseMin: this.firstHouseMin,
      barracks: this.builtBarracks,
      monastery: this.builtMonastery,
      archery: this.builtArchery,
      bestCombo: this.bestCombo,
      bossKilled: this.bossKilled,
      killsByKind: { ...this.killsByKind },
      cardsPicked: [...this.cardsPicked],
      contract: this.mods.contract,
      ukaz: this.mods.ukaz,
      challengeMods: [...this.challengeMods],
      blessing: this.mods.blessing,
      consumables: this.mods.consumables,
    };
    const res = applyRunToMeta(summary);
    return {
      glory: res.glory,
      questsDone: res.quests.done.length,
      questsTotal: res.quests.ids.length,
      questsCompletedNow: res.questsCompleted.map((q) => ({ descKey: q.descKey, reward: q.reward })),
      passLevels: res.passLevelsGained,
      passRewards: res.passRewards.map((r) => ({ kind: r.kind, amount: r.amount })),
      chainUnlocks: res.chainUnlocked.map((c) => ({ nameKey: c.nameKey, tier: c.tier })),
      endlessWave: wave,
      crownsEarned: res.crownsEarned,
      challenge: !!this.mods.challenge,
      ukaz: this.mods.ukaz,
      endless: this.mods.endless,
    };
  }

  /**
   * Тосты заданий дня (§H.17): раз в 5 сек сверяем активные задания с
   * локальными счётчиками; впервые достигнутая цель — анонс. Реальное
   * начисление славы делает applyRunToMeta в конце рана.
   */
  private checkQuestToasts(): void {
    if (this.gameEnded) return;
    const st = rollMetaDay();
    for (const id of st.quests.ids) {
      if (st.quests.done.includes(id) || this.questToastDone.has(id)) continue;
      const def = QUEST_POOL.find((q) => q.id === id);
      if (!def) continue;
      const rv = this.questRunValue(def.metric);
      const achieved = def.metric === 'firstHouseMin' ? rv <= def.goal : rv >= def.goal;
      if (achieved) {
        this.questToastDone.add(id);
        this.hud.announce(t('quest.completeToast', { v: def.reward }), '#ffd76e');
      }
    }
  }

  /** Локальная копия маппинга runValue из meta.applyRunToMeta (§H.17). */
  private questRunValue(m: QuestMetric): number {
    switch (m) {
      case 'buildings': return this.buildingsBuilt;
      case 'siegesDefended': return this.settlement.facts.siegesDefended;
      case 'monasteryHealed': return this.economy.monasteryHealed;
      case 'healHp': return Math.round(this.economy.healHpTotal);
      case 'idealWin': return 0; // идеальная победа определяется только в конце рана
      case 'hires': return this.hires;
      case 'successionBoss': return this.successions > 0 && this.bossKilled ? 1 : 0;
      case 'kills': return this.kills;
      // «Достигнута, если построил дом до 2:00» — та же формула, что в meta
      case 'firstHouseMin': return this.firstHouseMin > 0 ? Math.floor(this.firstHouseMin) : 99;
      case 'barracks': return this.builtBarracks;
      case 'monastery': return this.builtMonastery;
      case 'archery': return this.builtArchery;
      case 'veterans': return this.economy.pawns.filter((p) => p.veteranStars >= 3).length;
      case 'gold': return this.gold;
      case 'score': return this.currentScore();
      case 'time': return Math.floor(this.elapsed);
      case 'bestCombo': return this.bestCombo;
      case 'noSuccessionBoss': return this.successions === 0 && this.bossKilled ? 1 : 0;
      default: return 0;
    }
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

  // Старый ревайв за рекламу удалён (TZ §F.12): его роль перешла
  // к преемственности (SuccessionScene) — смерть больше не конец матча,
  // пока есть здание, выпускающее воина.

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
    // Контракт «Ночь» −25% / «Туман» −20% (§H.9, A2): светлого пятна в сцене
    // нет — равномерно усиливаем затемнение (радиус обзора условно)
    if (this.ambientDarkMult !== 1) {
      const dr = Math.round(((color >> 16) & 0xff) * this.ambientDarkMult);
      const dg = Math.round(((color >> 8) & 0xff) * this.ambientDarkMult);
      const db = Math.round((color & 0xff) * this.ambientDarkMult);
      this.ambientRect.setFillStyle(Phaser.Display.Color.GetColor(dr, dg, db));
    }
  }

  private makeEnemyCtx(): EnemyContext {
    return {
      playerX: () => this.player.x,
      playerY: () => this.player.y,
      siegeInterceptRadius: () => SIEGE.INTERCEPT_R + 40 * this.economy.card('militia'),
      onEnemyShoot: (x, y, proj) => {
        // Бросок выполняется по ТЕКУЩЕЙ позиции игрока в момент выпуска
        const tx = this.player.x, ty = this.player.y;
        const a = Math.atan2(ty - y, tx - x);
        const srcDmg = proj === 'bone' ? ENEMIES.gnoll.damage
          : proj === 'hex' ? ENEMIES.shaman.damage
            : ENEMIES['harpoon-shark'].damage;
        this.projectiles.shootEnemy(proj, x, y, a, Math.round(srcDmg * this.spawner.dmgMult));
      },
      onBossSlam: (x, y) => {
        // Ударная волна Огра: урон по радиусу + эффект + тряска
        const dmg = Math.round(20 * this.spawner.dmgMult);
        this.effects.explosion(x, y, 1.5, 2);
        audio.play('explosion');
        this.shakeCamera(180, 0.005);
        if (Math.hypot(this.player.x - x, this.player.y - y) < 170) {
          this.hurtPlayer(dmg);
        }
      },
      onBossSummon: (x, y) => {
        // Если толпа упёрлась в лимит, свита сначала расступается:
        // уходим от игрока, кто дальше — того и выкидываем. Иначе призыв
        // босса при полной толпе не вызывал ничего, и игрок его не замечал.
        let summoned = 0;
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2 + Math.random();
          const gx = x + Math.cos(a) * 170;
          const gy = y + Math.sin(a) * 170;
          let ok = this.spawnEnemy('goblin', gx, gy);
          // Освободить слот недостаточно: после eviction нужно повторить сам spawn.
          if (!ok && this.makeRoomForSummon()) ok = this.spawnEnemy('goblin', gx, gy);
          if (ok) summoned++;
        }
        if (summoned > 0) this.hud.announce(t('game.bossSummon'), '#ff8866');
      },
      onBomberExplode: (x, y, self, selfDestruct) => {
        // Уничтожаем рыбу-бомбу ДО взрыва: взрыв не должен бить её саму (иначе рекурсия)
        this.enemyGroup.remove(self, true, true);
        this.fishBombExplode(x, y, selfDestruct);
      },
      enemiesNear: (x, y, r) => this.enemiesNear(x, y, r),
      // Враг ранит пешку (§A.5): обычный бой — напрямую, осада — по лимиту профиля
      attackPawn: (pawn, dmg, siege) => {
        if (pawn.dead) return;
        if (siege) this.settlement.siegeWoundPawn(pawn, dmg, this.activeTimeMs);
        else {
          // Таунт мечника перетягивает и урон по гражданскому (§B.7.1).
          // Раньше он работал только по зданиям — половина правила молчала.
          const dmgToPawn = this.settlement.siegeIdx >= 0
            ? this.settlement.tauntCivilian(pawn, dmg, this.settlement.siegeIdx)
            : dmg;
          this.economy.woundPawn(pawn, dmgToPawn, this.activeTimeMs, 'regular');
        }
        this.effects.hitSound(this.activeTimeMs);
      },
      // Осада бьёт здание: потолок и таунт внутри Settlement (§E.4.2, §B.7.1)
      attackBuilding: (b, dmg, fire, isBoss) => {
        const building = b as Building;
        // Босс — вне потолка осады и таунта (§E.6, §B.7.1)
        if (fire && building.ignite(isBoss ? -1 : this.settlement.siegeIdx)) audio.play('fire');
        this.settlement.damageBuilding(building, dmg, isBoss ? -1 : this.settlement.siegeIdx, isBoss);
        this.effects.hitSpark(building.x, building.y - 20);
      },
      // Бросок снаряда по зданию: урон придёт по прибытии (§E.4.1).
      // Номер осады ЗАХВАТЫВАЕТСЯ В МОМЕНТ ВЫСТРЕЛА: снаряд летит дольше
      // окна атаки, и к попаданию `settlement.siegeIdx` уже мог сброситься —
      // тогда урон пришёл бы в обход потолка 12% (§E.4.4).
      siegeShoot: (kind, x, y, tx, ty, fire, building) => {
        const dmg = kind === 'hex' ? (ENEMIES.shaman.buildingDmg ?? 5) : (ENEMIES.gnoll.buildingDmg ?? 2);
        const firedAt = this.settlement.siegeIdx;
        this.projectiles.shootAtBuilding(kind, x, y, tx, ty, dmg, fire, (shot) => {
          const b = building as Building;
          if (b && b.alive) {
            if (fire) {
              if (b.ignite(firedAt)) audio.play('fire');
              this.effects.hexBlast(shot.x, shot.y);
            }
            this.settlement.damageBuilding(b, dmg, firedAt, false);
          }
        });
      },
      // Осада, дошедшая внутрь, ранит пешек рядом (§E.4) — по лимиту профиля.
      nearPawn: (x, y, r) => {
        let best: Pawn | null = null;
        let bestD = r;
        for (const p of this.economy.pawns) {
          // Уже раненые не могут получить второе ранение и не должны блокировать
          // поиск следующей цели осады.
          if (p.dead || !p.active || p.state === 'wounded' || p.state === 'bleeding') continue;
          // Герой — не пешка, его ранение идёт обычным путём (§A.5)
          const d = Math.hypot(p.x - x, p.y - y);
          if (d < bestD) { bestD = d; best = p; }
        }
        return best;
      },
      onSiegeWindowEnd: (e) => {
        // Окно атаки истекло — осада уходит за край карты (§E.4.2).
        this.enemyGroup.remove(e, true, true);
      },
    };
  }
}
