import Phaser from 'phaser';
import { SIEGE, TAUNT, SCORE } from '../constants';
import { SUCCESSION_SOURCES, type BuildingKind } from '../data';
import { track } from '../../platform/analytics';
import { audio } from './Audio';
import type { Economy } from './Economy';
import { Building } from '../entities/Building';
import type { Pawn } from '../entities/Pawn';
import type { Enemy } from '../entities/Enemy';

// ============ Поселение под уроном (TZ §E, §G.7) ============
//
// Два независимых «сердца»: инфраструктура (замок + постройки) и население
// (пешки + дома). Здесь: урон по зданиям с потолком осады 12%/6% и таунтом
// мечника, ранения по лимитам профиля, три условия поражения, приоритет
// целей осады (замок > монастырь > казармы > прочее).

export type LoseCause = 'hero' | 'castle' | 'population';

export interface SettlementCtx {
  onFeed(text: string, color?: string): void;
  onDefeat(cause: LoseCause): void;
  onMonasteryCollapsed(victims: number): void;
  onBuildingDestroyed(b: Building): void;
  onSiegeScore(outcome: 'defended' | 'partial', index: number): void;
  /** Пешка стала ветераном 3★ — микро-награды §H.6/§E.8 (+100 очков, +25 XP). */
  onVeteran(pawn: Pawn): void;
  heroX(): number;
  heroY(): number;
}

export class Settlement {
  readonly scene: Phaser.Scene;
  readonly eco: Economy;
  private ctx: SettlementCtx;
  /** Замок. */
  castle: Building;
  /** Активная осада: учёт урона для потолка (§E.4.2). */
  siegeIdx = -1;
  private siegeDmg = 0;
  private siegeCapApplied = false;
  /** Прикладывался ли потолок урона в текущей осаде (событие siege_result §K.2). */
  get capApplied(): boolean {
    return this.siegeCapApplied;
  }
  private siegeWounds = 0;
  private siegeWoundCap = 1;
  private siegeEnemies: Set<Enemy> = new Set();
  /** Пересчёт условия вымирания — раз в 60 сек (§E.3). */
  private popCheckAt = 0;
  /** 3-секундный экран перед GameOverScene (§E.3). */
  extinctAt: number | null = null;
  castleFellAt: number | null = null;
  /** Факты для хроники (§H.3). */
  facts: {
    monasteryFallenAt: string | null;
    monasteryVictims: number;
    siegesDefended: number;
    siegesTotal: number;
    castleMinHp: number;
    bledOutName: string | null;
    bledOutShort: number;
  } = {
    monasteryFallenAt: null, monasteryVictims: 0, siegesDefended: 0, siegesTotal: 0,
    castleMinHp: 500, bledOutName: null, bledOutShort: 0,
  };

  constructor(scene: Phaser.Scene, eco: Economy, ctx: SettlementCtx) {
    this.scene = scene;
    this.eco = eco;
    this.ctx = ctx;
    // Замок как здание с HP (не строится, не чинится)
    this.castle = new Building(scene, eco.castleX, eco.castleY, 'castle', 'castle', 0.9, {
      onDamaged: (b, _amount, _idx) => this.trackDamage(b),
      onDestroyed: (b) => this.onBuildingDestroyed(b),
      onMonasteryFalling: () => {},
    });
    eco.buildings.push(this.castle);
  }

  /** Замок: минимальный HP за матч — для хроники и near-miss (§H.3). */
  private trackDamage(b: Building): void {
    if (b.kind === 'castle') {
      this.facts.castleMinHp = Math.min(this.facts.castleMinHp, Math.max(0, b.hp));
    }
  }

  get infrastructureHp(): number {
    let hp = 0;
    for (const b of this.eco.buildings) {
      if (b.alive && !b.underConstruction) hp += b.hp;
    }
    return hp;
  }

  get infrastructureMax(): number {
    let hp = 0;
    for (const b of this.eco.buildings) {
      // Незавершённые стройки и руины не могут принимать урон и не должны
      // увеличивать знаменатель потолка осады. Иначе игрок получает скрытый
      // бонус к лимиту урона, просто начав строить/потеряв дом.
      if (b.alive && !b.underConstruction) hp += b.maxHp;
    }
    return Math.max(1, hp);
  }

