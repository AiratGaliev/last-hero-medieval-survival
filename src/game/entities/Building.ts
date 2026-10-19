import Phaser from 'phaser';
import { DEPTH, SIEGE, FONT } from '../constants';
import { BUILDING_PLANS, type BuildingKind } from '../data';

// ============ Построенное сооружение (TZ §B.4, §E.4, §G) ============
//
// Спрайт + HP + damage(). Осада бьёт здания (обычные волны — нет), огненный
// шар шамана поджигает (dynamite на корпусе + fire-01, DoT входит в потолок
// осады). Монастырь держит 10 мест лечения; разрушение убивает всех внутри.

export interface BuildingCtx {
  /** ruins=true — здание стало руинами (пятно остаётся занято),
   *  false — полное разрушение (монастырь/замок: пятно освобождается, §G.5.2). */
  onDamaged(b: Building, amount: number, siegeIdx: number): void;
  onDestroyed(b: Building, ruins: boolean): void;
  /** Предупреждение за 3 сек: обитель падает, погибнет N (TZ §G.5.1). */
  onMonasteryFalling(b: Building, victims: number): void;
}

/** Мета-подстройка (фазы Q/S): HP зданий/домов и места обители (§H.16, §H.17). */
export interface BuildingTuning {
  hpMult?: number;
  houseMult?: number;
  slots?: number;
}

export class Building extends Phaser.GameObjects.Image {
  readonly kind: BuildingKind;
  hp: number;
  maxHp: number;
  alive = true;
  /** Индекс осады, в которую здание получало урон (для потолка). */
  lastSiegeIdx = -1;
  /** Стройка: нулевой HP до завершения. */
  underConstruction = false;
  /** Монастырь: занятые места (индексы 0..9, null = свободно). */
  healSlots: (unknown | null)[] = [];
  /** Горение: DoT поджога (§E.4.1). */
  private burnUntil = 0;
  private burnSprite: Phaser.GameObjects.Sprite | null = null;
  private fireFx: Phaser.GameObjects.Sprite | null = null;
  private fireTimer = 0;
  private slotLabel: Phaser.GameObjects.Text | null = null;
  private readonly scene_: Phaser.Scene;
  private readonly ctx: BuildingCtx;

  constructor(scene: Phaser.Scene, x: number, y: number, kind: BuildingKind, texture: string, scale: number, ctx: BuildingCtx, tuning?: BuildingTuning) {
    super(scene, x, y, texture);
    this.scene_ = scene;
    this.ctx = ctx;
    this.kind = kind;
    const plan = BUILDING_PLANS[kind];
    const hpMult = tuning?.hpMult ?? 1;
    const houseMult = tuning?.houseMult ?? 1;
    this.maxHp = Math.max(1, Math.round(plan.hp * (kind === 'house' ? houseMult : hpMult)));
    this.hp = this.maxHp;
    scene.add.existing(this);
    this.setScale(scale);
    this.setDepth(DEPTH.ENTITY_BASE + y);
    const slots = tuning?.slots ?? plan.slots;
    if (slots) this.healSlots = new Array(slots).fill(null);
  }

  get plan() {
    return BUILDING_PLANS[this.kind];
  }

  /** Завершение стройки: твин scaleY 0→1 + полное HP (TZ §B.4). */
  finishConstruction(): void {
    this.underConstruction = false;
    this.hp = this.maxHp;
    this.setScale(this.scaleX, 0.02);
    this.scene_.tweens.add({
      targets: this,
      scaleY: this.scaleX,
      duration: 200,
      ease: 'Back.easeOut',
      onComplete: () => this.setDepth(DEPTH.ENTITY_BASE + this.y),
    });
    // Флаг на здании (juice №3 §H.13)
    const flag = this.scene_.add.image(this.x + 26 * this.scaleX, this.y - 60 * this.scaleX, 'ribbon-yellow')
      .setScale(0.22).setDepth(DEPTH.FX);
    this.scene_.tweens.add({
      targets: flag, y: flag.y - 14, alpha: 0, duration: 900, ease: 'Quad.easeOut',
      onComplete: () => flag.destroy(),
    });
  }

