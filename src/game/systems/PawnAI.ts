import Phaser from 'phaser';
import { AGGRO, GARRISON, RETREAT_HP, KITE, HEALER } from '../constants';
import { RESOURCES, FIGHTERS, BUILDING_PLANS, type BuildingKind } from '../data';
import { t } from '../../i18n';
import { HealerAI } from './HealerAI';
import type { Economy } from './Economy';
import type { Pawn } from '../entities/Pawn';
import type { Building } from '../entities/Building';
import type { ResourceNode } from '../entities/ResourceNode';
import type { Enemy } from '../entities/Enemy';

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
}

const RANGE_WOOD = 46;

export class PawnAI {
  private scene: Phaser.Scene;
  private eco: Economy;
  private ctx: PawnAICtx;
  private combatAcc = 0;
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

  // ================= ГРАЖДАНСКИЕ (каждый кадр) =================

  updateCivilian(p: Pawn, dtMs: number, _now: number): void {
    const eco = this.eco;
    p.cooldown = Math.max(0, p.cooldown - dtMs / 1000);

    // --- Раненая / истекающая кровью — важнее любой работы (§G.3) ---
    if (p.state === 'wounded' || p.state === 'bleeding') {
      this.woundedTick(p, dtMs);
      return;
    }

    // --- Кулдаун между задачами ---
    if (p.cooldown > 0) {
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
        this.walkTo(p, eco.castleX, eco.castleY, dtMs);
      }
      return;
    }

    // --- 2. Враг рядом → паника, бег к замку (§A.5, PANIC 220) ---
    if (this.enemyNear(p.x, p.y, AGGRO.PANIC)) {
      p.state = 'flee';
      this.walkTo(p, eco.castleX, eco.castleY, dtMs);
      return;
    }