  get aliveBuildings(): Building[] {
    return this.eco.buildings.filter((b) => b.alive && !b.underConstruction);
  }

  /** Есть ли здание, выпускающее воина (§F.6): казармы/тир/обитель. */
  hasSuccessionSource(): boolean {
    return this.aliveBuildings.some((b) => SUCCESSION_SOURCES.includes(b.kind as BuildingKind));
  }

  // ================= ОСАДА =================

  beginSiege(profileIndex: number, woundCap: number, enemies: Enemy[]): void {
    this.siegeIdx = profileIndex;
    this.siegeDmg = 0;
    this.siegeCapApplied = false;
    this.siegeWounds = 0;
    this.siegeWoundCap = woundCap;
    this.siegeEnemies = new Set(enemies);
    this.facts.siegesTotal++;
  }

  /** Все враги текущей осады убиты/ушли. */
  siegeMembers(): Enemy[] {
    return [...this.siegeEnemies].filter((e) => e.active);
  }

  endSiege(outcome: 'defended' | 'partial' | 'ignored'): void {
    if (outcome === 'defended') {
      this.facts.siegesDefended++;
      this.ctx.onSiegeScore('defended', this.siegeIdx);
    } else if (outcome === 'partial') {
      this.ctx.onSiegeScore('partial', this.siegeIdx);
    }
    // Ветеранство: пешка, пережившая осаду, получает ★ до 3 (§H.2)
    if (outcome !== 'ignored') {
      for (const p of this.eco.pawns) {
        if (p.dead || !p.active || p.state === 'wounded' || p.state === 'bleeding') continue;
        p.siegesSurvived++;
        if (p.siegesSurvived <= 3) {
          p.veteranStars = p.siegesSurvived;
          p.updateStarBadge();
          if (p.siegesSurvived === 3) {
            this.ctx.onFeed(`★ ${p.name} — ветеран!`, '#ffd76e');
            // Ветеран 3★ — +10% СКОРОСТИ РАБОТЫ (§H.2), а не скорости
            // передвижения: бонус обещан за «рубку/добычу», и в коде работа
            // идёт через workSpeed/tune. Раньше множился p.speed (ходьба),
            // то есть обещанного бонуса не было вовсе.
            p.workSpeedMult = 1.1;
            // Микро-награды ветеранства: +100 очков, +25 XP (§E.8, §H.6)
            this.ctx.onVeteran(p);
          }
        }
      }
    }
    this.siegeIdx = -1;
    this.siegeEnemies.clear();
  }

  /**
   * Урон по зданию: потолок 12% (6% при HP < 60%) на ВСЮ осаду (§E.4.2) +
   * таунт мечника: 50% урона в радиусе 150 px перетягивается на него (§B.7.1).
   * Против босса таунт не работает (§E.6) — передаётся `isBoss`.
   */
  damageBuilding(b: Building, raw: number, siegeIdx: number, isBoss = false): void {
    if (!b.alive || b.underConstruction) return;
    let amount = raw;

    // Таунт: мечник в состоянии fight в 150 px от здания (только осада, не босс)
    if (!isBoss && siegeIdx >= 0) {
      const sword = this.tauntingSword(b);
      if (sword) {
        const share = Math.min(amount * TAUNT.SHARE, sword.hp);
        amount -= share;
        this.eco.woundPawn(sword, share, this.simulationTimeMs);
        this.flashTaunt(sword);
        // Телеметрия §K.2: таунт перетянул долю урона на себя
        track('garrison_taunt', { weapon: sword.weapon ?? 'sword', building_kind: b.kind, dmg_redirected: Math.round(share * 10) / 10 });
      }
    }

    // Потолок осады: считается по всей инфраструктуре (§E.4.2)
    if (siegeIdx >= 0) {
      // ⚠️ Раньше условие было `siegeIdx === this.siegeIdx`. Горение живёт
      // 6 секунд, а Building.damage() перезаписывал lastSiegeIdx при ЛЮБОМ
      // уроне — в том числе уроном босса (−1). Огонь, начатый осадой N,
      // дожигал дом уже после её закрытия и уходил в здание ПОЛНОСТЬЮ,
      // минуя потолок: «огонь не суммируется в DoT сверх потолка» (§E.4.4)
      // переставал выполняться. Здесь любой осадный урон (включая DoT
      // прошлой осады) идёт через один и тот же счётчик.
      const infra = this.infrastructureHp;
      const total = this.infrastructureMax;
      const cap = infra < total * SIEGE.LOW_HP ? SIEGE.MAX_INFRA_DMG_LOW : SIEGE.MAX_INFRA_DMG;
      const maxDmg = total * cap;
      if (this.siegeDmg + amount > maxDmg) {
        amount = Math.max(0, maxDmg - this.siegeDmg);
        this.siegeCapApplied = true;
      }
      this.siegeDmg += amount;
      if (amount <= 0) return;
    }
    // siegeIdx < 0 — не осада (босс фаза 2): без потолка, это кульминация (§E.6)

    if (b.kind === 'castle') {
      this.facts.castleMinHp = Math.min(this.facts.castleMinHp, Math.max(0, b.hp - amount));
    }
    b.damage(amount, siegeIdx);
  }

