import Phaser from 'phaser';
import { HEALER } from '../constants';
import type { Economy } from './Economy';
import type { Pawn } from '../entities/Pawn';

// ============ Назначение целей монахам (TZ §B.7.2) ============
//
// Цель выбирает СИСТЕМА, а не юнит: список нуждающихся (приоритет:
// гарнизон в retreat → гражданский в wounded → герой < 40% HP) и к каждой
// цели — ближайший свободный монах. Иначе два монаха встают к одной пешке.
//
// Полевое лечение бесплатно (FIELD_WOOD = 0); поднятый до 50% maxHP раненый
// снимает state wounded и НЕ занимает слот обители (WOUNDED_FREE_AT).

export class HealerAI {
  private eco: Economy;
  private switchAt = 0;
  private heroHealer: Pawn | null = null;
  /** «Братья-целители» (§H.16): +2 HP/с к полевому лечению. Ставит Economy
   *  из мета-модификаторов рана; читается в статическом fieldHealTick. */
  static hpsBonus = 0;

  constructor(eco: Economy) {
    this.eco = eco;
  }

  /** Контекст героя (для приоритета «герой < 40%»). */
  setHeroProvider(fn: () => { hp: number; maxHp: number; x: number; y: number } | null): void {
    this.heroFn = fn;
  }

  private heroFn: (() => { hp: number; maxHp: number; x: number; y: number } | null) | null = null;

  update(now: number): void {
    const eco = this.eco;
    const monks = eco.garrison.filter((p) => p.kind === 'healer' && !p.dead
      && p.state !== 'wounded' && p.state !== 'bleeding' && p.state !== 'retreat');
    if (monks.length === 0) return;

    // Переключение цели не чаще 0.5 сек (§B.7.2)
    if (now < this.switchAt) return;
    this.switchAt = now + HEALER.SWITCH_MS;

    // Список нуждающихся с приоритетом
    interface Need { pawn: Pawn | null; prio: number; x: number; y: number }
    const needs: Need[] = [];
    for (const p of eco.pawns) {
      if (p.dead || !p.active) continue;
      if (p.state === 'retreat' && p.cls === 'garrison') needs.push({ pawn: p, prio: 0, x: p.x, y: p.y });
      else if (p.state === 'wounded' && p.hp > 0) needs.push({ pawn: p, prio: 1, x: p.x, y: p.y });
      else if (p.hp < p.maxHp * 0.6) needs.push({ pawn: p, prio: 2, x: p.x, y: p.y });
    }
    const hero = this.heroFn?.() ?? null;
    if (hero && hero.hp < hero.maxHp * 0.4) {
      needs.push({ pawn: null, prio: 3, x: hero.x, y: hero.y });
    }
    needs.sort((a, b) => a.prio - b.prio);

    const free = [...monks];
    for (const need of needs) {
      if (free.length === 0) break;
      // Ближайший свободный монах к цели
      let best: Pawn | null = null;
      let bestD = Infinity;
      for (const m of free) {
        const d = (m.x - need.x) ** 2 + (m.y - need.y) ** 2;
        if (d < bestD) { bestD = d; best = m; }
      }
      if (!best) continue;
      free.splice(free.indexOf(best), 1);
      best.healTarget = need.pawn;
      best.orderTarget = { x: need.x, y: need.y };
      best.taskProgress = now; // метка последнего назначения
      if (!need.pawn) this.heroHealer = best;
    }
    for (const m of free) {
      if (m.healTarget) m.healTarget = null;
      // Свободный монах следует за линией боя в 200 px позади (§B.7.2)
    }
  }

  /**
   * Полевое лечение: 8 HP/с в радиусе 320 px (§B.7.2). Вызывается из PawnAI
   * в ветке healer — здесь только числитель: снятие wounded при 50%.
   */
  static fieldHealTick(monk: Pawn, target: Pawn, dtMs: number, eco: Economy): void {
    if (target.dead || !target.active) { monk.healTarget = null; return; }
    const d = Phaser.Math.Distance.Between(monk.x, monk.y, target.x, target.y);
    if (d > HEALER.RADIUS) return; // подойти — движение делает PawnAI
    const amount = (HEALER.HPS + HealerAI.hpsBonus) * (dtMs / 1000);
    target.healBy(amount);
    eco.healHpTotal += amount;
    monk.state = 'heal';
    // Спасение на поле: 50% maxHP → wounded снят, слот обители не занят (§B.7.2)
    if (target.state === 'wounded' && target.hp >= target.maxHp * HEALER.WOUNDED_FREE_AT) {
      target.state = 'idle';
      target.cooldown = 0.5;
      if (target.monasterySlot !== null) {
        // слот не занимался (полевое) — но если успел занять, освобождаем
        for (const b of eco.buildings) {
          if (b.kind === 'monastery' && b.alive) b.releaseHealSlot(target.monasterySlot);
        }
        target.monasterySlot = null;
      }
      eco.emit('pawnSaved', { pawn: target });
      monk.healTarget = null;
    }
  }
}
