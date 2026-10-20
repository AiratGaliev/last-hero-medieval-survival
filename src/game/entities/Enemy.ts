import Phaser from 'phaser';
import { DEPTH, DESPAWN_DIST, WORLD, SHADOW_SCALE, SHADOW_BOX, SHADOW_SRC, AGGRO, SIEGE } from '../constants';
import { ENEMIES, type EnemyDef, type EnemyKind } from '../data';
import { audio } from '../systems/Audio';
import type { Pawn } from './Pawn';

// ============ Враг — существо из пака enemies/ (TZ §A) ============

/** Тип снаряда, который враг выдаёт через контекст сцены */
export type EnemyShotKind = 'bone' | 'hex' | 'harpoon';

export interface EnemyContext {
  playerX(): number;
  playerY(): number;
  /** Ранг «Ополчения» увеличивает радиус перехвата осады. */
  siegeInterceptRadius?(): number;
  /** Гнолл, шаман или гарпун-акула завершают анимацию броска. */
  onEnemyShoot(x: number, y: number, proj: EnemyShotKind): void;
  /** Огр бьёт клубом в землю: ударная волна по радиусу */
  onBossSlam(x: number, y: number): void;
  onBossSummon(x: number, y: number): void;
  onBomberExplode(x: number, y: number, self: Enemy, selfDestruct: boolean): void;
  enemiesNear(x: number, y: number, radius: number): Phaser.Physics.Arcade.Sprite[];
  /** Враг ранит пешку — осада по лимиту профиля (§E.4), обычный бой — §A.5 */
  attackPawn(pawn: Pawn, dmg: number, siege: boolean): void;
  /** Осада бьёт здание (fire=true — огненный шар шамана с поджогом); isBoss — вне потолка/таунта */
  attackBuilding(b: unknown, dmg: number, fire: boolean, isBoss: boolean): void;
  /** Бросок снаряда по зданию (кость гнолла / шар шамана); building — цель урона */
  siegeShoot(kind: EnemyShotKind, x: number, y: number, tx: number, ty: number, fire: boolean, building: unknown): void;
  /** Пешка рядом — для ранений осадой, дошедшей внутрь (§E.4). */
  nearPawn?: (x: number, y: number, r: number) => Pawn | null;
  /** Окно атаки истекло — враг осады отступает (§E.4.2). */
  onSiegeWindowEnd?: (e: Enemy) => void;
}

type AiState = 'chase' | 'windup' | 'charge' | 'recover' | 'bossPhase2';

export class Enemy extends Phaser.Physics.Arcade.Sprite {
  readonly def: EnemyDef;
  readonly kind: EnemyKind;
  hp: number;
  maxHp: number;
  speed: number;
  damage: number;
  xpValue: number;
  dead = false;   // защита от повторной обработки смерти
  private deathCleanupRemainingMs: number | null = null;
  private deathCleanup: (() => void) | null = null;
  aiState: AiState = 'chase';
  stateTimer = 0;
  /** Внешний буст скорости от Шамана (до этого момента времени) */
  hasteUntil = 0;
  hasteMult = 1;
  /** Ярость (слом щита скелета / финальная фаза Огра) */
  enraged = false;
  private shootCd = 0;
  /** Защита от повторного выпуска, если callback анимации и таймер совпадут. */
  private harpoonShotFired = false;
  /** Бросок остаётся ожидающим даже при пропущенном animationcomplete. */
  private harpoonWindupActive = false;
  /** Независимый fallback броска: AI tick не должен быть единственным таймером. */
  private harpoonWindupTimer: Phaser.Time.TimerEvent | null = null;
  private atkCd = 0;
  private summonCd = 8000; // мс до первого зова свиты
  private chargeDirX = 0;
  private chargeDirY = 0;
  private chargeCount = 0;
  private slamFired = false;
  private knockX = 0;
  private knockY = 0;
  private ctx: EnemyContext;
  private hpBar: Phaser.GameObjects.Graphics | null = null;
  private shadow: Phaser.GameObjects.Image;
  /** Кольцо ауры Шамана (создаётся только для kind === 'shaman') */
  private auraRing: Phaser.GameObjects.Image | null = null;
  /** Текущая анимация — чтобы не перезапускать один и тот же цикл каждый кадр */
  private lastAnim = '';
  /** Ожидаемый callback одноразовой анимации; старый отменяется при новом действии. */
  private animationCompleteHandler: ((anim: Phaser.Animations.Animation) => void) | null = null;