  /** Обитель уже обрушивалась в этом ране — второго обрушения не будет
   *  (гейт §G.11 п.19). Пятно стройки освобождается, отстроить можно. */
  private monasteryCollapsed = false;

  private tauntingSword(b: Building): Pawn | null {
    for (const p of this.eco.garrison) {
      if (p.kind !== 'fighter' || p.weapon !== 'sword' || p.dead) continue;
      if (p.state !== 'fight' || p.order !== 'hold' || !p.orderTarget) continue;
      if (Math.hypot(p.x - b.x, p.y - b.y) <= TAUNT.RADIUS) return p;
    }
    return null;
  }

  /**
   * Урон по гражданскому с перетягиванием на мечника (§B.7.1: «То же для урона
   * по гражданскому в этом радиусе»). Раньше таунт работал только по зданиям.
   */
  tauntCivilian(victim: Pawn, raw: number, siegeIdx: number): number {
    if (siegeIdx < 0) return raw;
    const sword = this.tauntingSwordAt(victim);
    if (!sword) return raw;
    const share = Math.min(raw * TAUNT.SHARE, sword.hp);
    this.eco.woundPawn(sword, share, this.simulationTimeMs);
    this.flashTaunt(sword);
    track('garrison_taunt', {
      weapon: sword.weapon ?? 'sword', building_kind: 'pawn', dmg_redirected: Math.round(share * 10) / 10,
    });
    return raw - share;
  }

  private tauntingSwordAt(victim: Pawn): Pawn | null {
    for (const p of this.eco.garrison) {
      if (p.kind !== 'fighter' || p.weapon !== 'sword' || p.dead) continue;
      if (p.state !== 'fight' || p.order !== 'hold' || !p.orderTarget) continue;
      if (Math.hypot(p.x - victim.x, p.y - victim.y) <= TAUNT.RADIUS) return p;
    }
    return null;
  }

  /**
   * Видимое подтверждение таунта (§B.7.1): «на мечнике вспыхивает
   * щит-контур, а над ним — индикатор „−50%“». Без этого игрок не видил, что
   * его воин перетянул урон, — а без обратной связи нельзя принять решение
   * «поставить мечника под осаду», ради которого таунт и придуман.
   */
  private flashTaunt(sword: Pawn): void {
    if (sword.tauntFlashUntil > this.simulationTimeMs) return;
    sword.tauntFlashUntil = this.simulationTimeMs + 700;
    sword.showTauntBadge();
    audio.play('hit');
  }

  /** Лимит ранений за осаду (§E.4: SIEGE_WOUND_CAP). */
  canWoundInSiege(): boolean {
    return this.siegeIdx >= 0 && this.siegeWounds < this.siegeWoundCap;
  }

  registerWound(): void {
    this.siegeWounds++;
  }

  /** Осадный враг ранит пешку: лимит расходуется только на реальный переход в wounded (§E.4). */
  siegeWoundPawn(pawn: Pawn, dmg: number, now: number): void {
    if (!this.canWoundInSiege()) return;
    if (this.eco.woundPawn(pawn, dmg, now)) this.registerWound();
  }

  // ================= РАЗРУШЕНИЕ =================

