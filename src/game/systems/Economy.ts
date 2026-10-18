import Phaser from 'phaser';
import {
  NEW_VILLAGER, REPAIR, VEIN_YIELD, VEIN_CHARGES, HIRE_COST, HIRE_TIME_MS,
} from '../constants';
import {
  RESOURCES, BUILDING_PLANS, BUILD_SPOTS, TOOL_BY_RESOURCE,
  type PawnKind, type PawnWeapon, type ResourceKind, type ResourceCost, type BuildingKind,
  PAWN_NAMES, PAWN_NAMES_RU, garrisonSourceOf,
} from '../data';
import { Pawn } from '../entities/Pawn';
import { Building } from '../entities/Building';
import { ResourceNode } from '../entities/ResourceNode';
import { PawnAI } from './PawnAI';
import { HealerAI } from './HealerAI';
import { Monastery } from './Monastery';
import { audio } from './Audio';
import { lang } from '../../i18n';
import { track } from '../../platform/analytics';

// ============ Экономика поселения (TZ §B) ============
//
// Оркестратор: тикает пешек, ресурсные узлы, стройку, ремонт, найм, обитель.
// Никакой логики пешек в GameScene — только создание Economy и подписки.

export interface EconomyEvents {
  change: void;                    // изменился склад (HUD)
  garrison: void;                  // изменился гарнизон (HUD)
  built: { kind: BuildingKind; first: boolean };
  feed: { text: string; color?: string };
  pawnDied: { pawn: Pawn };
  pawnWounded: { pawn: Pawn };
  pawnArrived: { pawn: Pawn };
  repairDone: { building: Building };
  hireDone: { weapon: PawnWeapon };
  /** inMonastery — раненый выписан именно из обители (задание «Обитель милосердия» §H.17). */
  pawnSaved: { pawn: Pawn; inMonastery?: boolean };
}

interface BuildJob {
  spot: { kind: BuildingKind; x: number; y: number };
  building: Building;
  progress: number;   // мс
  pawn: Pawn | null;
  /** Телеметрия §K.2 (economy_stuck): job висит, а стройка не растёт. */
  ageMs?: number;
  stuckReported?: boolean;
}

interface RepairJob {
  building: Building;
  progress: number;
  pawn: Pawn | null;
  rebuild: boolean;
}

interface HireJob {
  building: Building;
  weapon: PawnWeapon;
  progress: number;
}

/** Нормализованные множители мета-модификаторов (см. EconomyOpts). */
interface Tune {
  pawnSpeed: number;
  workSpeed: number;
  buildCost: number;
  houseCost: number;
  buildTime: number;
  hireCost: number;
  bowMonkCost: number;
  hireTime: number;
  veinYield: number;
  sheepYield: number;
  woodYield: number;
  garrisonHp: number;
  garrisonBonus: number;
  barracksBonus: number;
  buildingHp: number;
  houseHp: number;
  healHps: number;
  healWood: number;
  repairCost: number;
  veinCharges: number;
  meatDisabled: boolean;
  hireDisabled: boolean;
  repairDisabled: boolean;
  monasterySlots: number | null;
  extraHouseSpots: number;
  endless: boolean;
}

export interface EconomyOpts {
  castleX: number;
  castleY: number;
  /** Начисление опыта/очков за завершение стройки (§H.6) */
  onBuildComplete?: (kind: BuildingKind, x: number, y: number) => void;
  onRepairComplete?: () => void;
  /** DoT горения идёт через Settlement — потолок осады и таунт (§E.4.2) */
  onBurnDamage?: (b: Building, amount: number) => void;
  /** Разрушение здания → Settlement (обитель убивает раненых, §G.5) */
  onBuildingDestroyed?: (b: Building) => void;