  /**
   * Урон по зданию. `siegeIdx` — номер осады для потолка 12%/6% (§E.4.2):
   * суммарный урон одной осады по ВСЕЙ инфраструктуре ограничен — контроль
   * ведёт Settlement, Building просто рапортует.
   */
  damage(amount: number, siegeIdx: number): void {
    // Руины (hp=0, uc=true) и стройка урон не принимают
    if (!this.alive || this.underConstruction) return;
    this.hp = Math.max(0, this.hp - amount);
    // ⚠️ Метку осады обновляем только осадным уроном. Раньше `lastSiegeIdx`
    // перезаписывался при ЛЮБОМ уроне, в том числе уроном босса (−1), —
    // и оставшийся DoT осады «терял» принадлежность к потолку.
    if (siegeIdx >= 0) this.lastSiegeIdx = siegeIdx;
    this.ctx.onDamaged(this, amount, siegeIdx);
    // Предупреждения обители: 30% и 10% HP (TZ §G.5.1)
    if (this.kind === 'monastery') {
      const frac = this.hp / this.maxHp;
      const victims = this.healSlots.filter((s) => s !== null).length;
      if (frac <= 0.1 && !this.warned10) {
        this.warned10 = true;
        this.ctx.onMonasteryFalling(this, victims);
      } else if (frac <= 0.3 && !this.warned30) {
        this.warned30 = true;
        this.ctx.onMonasteryFalling(this, victims);
      }
    }
    if (this.hp <= 0) {
      // Замок и обитель гибнут полностью (§E.3, §G.5); прочие — руины,
      // которые ремонтник восстанавливает за 60 дерева / 10 сек (§E.5).
      if (this.kind === 'castle' || this.kind === 'monastery') this.destroy();
      else this.enterRuins();
    }
  }

  /** Руины: стоит сгоревший каркас, лимит не даёт, чинится через repair(). */
  private enterRuins(): void {
    this.underConstruction = true; // блокирует урон и найм
    this.burnUntil = 0;
    this.burnSprite?.destroy();
    this.burnSprite = null;
    this.fireFx?.destroy();
    this.fireFx = null;
    this.setAlpha(0.35);
    this.setTint(0x555555);
    this.ctx.onDestroyed(this, true);
    // Облако щепы (juice №5 §H.13)
    const puff = this.scene_.add.sprite(this.x, this.y - 20, 'fx-dust')
      .setScale(2.4).setAlpha(0.85).setDepth(DEPTH.FX - 5);
    puff.play('fx-dust');
    puff.once('animationcomplete', () => puff.destroy());
  }

  private warned30 = false;
  private warned10 = false;

  /** Сброс порогов предупреждений после ремонта (обитель достроена). */
  warnedReset(): void {
    this.warned30 = false;
    this.warned10 = false;
  }

  /** Поджог: DoT SIEGE.BURN_DMG за SIEGE.BURN_MS (TZ §E.4.1). */
  ignite(siegeIdx: number): void {
    if (!this.alive || this.underConstruction) return;
    this.burnUntil = Math.max(this.burnUntil, this.scene_.time.now + SIEGE.BURN_MS);
    this.lastSiegeIdx = siegeIdx;
    if (!this.burnSprite || !this.burnSprite.active) {
      // Динамит на корпусе: горящий фитиль (§E.4.1)
      this.burnSprite = this.scene_.add.sprite(this.x, this.y + 10, 'barrel')
        .setScale(0.8).setDepth(DEPTH.ENTITY_BASE + this.y + 1);
      this.burnSprite.play('barrel-burn');
    }
    if (!this.fireFx || !this.fireFx.active) {
      this.fireFx = this.scene_.add.sprite(this.x, this.y - 20, 'fx-fire')
        .setScale(1.1).setDepth(DEPTH.FX - 5).setAlpha(0.9);
    }
  }