  // ---- Выбор цели (§A.5): герой → гарнизон → гражданский, пересчёт 400 мс ----
  /** Осадный враг: цель — здание профиля, не игрок (§E.4) */
  siege = false;
  /** Шаман-поджигатель осады */
  firer = false;
  /** Здание-цель осады (Building; unknown — разрыв цикла импорта) */
  buildingTarget: unknown = null;
  private targetPawn: Pawn | null = null;
  /**
   * Текущая цель-пешка (TZ §A.5, выбор цели №2/№3).
   *
   * Открыт наружу для перехвата гарнизоном (§B.7.1: «враг, выбравший целью
   * №2 или №3, идёт к ней; ближайший `fighter` перехватывает») — раньше это
   * было невозможно, поле было приватным, и перехват срабатывал только на осаду.
   */
  get aimedPawn(): Pawn | null { return this.targetPawn; }
  private lastPick = 0;
  private buildingAtkCd = 0;
  /** Момент спавна — таймер отступления осады 60 сек (§E.4.2) */
  spawnedAt = 0;
  /** Окно атаки у стены, конец в мс (0 — не ограничено; §E.4.2) */
  attackWindowEnds = 0;
  private meleeCd = 0;

  constructor(scene: Phaser.Scene, x: number, y: number, kind: EnemyKind, hpMult: number, dmgMult: number, ctx: EnemyContext) {
    const def = ENEMIES[kind];
    super(scene, x, y, `${kind}-idle`);
    this.def = def;
    this.kind = kind;
    this.ctx = ctx;
    const big = def.isBoss || def.isElite;
    // Крупные цели тоже должны ощущать сложность, но их HP умножаем
    // лишь частично: 4000 * 1.45 = 5800 не берётся разумным билдом,
    // и «Кошмар» превратился бы в стену.
    this.maxHp = Math.round(def.hp * (big ? 1 + (hpMult - 1) * 0.5 : hpMult));
    this.hp = this.maxHp;
    this.speed = def.speed;
    // Урон крупных целей масштабируется полностью — иначе «Кошмар»
    // не отличался бы в финальном бою.
    this.damage = Math.round(def.damage * dmgMult);
    this.xpValue = def.xp;

    scene.add.existing(this);
    scene.physics.add.existing(this);
    this.setScale(def.scale);
    this.setDepth(DEPTH.ENTITY_BASE + y);
    this.lastAnim = `${kind}-idle`;
    this.play(this.lastAnim);

    // Круг коллизии — по измеренным границам контента спрайта (TZ §A.4):
    // координаты в кадре делим на scale (масштаб применит физика)
    const rb = def.body.r / def.scale;
    this.setCircle(rb, def.body.cx - rb, def.body.cy - rb);
    this.setCollideWorldBounds(false);

    // Тень — по стопе существа (groundY), а не по центру кадра
    const groundOff = def.groundY - def.frameW / 2;
    this.shadow = scene.add.image(x, y + groundOff * def.scale, 'shadow')
      .setOrigin((SHADOW_BOX.x + SHADOW_BOX.w / 2) / SHADOW_SRC, (SHADOW_BOX.y + SHADOW_BOX.h / 2) / SHADOW_SRC)
      .setScale(SHADOW_SCALE * def.scale, SHADOW_SCALE * 0.6 * def.scale)
      .setAlpha(0.3)
      .setDepth(DEPTH.SHADOW);

    if (big) {
      // Мир-координаты: слой HPBAR — над сущностями, под FX/HUD
      this.hpBar = scene.add.graphics().setDepth(DEPTH.HPBAR);
    }

    // Шаман: кольцо ауры на земле (слой GEM — под ногами сущностей)
    if (kind === 'shaman') {
      const R = def.auraSpeed ?? 250;
      this.auraRing = scene.add.image(x, y + 6, 'aoe-ring')
        .setScale(R / 110)
        .setAlpha(0.25)
        .setTint(0xc060ff)
        .setDepth(DEPTH.GEM);
    }
  }

  // ---------- Анимации ----------

  /** Цикл движения: run при движении, idle на месте */
  private playMove(moving: boolean): void {
    const want = moving ? `${this.kind}-run` : `${this.kind}-idle`;
    if (this.lastAnim !== want) {
      this.lastAnim = want;
      this.play(want, true);
    }
  }

  /** Однократная анимация (бросок/удар/замах); после завершения — движение.
   *
   *  Ключ проверяется до присвоения `lastAnim`. Иначе отсутствующая анимация
   *  ( Phaser молча игнорирует play() и не присылает animationcomplete )
   *  оставляла бы `lastAnim` залипшим навсегда: существо переставало
   *  переключать run/idle и ездило в бегущем цикле стоя на месте. */
  /** Зафиксировать циклическую анимацию текущей AI-фазы до явного перехода. */
  private playLoop(key: string): void {
    if (!this.scene.anims.exists(key)) return;
    if (this.lastAnim === key && this.anims.currentAnim?.key === key) return;
    this.lastAnim = key;
    this.play(key, true);
  }

