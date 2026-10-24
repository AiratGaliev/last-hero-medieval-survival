import Phaser from 'phaser';
import { AGGRO, GARRISON, RETREAT_HP, KITE, HEALER, BLEEDOUT_SEC, REPAIR, WORLD } from '../constants';
import { RESOURCES, FIGHTERS, BUILDING_PLANS, garrisonSourceOf, type BuildingKind, type ResourceKind } from '../data';
import { t } from '../../i18n';
import { track } from '../../platform/analytics';
import { HealerAI } from './HealerAI';
import type { Economy } from './Economy';
import type { Pawn } from '../entities/Pawn';
import type { Building } from '../entities/Building';
import type { ResourceNode } from '../entities/ResourceNode';
import type { Enemy } from '../entities/Enemy';
import { COMBAT_TIMING } from './Combat';
import { SpatialHash } from './SpatialHash';

// ============ AI пешки (TZ §B.6, §B.7) ============
//
// Раздельные ветки: civilianAI() — каждый кадр (экономика + паника),
// combatAI() — свой тик 150 мс с фолбэком до 250 мс (§B.7.1). Выбор ветки
// по PawnClass, не по флагу. Приоритеты автоповедения — §B.6.

export interface PawnAICtx {
  /** Живые враги (для паники и боя). */
  enemies(): Enemy[];
  /** Позиция героя (приказ СЛЕДОВАТЬ). */
  playerX(): number;
  playerY(): number;
  /** Атака врага пешкой: KILL растёт, комбо игрока — нет (§B.7.1). */
  pawnAttackEnemy(enemy: Enemy, dmg: number, weapon: 'sword' | 'lance' | 'bow'): void;
  /** Стрела лучника NPC. */
  shootArrow(from: Pawn, target: Enemy): void;
  /** Здание, которое сейчас бьёт осада (для таунта). */
  besiegedBuilding(): Building | null;
  /** Состояние героя — цель полевого лечения монаха (§B.7.2). */
  hero(): { hp: number; maxHp: number; x: number; y: number } | null;
  /** Date-seeded RNG for deterministic daily challenge pawn routing. */
  random?: () => number;
  randomInt?: (min: number, max: number) => number;
}

const RANGE_WOOD = 46;

export class PawnAI {
  private scene: Phaser.Scene;
  private eco: Economy;
  private ctx: PawnAICtx;
  /** Снимок живых врагов на текущий кадр: не создаём новый массив для каждого NPC. */
  private readonly enemySnapshot: Enemy[] = [];
  /** Индекс угроз для локальных проверок рабочих и ресурсных узлов. */
  private readonly enemySpatialHash = new SpatialHash<Enemy>(260);
  private readonly nearbyEnemyScratch: Enemy[] = [];
  /** Аккумулятор тика combatAI — строго на каждого воина (§B.7.1). */
  private combatAcc = new Map<Pawn, number>();
  private curTickMs: number = GARRISON.TICK_MS;
  /** Пункты патруля гарнизона. */
  private patrolPoints = new Map<Pawn, { x: number; y: number }>();
  private patrolSwap = new Map<Pawn, number>();

  constructor(scene: Phaser.Scene, eco: Economy) {
    this.scene = scene;
    this.eco = eco;
    // Контекст подкидывает GameScene после создания систем (buildSystems);
    // чтение ленивое — в buildWorld сцены реестра ещё нет.
    this.ctx = (scene.registry.get('tss-pawnai-ctx') ?? null) as PawnAICtx;
  }

  /** Контекст подкидывает GameScene после создания (разрыв цикла импорта). */
  setCtx(ctx: PawnAICtx): void {
    this.ctx = ctx;
    this.scene.registry.set('tss-pawnai-ctx', ctx);
  }

  /** Ленивое чтение контекста: реестр мог заполниться после конструктора. */
  private get c(): PawnAICtx {
    if (!this.ctx) {
      this.ctx = (this.scene.registry.get('tss-pawnai-ctx') ?? null) as PawnAICtx;
    }
    return this.ctx;
  }

  /** Обновить единый снимок и spatial hash один раз перед тиками всех пешек. */
  refreshEnemySnapshot(): void {
    this.enemySnapshot.length = 0;
    for (const enemy of this.c.enemies()) {
      if (enemy.active && !enemy.dead) this.enemySnapshot.push(enemy);
    }
    this.enemySpatialHash.rebuild(this.enemySnapshot);
  }

  private random(): number {
    return this.c.random?.() ?? Math.random();
  }

  private randomInt(min: number, max: number): number {
    return this.c.randomInt?.(min, max) ?? Phaser.Math.Between(min, max);
  }

  // ================= ГРАЖДАНСКИЕ (каждый кадр) =================

