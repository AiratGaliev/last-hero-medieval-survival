import { SUCCESSION_COST, SUCCESSION_GOLD, SUCCESSION_TYPES, type ResourceCost, type PawnWeapon, type HeroId } from '../data';
import { loadJson, saveJson } from '../storage';
import { getSuccessionFreeUsed, persistSuccessionFreeUsed } from '../../platform/player';
import type { Economy } from './Economy';
import type { Settlement } from './Settlement';
import type { Pawn } from '../entities/Pawn';

// ============ Преемственность героя (TZ §F) ============
//
// Матч продлевается только зданием, которое умеет выпустить воина
// (barracks/archery/monastery — SUCCESSION_SOURCES). Ветви по приоритету:
// 1) живой воин на карте → автоматически и бесплатно;
// 2) хватает ресурсов → новый воин из здания;
// 3) не хватает → реклама ИЛИ золото матча с выбором типа.
// Кроны нигде не принимаются (§J.9). Первая преемственность аккаунта
// бесплатна (lifetime-флаг).

export type SuccessionBranch = 'warrior' | 'resources' | 'ad' | 'gold' | 'refused';

export interface SuccessionOption {
  weapon: PawnWeapon;
  hero: HeroId;
  source: string;
  /** Есть ли здание-источник (иначе тип серый, §F.5). */
  available: boolean;
}

export class Succession {
  readonly eco: Economy;
  private settlement: Settlement;
  /** Число оплаченных и бесплатных преемников за матч (эскалация цены, §F.7). */
  successionsDone = 0;
  /** lifetime-флаг: первая преемственность в жизни аккаунта бесплатна. */
  freeUsed = false;
  /** Контракт «Один в поле» (§H.9): ветвь «за ресурсы» недоступна —
   *  остаются живой воин, реклама и золото матча. */
  private resourcesBranchDisabled: boolean;
  /** «Дорога героя» (узел m2, §H.16): цена преемства ×0.90. */
  private costMult: number;

  constructor(eco: Economy, settlement: Settlement, opts: { resourcesBranchDisabled?: boolean; successionCostMult?: number } = {}) {
    this.eco = eco;
    this.settlement = settlement;
    this.resourcesBranchDisabled = opts.resourcesBranchDisabled === true;
    this.costMult = Math.max(0.1, opts.successionCostMult ?? 1);
    // lifetime-флаг через storage.ts (префикс tss-); миграция старого ключа
    const legacy = (() => { try { return localStorage.getItem('tss-succession-free'); } catch { return null; } })();
    if (legacy === '1') {
      this.freeUsed = true;
      saveJson('succession-free', true);
      persistSuccessionFreeUsed();
      try { localStorage.removeItem('tss-succession-free'); } catch { /* приватный режим */ }
    } else {
      this.freeUsed = getSuccessionFreeUsed() ?? (loadJson<boolean>('succession-free') === true);
    }
  }

  /** Ветвь 1: живой воин на карте (wounded/retreat не считаются, §F.4). */
  findLivingWarrior(): Pawn | null {
    return this.eco.garrison.find((p) => p.canBecomeHero()) ?? null;
  }

  /** Доступен ли матч к продлению: есть здание-источник (§F.6). */
  canSucceed(): boolean {
    return this.settlement.hasSuccessionSource();
  }

  options(): SuccessionOption[] {
    return SUCCESSION_TYPES.map((t) => ({
      weapon: t.weapon,
      hero: t.hero,
      source: t.source,
      available: this.eco.buildings.some((b) => b.alive && b.kind === t.source && !b.underConstruction),
    }));
  }

  /**
 * Цена ресурсной ветви (§F.7): 40д+15р → 80д+35р → 140д+60р.
 *
 * ⚠️ С 4-й смены ресурсная ветвь ЗАКРЫТА (§F.7: «4-я и далее — только золото
 * матча, ×1.5 за каждую»). Раньше `min(successionsDone, len-1)` держал цену
 * 140д+60р вечно, то есть дерево можно было тратить на преемников
 * бесконечно — ровно то, чего спецификация запрещает.
 */
  resourceCost(): ResourceCost | null {
    const tier = SUCCESSION_COST[Math.min(this.successionsDone, SUCCESSION_COST.length - 1)];
    if (!tier || this.successionsDone >= SUCCESSION_COST.length) return null;
    if (this.costMult === 1) return tier;
    const out: ResourceCost = {};
    if (tier.wood !== undefined) out.wood = Math.max(1, Math.round(tier.wood * this.costMult));
    if (tier.ore !== undefined) out.ore = Math.max(1, Math.round(tier.ore * this.costMult));
    if (tier.meat !== undefined) out.meat = Math.max(1, Math.round(tier.meat * this.costMult));
    return out;
  }