  private playOnce(key: string, onComplete?: () => void): void {
    if (!this.scene.anims.exists(key)) {
      // Отсутствующая анимация не должна навсегда блокировать боевой FSM.
      this.lastAnim = '';
      if (this.active) onComplete?.();
      return;
    }
    // Не оставляем подписку от прерванного действия. Важно использовать
    // on/off с фильтрацией по ключу: once('animationcomplete') снимает
    // обработчик на завершении ЛЮБОЙ анимации, даже если её ключ не совпал.
    if (this.animationCompleteHandler) {
      this.off('animationcomplete', this.animationCompleteHandler);
      this.animationCompleteHandler = null;
    }
    const handler = (anim: Phaser.Animations.Animation): void => {
      if (anim.key !== key) return;
      this.off('animationcomplete', handler);
      if (this.animationCompleteHandler === handler) this.animationCompleteHandler = null;
      if (!this.active) return;
      this.lastAnim = '';
      onComplete?.();
    };
    this.animationCompleteHandler = handler;
    this.on('animationcomplete', handler);
    this.lastAnim = key;
    this.play(key);
  }

  /**
   * Разворот спрайта по направлению движения — значение для `setFlipX`.
   *
   *  По умолчанию листы Tiny Swords считаются нарисованными вправо; для
   *  листов, у которых морда смотрит влево (gnome, panda, spear-goblin и
   *  морские акулы), `EnemyDef.facesRight = false` явно меняет правило флипа.
   *  Значение используется только здесь, а не в координатах тела: `body` и
   *  `groundY` остаются размерами исходного кадра и не зависят от направления.
   */
  private faceDir(vx: number): boolean {
    return this.def.facesRight === false ? vx > 0 : vx < 0;
  }

  /** Выпускает гарпун ровно один раз даже при пропущенном animationcomplete. */
  private fireHarpoon(): void {
    if (!this.active || this.dead || !this.harpoonWindupActive || this.harpoonShotFired) return;
    this.harpoonShotFired = true;
    this.harpoonWindupActive = false;
    this.harpoonWindupTimer?.remove(false);
    this.harpoonWindupTimer = null;
    // Таймерный fallback может завершиться раньше animationcomplete. Снимаем
    // старый обработчик, чтобы он не висел до следующей одноразовой анимации.
    if (this.animationCompleteHandler) {
      this.off('animationcomplete', this.animationCompleteHandler);
      this.animationCompleteHandler = null;
    }
    // Сбрасываем маркер: следующая итерация AI сможет вернуть idle/run.
    this.lastAnim = '';
    this.ctx.onEnemyShoot(this.x, this.y, 'harpoon');
    this.shootCd = 2400;
    this.aiState = 'chase';
  }

  // ================= ВЫБОР ЦЕЛИ (TZ §A.5) =================

  /** Герой в 600 px → герой; иначе гарнизон в 900 px; иначе гражданский;
   *  иначе — герой (долгий погон, прежнее поведение). Поиск пешки делает
   *  сцена (registry-хук tss-picktarget): у сцены полный список пешек. */
  private pickTarget(): void {
    const hx = this.ctx.playerX(), hy = this.ctx.playerY();
    const heroD = Math.hypot(hx - this.x, hy - this.y);
    if (heroD <= AGGRO.HERO) { this.targetPawn = null; return; }
    const finder = this.scene.registry.get('tss-picktarget') as ((e: Enemy) => Pawn | null) | undefined;
    const pawn = finder?.(this) ?? null;
    this.targetPawn = pawn;
  }

  // ================= ОСАДА (TZ §E.4) =================