    // --- 3. Приказы игрока (перебивают автоприоритеты, §B.6) ---
    if (p.order === 'build') {
      const spot = this.nearestFreeSpot(p);
      if (spot) {
        if (Phaser.Math.Distance.Between(p.x, p.y, spot.x, spot.y) < 70) {
          if (eco.tryStartBuild(spot.kind, p)) {
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
        return;
      }
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
      const job = eco.buildJobs.find((j) => j.pawn === p);
      if (job) {
        const d = Phaser.Math.Distance.Between(p.x, p.y, job.spot.x, job.spot.y);
        if (d < 90) {
          p.state = 'work';
          p.playWork('hammer');
          p.setVelocity(0, 0);
        } else {
          p.state = 'walk';
          this.walkTo(p, job.spot.x, job.spot.y, dtMs);
        }
        return;
      }
      const spot = this.pickBuildSpot(p);
      let target = spot;
      if (spot && spot.kind !== 'house') {
        const cost = BUILDING_PLANS[spot.kind].cost;
        const affordBig = eco.resources.wood >= (cost.wood ?? 0) && eco.resources.ore >= (cost.ore ?? 0);
        if (!affordBig) {
          // Экономика в яме: крупная стройка не по карману. Фолбэк — дом:
          // он даёт +1 лимит населения и новых жителей (§B.2, §E.5), иначе
          // строитель простаивает вечно, а поселение не восстанавливается.
          const house = this.nearestHouseSpot(p);
          if (house) {
            const hc = BUILDING_PLANS.house.cost;
            if (eco.resources.wood >= (hc.wood ?? 0)) target = house;
          }
        }
      }
      if (target) {
        const cost = BUILDING_PLANS[target.kind].cost;
        const afford = eco.resources.wood >= (cost.wood ?? 0) && eco.resources.ore >= (cost.ore ?? 0);
        if (afford) {
          if (Phaser.Math.Distance.Between(p.x, p.y, target.x, target.y) < 70) {
            if (eco.tryStartBuild(target.kind, p)) {
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
    }

    // --- 5. Ремонтник: повреждённое здание (активировано фазой L) ---
    if (p.kind === 'repairer') {
      // Продолжаем начатый ремонт
      const job = eco.repairJobs.find((j) => j.pawn === p);
      if (job) {
        const d = Phaser.Math.Distance.Between(p.x, p.y, job.building.x, job.building.y);
        if (d < 100) {
          p.state = 'work';
          p.playWork('hammer');
          p.setVelocity(0, 0);
        } else {
          p.state = 'walk';
          this.walkTo(p, job.building.x, job.building.y, dtMs);
        }
        return;
      }
      const b = this.mostDamagedBuilding();
      if (b && eco.resources.wood >= 30 && eco.repair(b, p)) {
        p.state = 'work';
        p.taskProgress = 0;
        return;
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
    if (!node.alive) { node.release(p); p.workNode = null; p.state = 'idle'; return; }
    const d = Phaser.Math.Distance.Between(p.x, p.y, node.x, node.y);
    if (d > (node.kind === 'tree' || node.kind === 'sheep' ? RANGE_WOOD : 52)) {
      p.state = 'walk';
      node.release(p);
      this.walkTo(p, node.x, node.y, dtMs);
      return;
    }
    // Работа: claim + тики
    if (!node.claim(p)) { p.state = 'idle'; return; }
    p.workNode = node;
    p.state = 'work';
    const def = RESOURCES[node.res];
    p.taskProgress += dtMs;
    p.playWork(this.eco.toolFor(node.res));
    p.setVelocity(0, 0);
    if (p.taskProgress >= def.workMs * def.ticksPerCycle) {
      p.taskProgress = 0;
      p.workNode = null;
      const exhausted = !node.extract();
      node.release(p);
      if (!exhausted || node.kind !== 'vein') {
        // жила не исчезает сразу: добыча уходит даже на последнем цикле
      }
      p.carrying = node.res;
      p.carriedAmount = this.eco.workYield(node.res);
      p.state = 'carry';
      p.cooldown = 0.1;
    }
  }

  /**
   * Узел для сборщика: дефицит/дистанция (§B.6) со штрафом за врагов рядом —
   * иначе сборщик идёт в гущу толпы и цикл сбора превращается в беготню.
   */
  private pickNodeFor(p: Pawn): ResourceNode | null {
    const eco = this.eco;
    const enemies = this.c.enemies();
    // Дефицит: план расхода (стройки/ремонт) против склада + базовый план
    // старта (первый дом 30 дерева, казармы 40+15 — §B.4, §B.9)
    const target: Record<string, number> = { wood: 30, ore: 15, meat: 3 };
    for (const j of eco.buildJobs) {
      for (const [k, v] of Object.entries(BUILDING_PLANS[j.spot.kind].cost)) {
        target[k] += v;
      }
    }
    for (const j of eco.repairJobs) target.wood += j.rebuild ? 60 : 30;
    let best: ResourceNode | null = null;
    let bestScore = -1;
    for (const n of eco.nodes) {
      if (!n.alive || (n.claimedBy && n.claimedBy !== p)) continue;
      if (Math.hypot(n.x - eco.castleX, n.y - eco.castleY) > 1000) continue;
      if (n.claimedBy === p) return n;
      const deficit = Math.max(0.5, target[n.res] - eco.resources[n.res] * 0.5);
      const dist = Math.max(60, Math.hypot(n.x - p.x, n.y - p.y));
      let score = deficit / dist;
      // Штраф: враги в 260 px от узла делают его непривлекательным
      for (const e of enemies) {
        if (!e.active || e.dead) continue;
        if (Math.hypot(e.x - n.x, e.y - n.y) < 260) { score *= 0.05; break; }
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

  /** Ближайшее свободное пятно именно под дом (фолбэк автостройки, §B.2). */
  private nearestHouseSpot(p: Pawn): { kind: BuildingKind; x: number; y: number } | null {
    const spots = this.eco.freeSpots().filter((s) => s.kind === 'house');
    let best: { kind: BuildingKind; x: number; y: number } | null = null;
    let bestD = Infinity;
    for (const s of spots) {
      const d = (s.x - p.x) ** 2 + (s.y - p.y) ** 2;
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  /**
   * Пятно для автостройки строителя. Казармы имеют приоритет над домиками —
   * «страховка от смерти строится раньше» (Фаза E ROADMAP, TZ §F.3).
   */
  private pickBuildSpot(p: Pawn): { kind: BuildingKind; x: number; y: number } | null {
    const spots = this.eco.freeSpots();
    const big = spots.filter((s) => s.kind !== 'house');
    if (big.length > 0) {
      // Казармы первыми (порядок BUILD_SPOTS), затем прочие крупные
      const barracks = big.find((s) => s.kind === 'barracks');
      if (barracks) return barracks;
      return big[0];
    }
    return this.nearestFreeSpot(p);
  }

  private mostDamagedBuilding(): Building | null {
    let best: Building | null = null;
    let bestFrac = 1;
    for (const b of this.eco.buildings) {
      if (!b.alive || b.kind === 'castle' || b.plan.noRepair) continue;
      // Строящееся здание (hp=0 при стройке) — не «повреждённое» (§B.4)
      if (b.underConstruction) continue;
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
      p.bleedTimer -= dtMs / 1000;
      p.playMove(false);
      p.setVelocity(0, 0);
      if (p.bleedTimer <= 0) {
        // Окончательная гибель (§G.3)
        eco.removePawn(p);
      }
      return;
    }
    // state === 'wounded'
    if (!mon) {
      // Монастыря нет вообще → сразу bleeding у замка (§G.3)
      p.state = 'bleeding';
      p.bleedTimer = 45;
      this.eco.emit('feed', { text: t('pawn.bleeding', { v: p.name, s: 45 }), color: '#ff6655' });
      return;
    }
    const d = Phaser.Math.Distance.Between(p.x, p.y, mon.x, mon.y);
    if (d < 110) {
      const slot = mon.claimHealSlot(p);
      if (slot === null) {
        p.state = 'bleeding';
        p.bleedTimer = 45;
      } else {
        p.monasterySlot = slot;
        p.state = 'wounded'; // лечится внутри; monasteryHealTick поднимет
        p.playMove(false);
        p.setVelocity(0, 0);
      }
    } else {
      this.walkTo(p, mon.x, mon.y, dtMs, 0.55); // хромая, медленнее
    }
  }

  // ================= ГАРНИЗОН (тик 150 мс) =================

  updateCombat(p: Pawn, dtMs: number, now: number): void {
    // Логика состояния — по тику; движение — каждый кадр (§B.7.1)
    this.combatAcc += dtMs;
    const frame = dtMs;
    if (this.combatAcc >= this.curTickMs) {
      // Фолбэк тика при просадке FPS (§B.7.1)
      const fps = this.scene.game.loop.actualFps;
      this.curTickMs = fps < 40 ? GARRISON.TICK_FALLBACK_MS : GARRISON.TICK_MS;
      this.combatAcc = 0;
      this.combatThink(p, now);
    }
    this.combatMove(p, frame);
  }

  private combatThink(p: Pawn, now: number): void {
    const eco = this.eco;
    if (p.state === 'wounded' || p.state === 'bleeding') { this.woundedTick(p, 0); return; }

    // Отступление при HP < 35%: к монастырю/замку, слот не занимает (§B.7.1)
    if (p.state !== 'retreat' && p.hp < p.maxHp * RETREAT_HP) {
      p.state = 'retreat';
      p.attackCd = 0;
    }
    if (p.state === 'retreat') {
      // Поле лечения монаха может поднять — тогда вернётся в строй
      if (p.hp >= p.maxHp * 0.7) { p.state = 'idle'; }
      return;
    }

    p.attackCd = Math.max(0, p.attackCd - this.curTickMs);

    // Приказы гарнизону держатся до отмены (§B.6)
    const enemies = this.c.enemies();
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
      // Режим обители: стоит рядом и лечит по тарифу §G.3 (без слота)
      const mon = eco.nearestMonastery(p);
      if (mon) this.fightAround(p, enemies, mon.x, mon.y, 140, now, false);
      return;
    }

    // Автоповедение: враг в радиусе 700 px от поселения → fight (§B.6)
    const sx = eco.castleX, sy = eco.castleY;

    // Монах: полевое лечение цели от системы (§B.7.2)
    if (p.kind === 'healer' && p.healTarget) {
      const tgt = p.healTarget;
      if (tgt.dead || !tgt.active) { p.healTarget = null; }
      else {
        const d = Phaser.Math.Distance.Between(p.x, p.y, tgt.x, tgt.y);
        if (d > HEALER.RADIUS * 0.5) this.walkTo(p, tgt.x, tgt.y, this.curTickMs, 1.1);
        else { p.playMove(false); p.setVelocity(0, 0); }
        HealerAI.fieldHealTick(p, tgt, this.curTickMs, eco);
        return;
      }
    }

    let target: Enemy | null = null;
    let bestD: number = GARRISON.RALLY;
    for (const e of enemies) {
      if (!e.active || e.dead) continue;
      const d = Math.hypot(e.x - sx, e.y - sy);
      if (d < bestD) { bestD = d; target = e; }
    }
    // Перехват: враг идёт к пешке/зданию — воин в 260 px перехватывает (§B.7.1)
    if (!target) {
      const besieged = this.c.besiegedBuilding();
      if (besieged) {
        for (const e of enemies) {
          if (!e.active || e.dead) continue;
          if (Math.hypot(e.x - besieged.x, e.y - besieged.y) < 200
            && Math.hypot(p.x - besieged.x, p.y - besieged.y) < GARRISON.INTERCEPT + 120) {
            target = e;
            break;
          }
        }
      }
    }
    if (target) {
      p.state = 'fight';
      this.approachAndAttack(p, target, now);
      return;
    }

    // Патруль вокруг замка: точка смены каждые 6–10 сек (§B.6)
    if (p.kind === 'healer') {
      // Монах без цели: за линией боя, у замка
      const fighters = eco.garrison.filter((f) => f.kind === 'fighter' && f.state === 'fight');
      const anchor = fighters[0];
      if (anchor) {
        this.walkTo(p, anchor.x + HEALER.FOLLOW_OFFSET * 0.4, anchor.y + HEALER.FOLLOW_OFFSET * 0.4, this.curTickMs);
      } else {
        this.walkTo(p, sx + 60, sy + 80, this.curTickMs);
      }
      return;
    }
    const swapIn = this.patrolSwap.get(p) ?? 0;
    if (now > swapIn || !this.patrolPoints.get(p)) {
      const a = Math.random() * Math.PI * 2;
      const r = 120 + Math.random() * 140;
      this.patrolPoints.set(p, { x: sx + Math.cos(a) * r, y: sy + Math.sin(a) * r });
      this.patrolSwap.set(p, now + Phaser.Math.Between(GARRISON.PATROL_SWAP[0], GARRISON.PATROL_SWAP[1]));
    }
    const pt = this.patrolPoints.get(p)!;
    p.state = 'walk';
    this.walkTo(p, pt.x, pt.y, this.curTickMs);
  }

  /** Бой вокруг точки (пост/герой/точка ДЕРЖАТЬ). */
  private fightAround(p: Pawn, enemies: Enemy[], cx: number, cy: number, keep: number, now: number, allowTaunt: boolean): void {
    void allowTaunt; // таунт читается Settlement по состоянию fight+близости
    let target: Enemy | null = null;
    let bestD = Infinity;
    const priority = FIGHTERS[p.weapon ?? 'sword'].prioritise;
    for (const e of enemies) {
      if (!e.active || e.dead) continue;
      const d = Math.hypot(e.x - cx, e.y - cy);
      // Лучник бьёт приоритетно осадных шаманов (§B.7.1)
      const bonus = priority && e.kind === priority && e.siege ? -250 : 0;
      if (d + bonus < bestD) { bestD = d + bonus; target = e; }
    }
    const leashD = Math.hypot(p.x - cx, p.y - cy);
    if (target && bestD < GARRISON.RALLY) {
      p.state = 'fight';
      this.approachAndAttack(p, target, now);
      return;
    }
    // Лучник не уходит дальше 420 px от поста (§B.7.1)
    if (leashD > (p.weapon === 'bow' ? KITE.MAX_LEASH : keep + 40)) {
      p.state = 'walk';
      this.walkTo(p, cx, cy, this.curTickMs);
      return;
    }
    p.state = 'idle';
    this.walkTo(p, cx + Math.random() * 40 - 20, cy + Math.random() * 40 - 20, this.curTickMs);
  }

  /** Сближение и атака (подтипы различаются, §B.7.1). */
  private approachAndAttack(p: Pawn, e: Enemy, now: number): void {
    const w = p.weapon ?? 'sword';
    const def = FIGHTERS[w];
    const d = Phaser.Math.Distance.Between(p.x, p.y, e.x, e.y);

    if (w === 'bow') {
      // Кайтинг: враг ближе 180 px — отход на 80 px, стрельба на ходу (§B.7.1)
      if (d < KITE.NEAR) {
        const nx = p.x - e.x, ny = p.y - e.y;
        const len = Math.max(1, Math.hypot(nx, ny));
        this.walkTo(p, p.x + (nx / len) * KITE.STEP, p.y + (ny / len) * KITE.STEP, this.curTickMs, 1);
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
        p.attackCd = def.period;
        this.c.shootArrow(p, e);
        p.playAttackOnce();
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
          p.attackCd = def.period;
          p.playAttackOnce();
        }
        return;
      }
      if (d <= 200 && d > 90 && p.attackCd <= 0) {
        p.chargeWindup = def.telegraph ?? 480;
        return;
      }
      if (d <= def.range && p.attackCd <= 0) {
        p.attackCd = def.period;
        this.c.pawnAttackEnemy(e, def.dmg, 'lance');
        p.playAttackOnce();
      }
      if (d > def.range) this.walkTo(p, e.x, e.y, this.curTickMs);
      else { p.playMove(false); p.setVelocity(0, 0); }
      return;
    }

    // Мечник: держит 40 px и бьёт каждые 1.2 с (§B.7.1)
    if (d <= def.range + 14) {
      p.state = 'fight';
      p.playMove(false);
      p.setVelocity(0, 0);
      if (p.attackCd <= 0) {
        p.attackCd = def.period;
        this.c.pawnAttackEnemy(e, def.dmg, 'sword');
        p.playAttackOnce();
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
      const step = 430 * (dtMs / 1000);
      p.taskProgress -= step;
      if (p.taskProgress <= 0) { body.setVelocity(0, 0); p.taskProgress = 0; }
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

  private enemyNear(x: number, y: number, r: number): boolean {
    for (const e of this.c.enemies()) {
      if (!e.active || e.dead) continue;
      if (Math.hypot(e.x - x, e.y - y) < r) return true;
    }
    return false;
  }

  private postPoint(p: Pawn): { x: number; y: number } {
    const eco = this.eco;
    const order: Building['kind'][] = p.kind === 'healer' ? ['monastery', 'barracks', 'archery', 'castle'] : ['barracks', 'archery', 'monastery', 'castle'];
    for (const k of order) {
      const b = eco.buildings.find((bb) => bb.alive && bb.kind === k && !bb.underConstruction);
      if (b) return { x: b.x + 60, y: b.y + 70 };
    }
    return { x: eco.castleX + 70, y: eco.castleY + 80 };
  }
}
