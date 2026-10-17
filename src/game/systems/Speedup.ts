import { SPEEDUP_COST } from '../constants';
import { spendGold } from '../shop';
import { spendSpeedupToken, speedupTokenBalance } from '../meta';
import { showPlacementRewarded, placementAvailable } from '../../platform/ads';
import { track } from '../../platform/analytics';
import type { Economy } from './Economy';

// ============ Ускорения ремонта и лечения (TZ §G.8, фаза O) ============
//
// Ускорение — удобство, а не спасение: валюта — кошелёк лавки либо реклама
// (1 каждого вида за матч). Никогда не принудительно: можно просто подождать.
// Ускорение лечения выписывает И лечащихся в обители, И всех bleeding у ворот
// (иначе «окно для реакции» §G.5.1 не работало).

export type SpeedupKind = 'repair' | 'heal';

export type SpeedupResult =
  | { ok: true }
  | { ok: false; reason: 'noTarget' | 'poor' | 'adUnavailable' | 'noToken' };

export class Speedup {
  private eco: Economy;

  constructor(eco: Economy) {
    this.eco = eco;
  }

  /** Есть ли цель для ускорения (кнопка серая без причины, §G.8). */
  hasTarget(kind: SpeedupKind): boolean {
    if (kind === 'repair') return this.eco.activeRepair !== null;
    return this.eco.usedHealSlots() > 0
      || this.eco.pawns.some((p) => p.state === 'bleeding' && !p.dead);
  }

  /** Есть ли жетон ускорения (награды пропуска/сундуков, §J.6.2). */
  hasToken(): boolean {
    return speedupTokenBalance() > 0;
  }

  /** Купить за жетон ускорения (списание атомарно, эффект мгновенный §J.9). */
  buyWithToken(kind: SpeedupKind): SpeedupResult {
    if (!this.hasTarget(kind)) return { ok: false, reason: 'noTarget' };
    if (!spendSpeedupToken()) return { ok: false, reason: 'noToken' };
    this.apply(kind);
    track('speedup_bought', { kind, currency: 'token' });
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
    if (!res.ok) return { ok: false, reason: 'poor' };
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
    track('speedup_bought', { kind, currency: 'ad' });
    return { ok: true };
  }

  /** Мгновенный эффект (§G.8). */
  private apply(kind: SpeedupKind): void {
    if (kind === 'repair') {
      this.eco.finishRepairInstant();
    } else {
      // Все в местах лечения — полные HP, места свободны
      for (const b of this.eco.buildings) {
        if (!b.alive || b.kind !== 'monastery') continue;
        for (let s = 0; s < b.healSlots.length; s++) {
          const unit = b.healSlots[s] as import('../entities/Pawn').Pawn | null;
          if (!unit) continue;
          unit.healBy(unit.maxHp);
          // Сводка рана (§K.2): выписка из обители — ускоренное лечение
          this.eco.healHpTotal += unit.maxHp;
          this.eco.monasteryHealed += 1;
          unit.state = 'idle';
          unit.cooldown = 0.5;
          unit.monasterySlot = null;
          b.releaseHealSlot(s);
          this.eco.emit('pawnSaved', { pawn: unit, inMonastery: true });
        }
      }
      // Все bleeding у ворот — спасены (§G.8: выписывает и bleeding)
      for (const p of this.eco.pawns) {
        if (p.state === 'bleeding' && !p.dead) {
          p.state = 'idle';
          p.healBy(p.maxHp);
          p.cooldown = 0.5;
          this.eco.emit('pawnSaved', { pawn: p });
        }
      }
    }
  }
}