  /** Осадный враг: идёт к зданию, бьёт его; игрок в 260 px перехватывает. */
  private updateSiege(time: number, delta: number): void {
    const body = this.body as Phaser.Physics.Arcade.Body;
    // Срок атаки проверяется ДО перехвата героем: близость игрока не должна
    // продлевать десятисекундное окно у стены (§E.4.2).
    if (this.attackWindowEnds > 0 && time >= this.attackWindowEnds) {
      this.siege = false;
      this.buildingTarget = null;
      body.setVelocity(0, 0);
      this.playMove(false);
      this.ctx.onSiegeWindowEnd?.(this);
      return;
    }

    const b = this.buildingTarget as { x: number; y: number } | null;
    if (!b) { this.siege = false; return; }
    const hx = this.ctx.playerX(), hy = this.ctx.playerY();
    const heroD = Math.hypot(hx - this.x, hy - this.y);

    // Игрок рядом перехватывает осаду — она бьёт его, не постройку (§E.4.2)
    const interceptRadius = this.ctx.siegeInterceptRadius?.() ?? SIEGE.INTERCEPT_R;
    if (heroD < interceptRadius) {
      // обычный погон за игроком
      const dx = hx - this.x, dy = hy - this.y;
      const d = Math.max(1, Math.hypot(dx, dy));
      const vx = (dx / d) * this.speed, vy = (dy / d) * this.speed;
      body.setVelocity(vx + this.knockX, vy + this.knockY);
      if (Math.abs(body.velocity.x) > 8) {
        this.setFlipX(this.faceDir(body.velocity.x));
      }
      if (!this.lastAnim || this.lastAnim === `${this.kind}-idle`) this.playMove(true);
      return;
    }

    const dx = b.x - this.x, dy = b.y - this.y;
    const dist = Math.max(1, Math.hypot(dx, dy));
    const ranged = this.kind === 'gnoll' || this.kind === 'shaman';
    const stopDist = ranged ? 300 : 110;

    if (dist > stopDist + 30) {
      const vx = (dx / dist) * this.speed, vy = (dy / dist) * this.speed;
      body.setVelocity(vx + this.knockX, vy + this.knockY);
      if (Math.abs(body.velocity.x) > 8) {
        this.setFlipX(this.faceDir(body.velocity.x));
      }
      if (!this.lastAnim || this.lastAnim === `${this.kind}-idle`) this.playMove(true);
    } else {
      body.setVelocity(0, 0);
      this.setFlipX(this.faceDir(dx));
      // Пробившийся внутрь осады враг РАНИТ пешек, которых достиг (§E.4).
      // Без этого ветка SIEGE_WOUND_CAP (1/1/2/2/3) и весь второй канал убыли
      // населения (§E.3.1) были мёртвым кодом.
      this.meleeCd -= delta;
      if (this.meleeCd <= 0 && this.ctx.nearPawn) {
        const pawn = this.ctx.nearPawn(this.x, this.y, 64);
        if (pawn) {
          this.meleeCd = 2000;
          this.ctx.attackPawn(pawn, this.damage, true);
        }
      }
      this.buildingAtkCd -= delta;
      if (this.buildingAtkCd <= 0) {
        // Босс в фазе 2 бьёт замок быстрее осады: 8 урона / 0.535 c ≈ 15 HP/с
        // — замок (~500 HP, потолка для босса нет) держится ~33 с (§E.6)
        this.buildingAtkCd = this.kind === 'boss' ? 535 : ranged ? 2600 : 1500;
        if (ranged) {
          // Бросок по зданию: шаман — огненный шар (поджог), гнолл — кость
          this.playOnce(`${this.kind}-shoot`, () => {
            if (this.active && this.siege) {
              this.ctx.siegeShoot(
                this.kind === 'shaman' ? 'hex' : 'bone',
                this.x, this.y, b.x, b.y,
                this.kind === 'shaman',
                this.buildingTarget,
              );
            }
          });
        } else {
          this.playOnce(`${this.kind}-atk`);
          this.ctx.attackBuilding(b, this.def.buildingDmg ?? 1, false, this.def.isBoss === true);
        }
      }
    }
    void time;
  }

  /**
 * Отключает боевую логику, оставляя спрайт видимым.
 *
 * Нужно для анимации смерти босса (§A.2): сцена удаляет врага из группы и
 * физики сразу, а `dead`-лист должен доиграться. Проверки `active` в
 * preUpdate без этого вернули бы телу логику и рывки.
 */
  deactivateBossBody(): void {
    this.dead = true;
    const body = this.body as Phaser.Physics.Arcade.Body | null;
    if (body) {
      body.setVelocity(0, 0);
      body.enable = false;
    }
  }

  /** Frame-delta fallback if the Scene Clock is paused during the death transition. */
  setDeathCleanupTimer(delayMs: number, callback: () => void): void {
    this.deathCleanupRemainingMs = Math.max(0, delayMs);
    this.deathCleanup = callback;
  }

  clearDeathCleanupTimer(): void {
    this.deathCleanupRemainingMs = null;
    this.deathCleanup = null;
  }