  /** Доступна ли ресурсная ветвь (не 4-я смена и не контракт «Один в поле»). */
  resourcesBranchAvailable(): boolean {
    return !this.resourcesBranchDisabled && this.successionsDone < SUCCESSION_COST.length;
  }

  /**
   * Цена золота матча ветви 3 (§F.8): 500 / 900 / 1500, далее ×1.5 за каждую
   * смену (§F.7 — «4-я и далее — только золото матча, ×1.5 за каждую»).
   */
  goldCost(): number {
    const n = this.successionsDone;
    const base = SUCCESSION_GOLD[Math.min(n, SUCCESSION_GOLD.length - 1)];
    const escalated = n >= SUCCESSION_GOLD.length
      ? base * Math.pow(1.5, n - (SUCCESSION_GOLD.length - 1))
      : base;
    return Math.max(1, Math.round(escalated * this.costMult));
  }

  /** Первая преемственность аккаунта бесплатна (§F.4). */
  isFirstLifetimeFree(): boolean {
    return !this.freeUsed;
  }

  /** Отметить использование бесплатной преемственности. */
  markFreeUsed(): void {
    this.freeUsed = true;
    saveJson('succession-free', true);
    persistSuccessionFreeUsed();
  }

  /** Ветвь 1: воин становится героем. Пешка выпадает из гарнизона (§F.12).
   *  ⚠️ Эскалацию цены (§F.7) не поднимает: ветвь 1 — бесплатное «наследие»,
   *  счётчик successionsDone растёт только за платные ветви 2/3. */
  promoteWarrior(warrior: Pawn): Pawn {
    const i = this.eco.pawns.indexOf(warrior);
    if (i >= 0) this.eco.pawns.splice(i, 1); // лимит казарм освобождается
    warrior.destroy();
    return warrior;
  }

  /** Ветвь 2: воин приходит из здания за ресурсы (бесплатно для игрока).
   *  Контракт «Один в поле» (§H.9) и 4-я смена ветвь глушат (§F.7). */
  canAffordResources(): boolean {
    const cost = this.resourceCost();
    if (!cost) return false;
    return this.eco.canAfford(cost);
  }

  payResources(): boolean {
    const cost = this.resourceCost();
    if (!cost || this.resourcesBranchDisabled) return false;
    const ok = this.eco.spend(cost);
    if (ok) this.successionsDone++;
    return ok;
  }

  /** Ветвь 3 — золото матча (списывает GameScene), счётчик эскалации. */
  payGold(): void {
    this.successionsDone++;
  }

  payAd(): void {
    this.successionsDone++;
    this.markFreeUsed();
  }

  /**
   * Первая преемственность аккаунта: ничего не списываем (§F.4, §I.4).
   *
   * ⚠️ Счётчик эскалации ОБЯЗАТЕЛЬНО растёт (§F.7: «Номер смены считает
   * только оплаченные и бесплатные преемники (включая lifetime-бесплатную
   * первую)»). Раньше он оставался 0, и вторая смерть стоила 40д+15р вместо
   * 80д+35р — гейт §F.13 п.11 не выполнялся.
   */
  payFree(): void {
    this.markFreeUsed();
    this.successionsDone++;
  }

  /** Тип воина разрешён, если стоит его здание-источник (§F.4, §F.5, §F.13 п.6). */
  typeAvailable(weapon: PawnWeapon): boolean {
    const t = SUCCESSION_TYPES.find((x) => x.weapon === weapon);
    if (!t) return false;
    return this.eco.buildings.some((b) => b.alive && b.kind === t.source && !b.underConstruction);
  }

  /** Герой, соответствующий подтипу воина (§F.6): bow → archer, staff → monk. */
  heroFor(weapon: PawnWeapon): HeroId {
    return SUCCESSION_TYPES.find((x) => x.weapon === weapon)?.hero ?? 'warrior';
  }
}