  // ---- Мета-модификаторы рана (фазы Q/S, §H.16–H.18, A2, §J.6.2) ----
  /** «Торопливые ноги» / «Суровая зима»: скорость пешек. */
  pawnSpeedMult?: number;
  /** «Умелые топоры» + расходник «Дар лесника»: скорость работы у ресурса. */
  workSpeedMult?: number;
  /** «Скидки казны» / «Чёрный рынок»: цены построек. */
  buildCostMult?: number;
  /** «Суровая зима»: дом ×0.8 (A2). */
  houseCostMult?: number;
  /** «Каменный век»: время стройки ×1.3 (A2). */
  buildTimeMult?: number;
  /** «Сытые вербовщики»: цена наёма воинов. */
  hireCostMult?: number;
  /** «Верный конёк»: лучник/монах дополнительно к hireCostMult. */
  bowMonkCostMult?: number;
  /** «Наёмная гильдия»: время вербовки ×0.625. */
  hireTimeMult?: number;
  /** «Золотая жила» / сезон «Мировая золотая лихорадка»: руда с жилы. */
  veinYieldMult?: number;
  /** «Пастбище»: мясо овцы. */
  sheepYieldMult?: number;
  /** Указ «Засуха» (§H.17): дерево ×0.7. */
  woodYieldMult?: number;
  /** Расходник «Военный горн» (§J.6.2): HP гарнизона ×1.25 (слоты не расширяет). */
  garrisonHpMult?: number;
  /** «Ополчение»: +1 слот военных глобально. */
  garrisonSlotsBonus?: number;
  /** «Знамя дружины»: +1 слот мечников на казармы. */
  barracksSlotsBonus?: number;
  /** «Каменные стены» / «Каменный век» / «Хрупкая инфраструктура»: HP зданий. */
  buildingHpMult?: number;
  /** «Неприступный дом»: HP домов. */
  houseHpMult?: number;
  /** «Чистые перевязи»: лечение обители +3 HP/с. */
  healHpsBonus?: number;
  /** «Братья-целители»: монах +2 HP/с (ставится в HealerAI.hpsBonus). */
  monkHpsBonus?: number;
  /** «Бережные руки» (+ «Чума» ×2): дерево за лечение. */
  healWoodMult?: number;
  /** «Сметливые ремонтники»: ремонт ×0.75. */
  repairCostMult?: number;
  /** Контракт «Голодный год» (§H.9): мясо не добывается. */
  meatDisabled?: boolean;
  /** Указ «Одиночка» (§H.17): наём военных недоступен. */
  hireDisabled?: boolean;
  /** Контракт «Без ремонта» (§H.9): ремонт/восстановление запрещён. */
  repairDisabled?: boolean;
  /** Указ «Тишина монастыря» (§H.17): мест лечения 5 вместо 10. */
  monasterySlots?: number;
  /** «Шестое пятно» + бесконечный режим: доп. пятна под дома (§H.12 — +4). */
  extraHouseSpots?: number;
  /** Бесконечный режим (§H.12): жилы восстанавливаются раз в 5 минут. */
  endless?: boolean;
  /** «Золотая лихорадка» (A2): заряды жилы 4 → 8. */
  veinCharges?: number;
}

export class Economy extends Phaser.Events.EventEmitter {
  readonly scene: Phaser.Scene;
  readonly castleX: number;
  readonly castleY: number;
  resources: Record<ResourceKind, number> = { wood: 0, ore: 0, meat: 0 };
  pawns: Pawn[] = [];
  nodes: ResourceNode[] = [];
  buildings: Building[] = [];
  /** Занятые пятна стройки: ключ «x:y» → building kind. */
  private usedSpots = new Set<string>();
  /** Активные стройки (читает PawnAI для плана дефицита §B.6). */
  buildJobs: BuildJob[] = [];
  repairJobs: RepairJob[] = [];
  private hireJobs: HireJob[] = [];
  /** Очередь новых жителей (25 сек, §E.5). */
  private respawnQueue: number[] = [];
  private firstHouseBuilt = false;
  /** Карточки поселения (§H.5). */
  settlementLevels: Record<string, number> = {};
  private pawnAI: PawnAI;
  private healerAI: HealerAI;
  private opts: EconomyOpts;
  /** Сводка рана (§K.2): суммарное HP лечения пешек и спасённые обители. */
  healHpTotal = 0;
  monasteryHealed = 0;
  /** Модификаторы рана (читаются системами домена: Monastery и др.). */
  readonly tune: Tune;
  /** Бесконечный режим: накопитель 5-минутного восстановления жил (§H.12). */
  private veinRegenAcc = 0;

  constructor(scene: Phaser.Scene, opts: EconomyOpts) {
    super();
    this.scene = scene;
    this.opts = opts;
    this.castleX = opts.castleX;
    this.castleY = opts.castleY;
    this.tune = {
      pawnSpeed: opts.pawnSpeedMult ?? 1,
      workSpeed: opts.workSpeedMult ?? 1,
      buildCost: opts.buildCostMult ?? 1,
      houseCost: opts.houseCostMult ?? 1,
      buildTime: opts.buildTimeMult ?? 1,
      hireCost: opts.hireCostMult ?? 1,
      bowMonkCost: opts.bowMonkCostMult ?? 1,
      hireTime: opts.hireTimeMult ?? 1,
      veinYield: opts.veinYieldMult ?? 1,
      sheepYield: opts.sheepYieldMult ?? 1,
      woodYield: opts.woodYieldMult ?? 1,
      garrisonHp: opts.garrisonHpMult ?? 1,
      garrisonBonus: opts.garrisonSlotsBonus ?? 0,
      barracksBonus: opts.barracksSlotsBonus ?? 0,
      buildingHp: opts.buildingHpMult ?? 1,
      houseHp: opts.houseHpMult ?? 1,
      healHps: opts.healHpsBonus ?? 0,
      healWood: opts.healWoodMult ?? 1,
      repairCost: opts.repairCostMult ?? 1,
      veinCharges: opts.veinCharges ?? VEIN_CHARGES,
      meatDisabled: opts.meatDisabled === true,
      hireDisabled: opts.hireDisabled === true,
      repairDisabled: opts.repairDisabled === true,
      monasterySlots: opts.monasterySlots ?? null,
      extraHouseSpots: opts.extraHouseSpots ?? 0,
      endless: opts.endless === true,
    };
    // «Братья-целители» — статический бонус HealerAI: поле читается в
    // fieldHealTick, вызываемом из PawnAI (§H.16)
    HealerAI.hpsBonus = opts.monkHpsBonus ?? 0;
    this.pawnAI = new PawnAI(scene, this);
    this.healerAI = new HealerAI(this);
    this.monastery = new Monastery(this);
  }