  takeDamage(dmg: number): boolean {
    if (this.dead) return false;
    let final = dmg;
    // Защита по виду: щит скелета снимается на ярости, панцирь черепахи и
    // стойка панды уменьшают входящий урон постоянно.
    const armor = this.def.armorFront;
    const hasArmor = armor !== undefined && armor > 0 && (this.kind !== 'skull' || !this.enraged);
    if (hasArmor) {
      final = Math.max(1, final * (1 - armor));
      // Звон щита скелета — блок заметен и без чтения чисел урона.
      if (this.kind === 'skull' && Math.random() < 0.3) audio.play('hit');
    }
    // Ящер заметно реагирует на попадание: hit-лист есть только у этого вида.
    if (this.kind === 'lizard' && !this.dead) this.playOnce('lizard-hit');
    this.hp -= final;
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
    if (this.def.isElite || this.def.isBoss) this.drawHpBar();
    if (this.hp <= 0) this.dead = true;
    else if (this.kind === 'skull' && !this.enraged && this.hp < this.maxHp * 0.4) {
      this.breakShield();
    }
    return this.hp <= 0;
  }

  /** Скелет теряет щит: ярость — без брони, но заметно быстрее */
  private breakShield(): void {
    this.enraged = true;
    this.speed = Math.round(this.speed * 1.6);
    this.damage = Math.round(this.damage * 1.2);
    audio.play('slam');
    this.setTint(0xffb0a0);
    this.scene.time.delayedCall(140, () => {
      if (this.active) this.clearTint();
    });
    this.scene.cameras.main.shake(90, 0.002);
  }

  knockback(vx: number, vy: number, force: number): void {
    const len = Math.max(1, Math.hypot(vx, vy));
    if (this.def.isBoss) force *= 0.15;
    else if (this.def.isElite) force *= 0.4;
    // Скелет со щитом тяжело продавливается
    else if (this.kind === 'skull' && !this.enraged) force *= 0.3;
    this.knockX += (vx / len) * force;
    this.knockY += (vy / len) * force;
  }

  /** Лечение (задел под будущие механики; в раунде 1 врагов никто не лечит) */
  heal(hp: number): void {
    if (this.hp >= this.maxHp) return;
    this.hp = Math.min(this.maxHp, this.hp + hp);
    if (this.def.isElite || this.def.isBoss) this.drawHpBar();
  }

