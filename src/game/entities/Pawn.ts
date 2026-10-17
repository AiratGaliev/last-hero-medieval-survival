import Phaser from 'phaser';
import { DEPTH, SHADOW_SCALE, SHADOW_BOX, SHADOW_SRC } from '../constants';
import { PAWNS, FIGHTERS, type PawnKind, type PawnState, type PawnWeapon, type ResourceKind, type PawnDef } from '../data';

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
  /** Таймер истечения кровью (bleeding). */
  bleedTimer = 0;
  /** Кулдаут атаки (гарнизон). */
  attackCd = 0;
  /** Телеграф рывка копья (гарнизон lance). */
  chargeWindup = 0;
  /** Слот монастыря: индекс места, пока лечится в обители. */
  monasterySlot: number | null = null;
  /** Лечение монахом на поле: цель. */
  healTarget: Pawn | null = null;
  /** Работает над узлом ресурса / зданием. */
  workNode: unknown = null;
  dead = false;

  private shadow: Phaser.GameObjects.Image;
  private hpBar: Phaser.GameObjects.Graphics;
  private starBadge: Phaser.GameObjects.Text | null = null;
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
    this.setScale(0.42);
    this.setDepth(DEPTH.ENTITY_BASE + y);
    this.lastAnim = `${prefix}-idle`;
    this.play(this.lastAnim);

    // Тело у ног (кадр 192)
    const r = 16 / 0.42;
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

  /** Работа инструментом: pawn-interact-{axe,hammer,knife,pickaxe}. */
  playWork(tool: 'axe' | 'hammer' | 'knife' | 'pickaxe'): void {
    const want = `${this.prefix}-work-${tool}`;
    if (this.lastAnim !== want && this.scene.anims.exists(want)) {
      this.lastAnim = want;
      this.play(want, true);
    }
  }

  /** Однократная боевая анимация гарнизона. */
  playAttackOnce(): void {
    const p = this.prefix;
    const key = p === 'pawn-warrior' ? `${p}-attack1` : `${p}-atk`;
    const real = this.scene.anims.exists(key) ? key : `${p}-attack1`;
    if (this.lastAnim !== real) {
      this.lastAnim = real;
      this.play(real, true);
    }
    this.once('animationcomplete', (anim: Phaser.Animations.Animation) => {
      void anim;
      if (this.active) this.lastAnim = '';
    });
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
      return;
    }
    if (!this.starBadge || !this.starBadge.active) {
      this.starBadge = this.scene.add.text(this.x, this.y - 46, '★', {
        fontFamily: 'sans-serif', fontSize: '11px', color: '#ffd76e',
      }).setOrigin(0.5).setDepth(DEPTH.HPBAR);
    }
    this.starBadge.setText('★'.repeat(this.veteranStars));
  }

  canBecomeHero(): boolean {
    // Только живой на карте воин; wounded/retreat не считаются (§F.4)
    return this.cls === 'garrison' && !this.dead
      && this.state !== 'wounded' && this.state !== 'bleeding' && this.state !== 'retreat';
  }

  preUpdate(time: number, delta: number): void {
    super.preUpdate(time, delta);
    if (!this.active) return;
    this.shadow.setPosition(this.x, this.y + 8);
    this.setDepth(DEPTH.ENTITY_BASE + this.y);
    if (this.hpBar.visible) this.drawHpBar();
    if (this.starBadge?.active) this.starBadge.setPosition(this.x, this.y - 46);
    void time;
    void delta;
  }

  destroy(fromScene?: boolean): void {
    this.shadow.destroy();
    this.hpBar.destroy();
    this.starBadge?.destroy();
    super.destroy(fromScene);
  }
}