  /** Тик горения; возвращает урон DoT за кадр (вызывает Economy). */
  tickBurn(dtMs: number): number {
    if (!this.alive || this.scene_.time.now >= this.burnUntil) {
      if (this.burnSprite?.active) this.burnSprite.destroy();
      this.burnSprite = null;
      if (this.fireFx?.active) this.fireFx.destroy();
      this.fireFx = null;
      return 0;
    }
    this.fireTimer -= dtMs;
    if (this.fireTimer <= 0) {
      this.fireTimer = 500;
      const f = this.scene_.add.sprite(
        this.x + Phaser.Math.Between(-24, 24), this.y - Phaser.Math.Between(0, 40), 'fx-fire',
      ).setScale(0.8).setDepth(DEPTH.FX - 5).setAlpha(0.85);
      f.play('fx-fire');
      f.once('animationcomplete', () => f.destroy());
    }
    // DoT — равномерно за всё время горения
    return (SIEGE.BURN_DMG * dtMs) / SIEGE.BURN_MS;
  }

  /** Слот лечения: null если свободных нет (FIFO по приходу, §G.4). */
  claimHealSlot(unit: unknown): number | null {
    const i = this.healSlots.indexOf(null);
    if (i === -1) return null;
    this.healSlots[i] = unit;
    this.updateSlotLabel();
    return i;
  }

  releaseHealSlot(slot: number): void {
    if (slot >= 0 && slot < this.healSlots.length) {
      this.healSlots[slot] = null;
      this.updateSlotLabel();
    }
  }

  get occupiedSlots(): number {
    return this.healSlots.filter((s) => s !== null).length;
  }

  /** Индикатор мест над монастырём: «7/10» (TZ §G.11 п.2). */
  private updateSlotLabel(): void {
    if (!this.plan.slots) return;
    if (!this.slotLabel || !this.slotLabel.active) {
      this.slotLabel = this.scene_.add.text(this.x, this.y - 70 * this.scaleX, '0/10', {
        fontFamily: FONT, fontSize: '13px', color: '#ffe9b0',
        stroke: '#1a0f08', strokeThickness: 3,
      }).setOrigin(0.5).setDepth(DEPTH.HPBAR);
    }
    this.slotLabel.setText(`${this.occupiedSlots}/${this.healSlots.length}`);
  }

  destroy(fromScene?: boolean): void {
    // Phaser вызывает destroy() у всех детей при шатдауне/уничтожении сцены.
    // Это НЕ игровое разрушение: колбэки осад/жильцов били бы по уже
    // уничтоженному HUD (setText на уничтоженном кадре — «Cannot read
    // properties of null (reading 'drawImage')») и роняли загрузку новой
    // сцены. Поэтому при SHUTDOWN/DESTROYED глушим игровую логику.
    const status = this.scene_.sys.settings.status as number;
    const isSceneTeardown = fromScene === true
      || status === Phaser.Scenes.SHUTDOWN
      || status === Phaser.Scenes.DESTROYED;
    if (isSceneTeardown) {
      this.alive = false;
      super.destroy(fromScene);
      return;
    }
    if (!this.alive) return;
    this.alive = false;
    this.burnSprite?.destroy();
    this.fireFx?.destroy();
    this.slotLabel?.destroy();
    this.ctx.onDestroyed(this, false);
    // Облако щепы при разрушении (juice №5 §H.13)
    const puff = this.scene_.add.sprite(this.x, this.y - 20, 'fx-dust')
      .setScale(2.4).setAlpha(0.85).setDepth(DEPTH.FX - 5);
    puff.play('fx-dust');
    puff.once('animationcomplete', () => puff.destroy());
    super.destroy(fromScene);
  }
}