  /** Система обители (§G.10): места, лечение, выписка. */
  readonly monastery: Monastery;

  // ---------- Лимиты ----------

  get houses(): number {
    return this.buildings.filter((b) => b.kind === 'house' && b.alive && !b.underConstruction).length;
  }

  /** Лимит рабочих: 4 + 1 за каждый дом (§B.2), «Вече» +1 (§H.5). */
  get pawnLimit(): number {
    return 4 + this.houses + (this.card('assembly') > 0 ? 1 : 0);
  }

  get civilians(): Pawn[] {
    return this.pawns.filter((p) => p.cls === 'civilian' && !p.dead);
  }

  get garrison(): Pawn[] {
    return this.pawns.filter((p) => p.cls === 'garrison' && !p.dead);
  }

  /**
 * Слоты гарнизона от ОДНОГО источника (§B.2).
 *
 * ⚠️ Лимит считается по ЗДАНИЮ-ИСТОЧНИКУ, а не по типу оружия. У казарм
 * общий пул на мечника и копейщика (`fighter{sword}` **или**
 * `fighter{lance}`, максимум 2) — иначе одна казарма давала 2 + 2 = 4 воина
 * и правило «потолок гарнизона» переставало работать.
 */
  garrisonLimit(source: Building['kind'], weapon?: PawnWeapon): number {
    let n = 0;
    for (const b of this.buildings) {
      if (!b.alive || b.underConstruction || b.kind !== source) continue;
      if (source === 'barracks') n += 2 + this.tune.barracksBonus;
      else if (source === 'archery') n += 2;
      else if (source === 'monastery') n += 1;
    }
    if (n > 0) n += this.tune.garrisonBonus;
    void weapon;
    return n;
  }

  /** Здание, выпускающее воина данного типа (§F.6). */
  static sourceOf(weapon: PawnWeapon): Building['kind'] {
    return garrisonSourceOf(weapon);
  }

  /** Воины, занимающие слоты источника: живые + уже оплаченные и идущие. */
  private occupiedSlots(source: Building['kind'], weapon: PawnWeapon): number {
    const live = this.garrison.filter((p) => {
      if (source === 'barracks') return p.weapon === 'sword' || p.weapon === 'lance';
      return p.weapon === weapon;
    }).length;
    // ⚠️ Незавершённый найм тоже занимает слот. Без этого игрок успевал
    // оплатить N воинов подряд, пока первый ещё вербовался, и получал отряд
    // сверх лимита, заплатив за каждого.
    const pending = this.hireJobs.filter((j) => j.building.kind === source).length;
    return live + pending;
  }

  /** Всего слотов гарнизона во всех источниках — для HUD (§B.2). */
  totalGarrisonSlots(): number {
    return this.garrisonLimit('barracks') + this.garrisonLimit('archery') + this.garrisonLimit('monastery');
  }

  /** Занято слотов по источнику (живые + вербуются). Для плана расхода. */
  hireSlotUse(weapon: PawnWeapon): number {
    const source = Economy.sourceOf(weapon);
    return this.occupiedSlots(source, weapon);
  }

  // ---------- Старт ----------

  /** 4 стартовые пешки: 2 сборщика, строитель, ремонтник (§B.2).
   *  «Дополнительный сборщик» (§H.16) добавляет ещё — вызвать после. */
  spawnInitial(): void {
    this.spawnPawn('collector');
    this.spawnPawn('collector');
    this.spawnPawn('builder');
    this.spawnPawn('repairer');
  }

  /** Применяет мета-бусты к созданной пешке (§H.16, §J.6.2). */
  private applyPawnTuning(pawn: Pawn): void {
    // «Торопливые ноги» / «Суровая зима»: скорость пешек
    if (this.tune.pawnSpeed !== 1) pawn.speed = Math.round(pawn.speed * this.tune.pawnSpeed);
    // «Военный горн» (§J.6.2): +25% HP гарнизона — слоты не расширяет
    if (this.tune.garrisonHp !== 1 && pawn.cls === 'garrison') {
      pawn.maxHp = Math.round(pawn.maxHp * this.tune.garrisonHp);
      pawn.hp = pawn.maxHp;
    }
  }

