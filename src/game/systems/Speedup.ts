import { HEALER, SPEEDUP_COST } from '../constants';
import { spendGold } from '../shop';
import { spendSpeedupToken, speedupTokenBalance } from '../meta';
import { showPlacementRewarded, placementAvailable } from '../../platform/ads';
import { track } from '../../platform/analytics';
import type { Economy } from './Economy';
import type { Pawn } from '../entities/Pawn';

// ============ Ускорения ремонта и лечения (TZ §G.8, фаза O) ============
//
// Ускорение — удобство, а не спасение: валюта — кошелёк лавки либо реклама
// (1 каждого вида за матч). Никогда не принудительно: можно просто подождать.
// Ускорение лечения выписывает пациентов обителей и спасает bleeding рядом
// с воротами замка или живой обителью (радиус лечения — 320 px).

export type SpeedupKind = 'repair' | 'heal';

export type SpeedupResult =
  | { ok: true }
  | { ok: false; reason: 'noTarget' | 'poor' | 'adUnavailable' | 'noToken' | 'storage' };

export class Speedup {
  private eco: Economy;

  constructor(eco: Economy) {
    this.eco = eco;
  }

  /** Есть ли цель для ускорения (кнопка серая без причины, §G.8). */
  hasTarget(kind: SpeedupKind): boolean {
    if (kind === 'repair') return this.eco.activeRepair !== null;
    const hasLivingPatientInMonastery = this.eco.buildings.some((building) =>
      building.alive
      && building.kind === 'monastery'
      && !building.underConstruction
      && building.healSlots.some((slot) => {
        const patient = slot as Pawn | null;
        return patient !== null && patient !== undefined && !patient.dead;
      }));
    return hasLivingPatientInMonastery
      || this.eco.pawns.some((p) => this.isBleedingInHealRadius(p));
  }

  /**
   * Область мгновенного лечения ограничена 320 px от ворот замка либо
   * построенной обители. Это спасает лежащих у входа и не лечит удалённых
   * пешек по всей карте одним нажатием.
   */
  private isBleedingInHealRadius(pawn: Pawn): boolean {
    if (pawn.state !== 'bleeding' || pawn.dead) return false;
    const within = (x: number, y: number): boolean =>
      Math.hypot(pawn.x - x, pawn.y - y) <= HEALER.RADIUS;

    if (within(this.eco.castleX, this.eco.castleY)) return true;
    return this.eco.buildings.some((building) =>
      building.alive
      && building.kind === 'monastery'
      && !building.underConstruction
      && within(building.x, building.y));
  }

  /** Есть ли жетон ускорения (награды пропуска/сундуков, §J.6.2). */
  hasToken(): boolean {
    return speedupTokenBalance() > 0;
  }

  /** Купить за жетон ускорения (списание атомарно, эффект мгновенный §J.9). */
  buyWithToken(kind: SpeedupKind): SpeedupResult {
    if (!this.hasTarget(kind)) return { ok: false, reason: 'noTarget' };
    const hadToken = speedupTokenBalance() > 0;
    if (!spendSpeedupToken()) {
      return { ok: false, reason: hadToken ? 'storage' : 'noToken' };
    }
    this.apply(kind);
    track('speedup_bought', { kind, currency: 'token', cost: 1 });
    return { ok: true };
  }

  /**
   * Купить за золото кошелька (атомарное списание, TZ §G.10).
   * Эффект мгновенный в том же тике, что и списание (§J.9).
   */
  buyWithGold(kind: SpeedupKind): SpeedupResult {
    if (!this.hasTarget(kind)) return { ok: false, reason: 'noTarget' };
    const cost = SPEEDUP_COST[kind];
    const res = spendGold(cost);
    if (!res.ok) {
      return { ok: false, reason: res.reason === 'storage' ? 'storage' : 'poor' };
    }
    this.apply(kind);
    track('speedup_bought', { kind, currency: 'wallet', cost });
    return { ok: true };
  }

  /** Купить за rewarded-ролик (лимит 1/матч каждого вида). */
  async buyWithAd(kind: SpeedupKind): Promise<SpeedupResult> {
    if (!this.hasTarget(kind)) return { ok: false, reason: 'noTarget' };
    const placement = kind === 'repair' ? 'repair-speedup' : 'heal-speedup';
    if (!placementAvailable(placement)) return { ok: false, reason: 'adUnavailable' };
    const res = await showPlacementRewarded(placement);
    if (!res.rewarded) return { ok: false, reason: 'adUnavailable' };
    this.apply(kind);
    track('speedup_bought', { kind, currency: 'ad', cost: 1 });
    return { ok: true };
  }

  /** Мгновенный эффект (§G.8). */
  private apply(kind: SpeedupKind): void {
    if (kind === 'repair') {
      this.eco.finishRepairInstant();
    } else {
      // Все в местах лечения — полные HP, места свободны
      for (const b of this.eco.buildings) {
        if (!b.alive || b.kind !== 'monastery' || b.underConstruction) continue;
        for (let s = 0; s < b.healSlots.length; s++) {
          const unit = b.healSlots[s] as Pawn | null;
          if (!unit) continue;
          if (unit.dead) {
            b.releaseHealSlot(s);
            if (unit.monasteryBuilding === b) {
              unit.monasterySlot = null;
              unit.monasteryBuilding = null;
            }
            continue;
          }
          const hpBefore = unit.hp;
          unit.healBy(Math.max(0, unit.maxHp - unit.hp));
          // Учитываем фактически восстановленные HP, а не maxHp: событие
          // влияет на сводку рана и телеметрию эффективности лечения.
          this.eco.healHpTotal += Math.max(0, unit.hp - hpBefore);
          this.eco.monasteryHealed += 1;
          unit.state = 'idle';
          unit.cooldown = 0.5;
          unit.monasterySlot = null;
          unit.monasteryBuilding = null;
          b.releaseHealSlot(s);
          this.eco.emit('pawnSaved', { pawn: unit, inMonastery: true });
        }
      }
      // Кровоточащих спасаем только в пределах области лечения от замка/обители.
      for (const p of this.eco.pawns) {
        if (!this.isBleedingInHealRadius(p)) continue;
        const hpBefore = p.hp;
        p.healBy(Math.max(0, p.maxHp - p.hp));
        this.eco.healHpTotal += Math.max(0, p.hp - hpBefore);
        p.state = 'idle';
        p.cooldown = 0.5;
        p.monasterySlot = null;
        p.monasteryBuilding = null;
        this.eco.emit('pawnSaved', { pawn: p });
      }
    }
  }
}