  updateCivilian(p: Pawn, dtMs: number, _now: number): void {
    const eco = this.eco;

    // Не прерываем двухсекундное появление первого бесплатного жителя (§E.5).
    if (p.arrivalMs > 0) {
      p.arrivalMs = Math.max(0, p.arrivalMs - dtMs);
      p.state = 'walk';
      p.playMove(true);
      p.setVelocity(0, 0);
      return;
    }
    p.cooldown = Math.max(0, p.cooldown - dtMs / 1000);

    // --- Раненая / истекающая кровью — важнее любой работы (§G.3) ---
    if (p.state === 'wounded' || p.state === 'bleeding') {
      this.woundedTick(p, dtMs);
      return;
    }

    // Прямой приказ «ОТДЫХАТЬ» и критически низкое HP обходят короткий
    // cooldown. Сначала сохраняем груз: он доставляется до начала восстановления.
    const recoveryRequired = p.state === 'retreat'
      || p.state === 'resting'
      || p.order === 'rest'
      || p.hp <= p.maxHp * RETREAT_HP;

    // --- Кулдаун между обычными задачами ---
    if (p.cooldown > 0 && !recoveryRequired) {
      p.playMove(false);
      p.setVelocity(0, 0);
      return;
    }

    // --- 1. carrying → донести до склада (абсолютный приоритет, §B.6) ---
    if (p.carrying) {
      const d = Phaser.Math.Distance.Between(p.x, p.y, eco.castleX, eco.castleY);
      if (d < 120) {
        eco.deposit(p.carrying, p.carriedAmount);
        p.carrying = null;
        p.carriedAmount = 0;
        p.cooldown = 0.5;
        if (p.order === 'collect') p.order = null; // приказ выполнен (сброс после задачи)
      } else {
        // Перенос добычи — самостоятельная фаза FSM, а не idle с анимацией ходьбы.
        p.state = 'walk';
        this.walkTo(p, eco.castleX, eco.castleY, dtMs);
      }
      return;
    }

    // Гражданский не должен работать до потери последних HP. Он прерывает
    // работу, освобождает ресурсный узел, добирается до безопасной постройки,
    // лечится и возвращается к работе без потери оплаченных строительных jobs.
    if (this.updateCivilianRecovery(p, dtMs)) return;

    // Узел мог исчезнуть между тиками: освобождаем устаревшую цель,
    // но не трогаем build/repair jobs (у Building нет boolean available).
    const currentNode = p.workNode as ResourceNode | null;
    if (currentNode && typeof currentNode.available === 'boolean' && !currentNode.available) {
      currentNode.release(p);
      p.workNode = null;
      p.taskProgress = 0;
      if (p.state === 'work') {
        p.state = 'idle';
        p.setVelocity(0, 0);
      }
    }

    // --- 2. Враг рядом → паника, бег к замку (§A.5, PANIC 220) ---
    if (this.shouldFlee(p)) {
      p.state = 'flee';
      this.walkTo(p, eco.castleX, eco.castleY, dtMs);
      return;
    }

    // Уже оплаченная стройка или ремонт закреплены за пешкой до завершения.
    // Ранее эти jobs продолжались только в отдельных ветках builder/repairer
    // или при приказе BUILD: помощник-сборщик по карте «Вече» возвращался к
    // обычному сбору на следующем тике, оставляя оплаченный job незавершённым.
    const activeBuildJob = eco.buildJobs.find((job) => job.pawn === p);
    if (activeBuildJob) {
      const d = Phaser.Math.Distance.Between(p.x, p.y, activeBuildJob.spot.x, activeBuildJob.spot.y);
      if (d < 90) {
        p.state = 'work';
        p.playWork('hammer');
        p.setVelocity(0, 0);
      } else {
        p.state = 'walk';
        this.walkTo(p, activeBuildJob.spot.x, activeBuildJob.spot.y, dtMs);
      }
      return;
    }

    const activeRepairJob = eco.repairJobs.find((job) => job.pawn === p);
    if (activeRepairJob) {
      const d = Phaser.Math.Distance.Between(p.x, p.y, activeRepairJob.building.x, activeRepairJob.building.y);
      if (d < 100) {
        p.state = 'work';
        p.playWork('hammer');
        p.setVelocity(0, 0);
      } else {
        p.state = 'walk';
        this.walkTo(p, activeRepairJob.building.x, activeRepairJob.building.y, dtMs);
      }
      return;
    }

    // --- 3. Приказы игрока (перебивают автоприоритеты, §B.6) ---
    if (p.order === 'build') {
      const spot = this.nearestFreeSpot(p);
      if (spot) {
        if (Phaser.Math.Distance.Between(p.x, p.y, spot.x, spot.y) < 70) {
          if (eco.tryStartBuild(spot.kind, p, spot)) {
            p.state = 'work';
            p.taskProgress = 0;
            return;
          }
          p.order = null;
        } else {
          p.state = 'walk';
          this.walkTo(p, spot.x, spot.y, dtMs);
          return;
        }
      } else {
        p.order = null; // мест нет — приказ снимается
      }
    }
    if (p.order === 'repair') {
      const b = this.mostDamagedBuilding();
      if (b && eco.repair(b, p)) {
        p.state = 'work';
        p.taskProgress = 0;
        // The job now owns this pawn; the one-shot command is consumed.
        // updateCivilian() resumes the active repair job independently of order.
        p.order = null;
        return;
      }
      this.eco.emit('feed', {
        text: t(b ? 'building.cannot' : 'order.repairNoTarget'),
        color: '#ffd76e',
      });
      p.order = null;
    }
    if (p.order === 'collect') {
      const node = eco.bestNodeByDemand(p) ?? eco.freeNode('wood', p);
      if (node) {
        this.gotoNode(p, node, dtMs);
        return;
      }
      p.order = null;
    }

    // --- 4. Строитель: свободное место + хватает ресурсов → строить ---
    // ⚠️ Сначала продолжаем НАЧАТУЮ стройку — иначе строитель закладывал бы
    // новое здание каждый кадр (двойное списание, риск §D.2).
    if (p.kind === 'builder') {
      const spot = this.pickBuildSpot(p);
      // ⚠️ Раньше здесь был фолбэк «крупное здание не по карману → дом».
      // Он ломал план поселения: строитель всегда уходил строить дом и
      // казармы (нужны для преемственности, §F.3) не появлялись НИКОГДА.
      // Теперь порядок задаёт Economy.nextBuildKind(), а если цель ещё
      // недоступна по деньгам — строитель копит под неё (target ниже).
      const target = spot;
      if (target) {
        const cost = BUILDING_PLANS[target.kind].cost;
        const afford = eco.resources.wood >= (cost.wood ?? 0) && eco.resources.ore >= (cost.ore ?? 0);
        if (afford) {
          if (Phaser.Math.Distance.Between(p.x, p.y, target.x, target.y) < 70) {
            if (eco.tryStartBuild(target.kind, p, target)) {
              p.state = 'work';
              p.taskProgress = 0;
            }
            return;
          }
          p.state = 'walk';
          this.walkTo(p, target.x, target.y, dtMs);
          return;
        }
      }

      // Если строить нельзя из-за нехватки ресурсов или свободных пятен больше
      // нет, строитель возвращается к сбору; иначе фаза E может застрять в idle.
      const required = target ? BUILDING_PLANS[target.kind].cost : undefined;
      const node = this.pickNodeFor(p, required);
      if (node) {
        this.gotoNode(p, node, dtMs);
        return;
      }
    }

    // --- 5. Ремонтник: повреждённое здание (активировано фазой L) ---
    if (p.kind === 'repairer') {
      const b = this.mostDamagedBuilding();
      if (b && eco.resources.wood >= 30 && eco.repair(b, p)) {
        p.state = 'work';
        p.taskProgress = 0;
        return;
      }
    }

    // --- 5.5 «Вече» (§H.5): при дефиците рабочие рук стройка/ремонт
    // приоритетнее сбора. Сборщик подключается молотком, когда строитель/
    // ремонтник уже заняты, а работы ещё остались (+1 лимит — в Economy).
    if (p.kind === 'collector' && this.eco.card('assembly') > 0) {
      const freeSpot = this.pickBuildSpot(p);
      if (freeSpot) {
        const cost = BUILDING_PLANS[freeSpot.kind].cost;
        const afford = this.eco.resources.wood >= (cost.wood ?? 0)
          && this.eco.resources.ore >= (cost.ore ?? 0);
        const buildersBusy = this.eco.buildJobs.filter((j) => j.pawn).length;
        const builderAlive = this.eco.pawns.some((x) => x.kind === 'builder' && !x.dead);
        // Дефицит рук: строитель есть и занят, либо его вообще нет
        if (afford && (!builderAlive || buildersBusy >= 1)
          && Phaser.Math.Distance.Between(p.x, p.y, freeSpot.x, freeSpot.y) < 400) {
          if (Phaser.Math.Distance.Between(p.x, p.y, freeSpot.x, freeSpot.y) < 70) {
            if (this.eco.tryStartBuild(freeSpot.kind, p, freeSpot)) {
              p.state = 'work';
              p.taskProgress = 0;
              return;
            }
          } else {
            p.state = 'walk';
            this.walkTo(p, freeSpot.x, freeSpot.y, dtMs);
            return;
          }
        }
      }
      const damaged = this.mostDamagedBuilding();
      if (damaged && this.eco.resources.wood >= 30) {
        const repairersBusy = this.eco.repairJobs.filter((j) => j.pawn).length;
        const repairerAlive = this.eco.pawns.some((x) => x.kind === 'repairer' && !x.dead);
        if ((!repairerAlive || repairersBusy >= 1) && this.eco.repair(damaged, p)) {
          p.state = 'work';
          p.taskProgress = 0;
          return;
        }
      }
    }

    // --- 6. Сборщик: узел по потребности (§B.6) + обход врагов ---
    if (p.kind === 'collector') {
      const node = this.pickNodeFor(p);
      if (node) {
        this.gotoNode(p, node, dtMs);
        return;
      }
    }

    // --- 7. idle у замка ---
    p.state = 'idle';
    const idleD = Phaser.Math.Distance.Between(p.x, p.y, eco.castleX, eco.castleY);
    if (idleD > 220) this.walkTo(p, eco.castleX, eco.castleY, dtMs);
    else { p.playMove(false); p.setVelocity(0, 0); }
  }