  preUpdate(time: number, delta: number): void {
    super.preUpdate(time, delta);
    if (!this.active) return;
    // Умерший босс остаётся в display list только на время финальной анимации.
    // super.preUpdate уже продвинул кадр; больше AI и физика не должны двигать спрайт.
    if (this.dead) {
      const body = this.body as Phaser.Physics.Arcade.Body | null;
      body?.setVelocity(0, 0);
      if (this.deathCleanup && this.deathCleanupRemainingMs !== null) {
        this.deathCleanupRemainingMs = Math.max(0, this.deathCleanupRemainingMs - Math.max(0, delta));
        if (this.deathCleanupRemainingMs === 0) {
          const cleanup = this.deathCleanup;
          this.clearDeathCleanupTimer();
          cleanup();
        }
      }
      return;
    }

    // Хитстоп: короткая заморозка врагов (реестр пишет GameScene)
    const freezeUntil = (this.scene.registry.get('tss-freeze') as number | undefined) ?? 0;
    if (time < freezeUntil) {
      const b = this.body as Phaser.Physics.Arcade.Body | null;
      if (b) b.setVelocity(0, 0);
      return;
    }

    const dt = delta / 1000;

    // ---- Осада: цель — здание профиля, игрок может перехватить (§E.4) ----
    if (this.siege && this.buildingTarget) {
      this.updateSiege(time, delta);
      const groundOff = this.def.groundY - this.def.frameW / 2;
      this.shadow.setPosition(this.x, this.y + groundOff * this.def.scale);
      this.setDepth(DEPTH.ENTITY_BASE + this.y);
      if (this.def.isElite || this.def.isBoss) this.drawHpBar();
      return;
    }

    // ---- Выбор цели (§A.5): пересчёт не чаще раза в 400 мс ----
    if (time - this.lastPick > 400) {
      this.lastPick = time;
      this.pickTarget();
    }

    const px = this.targetPawn ? this.targetPawn.x : this.ctx.playerX();
    const py = this.targetPawn ? this.targetPawn.y : this.ctx.playerY();
    const dx = px - this.x;
    const dy = py - this.y;
    const dist = Math.max(1, Math.hypot(dx, dy));
    const nx = dx / dist, ny = dy / dist;

    // Цель-пешка погибла — сброс на героя
    if (this.targetPawn && (!this.targetPawn.active || this.targetPawn.dead)) {
      this.targetPawn = null;
    }

    // Атака пешки: ближний урон по цели (§A.5 — гражданские гибнут)
    if (this.targetPawn && dist < 64 && this.aiState === 'chase') {
      this.atkCd -= delta;
      if (this.atkCd <= 0) {
        this.atkCd = 1500;
        this.playOnce(`${this.kind}-atk`);
        this.ctx.attackPawn(this.targetPawn, this.damage, false);
      }
    }

    let vx = 0, vy = 0;
    // Резервные виды фазы I используют полноценный FSM боя; их ниша задаётся
    // скоростью, дистанцией атаки и защитой в отдельных ENEMIES defs.
    switch (this.kind) {
      case 'goblin':
      case 'thief':
      case 'skull':
      case 'bear':
      case 'spider':
      case 'snake':
      case 'lizard':
      case 'turtle':
      case 'gnome':
      case 'panda':
      case 'spear-goblin':
      case 'paddle-shark':
        // Простой погон; вблизи — косметический замах (урон наносит overlap)
        vx = nx * this.speed; vy = ny * this.speed;
        this.atkCd -= delta;
        if (dist < 70 && this.atkCd <= 0 && this.aiState === 'chase') {
          this.atkCd = 1500;
          this.playOnce(`${this.kind}-atk`);
        }
        break;

      case 'harpoon-shark': {
        // Гарпун-акула — отдельный дальнобойный тип: держит дистанцию,
        // прекращает движение на время броска и стреляет после окончания throw-анимации.
        this.shootCd -= delta;
        const want = 300;
        if (this.aiState === 'windup') {
          vx = 0;
          vy = 0;
          // Пропущенное animationcomplete не должно навсегда блокировать AI и атаку.
          this.stateTimer -= delta;
          if (this.stateTimer <= 0) this.fireHarpoon();
        } else if (dist > want + 45) {
          vx = nx * this.speed;
          vy = ny * this.speed;
        } else if (dist < want - 55) {
          vx = -nx * this.speed;
          vy = -ny * this.speed;
        } else {
          vx = -ny * this.speed * 0.55;
          vy = nx * this.speed * 0.55;
        }
        if (this.shootCd <= 0 && dist < 520 && this.aiState === 'chase') {
          this.aiState = 'windup';
          this.stateTimer = 900; // Совместимый fallback внутри AI tick.
          this.harpoonShotFired = false;
          this.harpoonWindupActive = true;
          this.harpoonWindupTimer?.remove(false);
          // Scene Clock надёжнее одного animationcomplete и продолжает отсчёт,
          // даже если анимация была прервана или AI временно сменил состояние.
          this.harpoonWindupTimer = this.scene.time.delayedCall(900, () => {
            this.harpoonWindupTimer = null;
            this.fireHarpoon();
          });
          this.playOnce('harpoon-shark-atk', () => this.fireHarpoon());
        }
        break;
      }

      case 'gnoll': {
        // Метатель костей: держит дистанцию 300 px
        this.shootCd -= delta;
        const want = 300;
        if (dist > want + 40) { vx = nx * this.speed; vy = ny * this.speed; }
        else if (dist < want - 60) { vx = -nx * this.speed; vy = -ny * this.speed; }
        else {
          // стрейф по касательной
          vx = -ny * this.speed * 0.6;
          vy = nx * this.speed * 0.6;
        }
        if (this.shootCd <= 0 && dist < 560 && this.aiState === 'chase') {
          this.aiState = 'windup';
          this.playOnce(`${this.kind}-shoot`, () => {
            this.ctx.onEnemyShoot(this.x, this.y, 'bone');
            this.shootCd = 2200;
            this.aiState = 'chase';
          });
        }
        break;
      }

      case 'shaman': {
        // Колдун: держится поодаль, гонит толпу вперёд (аура скорости) и швыряет шары
        this.shootCd -= delta;
        const want = 280;
        if (dist > want + 60) { vx = nx * this.speed; vy = ny * this.speed; }
        else if (dist < want - 80) { vx = -nx * this.speed * 0.8; vy = -ny * this.speed * 0.8; }
        else {
          vx = -ny * this.speed * 0.5;
          vy = nx * this.speed * 0.5;
        }
        // Тик ауры: каждые 500мс помечаем союзников рядом
        this.atkCd -= delta;
        if (this.atkCd <= 0) {
          this.atkCd = 500;
          const R = this.def.auraSpeed ?? 250;
          for (const s of this.ctx.enemiesNear(this.x, this.y, R)) {
            const e = s as Enemy;
            if (e === this || !e.active) continue;
            // Босса аура не разгоняет: его скорость калибруется отдельно
            if (e.def.isBoss) continue;
            e.hasteUntil = time + 750;
            e.hasteMult = 1.3;
          }
        }
        // Кольцо ауры следует за шаманом
        if (this.auraRing) {
          this.auraRing.setPosition(this.x, this.y + 6);
          const pulse = 0.22 + Math.abs(Math.sin(time / 320)) * 0.2;
          this.auraRing.setAlpha(pulse);
        }
        if (this.shootCd <= 0 && dist < 520 && this.aiState === 'chase') {
          this.aiState = 'windup';
          this.playOnce(`${this.kind}-shoot`, () => {
            this.ctx.onEnemyShoot(this.x, this.y, 'hex');
            this.shootCd = 2600;
            this.aiState = 'chase';
          });
        }
        break;
      }

      case 'pig-rider': {
        // Всадник: телеграф (дрожь + красный tint) → рывок → отдых
        this.stateTimer -= delta;
        switch (this.aiState) {
          case 'chase':
            vx = nx * this.speed; vy = ny * this.speed;
            if (dist < 380) {
              this.aiState = 'windup';
              this.stateTimer = 480;
              this.playLoop(`${this.kind}-idle`);
            }
            break;
          case 'windup':
            this.setTint(0xff9999);
            if (this.stateTimer <= 0) {
              this.clearTint();
              this.chargeDirX = nx; this.chargeDirY = ny;
              this.aiState = 'charge';
              this.stateTimer = 560;
              this.playOnce(`${this.kind}-atk`);
            }
            break;
          case 'charge':
            vx = this.chargeDirX * 420; vy = this.chargeDirY * 420;
            if (this.stateTimer <= 0) { this.aiState = 'recover'; this.stateTimer = 850; }
            break;
          case 'recover':
            if (this.stateTimer <= 0) this.aiState = 'chase';
            break;
        }
        break;
      }

      case 'bomb-fish': {
        // Рыба-бомба: катится к игроку, мигает и взрывается
        this.stateTimer -= delta;
        if (this.aiState === 'windup') {
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
        } else {
          vx = nx * this.speed; vy = ny * this.speed;
          // Покачивание в полёне-разбеге
          this.rotation = Math.sin(time / 120) * 0.12;
          if (dist < 115) {
            this.aiState = 'windup';
            this.stateTimer = 620;
            this.playOnce(`${this.kind}-atk`);
            audio.play('slam');
          }
        }
        break;
      }

      case 'minotaur': {
        // Элита: погон + рывок с телеграфом
        this.stateTimer -= delta;
        switch (this.aiState) {
          case 'chase':
            vx = nx * this.speed; vy = ny * this.speed;
            this.atkCd -= delta;
            if (dist < 430) {
              this.aiState = 'windup';
              this.stateTimer = 550;
              this.playLoop(`${this.kind}-guard`);
            }
            break;
          case 'windup':
            // Телеграф держится весь замах: циклический guard не обрывает состояние.
            this.setTint(0xff8888);
            if (this.stateTimer <= 0) {
              this.clearTint();
              this.chargeDirX = nx; this.chargeDirY = ny;
              this.aiState = 'charge';
              this.stateTimer = 700;
              this.playOnce(`${this.kind}-atk`);
            }
            break;
          case 'charge':
            vx = this.chargeDirX * 430; vy = this.chargeDirY * 430;
            if (this.stateTimer <= 0) { this.aiState = 'recover'; this.stateTimer = 800; }
            break;
          case 'recover':
            if (this.stateTimer <= 0) this.aiState = 'chase';
            break;
        }
        break;
      }

      case 'boss': {
        this.updateBoss(delta, dist, nx, ny);
        vx = this.bossVx; vy = this.bossVy;
        break;
      }
    }

    // Затухание отброса
    const decay = Math.pow(0.5, dt / 0.13);
    this.knockX *= decay; this.knockY *= decay;

    // Ускорение от ауры Шамана — применяется к итоговой скорости
    if (time < this.hasteUntil) {
      vx *= this.hasteMult;
      vy *= this.hasteMult;
    }

    const body = this.body as Phaser.Physics.Arcade.Body;
    body.setVelocity(vx + this.knockX, vy + this.knockY);

    // Границы травы: враги не должны «гулять по воде» за кромкой арены
    const m = WORLD.GRASS_MARGIN + 20;
    if (this.x < m) {
      this.x = m;
      if (body.velocity.x < 0) body.velocity.x = 0;
    } else if (this.x > WORLD.SIZE - m) {
      this.x = WORLD.SIZE - m;
      if (body.velocity.x > 0) body.velocity.x = 0;
    }
    if (this.y < m) {
      this.y = m;
      if (body.velocity.y < 0) body.velocity.y = 0;
    } else if (this.y > WORLD.SIZE - m) {
      this.y = WORLD.SIZE - m;
      if (body.velocity.y > 0) body.velocity.y = 0;
    }

    // Поворот по направлению движения (с учётом ориентации спрайта)
    if (Math.abs(body.velocity.x) > 8) {
      this.setFlipX(this.faceDir(body.velocity.x));
    }

    // Цикл движения: run/idle — только когда не играет однократная анимация
    if (!this.lastAnim || this.lastAnim === `${this.kind}-idle` || this.lastAnim === `${this.kind}-run`) {
      const moving = Math.abs(body.velocity.x) + Math.abs(body.velocity.y) > 10;
      if (this.kind === 'bomb-fish') {
        // У рыбы-бомбы idle занят покачиванием — в разбеге всегда run
        this.playMove(true);
      } else {
        this.playMove(moving);
      }
    }

    const groundOff = this.def.groundY - this.def.frameW / 2;
    this.shadow.setPosition(this.x, this.y + groundOff * this.def.scale);
    this.setDepth(DEPTH.ENTITY_BASE + this.y);
    // HP-бар — world-space Graphics, перерисовываем его после каждого смещения.
    if (this.def.isElite || this.def.isBoss) this.drawHpBar();
  }