  spawnPawn(kind: PawnKind, nearX?: number, nearY?: number, announce = true): Pawn | null {
    if (kind !== 'fighter' && kind !== 'healer' && this.civilians.length >= this.pawnLimit) return null;
    const female = Math.random() < 0.5;
    // Имена по языку (Приложение A1): RU-пул для русской локали
    const book = lang() === 'ru' ? PAWN_NAMES_RU : PAWN_NAMES;
    const pool = book[female ? 'female' : 'male'];
    const name = pool[Math.floor(Math.random() * pool.length)];
    // Слоты мечника и копейщика общие (одни казармы), сравнивать их лимиты
    // бессмысленно — берём мечника как базовый подтип гарнизона (§B.2).
    const weapon = kind === 'fighter' ? 'sword'
      : kind === 'healer' ? 'staff' : undefined;
    const a = Math.random() * Math.PI * 2;
    const r = 90 + Math.random() * 60;
    const px = (nearX ?? this.castleX) + Math.cos(a) * r;
    const py = (nearY ?? this.castleY) + Math.sin(a) * r;
    const pawn = new Pawn(this.scene, px, py, kind, name, female, weapon);
    this.applyPawnTuning(pawn);
    this.pawns.push(pawn);
    if (announce) {
      this.emit('pawnArrived', { pawn });
    }
    return pawn;
  }

  /** Пешка по типу оружия (для преемственности §F). */
  spawnFighter(weapon: PawnWeapon, announce = false): Pawn {
    const female = Math.random() < 0.5;
    const book = lang() === 'ru' ? PAWN_NAMES_RU : PAWN_NAMES;
    const pool = book[female ? 'female' : 'male'];
    const name = pool[Math.floor(Math.random() * pool.length)];
    const pawn = new Pawn(this.scene, this.castleX + Phaser.Math.Between(-70, 70), this.castleY + Phaser.Math.Between(60, 110), 'fighter', name, female, weapon);
    this.applyPawnTuning(pawn);
    this.pawns.push(pawn);
    if (announce) this.emit('pawnArrived', { pawn });
    return pawn;
  }

  // ---------- Ресурсы ----------

  canAfford(cost: ResourceCost): boolean {
    return (this.resources.wood >= (cost.wood ?? 0))
      && (this.resources.ore >= (cost.ore ?? 0))
      && (this.resources.meat >= (cost.meat ?? 0));
  }

  spend(cost: ResourceCost): boolean {
    if (!this.canAfford(cost)) return false;
    this.resources.wood -= cost.wood ?? 0;
    this.resources.ore -= cost.ore ?? 0;
    this.resources.meat -= cost.meat ?? 0;
    this.emit('change');
    return true;
  }

  /**
   * Списание частичного объёма дерева (обительное лечение, §G.3/§G.10).
   *
   * `spend()` требует полного покрытия остатка, а лечение берёт дробное
   * дерево каждый кадр: при 0.013 дерева на кадр и запасе 0.01 обычный
   * `spend()` отказал бы в списании. Возвращает фактически списанное.
   */
  spendWoodPartial(amount: number): number {
    const take = Math.min(this.resources.wood, Math.max(0, amount));
    if (take <= 0) return 0;
    this.resources.wood -= take;
    this.emit('change');
    return take;
  }

  /** Сдача добычи на склад — единственная точка роста ресурсов (§B.5). */
  deposit(kind: ResourceKind, amount: number): void {
    this.resources[kind] += amount;
    audio.play('pickup');
    this.emit('change');
  }

  // ---------- Ресурсные узлы ----------

  registerNode(node: ResourceNode): void {
    this.nodes.push(node);
  }

  /** Свободный узел ресурса (не занят другой пешкой).
   *  Сбор ограничен радиусом от замка — пешки работают на виду у базы (§B.9). */
  freeNode(res: ResourceKind, from: Pawn): ResourceNode | null {
    // Контракт «Голодный год» (§H.9): мясо не добывается
    if (this.tune.meatDisabled && res === 'meat') return null;
    let best: ResourceNode | null = null;
    let bestD = Infinity;
    for (const n of this.nodes) {
      if (!n.alive || n.res !== res) continue;
      if (n.claimedBy && n.claimedBy !== from) continue;
      if (Math.hypot(n.x - this.castleX, n.y - this.castleY) > 1000) continue;
      const d = (n.x - from.x) ** 2 + (n.y - from.y) ** 2;
      if (d < bestD) { bestD = d; best = n; }
    }
    return best;
  }