  /** Идти к узлу → работать → нести (общая ветка сборки/приказа). */
  private gotoNode(p: Pawn, node: ResourceNode, dtMs: number): void {
    if (!node.available) { node.release(p); p.workNode = null; p.state = 'idle'; return; }
    const d = Phaser.Math.Distance.Between(p.x, p.y, node.x, node.y);
    if (d > (node.kind === 'tree' || node.kind === 'sheep' ? RANGE_WOOD : 52)) {
      p.state = 'walk';
      node.release(p);
      p.workNode = null;
      this.walkTo(p, node.x, node.y, dtMs);
      return;
    }
    // Работа: claim + тики
    if (!node.claim(p)) {
      p.workNode = null;
      p.state = 'idle';
      return;
    }
    p.workNode = node;
    p.state = 'work';
    const def = RESOURCES[node.res];
    // Ветеран 3★ работает на 10% быстрее (§H.2)
    p.taskProgress += dtMs * (p.workSpeedMult ?? 1);
    p.playWork(this.eco.toolFor(node.res));
    p.setVelocity(0, 0);
    if (p.taskProgress >= def.workMs * def.ticksPerCycle) {
      p.taskProgress = 0;
      p.workNode = null;
      node.extract();
      node.release(p);
      // Жила не исчезает сразу: добыча уходит даже на последнем цикле
      p.carrying = node.res;
      p.carriedAmount = this.eco.workYield(node.res);
      p.state = 'carry';
      p.cooldown = 0.1;
    }
  }

  /**
   * Узел для сборщика в автоповедении: дефицит/дистанция (§B.6) со штрафом
   * за врагов рядом — иначе сборщик идёт в гущу толпы и цикл сбора
   * превращается в беготню.
   *
   * Формула — ровно из спецификации: `max(0, план − склад) / max(1, dist)`.
   * Раньше здесь стоял `Math.max(0.5, план − склад × 0.5)`: из-за нижней
   * границы 0.5 и «половинного» склада узел с ИЗБЫТКОМ ресурса всегда
   * набирал положительную оценку и обгонял далёкий действительно нужный —
   * ровно тот тупик, от которого предостерегает §B.6 («ближайший порождал
   * тупик: сборщик бесконечно таскал ненужное мясо, пока горят дома»).
   * Нужды нет → возвращаем null, и пешка уходит на IdlePoint (§B.6 п.6).
   */
  private pickNodeFor(p: Pawn, minimums?: Partial<Record<ResourceKind, number>>): ResourceNode | null {
    const eco = this.eco;
    // Дефицит: план расхода (стройки/ремонт/лечение/наём) против склада.
    //
    // ⚠️ Раньше здесь стоял жёсткий базовый план `{ wood: 30, ore: 15, meat: 3 }`
    // и НЕ учитывалась цель автостройки. Из-за этого руда под казармы никогда
    // не добывалась (дефицит руды был 15 против 30 дерева, и сборщики
    // бесконечно таскали дерево), а после исчерпания базового плана все
    // оценки становились нулевыми и сборщик вообще вставал. Теперь план
    // расхода — это цель следующей постройки плюс активные стройки, ремонты
    // и найм (§B.6: «target — план расхода»).
    const target: Record<string, number> = { wood: 0, ore: 0, meat: 3 };
    // План автостройки: цель и следующий шаг (§B.6 «target — план расхода»).
    // Если такая стройка уже заложена, её цена учтена ниже по списку.
    const plannedCost = eco.plannedBuildCost();
    const plannedKind = eco.nextBuildKind();
    if (plannedKind && !eco.buildJobs.some((j) => j.spot.kind === plannedKind)) {
      for (const [k, v] of Object.entries(plannedCost)) {
        target[k] = (target[k] ?? 0) + v;
      }
    }
    for (const j of eco.buildJobs) {
      for (const [k, v] of Object.entries(BUILDING_PLANS[j.spot.kind].cost)) {
        target[k] += v;
      }
    }
    for (const j of eco.repairJobs) target.wood += j.rebuild ? REPAIR.REBUILD_WOOD : REPAIR.WOOD;
    // Запланированный найм гарнизона — тоже часть плана расхода (§B.9.1)
    for (const weapon of ['sword', 'lance', 'bow', 'staff'] as const) {
      const h = eco.garrisonLimit(garrisonSourceOf(weapon)) - eco.hireSlotUse(weapon);
      if (h <= 0) continue;
      for (const [k, v] of Object.entries(eco.hireCost(weapon))) {
        target[k] = (target[k] ?? 0) + v;
      }
    }
    // При fallback строителя повышаем целевой запас до стоимости его следующей
    // постройки, даже когда общий план спроса на ресурс уже выполнен.
    for (const key of ['wood', 'ore', 'meat'] as const) {
      const required = minimums?.[key];
      if (required !== undefined) target[key] = Math.max(target[key] ?? 0, required);
    }
    let best: ResourceNode | null = null;
    let bestScore = 0;
    for (const n of eco.nodes) {
      if (!n.available || (n.claimedBy && n.claimedBy !== p)) continue;
      if (Math.hypot(n.x - eco.castleX, n.y - eco.castleY) > 1000) continue;
      if (n.claimedBy === p) return n;
      if (eco.tune.meatDisabled && n.res === 'meat') continue;
      const deficit = Math.max(0, target[n.res] - eco.resources[n.res]);
      const dist = Math.max(60, Math.hypot(n.x - p.x, n.y - p.y));
      let score = deficit / dist;
      // Смотрим только соседние ячейки вместо полного прохода по всем врагам.
      const nearby = this.enemySpatialHash.query(n.x, n.y, 260, this.nearbyEnemyScratch);
      for (const e of nearby) {
        if (!e.active || e.dead) continue;
        const dx = e.x - n.x;
        const dy = e.y - n.y;
        if (dx * dx + dy * dy < 260 * 260) { score *= 0.05; break; }
      }
      if (score > bestScore) { bestScore = score; best = n; }
    }
    return best;
  }

