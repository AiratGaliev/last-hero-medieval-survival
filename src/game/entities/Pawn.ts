import Phaser from 'phaser';
import { DEPTH, SHADOW_SCALE, SHADOW_BOX, SHADOW_SRC, FONT } from '../constants';
import { FS } from '../systems/Text';
import { t } from '../../i18n';
import { PAWNS, FIGHTERS, type PawnKind, type PawnState, type PawnWeapon, type ResourceKind, type PawnDef } from '../data';
import { COMBAT_TIMING, attackImpactFrameIndex } from '../systems/Combat';
import type { Building } from './Building';
import type { Enemy } from './Enemy';

// ============ Пешка поселения: гражданские и гарнизон (TZ §B.2) ============
//
// Состояния: idle/walk/work/carry/flee (гражданские) + fight/retreat/kite/heal
// (гарнизон) + wounded/bleeding/cooldown (все). Логика переходов — PawnAI,
// здесь только сущность: анимации, HP, имена, ветеранство, урон.

export interface PawnCtx {
  /** Активен ли отряд гражданских — проверка паники (§B.2) */
  enemiesNearPanic(x: number, y: number, r: number): boolean;
}

export class Pawn extends Phaser.Physics.Arcade.Sprite {
  readonly kind: PawnKind;
  readonly cls: 'civilian' | 'garrison';
  readonly weapon: PawnWeapon | null;
  state: PawnState = 'idle';
  hp: number;
  maxHp: number;
  speed: number;
  /** Имя для ленты событий (§H.2): «сборщик Томас». */
  readonly name: string;
  readonly female: boolean;
  /** Ветеранство: ★ за пережитые осады (до 3). */
  veteranStars = 0;
  siegesSurvived = 0;
  /** Что несёт на склад (carry-фаза). */
  carrying: ResourceKind | null = null;
  carriedAmount = 0;
  /** Прогресс текущей задачи (тики работы / путь до цели). */
  taskProgress = 0;
  /** Приказ игрока: у гражданских сбрасывается, у гарнизона — до отмены (§B.6). */
  order: string | null = null;
  orderTarget: { x: number; y: number } | null = null;
  /** Точка патруля гарнизона. */
  patrolTarget: { x: number; y: number } | null = null;
  cooldown = 0;
  /** Входная анимация бесплатного жителя после первого дома (§E.5). */
  arrivalMs = 0;
  /** Таймер истечения кровью (bleeding). */
  bleedTimer = 0;
  /** Кулдаут атаки (гарнизон). */
  attackCd = 0;
  attackPending = false;
  attackRecoveryMs = 0;
  attackTarget: Enemy | null = null;
  attackDamage = 0;
  attackWeapon: 'sword' | 'lance' | 'bow' | null = null;
  chargeTarget: Enemy | null = null;
  chargeDamage = 0;
  private attackAnimationHandler: ((anim: Phaser.Animations.Animation) => void) | null = null;
  private attackImpactFrameHandler: ((animation: Phaser.Animations.Animation, frame: Phaser.Animations.AnimationFrame) => void) | null = null;
  private attackImpactCompleteHandler: ((animation: Phaser.Animations.Animation) => void) | null = null;
  private attackImpactFallbackTimer: Phaser.Time.TimerEvent | null = null;
  /** Телеграф рывка копья (гарнизон lance). */
  chargeWindup = 0;
  /** Слот монастыря: индекс места, пока лечится в обители. */
  monasterySlot: number | null = null;
  /** Конкретная обитель-владелец слота; одного индекса недостаточно при нескольких зданиях. */
  monasteryBuilding: Building | null = null;
  /** Лечение монахом на поле: цель-пешка. */
  healTarget: Pawn | null = null;
  /** Лечение монахом на поле: цель-герой (герой не `Pawn`, §B.7.2). */
  healHeroPoint: { x: number; y: number } | null = null;
  /** Работает над узлом ресурса / зданием. */
  workNode: unknown = null;
  /** Множитель скорости работы: ветеран 3★ (§H.2), «Умелые топоры» (§H.16). */
  workSpeedMult = 1;
  /** Момент последней вспышки таунта (§B.7.1) — щит-контур + «−50%». */
  tauntFlashUntil = 0;
  dead = false;