  /** Разрушение здания: обитель убивает раненых, дом снижает лимит (§G.5, §B.4). */
  onBuildingDestroyed(b: Building): void {
    this.ctx.onBuildingDestroyed(b);
    // Обрушение обители: все раненые внутри погибают (§G.5, вариант B).
    // Гейт §G.11 п.19: за матч обрушение происходит НЕ ЧАЩЕ РАЗА. Второе
    // разрушение — уже не «событие», а рутина, которая выбивает население
    // каждые пару минут и обещает игроку бесперспективность.
    if (b.kind === 'monastery') {
      // Каждое разрушение обители убивает находящихся внутри. Флаг хранит факт
      // первого обрушения для обучения/хроники, но не отменяет правило G.5 для
      // второй обители, построенной позже.
      this.monasteryCollapsed = true;
      // Слот — локальный индекс здания. Дедуплицируем возможные старые ссылки:
      // одна пешка умирает и учитывается один раз, даже если была в двух местах.
      const victims = [...new Set(
        b.healSlots.filter((slot): slot is Pawn => slot !== null) as Pawn[],
      )];
      if (this.facts.monasteryFallenAt === null) {
        this.facts.monasteryFallenAt = this.fmtTime();
      }
      this.facts.monasteryVictims += victims.length;

      // Building уже помечен destroyed при вызове callback. removePawn()
      // корректно не вызывает UI-освобождение слота у мёртвого здания, поэтому
      // обнуляем массив без создания новых slot-label-ов на разрушенном спрайте
      // и убираем owner-ссылки до обработки окончательной смерти.
      b.healSlots.fill(null);
      for (const victim of victims) {
        if (victim.monasteryBuilding === b) {
          victim.monasterySlot = null;
          victim.monasteryBuilding = null;
        }
        this.eco.removePawn(victim);
      }
      // Этот callback отвечает и за объявление числа жертв, и за единственное
      // событие аналитики. Он нужен для каждого обрушения, не только первого.
      this.ctx.onMonasteryCollapsed(victims.length);
    }
    // Дом падает — лимит рабочих уменьшается; лишние пешки уходят (§B.4).
      // Уход — не смерть: восстановление за дерево и мясо не запускается.
      if (b.kind === 'house') {
        const excess = this.eco.civilians.length - this.eco.pawnLimit;
        for (let i = 0; i < excess; i++) {
          const victim = this.eco.civilians[this.eco.civilians.length - 1 - i];
          if (victim) {
            this.ctx.onFeed(`{${victim.name}} ${'—'} уходит — некуда вернуться`, '#ff8866');
            this.eco.removePawn(victim, false);
          }
        }
      }
  }

  private get simulationTimeMs(): number {
    const value = this.scene.registry.get('tss-active-time-ms');
    return typeof value === 'number' && Number.isFinite(value) ? value : this.scene.time.now;
  }

  private fmtTime(): string {
    const s = Math.floor(this.simulationTimeMs / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  // ================= УСЛОВИЯ ПОРАЖЕНИЯ (§E.3) =================

  /**
   * Проверка вымирания — раз в 60 сек, тройное условие:
   * 0 пешек И 0 домов И на складе < 30 дерева (цена дома).
   */
  checkExtinction(now: number): boolean {
    if (this.extinctAt !== null || now < this.popCheckAt) return false;
    this.popCheckAt = now + 60000;
    const noPawns = this.eco.pawns.length === 0;
    const noHouses = this.eco.houses === 0;
    const noWood = this.eco.resources.wood < 30;
    if (noPawns && noHouses && noWood) {
      this.extinctAt = now;
      return true;
    }
    return false;
  }

  /** Очки ЗАЩИТА/НАСЕЛЕНИЕ на финише (§E.8). */
  settlementScore(): { defence: number; population: number; buildings: number; pawns: number } {
    const buildings = this.aliveBuildings.length;
    const pawns = this.eco.pawns.length;
    return {
      defence: buildings * SCORE.SETTLEMENT,
      population: pawns * SCORE.POPULATION,
      buildings,
      pawns,
    };
  }

  /** Идеальная победа: босс убит + замок цел + ≥3 пешек (§E.7). */
  isIdealVictory(bossKilled: boolean): boolean {
    return bossKilled && this.castle.alive && this.eco.pawns.length >= 3;
  }
}