  // ---- Фазы босса (Огр-разрушитель) ----
  private bossVx = 0;
  private bossVy = 0;
  private bossTimer = 2500;

  private updateBoss(delta: number, dist: number, nx: number, ny: number): void {
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
        if (this.bossTimer <= 0 && dist < 280) {
          this.aiState = 'windup';
          this.stateTimer = 900;
          this.setTint(0xff9090);
          // Замах длится 900 мс, поэтому короткий пятикадровый лист должен
          // циклически держать телеграф до фактического начала атаки.
          this.playLoop('boss-windup');
        }
        break;
      case 'windup':
        this.bossVx = 0; this.bossVy = 0;
        if (this.stateTimer <= 0) {
          this.clearTint();
          if (this.enraged) this.setTint(0xffb0b0);
          this.chargeDirX = nx; this.chargeDirY = ny;
          this.aiState = 'charge';
          this.stateTimer = 620;
          this.slamFired = false;
          this.playOnce('boss-atk');
          this.scene.cameras.main.shake(200, 0.004);
        }
        break;
      case 'charge':
        this.bossVx = this.chargeDirX * this.speed * 2.6;
        this.bossVy = this.chargeDirY * this.speed * 2.6;
        // Ударная волна в середине замаха-рывка
        if (!this.slamFired && this.stateTimer < 310) {
          this.slamFired = true;
          this.ctx.onBossSlam(this.x, this.y);
        }
        if (this.stateTimer <= 0) {
          this.aiState = 'recover';
          this.stateTimer = 1000;
          this.playOnce('boss-recover');
        }
        break;
      case 'recover':
        this.bossVx = 0; this.bossVy = 0;
        if (this.stateTimer <= 0) {
          this.aiState = 'chase';
          this.bossTimer = this.enraged ? 3200 : 4800;
        }
        break;
    }

