import { HEAL_HP_PER_SEC } from '../constants';
import type { Economy } from './Economy';
import type { Building } from '../entities/Building';
import type { Pawn } from '../entities/Pawn';

// ============ Обитель: лечение раненых (TZ §G) ============
//
// Отдельная система домена обители: ровно 10 мест на монастырь (FIFO-логика
// слотов на здании), лечение 12 HP/с, плата 1 дерево / 15 HP, пустой склад —
// пауза лечения с удержанием места (§G.3, §G.4). Экономику не дублируем:
// слоты физически живут на Building, здесь — единая точка доменных правил.
//
// ⚠️ Лечат только своих (§G.2): враги не лечатся ни при каких условиях и
// мест не занимают — в слоты попадают только Pawn из Economy.pawns.

export class Monastery {
  /** Вместимость одной обители (§G.4). Дублирует plan.slots из data.ts —
   *  источник истины для балансовых проверок гейта. */
  static readonly SLOTS = 10;

  constructor(private eco: Economy) {}

  /** Живые (построенные) обители. */
  list(): Building[] {
    return this.eco.buildings.filter((b) => b.alive && b.kind === 'monastery' && !b.underConstruction);
  }

  /** Ближайшая обитель к пешке (для маршрута раненого, §G.3). */
  nearest(from: Pawn): Building | null {
    let best: Building | null = null;
    let bestD = Infinity;
    for (const b of this.list()) {
      const d = Math.hypot(b.x - from.x, b.y - from.y);
      if (d < bestD) { bestD = d; best = b; }
    }
    return best;
  }

  /** Суммарная вместимость: 10 × число живых обителей (§G.4). */
  totalSlots(): number {
    let n = 0;
    for (const b of this.eco.buildings) {
      if (b.alive && b.kind === 'monastery' && !b.underConstruction) n += b.plan.slots ?? 0;
    }
    return n;
  }

  /** Занятые места (HUD «7/10», кнопка ускорения §G.8). */
  usedSlots(): number {
    let n = 0;
    for (const b of this.eco.buildings) {
      if (b.alive && b.kind === 'monastery') n += b.occupiedSlots;
    }
    return n;
  }

  /** Свободные места (решение «лечиться или истекать кровью», §G.3). */
  freeSlots(): number {
    return Math.max(0, this.totalSlots() - this.usedSlots());
  }

  /** «Полевой лекарь»: ранг I экономит 25% дерева, ранг II — 50%. */
  private healWoodMultiplier(): number {
    return Math.max(0.5, 1 - 0.25 * this.eco.card('fieldmedic')) * this.eco.tune.healWood;
  }

  /**
   * Тик лечения: 12 HP/с (+3 «Чистые перевязи» §H.16), 1 дерево за 15 HP;
   * «Бережные руки» ×0.7 и «Чума» ×2 (A2); пустой склад — пауза, место
   * удерживается (§G.3). Выздороровший выписывается и возвращается к работе.
   */
  healTick(dtMs: number): void {
    const hpPerSec = HEAL_HP_PER_SEC + this.eco.tune.healHps;
    const seconds = dtMs / 1000;
    // ⚠️ Списание идёт через Economy.spendWoodPartial() (§G.10), а не прямой
    // записью в resources. Прямая запись не поднимала `emit('change')`, и
    // единственная подписка HUD (economy.on('change'), §B.8) не видела расход.
    // spendWoodPartial умеет списывать дробный остаток и сама ограничивает
    // частоту этой покадровой эмиссии ~10 Гц — депозиты остаются мгновенными.
    let remainingWood = Math.max(0, this.eco.resources.wood);
    let spentWood = 0;
    const woodPerHp = Math.max(0, this.healWoodMultiplier()) / 15;
    for (const b of this.eco.buildings) {
      if (!b.alive || b.kind !== 'monastery' || b.underConstruction) continue;
      for (let s = 0; s < b.healSlots.length; s++) {
        const unit = b.healSlots[s] as Pawn | null;
        if (!unit || !unit.active) continue;
        // Общий остаток дерева расходуется FIFO по монастырям и местам.
        // Проверка исходного склада для каждого слота позволяла всем раненым
        // вылечиться при одном и том же небольшом остатке.
        const requestedAmount = Math.max(0, hpPerSec * seconds);
        const affordableAmount = woodPerHp > 0
          ? remainingWood / woodPerHp
          : requestedAmount;
        const amount = Math.min(requestedAmount, affordableAmount, Math.max(0, unit.maxHp - unit.hp));
        if (amount <= 0) continue; // пустой склад — HP не растёт, место удерживается
        const woodCost = amount * woodPerHp;
        remainingWood = Math.max(0, remainingWood - woodCost);
        spentWood += woodCost;
        unit.healBy(amount);
        this.eco.healHpTotal += amount;
        if (unit.hp >= unit.maxHp) {
          b.releaseHealSlot(s);
          unit.monasterySlot = null;
          unit.monasteryBuilding = null;
          unit.state = 'idle';
          unit.cooldown = 0.5;
          this.eco.monasteryHealed += 1;
          this.eco.emit('pawnSaved', { pawn: unit, inMonastery: true });
        }
      }
    }
    if (spentWood > 0) {
      this.eco.spendWoodPartial(spentWood, dtMs);
    }
  }
}