  /**
 * Узел по потребности: `score = max(0, план − склад) / max(1, dist)` (§B.6).
 *
 * ⚠️ Раньше план строился ТОЛЬКО из активных строек и ремонта. Когда таких не
 * было (а в начале матча их нет), дефицит у всех узлов оказывался 0, все
 * оценки равнялись 0, а `bestScore` стартовал с −1 — выигрывал первый узел в
 * массиве, то есть сборщик шёл «куда попало». §B.6 требует: при отсутствии
 * плана расхода СОБИРАТЬ идёт к БЛИЖАЙШЕМУ доступному узлу.
 */
  bestNodeByDemand(from: Pawn): ResourceNode | null {
    const target: Record<ResourceKind, number> = { wood: 0, ore: 0, meat: 0 };
    // План расхода: активные стройки + ремонт + лечение
    for (const j of this.buildJobs) {
      for (const [k, v] of Object.entries(BUILDING_PLANS[j.spot.kind].cost)) {
        target[k as ResourceKind] += v;
      }
    }
    for (const j of this.repairJobs) target.wood += j.rebuild ? REPAIR.REBUILD_WOOD : REPAIR.WOOD;
    const planned = target.wood + target.ore + target.meat;
    if (planned <= 0) return this.nearestFreeNode(from);

    let best: ResourceNode | null = null;
    let bestScore = -1;
    for (const n of this.nodes) {
      if (!n.alive || (n.claimedBy && n.claimedBy !== from)) continue;
      if (n.claimedBy === from) return n; // уже наш узел
      if (Math.hypot(n.x - this.castleX, n.y - this.castleY) > 1000) continue;
      // Контракт «Голодный год» (§H.9): мясо не добывается
      if (this.tune.meatDisabled && n.res === 'meat') continue;
      const deficit = Math.max(0, target[n.res] - this.resources[n.res]);
      const dist = Math.max(60, Math.hypot(n.x - from.x, n.y - from.y));
      const score = deficit / dist;
      if (score > bestScore) { bestScore = score; best = n; }
    }
    // Ничего не нужно и ни один узел не выгоден — идём за ближайшим, как
    // требует приказ СОБИРАТЬ, а не стоим столбом.
    return bestScore > 0 ? best : this.nearestFreeNode(from);
  }

  /** Ближайший доступный узел любого типа (§B.6, приказ СОБИРАТЬ). */
  nearestFreeNode(from: Pawn): ResourceNode | null {
    let best: ResourceNode | null = null;
    let bestD = Infinity;
    for (const n of this.nodes) {
      if (!n.alive) continue;
      if (n.claimedBy && n.claimedBy !== from) continue;
      if (this.tune.meatDisabled && n.res === 'meat') continue;
      if (Math.hypot(n.x - this.castleX, n.y - this.castleY) > 1000) continue;
      const d = (n.x - from.x) ** 2 + (n.y - from.y) ** 2;
      if (d < bestD) { bestD = d; best = n; }
    }
    return best;
  }

  // ---------- Стройка ----------

  /** Дополнительные пятна домов (§H.16 «Шестое пятно», §H.12 — +4 дома). */
  private extraSpots(): Array<{ kind: BuildingKind; dx: number; dy: number }> {
    const pts: Array<{ dx: number; dy: number }> = [
      { dx: -380, dy: 260 },
      { dx: -440, dy: -100 },
      { dx: 500, dy: 180 },
      { dx: 160, dy: -320 },
      { dx: -600, dy: 140 },
    ];
    const out: Array<{ kind: BuildingKind; dx: number; dy: number }> = [];
    for (let i = 0; i < this.tune.extraHouseSpots && i < pts.length; i++) {
      out.push({ kind: 'house', ...pts[i] });
    }
    return out;
  }

  spotFor(kind: BuildingKind): { x: number; y: number } | null {
    for (const s of [...BUILD_SPOTS, ...this.extraSpots()]) {
      if (s.kind !== kind) continue;
      const key = `${this.castleX + s.dx}:${this.castleY + s.dy}`;
      if (!this.usedSpots.has(key)) {
        // Место свободно физически (нет здания)
        return { x: this.castleX + s.dx, y: this.castleY + s.dy };
      }
    }
    return null;
  }

  isSpotUsed(x: number, y: number): boolean {
    return this.usedSpots.has(`${x}:${y}`);
  }

  markSpot(x: number, y: number): void {
    this.usedSpots.add(`${x}:${y}`);
  }

  freeSpots(): Array<{ kind: BuildingKind; x: number; y: number }> {
    const out: Array<{ kind: BuildingKind; x: number; y: number }> = [];
    for (const s of [...BUILD_SPOTS, ...this.extraSpots()]) {
      const x = this.castleX + s.dx, y = this.castleY + s.dy;
      if (!this.usedSpots.has(`${x}:${y}`)) out.push({ kind: s.kind, x, y });
    }
    return out;
  }

  /** Стоимость постройки с мета-модификаторами: «Скидки казны» (§H.16),
   *  «Чёрный рынок» ×1.5 (§H.9), «Суровая зима» — дом ×0.8 (A2). */
  buildingCost(kind: BuildingKind): ResourceCost {
    const plan = BUILDING_PLANS[kind];
    const m = this.tune.buildCost * (kind === 'house' ? this.tune.houseCost : 1);
    const out: ResourceCost = {};
    if (plan.cost.wood) out.wood = Math.round(plan.cost.wood * m);
    if (plan.cost.ore) out.ore = Math.round(plan.cost.ore * m);
    if (plan.cost.meat) out.meat = Math.round(plan.cost.meat * m);
    return out;
  }