  private nearestFreeSpot(p: Pawn): { kind: BuildingKind; x: number; y: number } | null {
    const spots = this.eco.freeSpots();
    let best: { kind: BuildingKind; x: number; y: number } | null = null;
    let bestD = Infinity;
    for (const s of spots) {
      const d = (s.x - p.x) ** 2 + (s.y - p.y) ** 2;
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  /**
   * Пятно для автостройки строителя — по плану поселения (TZ §B.4, §B.9).
   *
   *  Порядок задаёт Economy.nextBuildKind(): сначала дом (цель первой
   *  минуты), потом казармы (страховка от смерти героя), затем остальные
   *  дома, обитель, башня и тир. Прежний порядок «крупное пятно первым»
   *  держал строителя в ожидании руды до 107-й секунды матча, а дом
   *  не появлялся вообще.
   */
  private pickBuildSpot(p: Pawn): { kind: BuildingKind; x: number; y: number } | null {
    const spots = this.eco.freeSpots();
    const kind = this.eco.nextBuildKind();
    if (kind) {
      const spot = spots.find((s) => s.kind === kind);
      if (spot) return spot;
    }
    // Пятна нужного вида кончились (или план исчерпан) — берём ближайшее.
    return this.nearestFreeSpot(p);
  }

  private mostDamagedBuilding(): Building | null {
    let best: Building | null = null;
    let bestFrac = 1;
    let bestIsRuins = false;
    for (const b of this.eco.buildings) {
      if (!b.alive || b.kind === 'castle' || b.plan.noRepair || b.collapsePending) continue;
      // Активная стройка не является целью ремонта. Руины тоже помечены
      // underConstruction, но у них нет buildJob и hp=0 — их надо восстановить.
      if (this.eco.buildJobs.some((job) => job.building === b)) continue;
      const isRuins = b.hp <= 0;
      if (b.underConstruction && !isRuins) continue;
      if (isRuins) {
        // Восстановление руин приоритетнее починки повреждённого здания.
        if (!bestIsRuins) {
          best = b;
          bestFrac = -1;
          bestIsRuins = true;
        }
        continue;
      }
      if (bestIsRuins) continue;
      const frac = b.hp / b.maxHp;
      if (frac < 1 && frac < bestFrac) { bestFrac = frac; best = b; }
    }
    return best;
  }

  // ================= РАНЕНЫЙ → ОБИТЕЛЬ (§G.3) =================

  /** Раненый идёт в монастырь; нет места — bleeding 45 сек у ворот. */
  private woundedTick(p: Pawn, dtMs: number): void {
    const eco = this.eco;
    const mon = eco.nearestMonastery(p);
    if (p.state === 'bleeding') {
      // Без очереди: кровоточащая пешка самостоятельно пробует занять место
      // только при новом доступном слоте. Это реализует §G.3: освобождение
      // койки или достройка монастыря спасает NPC до истечения 45 секунд.
      // Если монастырь только появился далеко от ворот, пешка хромает к нему,
      // пока таймер продолжает идти.
      if (mon) {
        const distance = Phaser.Math.Distance.Between(p.x, p.y, mon.x, mon.y);
        if (distance < 110) {
          const slot = mon.claimHealSlot(p);
          if (slot !== null) {
            p.monasterySlot = slot;
            p.monasteryBuilding = mon;
            p.state = 'wounded';
            p.bleedTimer = 0;
            p.updateStarBadge();
            p.playMove(false);
            p.setVelocity(0, 0);
            return;
          }
          p.playMove(false);
          p.setVelocity(0, 0);
        } else {
          this.walkTo(p, mon.x, mon.y, dtMs, 0.55);
        }
      } else {
        // До появления монастыря кровоточащий лежит там, где его настигло
        // ранение; у ворот замка — если лечебницы ещё нет.
        p.playMove(false);
        p.setVelocity(0, 0);
      }
      p.bleedTimer -= dtMs / 1000;
      p.updateStarBadge();
      if (p.bleedTimer <= 0) {
        // Окончательная гибель (§G.3)
        eco.removePawn(p);
      }
      return;
    }
    // В монастыре состояние остаётся wounded до полного лечения. Повторная
    // резервация на каждом AI-тике занимала несколько коек одной пешкой.
    if (p.monasterySlot !== null) {
      const owner = p.monasteryBuilding;
      if (owner?.alive && owner.kind === 'monastery'
        && owner.healSlots[p.monasterySlot] === p) {
        p.playMove(false);
        p.setVelocity(0, 0);
        return;
      }
      // Удалённый/освобождённый слот больше не принадлежит пешке.
      p.monasterySlot = null;
      p.monasteryBuilding = null;
    }
    // state === 'wounded'
    if (!mon) {
      // Монастыря нет вообще → сразу bleeding у ЗАМКА (§G.3)
      this.toBleeding(p);
      this.bleedStep(p, eco.castleX, eco.castleY, dtMs);
      return;
    }
    const d = Phaser.Math.Distance.Between(p.x, p.y, mon.x, mon.y);
    if (d < 110) {
      const slot = mon.claimHealSlot(p);
      if (slot === null) {
        // ⚠️ Именной анонс обязателен (§G.3 / §G.11 п.23): раньше он
        // вызывался ТОЛЬКО при отсутствии монастыря, и переполнение
        // обители происходило молча — игрок не понимал, кого он теряет.
        this.toBleeding(p);
      } else {
        p.monasterySlot = slot;
        p.monasteryBuilding = mon;
        p.state = 'wounded'; // лечится внутри; monasteryHealTick поднимет
        p.playMove(false);
        p.setVelocity(0, 0);
      }
    } else {
      this.walkTo(p, mon.x, mon.y, dtMs, 0.55); // хромая, медленнее
    }
  }

  /** Вход в состояние истечения кровью: таймер, именной анонс, телеметрия. */
  private toBleeding(p: Pawn): void {
    p.state = 'bleeding';
    p.bleedTimer = this.bleedoutSec();
    this.eco.emit('feed', {
      text: t('pawn.bleeding', { v: p.name, s: Math.ceil(p.bleedTimer) }),
      color: '#ff6655',
    });
    const monasteryExists = this.eco.nearestMonastery(p) !== null;
    track('pawn_bleeding_start', {
      name_role: `${p.kind}:${p.name}`,
      cause: monasteryExists ? 'no_free_slot' : 'no_monastery',
      monastery_exists: monasteryExists,
      slots_free: this.eco.freeMonasterySlots(),
    });
    p.updateStarBadge();
  }

  /** 45 сек, +15 с картой «Полевой лекарь» (§G.3 / §H.5). */
  private bleedoutSec(): number {
    return BLEEDOUT_SEC + 15 * this.eco.card('fieldmedic');
  }

  /** Доводит истекающего до ворот (у монастыря — уже там, у замка — нет). */
  private bleedStep(p: Pawn, x: number, y: number, dtMs: number): void {
    if (Phaser.Math.Distance.Between(p.x, p.y, x, y) > 60) {
      this.walkTo(p, x, y, dtMs, 0.6);
    } else {
      p.playMove(false);
      p.setVelocity(0, 0);
    }
  }

  // ================= ГАРНИЗОН (тик 150 мс) =================

  updateCombat(p: Pawn, dtMs: number, now: number): void {
    // Логика состояний — по собственному тику каждого воина (§B.7.1); движение
    // — каждый кадр. Аккумулятор обязан быть ПЕР-ЮНИТОМ: общий на всех
    // отдавал одно 150-миллисекундное окно первому попавшему, и при двух
    // воинах первый думал вдвое чаще второго — с ростом гарнизона тайминг
    // боя становился всё более неровным.
    //
    // Сначала выбираем актуальное окно, а уже потом сравниваем с аккумулятором.
    // В старом порядке условие проверялось по 150 мс, но при FPS<40 из
    // аккумулятора вычиталось 250 мс: получалось отрицательное время и первый
    // боевой тик запускался раньше окна, а следующий — позже.
    const fps = this.scene.game.loop.actualFps;
    this.curTickMs = fps < 40 ? GARRISON.TICK_FALLBACK_MS : GARRISON.TICK_MS;
    const tickMs = this.curTickMs;
    const acc = (this.combatAcc.get(p) ?? 0) + Math.max(0, dtMs);
    if (acc >= tickMs) {
      // Отнимаем ровно одно окно, сохраняя остаток для следующего тика.
      this.combatAcc.set(p, acc - tickMs);
      this.combatThink(p, now, tickMs);
    } else {
      this.combatAcc.set(p, acc);
    }
    this.combatMove(p, dtMs);
  }

  private combatThink(p: Pawn, now: number, tickMs: number): void {
    const eco = this.eco;
    // ⚠️ dtMs обязан быть реальным: раньше сюда передавался 0, и таймер
    // истечения кровью у гарнизона не уменьшался НИКОГДА — раненый воин был
    // бессмертным (§G.3).
    if (p.state === 'wounded' || p.state === 'bleeding') { this.woundedTick(p, tickMs); return; }

    // Отступление при HP < 35%: к монастырю/замку, слот не занимает (§B.7.1)
    if (p.state !== 'retreat' && p.hp < p.maxHp * RETREAT_HP) {
      p.state = 'retreat';
      p.attackCd = 0;
      p.cancelPendingAttack();
      p.attackRecoveryMs = 0;
      p.chargeTarget = null;
      p.chargeWindup = 0;
      p.taskProgress = 0;
      // Телеметрия §K.2: отступление гарнизона
      track('garrison_retreat', { weapon: p.weapon ?? 'sword', hp_pct: Math.round((p.hp / p.maxHp) * 100) });
    }
    if (p.state === 'retreat') {
      // Поле лечения монаха может поднять — тогда вернётся в строй
      if (p.hp >= p.maxHp * 0.7) { p.state = 'idle'; return; }
      // Отход к обители (а её нет — к замку). Без явного walkTo воин сохранял
      // скорость последнего боя и уезжал дальше, ПРЯМО в врага: у Arcade-тела
      // нет ни гравитации, ни трения, и тормозит только явный setVelocity(0,0).
      const mon = eco.nearestMonastery(p);
      const rx = mon ? mon.x : eco.castleX;
      const ry = mon ? mon.y : eco.castleY;
      const away = this.nearestEnemy(p, 200);
      let tx = rx, ty = ry;
      if (away) {
        // Если враг между воином и обителью — обходим вбок от него.
        const dx = rx - p.x, dy = ry - p.y;
        const len = Math.max(1, Math.hypot(dx, dy));
        const px = -dy / len, py = dx / len;
        tx = p.x + dx * 0.4 + px * 160;
        ty = p.y + dy * 0.4 + py * 160;
      }
      this.walkTo(p, tx, ty, tickMs, 1.05);
      return;
    }

    // Attack cooldown advances during windup/recovery as well as while moving.
    p.attackCd = Math.max(0, p.attackCd - tickMs);


    if (p.attackPending) {
      p.setVelocity(0, 0);
      return;
    }
    if (p.attackRecoveryMs > 0) {
      p.attackRecoveryMs = Math.max(0, p.attackRecoveryMs - tickMs);
      p.setVelocity(0, 0);
      return;
    }
    // Не перезаписываем скорость копейщика во время рывка.
    if (p.weapon === 'lance' && p.taskProgress > 0) return;



    const enemies = this.enemySnapshot;

    // Монах: полевое лечение работает ВСЕГДА (§B.6 — приказы СЛЕДОВАТЬ /
    // НА ПОСТ / ДЕРЖАТЬ тоже лечат, иначе приказ полностью обессценивает
    // единственного лекаря). Проверяем ДО веток приказов.
    if (p.kind === 'healer') {
      if (p.healTarget && (p.healTarget.dead || !p.healTarget.active)) p.healTarget = null;
      if (p.healTarget) {
        const tgt = p.healTarget;
        const d = Phaser.Math.Distance.Between(p.x, p.y, tgt.x, tgt.y);
        if (d > HEALER.RADIUS * 0.5) this.walkTo(p, tgt.x, tgt.y, tickMs, 1.1);
        else { p.playMove(false); p.setVelocity(0, 0); }
        HealerAI.fieldHealTick(p, tgt, tickMs, eco);
        return;
      }
      // Герой — полноправная цель полевого лечения (§B.7.2, §B.6 «СЛЕДОВАТЬ»)
      if (p.healHeroPoint) {
        const hero = this.c.hero();
        if (!hero || hero.hp >= hero.maxHp) { p.healHeroPoint = null; }
        else {
          const d = Phaser.Math.Distance.Between(p.x, p.y, hero.x, hero.y);
          if (d > HEALER.RADIUS * 0.5) this.walkTo(p, hero.x, hero.y, tickMs, 1.1);
          else { p.playMove(false); p.setVelocity(0, 0); }
          HealerAI.fieldHealHeroTick(p, tickMs, hero);
          return;
        }
      }
    }

    // Приказы гарнизону держатся до отмены (§B.6)
    if (p.order === 'hold' && p.orderTarget) {
      this.fightAround(p, enemies, p.orderTarget.x, p.orderTarget.y, 120, now, true);
      return;
    }
    if (p.order === 'follow') {
      this.fightAround(p, enemies, this.c.playerX(), this.c.playerY(), 160, now, false);
      return;
    }
    if (p.order === 'post') {
      const post = this.postPoint(p);
      this.fightAround(p, enemies, post.x, post.y, 160, now, false);
      return;
    }
    if (p.order === 'monastery' && p.kind === 'healer') {
      // Режим обители: остаётся у здания, не вступает в бой (§B.7.2).
      const mon = eco.nearestMonastery(p);
      if (mon) this.fightAround(p, enemies, mon.x, mon.y, 140, now, false);
      return;
    }

    // Монах по умолчанию следует за фронтом, оставаясь за своим воином.
    // Он не выбирает врагов как цель и никогда не входит в state='fight'.
    if (p.kind === 'healer') {
      const point = this.healerFollowPoint(p, enemies);
      if (Phaser.Math.Distance.Between(p.x, p.y, point.x, point.y) <= 14) {
        p.state = 'idle';
        p.playMove(false);
        p.setVelocity(0, 0);
      } else {
        p.state = 'walk';
        this.walkTo(p, point.x, point.y, tickMs);
      }
      return;
    }

    // Лучник использует свой пост даже в автономном режиме: выбор цели,
    // кайтинг и поводок не должны отличаться от ручного приказа «НА ПОСТ».
    if (p.weapon === 'bow') {
      const post = this.postPoint(p);
      this.fightAround(p, enemies, post.x, post.y, 160, now, false);
      return;
    }

    // Автоповедение: враг в радиусе 700 px от поселения → fight (§B.6)
    const sx = eco.castleX, sy = eco.castleY;

    let target: Enemy | null = null;
    let bestD: number = GARRISON.RALLY;
    for (const e of enemies) {
      if (!e.active || e.dead) continue;
      const d = Math.hypot(e.x - sx, e.y - sy);
      if (d < bestD) { bestD = d; target = e; }
    }
    // Перехват (§B.7.1): враг выбрал целью пешку или идёт к стене — ближайший
    // воин в GARRISON.INTERCEPT перехватывает и переводит бой на себя.
    // Раньше блок срабатывал только при осаде и с завышенным радиусом 380 px.
    if (!target) {
      const besieged = this.c.besiegedBuilding();
      const markedPawn = besieged ? null : this.pawnUnderAttack(p, enemies);
      const marked = besieged ?? markedPawn;
      if (marked) {
        for (const e of enemies) {
          if (!e.active || e.dead) continue;
          // К стене: враг уже у цели профиля осады. К пешке: враг выбрал
          // её целью (§A.5, приоритет №2/№3).
          const onTarget = besieged
            ? Math.hypot(e.x - besieged.x, e.y - besieged.y) < 200
            : e.aimedPawn === markedPawn?.pawn
              || Phaser.Math.Distance.Between(e.x, e.y, marked.x, marked.y) < 60;
          if (onTarget && Phaser.Math.Distance.Between(p.x, p.y, e.x, e.y) < GARRISON.INTERCEPT) {
            target = e;
            break;
          }
        }
      }
    }
    if (target && this.withinLeash(p)) {
      // ⚠️ Поводок (§B.7.1): за 900 px от ближайшего здания бой прекращается
      // и воин возвращается к патрулю. Без этого гарнизон уводился за карту,
      // и база оставалась без защиты — ровно то, ради чего он и нанят.
      p.state = 'fight';
      this.approachAndAttack(p, target, now);
      return;
    }

    // Патруль вокруг замка: точка смены каждые 6–10 сек (§B.6)
    const swapIn = this.patrolSwap.get(p) ?? 0;
    if (now > swapIn || !this.patrolPoints.get(p)) {
      const a = this.random() * Math.PI * 2;
      const r = 120 + this.random() * 140;
      this.patrolPoints.set(p, { x: sx + Math.cos(a) * r, y: sy + Math.sin(a) * r });
      this.patrolSwap.set(p, now + this.randomInt(GARRISON.PATROL_SWAP[0], GARRISON.PATROL_SWAP[1]));
    }
    const pt = this.patrolPoints.get(p)!;
    p.state = 'walk';
    this.walkTo(p, pt.x, pt.y, tickMs);
  }

  /** Ближайшее живое здание поселения и расстояние до него. */
  private nearestBuilding(p: Pawn): Building | null {
    let best: Building | null = null;
    let bestD = Infinity;
    for (const b of this.eco.buildings) {
      if (!b.alive) continue;
      const d = Phaser.Math.Distance.Between(p.x, p.y, b.x, b.y);
      if (d < bestD) { bestD = d; best = b; }
    }
    if (!best) {
      // Замок всегда считается зданием — поводок не должен «исчезать».
      return { x: this.eco.castleX, y: this.eco.castleY } as unknown as Building;
    }
    return best;
  }

  /** В пределах поводка от ближайшего здания? (§B.7.1, GARRISON.LEASH) */
  private withinLeash(p: Pawn): boolean {
    const b = this.nearestBuilding(p);
    if (!b) return true;
    return Phaser.Math.Distance.Between(p.x, p.y, b.x, b.y) <= GARRISON.LEASH;
  }

  /** Пешка, которую враг выбрал целью, и до которой осталось немного (§B.7.1). */
  private pawnUnderAttack(self: Pawn, enemies: Enemy[]): { pawn: Pawn; x: number; y: number } | null {
    for (const e of enemies) {
      if (!e.active || e.dead) continue;
      const target = e.aimedPawn;
      if (!target || target === self || target.dead) continue;
      const d = Phaser.Math.Distance.Between(self.x, self.y, target.x, target.y);
      if (d > GARRISON.INTERCEPT * 2) continue;
      return { pawn: target, x: target.x, y: target.y };
    }
    return null;
  }

  /** Ближайший живой враг в радиусе (для обхода при отступлении). */
  private nearestEnemy(p: Pawn, r: number): Enemy | null {
    let best: Enemy | null = null;
    let bestD = r;
    for (const e of this.enemySnapshot) {
      if (!e.active || e.dead) continue;
      const d = Phaser.Math.Distance.Between(p.x, p.y, e.x, e.y);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  /** Бой вокруг точки (пост/герой/точка ДЕРЖАТЬ). */
  private fightAround(p: Pawn, enemies: Enemy[], cx: number, cy: number, keep: number, now: number, allowTaunt: boolean): void {
    void allowTaunt; // таунт читается Settlement по состоянию fight+близости
    const leashD = Math.hypot(p.x - cx, p.y - cy);

    // Поводок проверяется ДО выбора/атаки цели: лучник за 420 px обязан
    // вернуться к посту, а не продолжать стрелять и уводить врагов с базы.
    if (p.weapon === 'bow' && leashD > KITE.MAX_LEASH) {
      p.state = 'walk';
      this.walkTo(p, cx, cy, this.curTickMs);
      return;
    }

    // Гарнизонный монах выполняет приказ позиционирования, но не выбирает
    // противников и не получает состояние fight — только heal/idle/walk.
    if (p.weapon === 'staff') {
      let destinationX = cx;
      let destinationY = cy;
      if (p.order === 'follow') {
        // При явном приказе следовать не накладывается на героя: сохраняет
        // дистанцию keep с его тыльной стороны, включая нулевую начальную дистанцию.
        let dx = p.x - cx;
        let dy = p.y - cy;
        let length = Math.hypot(dx, dy);
        if (length < 1) { dx = 0; dy = -1; length = 1; }
        destinationX = cx + (dx / length) * keep;
        destinationY = cy + (dy / length) * keep;
      }
      if (Phaser.Math.Distance.Between(p.x, p.y, destinationX, destinationY) > 14) {
        p.state = 'walk';
        this.walkTo(p, destinationX, destinationY, this.curTickMs);
      } else {
        p.state = 'idle';
        p.playMove(false);
        p.setVelocity(0, 0);
      }
      return;
    }

    let target: Enemy | null = null;
    if (p.weapon === 'bow') {
      // Осадный шаман — безусловный приоритет в радиусе обороны. Штраф к
      // расстоянию был недостаточен: обычный враг всё ещё мог выигрывать.
      const priority = FIGHTERS.bow.prioritise;
      let priorityTarget: Enemy | null = null;
      let priorityD = Infinity;
      let nearestTarget: Enemy | null = null;
      let nearestD = Infinity;
      for (const e of enemies) {
        if (!e.active || e.dead) continue;
        const d = Math.hypot(e.x - cx, e.y - cy);
        if (d >= GARRISON.RALLY) continue;
        if (d < nearestD) {
          nearestD = d;
          nearestTarget = e;
        }
        if (priority && e.kind === priority && e.siege && d < priorityD) {
          priorityD = d;
          priorityTarget = e;
        }
      }
      target = priorityTarget ?? nearestTarget;
    } else {
      let bestD = Infinity;
      for (const e of enemies) {
        if (!e.active || e.dead) continue;
        const d = Math.hypot(e.x - cx, e.y - cy);
        if (d < bestD) { bestD = d; target = e; }
      }
    }

    if (target && Math.hypot(target.x - cx, target.y - cy) < GARRISON.RALLY) {
      p.state = 'fight';
      this.approachAndAttack(p, target, now);
      return;
    }
    p.state = 'idle';
    this.walkTo(p, cx + this.random() * 40 - 20, cy + this.random() * 40 - 20, this.curTickMs);
  }

  private startAttack(p: Pawn, e: Enemy, weapon: 'sword' | 'lance' | 'bow', damage: number): void {
    p.attackCd = FIGHTERS[weapon].period;
    p.attackTarget = e;
    p.attackDamage = damage;
    p.attackWeapon = weapon;
    p.attackPending = true;
    p.setFlipX(e.x < p.x);
    if (weapon !== 'bow' || p.state !== 'kite') p.setVelocity(0, 0);
    const fallbackMs = weapon === 'bow'
      ? COMBAT_TIMING.PAWN_BOW_WINDUP_MS
      : COMBAT_TIMING.PAWN_SWORD_WINDUP_MS;
    p.playAttackOnce(() => this.resolvePendingAttack(p), fallbackMs);
  }

  /** Перепроверяет цель на кадре попадания, а не при начале анимации. */
  private resolvePendingAttack(p: Pawn): void {
    if (!p.attackPending) return;
    p.attackPending = false;
    const target = p.attackTarget;
    const weapon = p.attackWeapon;
    const damage = p.attackDamage;
    p.attackTarget = null;
    p.attackWeapon = null;
    p.attackRecoveryMs = COMBAT_TIMING.PAWN_ATTACK_RECOVERY_MS;
    if (!target || !target.active || target.dead || !weapon) return;

    const d = Phaser.Math.Distance.Between(p.x, p.y, target.x, target.y);
    const radius = target.def.body.r * target.def.scale;
    const reach = weapon === 'bow' ? FIGHTERS.bow.range + 40
      : weapon === 'lance' ? 100 + radius : FIGHTERS.sword.range + radius;
    if (d > reach) return;
    if (weapon === 'bow') this.c.shootArrow(p, target);
    else this.c.pawnAttackEnemy(target, damage, weapon);
  }

  /** Сближение и атака (подтипы различаются, §B.7.1). */
  private approachAndAttack(p: Pawn, e: Enemy, now: number): void {
    const w = p.weapon ?? 'sword';
    const def = FIGHTERS[w];
    const d = Phaser.Math.Distance.Between(p.x, p.y, e.x, e.y);

    // Защитный инвариант: монах не атакует и не преследует врага даже при
    // ошибочном вызове этой функции из будущего кода (§B.7.2).
    if (w === 'staff') {
      p.state = 'idle';
      p.playMove(false);
      p.setVelocity(0, 0);
      void d;
      void now;
      return;
    }

    if (w === 'bow') {
      // Кайтинг: враг ближе 180 px — отход на 80 px, стрельба на ходу (§B.7.1)
      if (d < KITE.NEAR) {
        const nx = p.x - e.x, ny = p.y - e.y;
        const len = Math.max(1, Math.hypot(nx, ny));
        this.walkTo(p, p.x + (nx / len) * KITE.STEP, p.y + (ny / len) * KITE.STEP, this.curTickMs, 1);
        if (p.state !== 'kite') {
          // Телеметрия §K.2: кайтинг лучника
          track('garrison_kite', { weapon: 'bow', hp_pct: Math.round((p.hp / p.maxHp) * 100) });
        }
        p.state = 'kite';
      } else if (d > def.range) {
        this.walkTo(p, e.x, e.y, this.curTickMs);
        p.state = 'fight';
      } else {
        p.state = 'fight';
        p.playMove(false);
        p.setVelocity(0, 0);
      }
      if (d <= def.range + 40 && p.attackCd <= 0) {
        this.startAttack(p, e, 'bow', def.dmg);
      }
      return;
    }

    if (w === 'lance') {
      // Рывок 400 px с телеграфом 480 мс (§B.7.1)
      if (p.chargeWindup > 0) {
        p.chargeWindup -= this.curTickMs;
        p.setTint(0xff9999);
        p.setVelocity(0, 0);
        if (p.chargeWindup <= 0) {
          p.clearTint();
          const a = Math.atan2(e.y - p.y, e.x - p.x);
          const body = p.body as Phaser.Physics.Arcade.Body;
          body.setVelocity(Math.cos(a) * 430, Math.sin(a) * 430);
          p.taskProgress = 400; // остаток пути рывка
          p.chargeTarget = e;
          p.chargeDamage = def.dmg;
          p.attackCd = def.period;
          p.playAttackOnce();
        }
        return;
      }
      if (d <= 200 && d > 90 && p.attackCd <= 0) {
        p.chargeWindup = def.telegraph ?? 480;
        p.chargeTarget = e;
        p.chargeDamage = def.dmg;
        return;
      }
      if (d <= def.range && p.attackCd <= 0) {
        this.startAttack(p, e, 'lance', def.dmg);
      }
      if (d > def.range) this.walkTo(p, e.x, e.y, this.curTickMs);
      else { p.playMove(false); p.setVelocity(0, 0); }
      return;
    }

    // Мечник: держит 40 px и бьёт каждые 1.2 с (§B.7.1)
    if (d <= def.range) {
      p.state = 'fight';
      p.playMove(false);
      p.setVelocity(0, 0);
      if (p.attackCd <= 0) {
        this.startAttack(p, e, 'sword', def.dmg);
      }
    } else {
      p.state = 'fight';
      this.walkTo(p, e.x, e.y, this.curTickMs);
    }
    void now;
  }

  /** Движение рывка копья: остаток пути гасится, затем стоп. */
  private combatMove(p: Pawn, dtMs: number): void {
    const body = p.body as Phaser.Physics.Arcade.Body | null;
    if (p.taskProgress > 0 && p.weapon === 'lance' && body) {
      const target = p.chargeTarget;
      if (target && target.active && !target.dead
        && Phaser.Math.Distance.Between(p.x, p.y, target.x, target.y) <= 40 + target.def.body.r * target.def.scale) {
        this.c.pawnAttackEnemy(target, p.chargeDamage, 'lance');
        p.chargeTarget = null;
      }
      p.taskProgress -= 430 * (dtMs / 1000);
      if (p.taskProgress <= 0) {
        body.setVelocity(0, 0);
        p.taskProgress = 0;
        p.chargeTarget = null;
      }
      // Листы units/* смотрят ВПРАВО (как у героя: flipX при движении влево)
      p.setFlipX(body.velocity.x < 0);
      p.playMove(true);
      return;
    }
    void body;
  }

  // ---------- Общие утилиты ----------

  private walkTo(p: Pawn, x: number, y: number, dtMs: number, speedMult = 1): void {
    const body = p.body as Phaser.Physics.Arcade.Body;
    const dx = x - p.x, dy = y - p.y;
    const d = Math.max(1, Math.hypot(dx, dy));
    if (d < 14) {
      body.setVelocity(0, 0);
      p.playMove(false);
      return;
    }
    // «Лесничество» влияет на урожай дерева (workYield), не на скорость ходьбы
    const sp = p.speed * speedMult;
    body.setVelocity((dx / d) * sp, (dy / d) * sp);
    // Листы units/* смотрят ВПРАВО: flipX только при движении влево.
    // Прежнее dx > 0 разворачивало пешек задом наперёд (TZ §C.2 флип героя).
    p.setFlipX(dx < 0);
    p.playMove(true);
    void dtMs;
  }

  /** Безопасная точка у готового здания, которое сейчас не атакует осада. */
  /** Выбрать готовое здание, не атакуемое осадой, для укрытия гражданского. */
  private civilianShelter(p: Pawn): { building: Building | null; point: { x: number; y: number } } {
    const threatened = new Set<unknown>();
    for (const enemy of this.enemySnapshot) {
      if (enemy.active && !enemy.dead && enemy.siege && enemy.buildingTarget) {
        threatened.add(enemy.buildingTarget);
      }
    }

    let shelter: Building | null = null;
    let bestDistance = Infinity;
    for (const building of this.eco.buildings) {
      if (!building.alive || building.underConstruction || building.collapsePending
        || threatened.has(building)) continue;
      const distance = Phaser.Math.Distance.Between(p.x, p.y, building.x, building.y);
      if (distance < bestDistance) {
        shelter = building;
        bestDistance = distance;
      }
    }

    if (!shelter) {
      return {
        building: null,
        point: {
          x: Phaser.Math.Clamp(this.eco.castleX + 120, 64, WORLD.SIZE - 64),
          y: Phaser.Math.Clamp(this.eco.castleY + 120, 64, WORLD.SIZE - 64),
        },
      };
    }

    const side = p.x <= shelter.x ? -1 : 1;
    return {
      building: shelter,
      point: {
        x: Phaser.Math.Clamp(shelter.x + side * 78, 64, WORLD.SIZE - 64),
        y: Phaser.Math.Clamp(shelter.y + 58, 64, WORLD.SIZE - 64),
      },
    };
  }

  /** Автоматическое восстановление гражданского у безопасного здания. */
  private updateCivilianRecovery(p: Pawn, dtMs: number): boolean {
    const manualRest = p.order === 'rest';
    const required = manualRest || p.state === 'retreat' || p.state === 'resting'
      || p.hp <= p.maxHp * RETREAT_HP;
    if (!required) return false;

    if (p.state !== 'retreat' && p.state !== 'resting') {
      const node = p.workNode as ResourceNode | null;
      if (node && typeof node.available === 'boolean' && typeof node.release === 'function') {
        node.release(p);
        p.workNode = null;
        p.taskProgress = 0;
      }
      // Закрепляем убежище на весь цикл, чтобы не менять путь на каждом кадре.
      const selection = this.civilianShelter(p);
      p.recoveryTarget = selection.point;
      p.recoveryBuilding = selection.building;
      p.state = 'retreat';
    }

    // Если выбранное здание разрушилось/начало рушиться или стало целью осады,
    // укрытие теряет безопасность: NPC выходит из него и выбирает новое место.
    const currentBuilding = p.recoveryBuilding;
    const targetedBySiege = currentBuilding && this.enemySnapshot.some((enemy) =>
      enemy.active && !enemy.dead && enemy.siege && enemy.buildingTarget === currentBuilding,
    );
    if (currentBuilding && (!currentBuilding.alive || currentBuilding.underConstruction
      || currentBuilding.collapsePending || targetedBySiege)) {
      p.setSheltered(false);
      p.recoveryBuilding = null;
      p.recoveryTarget = null;
    }

    if (!p.recoveryTarget) {
      const selection = this.civilianShelter(p);
      p.recoveryTarget = selection.point;
      p.recoveryBuilding = selection.building;
    }
    const target = p.recoveryTarget;
    // После входа центр пешки совпадает с центром здания, а не с точкой подхода.
    // Не выталкиваем её обратно на улицу на следующем AI-тике.
    const distance = p.sheltered && p.recoveryBuilding
      ? 0
      : Phaser.Math.Distance.Between(p.x, p.y, target.x, target.y);
    if (distance > 92) {
      p.setSheltered(false);
      p.state = 'retreat';
      this.walkTo(p, target.x, target.y, dtMs, 0.95);
      return true;
    }

    p.state = 'resting';
    p.setVelocity(0, 0);
    p.playMove(false);
    if (p.recoveryBuilding) {
      // Внутри здания спрайт скрывается, физическое тело отключается, а враг
      // больше не выбирает жителя целью. Никакое лечение не отменяет разрушение.
      p.setPosition(p.recoveryBuilding.x, p.recoveryBuilding.y);
      p.setSheltered(true);
    } else {
      // Крайний fallback: если нет готового здания, отдыхать у замка, не скрывая NPC.
      p.setSheltered(false);
    }

    // Базовый отдых бесплатный и медленный; монастырь остаётся специализированной
    // лечебницей с более высокой скоростью восстановления и расходом дерева.
    p.healBy(Math.max(0, dtMs) * 3 / 1000);

    const resumeAt = manualRest ? p.maxHp : p.maxHp * 0.7;
    if (p.hp >= resumeAt) {
      const exitPoint = target;
      p.state = 'idle';
      p.setSheltered(false);
      p.recoveryTarget = null;
      p.recoveryBuilding = null;
      p.setPosition(exitPoint.x, exitPoint.y);
      if (manualRest) p.order = null;
      p.cooldown = 0.5;
    }
    return true;
  }

  /**
   * Паника гражданского (§B.2, §A.5).
   *
   *  Базовое правило: враг ближе AGGRO.PANIC — пешка бежит к замку.
   *
   *  ⚠️ **Два уточнения, без которых экономика не работала.**
   *
   *  1. **Ядро поселения** (авторизованное отклонение §A.5): гражданские
   *     внутри ядра (замок + пояс вокруг строек, `Economy.isSettlementCore`)
   *     недостижимы для обычных волн — враг их там не выбирает целью. Паниковать
   *     из-за врага, который всё равно не дойдёт, бессмысленно: толпа гоблинов
   *     у ворот вставала колом ВСЁ поселение, и экономика вставала вместе с
   *     ним (в замере первый дом не появлялся и за 3,5 минуты матча). Осада —
   *     единственный механизм угрозы базе (§D.1), поэтому от осадного врага
   *     паника сохраняется в любой точке карты.
   *
   *  2. **Враг, занятый героем, — не личная угроза рабочему.** §A.5
   *     отдаёт герою первую цель: пока игрок дерётся, толпа идёт за ним, и
   *     рабочие не должны бросать работу из-за каждого проходящего гоблина.
   *     Паника включается ровно тогда, когда враг переключился на
   *     поселение (цель-пешка вместо героя) — это и есть «база в опасности»
   *     из §B.2. Именно тогда игрок должен вернуться к базе.
   */
  private shouldFlee(p: Pawn): boolean {
    const radius = AGGRO.PANIC;
    const nearby = this.enemySpatialHash.query(p.x, p.y, radius, this.nearbyEnemyScratch);
    const radiusSq = radius * radius;
    let enemyNear = false;
    let siegeNear = false;
    let hunterNear = false;

    // Один локальный проход одновременно проверяет врага, осаду и агро на пешку.
    for (const enemy of nearby) {
      if (!enemy.active || enemy.dead) continue;
      const dx = enemy.x - p.x;
      const dy = enemy.y - p.y;
      if (dx * dx + dy * dy >= radiusSq) continue;

      enemyNear = true;
      if (enemy.siege) siegeNear = true;
      // Агро относится только к пешке, которую враг действительно выбрал целью.
      // Иначе один нападающий одновременно отправляет в бегство всех соседних рабочих.
      if (enemy.aimedPawn === p) hunterNear = true;
      if (siegeNear && hunterNear) break;
    }

    if (!enemyNear) return false;
    // В ядре угрозой считается только осада; вне ядра — враг, выбравший пешку целью.
    return this.eco.isSettlementCore(p.x, p.y) ? siegeNear : hunterNear;
  }

  /** Позиция монаха: 200 px за ближайшим бойцом относительно врага. */
  private healerFollowPoint(p: Pawn, enemies: Enemy[]): { x: number; y: number } {
    const eco = this.eco;
    const fallback = { x: eco.castleX + 60, y: eco.castleY + 80 };
    const fighters = eco.garrison.filter((f) => f.kind === 'fighter'
      && f.weapon !== 'bow' && f.weapon !== 'staff'
      && !f.dead && f.active
      && Phaser.Math.Distance.Between(f.x, f.y, eco.castleX, eco.castleY) <= GARRISON.LEASH
      && f.state !== 'wounded' && f.state !== 'bleeding' && f.state !== 'retreat');

    let anchor: Pawn | null = null;
    let threat: Enemy | null = null;
    let bestScore = Infinity;
    for (const fighter of fighters) {
      let nearest: Enemy | null = null;
      let nearestD: number = GARRISON.RALLY;
      for (const enemy of enemies) {
        if (!enemy.active || enemy.dead) continue;
        const d = Phaser.Math.Distance.Between(fighter.x, fighter.y, enemy.x, enemy.y);
        if (d < nearestD) {
          nearestD = d;
          nearest = enemy;
        }
      }
      // Важнее прикрыть бойца, который уже engaged; при равном приоритете —
      // тот, к кому монаху ближе добраться.
      const distance = Phaser.Math.Distance.Between(p.x, p.y, fighter.x, fighter.y);
      const score = distance - (nearest ? 800 : 0) - (fighter.state === 'fight' ? 200 : 0);
      if (score < bestScore) {
        bestScore = score;
        anchor = fighter;
        threat = nearest;
      }
    }
    if (!anchor) return fallback;

    // Линия «боец → враг» определяет фронт. Монах остаётся на 200 px
    // с противоположной стороны; при отсутствии врага он возвращается
    // к стороне замка, а не уходит по фиксированной диагонали.
    const dx = threat ? anchor.x - threat.x : eco.castleX - anchor.x;
    const dy = threat ? anchor.y - threat.y : eco.castleY - anchor.y;
    const length = Math.hypot(dx, dy);
    if (length < 1) return { x: anchor.x + HEALER.FOLLOW_OFFSET, y: anchor.y };
    return {
      x: anchor.x + (dx / length) * HEALER.FOLLOW_OFFSET,
      y: anchor.y + (dy / length) * HEALER.FOLLOW_OFFSET,
    };
  }

  private postPoint(p: Pawn): { x: number; y: number } {
    const eco = this.eco;
    const order: Building['kind'][] = p.kind === 'healer'
      ? ['monastery', 'barracks', 'archery', 'castle']
      : p.weapon === 'bow'
        ? ['archery', 'barracks', 'monastery', 'castle']
        : ['barracks', 'archery', 'monastery', 'castle'];
    for (const k of order) {
      const b = eco.buildings.find((bb) => bb.alive && bb.kind === k && !bb.underConstruction);
      if (b) return { x: b.x + 60, y: b.y + 70 };
    }
    return { x: eco.castleX + 70, y: eco.castleY + 80 };
  }
}