  private shadow: Phaser.GameObjects.Image;
  private hpBar: Phaser.GameObjects.Graphics;
  private starBadge: Phaser.GameObjects.Text | null = null;
  /** Компактная плашка статуса ранения/отступления (§J). */
  private stateBadge: Phaser.GameObjects.Text | null = null;
  /** Таймер истечения кровью над пешкой (§G.3) — видимый дедлайн. */
  private bleedBadge: Phaser.GameObjects.Text | null = null;
  /** Контур щита таунта (§B.7.1). */
  private tauntBadge: Phaser.GameObjects.Graphics | null = null;
  private tauntText: Phaser.GameObjects.Text | null = null;
  private lastAnim = '';
  readonly def: PawnDef;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    kind: PawnKind,
    name: string,
    female: boolean,
    weapon?: PawnWeapon,
  ) {
    // Спрайт гарнизона берётся из отдельных листов с префиксом pawn-*
    const prefix = Pawn.spritePrefix(kind, weapon);
    super(scene, x, y, `${prefix}-idle`);
    this.kind = kind;
    const pd = PAWNS[kind];
    this.def = pd;
    this.cls = pd.cls;
    this.weapon = kind === 'fighter' || kind === 'healer'
      ? (weapon ?? (kind === 'healer' ? 'staff' : 'sword'))
      : null;
    // Гарнизон: статы из FIGHTERS, не из PAWNS (TZ §B.2)
    if (this.weapon && FIGHTERS[this.weapon]) {
      this.maxHp = FIGHTERS[this.weapon].hp;
      this.speed = FIGHTERS[this.weapon].speed;
    } else {
      this.maxHp = pd.hp;
      this.speed = pd.speed;
    }
    this.hp = this.maxHp;
    this.name = name;
    this.female = female;

    scene.add.existing(this);
    scene.physics.add.existing(this);
    const scale = Pawn.spriteScale(prefix);
    this.setScale(scale);
    this.setDepth(DEPTH.ENTITY_BASE + y);
    this.lastAnim = `${prefix}-idle`;
    this.play(this.lastAnim);

    // Тело у ног (кадр 192). Радиус в МИРОВЫХ единицах не зависит от
    // масштаба спрайта: 16 px — тело пешки, как и у героя.
    const r = 16 / scale;
    this.setCircle(r, 96 - r, 150 - r);
    this.setCollideWorldBounds(false);

    this.shadow = scene.add.image(x, y + 8, 'shadow')
      .setOrigin((SHADOW_BOX.x + SHADOW_BOX.w / 2) / SHADOW_SRC, (SHADOW_BOX.y + SHADOW_BOX.h / 2) / SHADOW_SRC)
      .setScale(SHADOW_SCALE * 0.9, SHADOW_SCALE * 0.55)
      .setAlpha(0.3)
      .setDepth(DEPTH.SHADOW);

    this.hpBar = scene.add.graphics().setDepth(DEPTH.HPBAR);
    this.hpBar.setVisible(false);
  }

  /**
   * Масштаб спрайта пешки.
   *
   *  Рабочие и гарнизон берут те же листы, что и герой (units/*), поэтому
   *  масштаб должен совпадать с геройским (0.55) — иначе рабочий выглядит
   *  муравьём: при 0.42 содержание кадра (≈55×72 px) давало на экране
   *  23×30 px против 43×49 у героя, и поселение читалось как пустое поле.
   *  Копейщик — лист 320 px, как у героя-копейщика: 0.34.
   */
  static spriteScale(prefix: string): number {
    return prefix === 'pawn-lancer' ? 0.34 : 0.55;
  }

  /** Префикс анимаций: pawn/pawny для рабочих, pawn-warrior/lancer/archer/monk для гарнизона. */
  static spritePrefix(kind: PawnKind, weapon?: PawnWeapon): string {
    if (kind === 'fighter') {
      return weapon === 'lance' ? 'pawn-lancer' : weapon === 'bow' ? 'pawn-archer' : 'pawn-warrior';
    }
    if (kind === 'healer') return 'pawn-monk';
    return PAWNS[kind].prefix;
  }

  get prefix(): string {
    return Pawn.spritePrefix(this.kind, this.weapon ?? undefined);
  }

  /** Коротко поворачивает спрайт к завершённой постройке (juice №3 §H.13). */
  faceToward(targetX: number): void {
    if (!this.active || this.dead || !Number.isFinite(targetX)) return;
    if (Math.abs(targetX - this.x) > 2) this.setFlipX(targetX < this.x);
  }

  // ---------- Анимации ----------

  /** Цикл: run с carry-листом, если несёт добычу (§B.2 «ресурс виден на руках»). */
  playMove(moving: boolean): void {
    const p = this.prefix;
    let want: string;
    if (moving) {
      want = this.carrying ? `${p}-carry-${this.carrying === 'ore' ? 'gold' : this.carrying}` : `${p}-run`;
    } else {
      want = this.carrying ? `${p}-carry-idle-${this.carrying === 'ore' ? 'gold' : this.carrying}` : `${p}-idle`;
    }
    if (this.lastAnim === `${p}-attack1` || this.lastAnim === `${p}-attack2` || this.lastAnim === `${p}-atk`) return;
    if (this.lastAnim !== want) {
      this.lastAnim = want;
      // Ключ может отсутствовать (нет carry-idle в пака) — фолбэк на базовый
      if (this.scene.anims.exists(want)) this.play(want, true);
      else {
        want = moving ? `${p}-run` : `${p}-idle`;
        this.play(want, true);
      }
    }
  }

  /**
   * Появление бесплатного жителя из-за края видимой области к дому (§E.5).
   * AI удерживает пешку в транзитном состоянии, пока этот tween не завершится.
   */
  arriveFrom(startX: number, startY: number, durationMs = 2_000): void {
    const targetX = this.x;
    const targetY = this.y;
    this.arrivalMs = durationMs;
    this.state = 'walk';
    this.setPosition(startX, startY).setAlpha(0);
    this.shadow.setPosition(startX, startY + 8).setAlpha(0);
    this.lastAnim = '';
    this.playMove(true);
    this.scene.tweens.add({
      targets: this,
      x: targetX,
      y: targetY,
      alpha: 1,
      duration: durationMs,
      ease: 'Sine.easeOut',
      onComplete: () => {
        this.arrivalMs = 0;
        if (!this.active) return;
        this.setAlpha(1);
        this.shadow.setAlpha(0.3);
        this.lastAnim = '';
        this.playMove(false);
        this.setDepth(DEPTH.ENTITY_BASE + this.y);
      },
    });
  }

  /** Работа инструментом: pawn-interact-{axe,hammer,knife,pickaxe}. */
  playWork(tool: 'axe' | 'hammer' | 'knife' | 'pickaxe'): void {
    const want = `${this.prefix}-work-${tool}`;
    if (this.lastAnim !== want && this.scene.anims.exists(want)) {
      this.lastAnim = want;
      this.play(want, true);
    }
  }

  private clearAttackImpactListeners(): void {
    if (this.attackImpactFrameHandler) this.off('animationupdate', this.attackImpactFrameHandler);
    if (this.attackImpactCompleteHandler) this.off('animationcomplete', this.attackImpactCompleteHandler);
    this.attackImpactFrameHandler = null;
    this.attackImpactCompleteHandler = null;
    this.attackImpactFallbackTimer?.remove(false);
    this.attackImpactFallbackTimer = null;
  }

  /** Прерывает ожидающий удар: отступление/ранение не должно наносить урон после отмены. */
  cancelPendingAttack(): void {
    this.attackPending = false;
    this.attackTarget = null;
    this.attackWeapon = null;
    this.clearAttackImpactListeners();
  }

  /**
   * Анимация гарнизона; callback срабатывает на среднем кадре действия.
   * Если лист отсутствует, применяется отдельный таймерный fallback; у штатных
   * анимаций попадание разрешает только animationupdate.
   */
  playAttackOnce(onImpact?: () => void, fallbackMs: number = COMBAT_TIMING.PAWN_SWORD_WINDUP_MS): void {
    const p = this.prefix;
    const key = p === 'pawn-warrior' ? `${p}-attack1` : `${p}-atk`;
    const real = this.scene.anims.exists(key) ? key : `${p}-attack1`;

    this.clearAttackImpactListeners();
    if (this.attackAnimationHandler) {
      this.off('animationcomplete', this.attackAnimationHandler);
      this.attackAnimationHandler = null;
    }

    if (!this.scene.anims.exists(real)) {
      this.lastAnim = '';
      if (onImpact) {
        this.attackImpactFallbackTimer = this.scene.time.delayedCall(fallbackMs, () => {
          this.attackImpactFallbackTimer = null;
          if (this.active) onImpact();
        });
      }
      return;
    }

    const handler = (anim: Phaser.Animations.Animation): void => {
      if (anim.key !== real) return;
      this.off('animationcomplete', handler);
      if (this.attackAnimationHandler === handler) this.attackAnimationHandler = null;
      if (this.active) this.lastAnim = '';
    };
    this.attackAnimationHandler = handler;
    this.on('animationcomplete', handler);

    if (onImpact) {
      let fired = false;
      const impactIndex = attackImpactFrameIndex(this.scene.anims.get(real)?.frames.length ?? 0);
      const fireImpact = (): void => {
        if (fired) return;
        fired = true;
        this.clearAttackImpactListeners();
        if (this.active) onImpact();
      };
      this.attackImpactFrameHandler = (animation, frame): void => {
        if (animation.key === real && frame.index >= impactIndex) fireImpact();
      };
      this.attackImpactCompleteHandler = (animation): void => {
        if (animation.key === real) fireImpact();
      };
      this.on('animationupdate', this.attackImpactFrameHandler);
      this.on('animationcomplete', this.attackImpactCompleteHandler);
    }

    this.lastAnim = real;
    this.play(real, true);
  }

  // ---------- Урон и лечение ----------

  /** Урон от врага. false — выжил; true — перешёл в wounded (§G.3). */
  takeDamage(dmg: number, _now: number): boolean {
    if (this.dead || this.state === 'wounded' || this.state === 'bleeding') return false;
    this.hp = Math.max(0, this.hp - dmg);
    this.setTint(0xffffff);
    this.setTintMode(Phaser.TintModes.FILL);
    this.scene.time.delayedCall(70, () => {
      if (this.active) {
        this.clearTint();
        this.setTintMode(Phaser.TintModes.MULTIPLY);
      }
    });
    this.drawHpBar();
    if (this.hp <= 0) {
      this.cancelPendingAttack();
      this.attackRecoveryMs = 0;
      this.attackWeapon = null;
      this.chargeTarget = null;
      this.taskProgress = 0;
      // Не умирает сразу — раненый идёт в монастырь (§G.3)
      this.state = 'wounded';
      this.carrying = null;
      this.workNode = null;
      this.drawHpBar();
      return true;
    }
    return false;
  }

  healBy(v: number): void {
    if (this.dead) return;
    this.hp = Math.min(this.maxHp, this.hp + v);
    if (this.hp >= this.maxHp) this.hpBar.setVisible(false);
    else this.drawHpBar();
  }

  /** Окончательная смерть: bleedout или обрушение обители (§G.3, §G.5). */
  killFinal(): void {
    this.dead = true;
    this.hp = 0;
  }

  private drawHpBar(): void {
    if (this.hp >= this.maxHp) {
      this.hpBar.setVisible(false);
      return;
    }
    const w = 44, h = 5;
    const x = this.x - w / 2, y = this.y + 26;
    const g = this.hpBar.setVisible(true);
    g.clear();
    g.fillStyle(0x1a0f08, 0.85).fillRoundedRect(x - 1, y - 1, w + 2, h + 2, 2);
    g.fillStyle(0x50120f).fillRect(x, y, w, h);
    const frac = Math.max(0, this.hp / this.maxHp);
    g.fillStyle(frac > 0.5 ? 0x53b44a : frac > 0.25 ? 0xe0a030 : 0xd03028)
      .fillRect(x, y, Math.round(w * frac), h);
  }

  /** ★ ветерана над головой (§H.2: до 3 звёзд). */
  updateStarBadge(): void {
    if (this.veteranStars <= 0) {
      this.starBadge?.destroy();
      this.starBadge = null;
    } else {
      if (!this.starBadge || !this.starBadge.active) {
        this.starBadge = this.scene.add.text(this.x, this.y - 46, '★', {
          fontFamily: FONT, fontSize: `${FS.small}px`, color: '#ffd76e',
        }).setOrigin(0.5).setDepth(DEPTH.HPBAR);
      }
      this.starBadge.setText('★'.repeat(this.veteranStars));
    }
    this.updateBleedBadge();
  }

  /**
   * Видимый дедлайн истечения кровью (§G.3, гейт §G.11 п.23).
   *
   * Спецификация требует «таймер над пешкой, именная плашка „{имя} истекает
   * кровью — 0:31“» — игрок видит цену бездействия в реальном времени и может
   * её отменить». Раньше таймер уменьшался, но ничего не рисовался: игрок не
   * видел ни оставшегося времени, ни кого именно он теряет.
   */
  updateBleedBadge(): void {
    const bleeding = this.state === 'bleeding';
    if (!bleeding) {
      this.bleedBadge?.destroy();
      this.bleedBadge = null;
      return;
    }
    if (!this.bleedBadge || !this.bleedBadge.active) {
      this.bleedBadge = this.scene.add.text(this.x, this.y - 34, '', {
        fontFamily: FONT, fontSize: `${FS.small}px`, color: '#ff6655',
        stroke: '#1a0f08', strokeThickness: 3,
      }).setOrigin(0.5).setDepth(DEPTH.HPBAR);
    }
    const secs = Math.max(0, Math.ceil(this.bleedTimer));
    // Мигание в последние 10 секунд — дедлайн должен бросаться в глаза
    this.bleedBadge.setAlpha(secs <= 10 && Math.floor(this.bleedTimer * 4) % 2 === 0 ? 0.35 : 1);
    this.bleedBadge.setText(`${secs}`);
  }

  /**
 * Вспышка таунта: щит-контур вокруг мечника и подпись «−50%» над ним
 * (§B.7.1). Снимается сама по истечении `tauntFlashUntil`.
 */
  /** Подпись над головой делает состояния retreat/wounded визуально читаемыми. */
  private updateStateBadge(): void {
    const label = this.state === 'retreat'
      ? t('pawn.badgeRetreat')
      : this.state === 'wounded' || this.state === 'bleeding'
        ? t('pawn.badgeWounded')
        : '';
    if (!label) {
      this.stateBadge?.destroy();
      this.stateBadge = null;
      return;
    }
    const isRetreating = this.state === 'retreat';
    if (!this.stateBadge || !this.stateBadge.active) {
      this.stateBadge = this.scene.add.text(this.x, this.y - 52, label, {
        fontFamily: FONT,
        fontSize: `${FS.small}px`,
        color: isRetreating ? '#ffd76e' : '#ff806e',
        backgroundColor: '#1a0f08',
        padding: { x: 3, y: 1 },
        stroke: '#1a0f08',
        strokeThickness: 2,
      }).setOrigin(0.5).setDepth(DEPTH.HPBAR);
    }
    if (this.stateBadge.text !== label) this.stateBadge.setText(label);
    this.stateBadge.setColor(isRetreating ? '#ffd76e' : '#ff806e');
    // Индикатор истечения кровью и звёзды остаются отдельными, не накладываются.
    const offset = this.state === 'bleeding' ? 66 : this.starBadge?.active ? 64 : 48;
    this.stateBadge.setPosition(this.x, this.y - offset).setVisible(true);
  }

  showTauntBadge(): void {
    if (!this.tauntBadge || !this.tauntBadge.active) {
      this.tauntBadge = this.scene.add.graphics().setDepth(DEPTH.FX);
      this.tauntText = this.scene.add.text(this.x, this.y - 58, '−50%', {
        fontFamily: FONT, fontSize: `${FS.small}px`, color: '#8fd0ff',
        stroke: '#1a0f08', strokeThickness: 3,
      }).setOrigin(0.5).setDepth(DEPTH.FX);
    }
    this.tauntBadge.clear();
    this.tauntBadge.lineStyle(2, 0x8fd0ff, 0.95).strokeCircle(0, 0, 22);
    this.tauntBadge.lineStyle(1, 0x8fd0ff, 0.5).strokeCircle(0, 0, 26);
    if (this.tauntText) this.tauntText.setPosition(this.x, this.y - 58).setVisible(true);
  }

  /** Держит контур и подпись поверх воина и гасит их по таймауту. */
  private tickTauntBadge(now: number): void {
    const g = this.tauntBadge;
    if (!g || !g.active) return;
    if (this.tauntFlashUntil <= 0 || now >= this.tauntFlashUntil) {
      g.setVisible(false);
      this.tauntText?.setVisible(false);
      return;
    }
    g.setVisible(true).setPosition(this.x, this.y);
    // Пульсация контура — «щит» должен читаться как активный, а не как статика
    const k = 1 + Math.sin(now / 90) * 0.06;
    g.setScale(k);
    if (this.tauntText) {
      this.tauntText.setPosition(this.x, this.y - 58).setVisible(true);
    }
  }

  canBecomeHero(): boolean {
    // Только живой на карте воин; wounded/retreat не считаются (§F.4)
    return this.cls === 'garrison' && !this.dead
      && this.state !== 'wounded' && this.state !== 'bleeding' && this.state !== 'retreat';
  }

  preUpdate(time: number, delta: number): void {
    if (!this.active || this.scene.registry.get('tss-hint-overlay-paused') === true) return;
    super.preUpdate(time, delta);
    if (!this.active) return;
    this.shadow.setPosition(this.x, this.y + 8);
    this.setDepth(DEPTH.ENTITY_BASE + this.y);
    if (this.hpBar.visible) this.drawHpBar();
    if (this.starBadge?.active) this.starBadge.setPosition(this.x, this.y - 46);
    if (this.bleedBadge?.active) {
      this.bleedBadge.setPosition(this.x, this.y - 34);
      this.updateBleedBadge();
    }
    this.updateStateBadge();
    const activeTimeValue = this.scene.registry.get('tss-active-time-ms');
    const activeTime = typeof activeTimeValue === 'number' && Number.isFinite(activeTimeValue)
      ? activeTimeValue
      : time;
    this.tickTauntBadge(activeTime);
    void delta;
  }

  destroy(fromScene?: boolean): void {
    this.cancelPendingAttack();
    this.clearAttackImpactListeners();
    this.shadow.destroy();
    this.hpBar.destroy();
    this.starBadge?.destroy();
    this.stateBadge?.destroy();
    this.bleedBadge?.destroy();
    this.tauntBadge?.destroy();
    this.tauntText?.destroy();
    super.destroy(fromScene);
  }
}