  /**
   * Заложить стройку: spend() в момент СТАРТА (§D.2 — не по завершении),
   * здание появляется недостроенным, строитель играет pawny-work-hammer.
   */
  tryStartBuild(kind: BuildingKind, pawn: Pawn): boolean {
    const plan = BUILDING_PLANS[kind];
    const spot = this.spotFor(kind);
    if (!spot) return false;
    if (!this.spend(this.buildingCost(kind))) return false;
    const tex = plan.sprites
      ? plan.sprites[Phaser.Math.Between(0, plan.sprites.length - 1)]
      : kind;
    const scale = kind === 'castle' ? 0.9 : kind === 'house' ? 0.8 : 0.85;
    // HP зданий: «Каменные стены»/«Неприступный дом» (§H.16), «Каменный век»
    // и «Хрупкая инфраструктура» (A2, §H.17); места обители — указ «Тишина монастыря»
    const b = new Building(this.scene, spot.x, spot.y, kind, tex, scale, {
      onDamaged: () => {},
      // Полное разрушение освобождает пятно стройки (обитель — §G.5.2);
      // руины остаются на пятне — его восстанавливает ремонтник.
      onDestroyed: (bb, ruins) => {
        if (!ruins) this.usedSpots.delete(`${bb.x}:${bb.y}`);
        this.opts.onBuildingDestroyed?.(bb);
      },
      onMonasteryFalling: () => {},
    }, {
      // HP зданий: карта «Каменное зодчество» +15%/ур. (§H.5), мета-эффекты
      hpMult: this.tune.buildingHp * (1 + 0.15 * this.card('masonry')),
      houseMult: this.tune.houseHp * (1 + 0.15 * this.card('masonry')),
      // Места лечения — только монастырю (указ «Тишина монастыря» §H.17)
      slots: kind === 'monastery' ? (this.tune.monasterySlots ?? undefined) : undefined,
    });
    b.underConstruction = true;
    b.hp = 0;
    b.setScale(scale, 0.02);
    this.markSpot(spot.x, spot.y);
    this.buildings.push(b);
    this.buildJobs.push({ spot: { kind, x: spot.x, y: spot.y }, building: b, progress: 0, pawn });
    if (pawn) pawn.workNode = b;
    return true;
  }

  // ---------- Ремонт ----------

  /** Ремонт/восстановление. Замок не чинится (§B.4), строящееся — не «повреждено».
   *  Контракт «Без ремонта» (§H.9) запрещает оба сценария. */
  repair(building: Building, pawn: Pawn | null): boolean {
    if (this.tune.repairDisabled) return false;
    if (!building.alive || building.kind === 'castle' || building.plan.noRepair) return false;
    if (building.underConstruction && building.hp > 0) return false;
    if (this.buildJobs.some((j) => j.building === building)) return false; // ещё строится
    if (this.repairJobs.some((j) => j.building === building)) return false;
    const rebuild = building.hp <= 0;
    // «Сметливые ремонтники» (§H.16): стоимость ремонта ×0.75
    const wood = Math.round((rebuild ? REPAIR.REBUILD_WOOD : REPAIR.WOOD) * this.tune.repairCost);
    if (!this.spend({ wood })) return false;
    building.underConstruction = true;
    if (rebuild) building.setScale(building.scaleX, 0.02);
    this.repairJobs.push({ building, progress: 0, pawn, rebuild });
    if (pawn) pawn.workNode = building;
    return true;
  }

  finishRepairInstant(): boolean {
    const j = this.repairJobs[0];
    if (!j) return false;
    j.building.hp = j.building.maxHp;
    j.building.underConstruction = false;
    j.building.setScale(j.building.scaleX, j.building.scaleX);
    if (j.pawn) j.pawn.workNode = null;
    this.repairJobs.shift();
    this.emit('repairDone', { building: j.building });
    return true;
  }

  get activeRepair(): RepairJob | null {
    return this.repairJobs[0] ?? null;
  }

  // ---------- Найм гарнизона (§B.9.1) ----------

  /** Цена найма с множителями: «Сытые вербовщики» — воины, «Верный конёк» —
   *  лучник/монах дополнительно (§H.16). */
  hireCost(weapon: PawnWeapon): ResourceCost {
    const m = this.tune.hireCost
      * (weapon === 'bow' || weapon === 'staff' ? this.tune.bowMonkCost : 1);
    const base = HIRE_COST[weapon];
    const out: ResourceCost = {};
    if (base.wood) out.wood = Math.round(base.wood * m);
    if (base.ore) out.ore = Math.round(base.ore * m);
    if (base.meat) out.meat = Math.round(base.meat * m);
    return out;
  }

  canHire(weapon: PawnWeapon): boolean {
    // Указ «Одиночка» (§H.17): военные юниты недоступны
    if (this.tune.hireDisabled) return false;
    const source = Economy.sourceOf(weapon);
    return this.occupiedSlots(source, weapon) < this.garrisonLimit(source, weapon)
      && this.canAfford(this.hireCost(weapon));
  }

  hire(weapon: PawnWeapon, building: Building): boolean {
    if (!building.alive || building.kind !== Economy.sourceOf(weapon)) return false;
    if (!this.canHire(weapon)) return false;
    if (!this.spend(this.hireCost(weapon))) return false;
    this.hireJobs.push({ building, weapon, progress: 0 });
    return true;
  }

  // ---------- Карточки поселения (§H.5) ----------

  card(id: string): number {
    return this.settlementLevels[id] ?? 0;
  }

