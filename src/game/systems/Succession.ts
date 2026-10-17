import { SUCCESSION_COST, SUCCESSION_GOLD, SUCCESSION_TYPES, type ResourceCost, type PawnWeapon, type HeroId } from '../data';
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

  constructor(eco: Economy, settlement: Settlement, opts: { resourcesBranchDisabled?: boolean } = {}) {
    this.eco = eco;
    this.settlement = settlement;
    this.resourcesBranchDisabled = opts.resourcesBranchDisabled === true;
    try {
      this.freeUsed = localStorage.getItem('tss-succession-free') === '1';
    } catch { this.freeUsed = false; }
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

  /** Цена ветви 2 по номеру смены (§F.7). */
  resourceCost(): ResourceCost {
    return SUCCESSION_COST[Math.min(this.successionsDone, SUCCESSION_COST.length - 1)];
  }

  /** Цена золота матча ветви 3 (§F.8). */
  goldCost(): number {
    return SUCCESSION_GOLD[Math.min(this.successionsDone, SUCCESSION_GOLD.length - 1)];
  }

  /** Первая преемственность аккаунта бесплатна (§F.4). */
  isFirstLifetimeFree(): boolean {
    return !this.freeUsed;
  }

  /** Отметить использование бесплатной преемственности. */
  markFreeUsed(): void {
    this.freeUsed = true;
    try { localStorage.setItem('tss-succession-free', '1'); } catch { /* приватный режим */ }
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
   *  Контракт «Один в поле» (§H.9) ветвь глушит. */
  canAffordResources(): boolean {
    if (this.resourcesBranchDisabled) return false;
    return this.eco.canAfford(this.resourceCost());
  }

  payResources(): boolean {
    if (this.resourcesBranchDisabled) return false;
    const ok = this.eco.spend(this.resourceCost());
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

  /** Первая преемственность аккаунта: ничего не списываем (§F.4, §I.4). */
  payFree(): void {
    this.markFreeUsed();
  }
}