    // Зов свиты: гоблины разбегаются из-за спины Огра
    if (this.summonCd <= 0 && hpFrac < 0.65) {
      this.ctx.onBossSummon(this.x, this.y);
      this.summonCd = 11000;
    }
  }

  private drawHpBar(): void {
    if (!this.hpBar) return;
    const w = 90, h = 6;
    const barY = this.y - (this.def.headOffset ?? this.def.frameW * 0.26) * this.def.scale - 10;
    const x = this.x - w / 2, y = barY;
    const g = this.hpBar;
    g.clear();
    g.fillStyle(0x1a0f08, 0.85).fillRoundedRect(x - 1, y - 1, w + 2, h + 2, 2);
    g.fillStyle(0x50120f).fillRect(x, y, w, h);
    const frac = Math.max(0, this.hp / this.maxHp);
    g.fillStyle(0xd03028).fillRect(x, y, Math.round(w * frac), h);
  }

  tooFar(): boolean {
    // Осада не деспавнится от дистанции до игрока — она идёт к базе (§E.4)
    if (this.siege) return false;
    return Math.hypot(this.x - this.ctx.playerX(), this.y - this.ctx.playerY()) > DESPAWN_DIST
      && !this.def.isBoss && !this.def.isElite;
  }

  destroy(fromScene?: boolean): void {
    this.clearDeathCleanupTimer();
    this.harpoonWindupTimer?.remove(false);
    this.harpoonWindupTimer = null;
    this.harpoonWindupActive = false;
    this.shadow.destroy();
    this.hpBar?.destroy();
    this.auraRing?.destroy();
    super.destroy(fromScene);
  }
}