  applySettlementCard(id: string): void {
    this.settlementLevels[id] = Math.min(2, this.card(id) + 1);
    // «Каменное зодчество» (§H.5): +15% макс. HP всем живым зданиям —
    // карта берётся после первого дома, постройки до неё тоже растут
    if (id === 'masonry') {
      for (const b of this.buildings) {
        if (!b.alive) continue;
        const old = b.maxHp;
        b.maxHp = Math.max(1, Math.round(b.maxHp * 1.15));
        b.hp += b.maxHp - old;
      }
    }
  }

  // ---------- Пешки: урон/смерть/восстановление ----------

  /** Враг ранит пешку: wounded → в монастырь, без места — bleeding (§G.3). */
  woundPawn(pawn: Pawn, dmg: number, now: number): boolean {
    const wounded = pawn.takeDamage(dmg, now);
    if (!wounded) return false;
    this.emit('pawnWounded', { pawn });
    return true;
  }

  /** Окончательная гибель пешки (bleedout/обрушение/бой — см. Settlement).
   *  Погибший житель запускает восстановление §E.5: новый через 25 сек,
   *  10 дерева + 3 мяса, при свободном доме.
   *
   *  ⚠️ `paid` = false для УХОДА из-за потери жилья (§B.4): избыток населения
   *  «уходит», это не смерть. Раньше эмигрант попадал в очередь respawn и
   *  игрок платил 10 дерева + 3 мяса за замену ушедшему добровольно.
   *  Сообщество при такой трактовке теряло смысл: сжигал дома — платил. */
  removePawn(pawn: Pawn, paid = true): void {
    pawn.killFinal();
    pawn.monasterySlot = null;
    const i = this.pawns.indexOf(pawn);
    if (i >= 0) this.pawns.splice(i, 1);
    pawn.destroy();
    if (paid && pawn.cls === 'civilian') this.queueRespawn();
    this.emit('pawnDied', { pawn });
  }

  /** Новые жители приходят через 25 сек при свободном доме (§E.5). */
  queueRespawn(): void {
    this.respawnQueue.push(NEW_VILLAGER.DELAY * 1000);
  }

  // ---------- Тик ----------

  tick(dtMs: number, now: number): void {

    // Стройка: прогресс идёт, только если строитель у места и работает
    for (let i = this.buildJobs.length - 1; i >= 0; i--) {
      const j = this.buildJobs[i];
      const p = j.pawn;
      const working = p && !p.dead && p.state === 'work'
        && Math.hypot(p.x - j.spot.x, p.y - j.spot.y) < 90;
      if (working) {
        // Застрявшая стройка (§B.9, §K.2): job висит >45 c, а прогресс <25% —
        // сигнал телеметрии (дебаг-гейт Economy.debugLog).
        j.ageMs = (j.ageMs ?? 0) + dtMs;
        if (!j.stuckReported && j.ageMs > 45000
          && j.progress < BUILDING_PLANS[j.spot.kind].timeMs * 0.25) {
          j.stuckReported = true;
          track('economy_stuck', { kind: j.spot.kind, t_sec: Math.round(j.ageMs / 1000) });
        }
        // «Каменный век» (A2): время стройки ×1.3 — учтено в tune.buildTime
        j.progress += dtMs / this.tune.buildTime;
        if (j.progress >= BUILDING_PLANS[j.spot.kind].timeMs) {
          j.building.finishConstruction();
          this.buildJobs.splice(i, 1);
          if (p) p.workNode = null;
          const first = j.spot.kind === 'house' && !this.firstHouseBuilt;
          if (first) {
            this.firstHouseBuilt = true;
            // Первый дом дарит жителя бесплатно (§E.5)
            const v = this.spawnPawn('collector', j.spot.x, j.spot.y + 40);
            void v;
          }
          this.emit('built', { kind: j.spot.kind, first });
          this.opts.onBuildComplete?.(j.spot.kind, j.spot.x, j.spot.y);
        }
      }
    }

    // Ремонт
    for (let i = this.repairJobs.length - 1; i >= 0; i--) {
      const j = this.repairJobs[i];
      const p = j.pawn;
      const working = p && !p.dead && p.state === 'work'
        && Math.hypot(p.x - j.building.x, p.y - j.building.y) < 100;
      if (working) {
        j.progress += dtMs;
        const need = j.rebuild ? REPAIR.REBUILD_MS : REPAIR.MS;
        if (j.progress >= need) {
          j.building.hp = j.building.maxHp;
          j.building.underConstruction = false;
          j.building.warnedReset();
          j.building.setAlpha(1);
          j.building.clearTint();
          if (j.rebuild) j.building.finishConstruction();
          else j.building.setScale(j.building.scaleX, j.building.scaleX);
          if (p) p.workNode = null;
          this.repairJobs.splice(i, 1);
          this.emit('repairDone', { building: j.building });
        }
      }
    }

    // Найм
    for (let i = this.hireJobs.length - 1; i >= 0; i--) {
      const j = this.hireJobs[i];
      if (!j.building.alive) { this.hireJobs.splice(i, 1); continue; }
      j.progress += dtMs;
      // «Наёмная гильдия» (§H.16): вербовка быстрее
      if (j.progress >= HIRE_TIME_MS[j.weapon] * this.tune.hireTime) {
        this.hireJobs.splice(i, 1);
        const pawn = j.weapon === 'staff'
          ? this.spawnHealer()
          : this.spawnFighter(j.weapon);
        if (pawn) this.emit('hireDone', { weapon: j.weapon });
      }
    }

    // Новые жители: 25 сек + 10 дерева + 3 мяса при свободном доме (§E.5).
    // 0 домов — новых пешек нет (осознанная спираль поражения №3);
    // не хватает ресурсов — таймер откладывается на 5 сек (копим на жителя).
    for (let i = this.respawnQueue.length - 1; i >= 0; i--) {
      this.respawnQueue[i] -= dtMs;
      if (this.respawnQueue[i] <= 0) {
        this.respawnQueue.splice(i, 1);
        if (this.houses > 0 && this.civilians.length < this.pawnLimit) {
          const cost: ResourceCost = { wood: NEW_VILLAGER.wood, meat: NEW_VILLAGER.meat };
          if (this.spend(cost)) {
            const kind: PawnKind = this.civilians.filter((p) => p.kind === 'collector').length
              <= this.civilians.filter((p) => p.kind !== 'collector').length
              ? 'collector' : (this.civilians.some((p) => p.kind === 'builder') ? 'repairer' : 'builder');
            this.spawnPawn(kind);
          } else {
            this.respawnQueue.push(5000);
          }
        }
      }
    }

    // Горение зданий: DoT через Settlement — потолок осады и таунт (§E.4.2)
    for (const b of this.buildings) {
      if (!b.alive) continue;
      const dot = b.tickBurn(dtMs);
      if (dot > 0) {
        if (this.opts.onBurnDamage) this.opts.onBurnDamage(b, dot);
        else b.damage(dot, b.lastSiegeIdx);
      }
    }

    // Пешки. «Умелые топоры»/«Дар лесника» (§H.16, §J.6.2): тик у ресурса
    // идёт с множителем — пешка в состоянии work над узлом не двигается,
    // поэтому инфляция dtMs ускоряет только работу.
    const workSpeed = this.tune.workSpeed;
    for (const p of [...this.pawns]) {
      if (p.dead || !p.active) continue;
      if (p.cls === 'civilian') {
        const atNode = workSpeed !== 1 && p.state === 'work' && p.workNode !== null
          && (p.workNode as { res?: unknown }).res !== undefined;
        this.pawnAI.updateCivilian(p, atNode ? dtMs * workSpeed : dtMs, now);
      } else this.pawnAI.updateCombat(p, dtMs, now);
    }

    // Назначение целей монахам (система, не сам монах — §B.7.2)
    this.healerAI.update(now);

    // Бесконечный режим (§H.12): жилы восстанавливаются раз в 5 минут —
    // единственное место игры с регенерацией
    if (this.tune.endless) {
      this.veinRegenAcc += dtMs;
      if (this.veinRegenAcc >= 300_000) {
        this.veinRegenAcc = 0;
        for (const n of this.nodes) n.recharge();
      }
    }

    // Уборка мёртвых узлов
    if (this.nodes.length > 64) {
      this.nodes = this.nodes.filter((n) => n.alive);
    }
  }

  spawnHealer(): Pawn | null {
    return this.spawnPawn('healer', this.castleX, this.castleY + 80);
  }

  workYield(res: ResourceKind): number {
    const base = RESOURCES[res].yieldPerCycle;
    // Дерево: «Засуха» ×0.7 (§H.17); мясо: «Пастбище» (§H.16);
    // руда: «Золотая жила»/сезон «Золотая лихорадка мира» (§H.16, §H.18)
    if (res === 'wood') return Math.max(1, Math.round(base * (1 + 0.2 * this.card('forestry')) * this.tune.woodYield));
    if (res === 'meat') return Math.max(1, Math.round(base * (this.card('provisions') > 0 ? 4 / 3 : 1) * this.tune.sheepYield));
    return Math.max(1, Math.round(base * this.tune.veinYield));
  }

  veinCharges(): number {
    return this.tune.veinCharges + (this.card('deepmines') > 0 ? 1 : 0);
  }

  veinYield(): number {
    return Math.round(VEIN_YIELD * this.tune.veinYield);
  }

  toolFor(res: ResourceKind): 'axe' | 'knife' | 'pickaxe' {
    return TOOL_BY_RESOURCE[res];
  }

  /** Обитель: ближайший живой монастырь (делегирует системе Monastery, §G.10). */
  nearestMonastery(from: Pawn): Building | null {
    return this.monastery.nearest(from);
  }

  totalHealSlots(): number {
    return this.monastery.totalSlots();
  }

  usedHealSlots(): number {
    return this.monastery.usedSlots();
  }

  /** Лечение в обители — доменные правила в системе Monastery (§G.10). */
  monasteryHealTick(dtMs: number): void {
    this.monastery.healTick(dtMs);
  }
}
