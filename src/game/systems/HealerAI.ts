import Phaser from 'phaser';
import { HEALER } from '../constants';
import { track } from '../../platform/analytics';
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
    interface Need { pawn: Pawn | null; prio: number; x: number; y: number; hpRatio: number }
    const needs: Need[] = [];
    for (const p of eco.pawns) {
      if (p.dead || !p.active) continue;
      if (p.hp >= p.maxHp) continue;
      // ⚠️ Только в радиусе лечения (§B.7.2). Без фильтра монах уходил
      // за две тысячи пикселей к раненому за краем карты — «лечение» было
      // неуправляемым, а не «скорая помощь».
      let need = false;
      for (const m of monks) {
        if (Phaser.Math.Distance.Between(m.x, m.y, p.x, p.y) <= HEALER.RADIUS * 1.6) { need = true; break; }
      }
      if (!need) continue;
      const ratio = p.hp / p.maxHp;
      // Приоритет §B.7.2: отступающий гарнизон → критически раненый
      // союзник в wounded → герой ниже 40% → обычные несмертельные ранения.
      // Слегка повреждённый гражданский не должен опережать раненого героя.
      let prio = 3;
      if (p.state === 'retreat' && p.cls === 'garrison') prio = 0;
      else if (p.state === 'wounded') prio = 1;
      needs.push({ pawn: p, prio, x: p.x, y: p.y, hpRatio: ratio });
    }
    const hero = this.heroFn?.() ?? null;
    if (hero && hero.hp < hero.maxHp * 0.4) {
      needs.push({
        pawn: null, prio: 2, x: hero.x, y: hero.y, hpRatio: hero.hp / hero.maxHp,
      });
    }
    // ⚠️ Внутри одного приоритета — САМАЯ НИЗКАЯ ДОЛЯ HP (§B.7.2): лечим того,
    // кто вот-вот умрёт. Раньше сортировка шла только по prio, и внутри полосы
    // порядок задавал массив — то есть «первого попавшегося».
    needs.sort((a, b) => (a.prio - b.prio) || (a.hpRatio - b.hpRatio));

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
      // Герой лечится отдельно: цель в Pawn — это Pawn, а не герой (§B.7.2
      // «лечит героя и союзников»), поэтому помечаем точку и оставляем healTarget
      // уединённым, а healHeroTick разбирает это по флагу.
      best.healHeroPoint = need.pawn ? null : { x: need.x, y: need.y };
      best.orderTarget = { x: need.x, y: need.y };
      best.taskProgress = now; // метка последнего назначения
    }
    for (const m of free) {
      if (m.healTarget) m.healTarget = null;
      if (m.healHeroPoint) m.healHeroPoint = null;
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
      const slotFreed = target.monasterySlot !== null;
      target.state = 'idle';
      target.cooldown = 0.5;
      if (target.monasterySlot !== null) {
        const freedIdx = target.monasterySlot;
        for (const b of eco.buildings) {
          if (b.kind === 'monastery' && b.alive) b.releaseHealSlot(freedIdx);
        }
        target.monasterySlot = null;
      }
      // Телеметрия §K.2: полевое спасение освобождает слот (§B.7.2)
      track('field_heal_save', { target_kind: target.kind, hp_restored: Math.round(target.hp), monastery_slot_freed: slotFreed });
      eco.emit('pawnSaved', { pawn: target });
      monk.healTarget = null;
    }
  }

  /**
   * Полевое лечение ГЕРОЯ (§B.7.2, приказ СЛЕДОВАТЬ: «лечит героя и
   * союзников в радиусе 120 px»). Бесплатно — дерево платится только за
   * лечение в обители (§B.7.2).
   *
   * Раньше герой в списке нуждающихся давал `pawn: null`, и монах всё равно
   * уходил в полевое лечение пешки: назначение снималось, а цели лечения у
   * монаха не появлялось — мёртвая ветка.
   */
  static fieldHealHeroTick(monk: Pawn, dtMs: number, hero: { hp: number; maxHp: number; x: number; y: number }): void {
    const amount = (HEALER.HPS + HealerAI.hpsBonus) * (dtMs / 1000);
    const heal = Math.min(amount, hero.maxHp - hero.hp);
    if (heal <= 0) return;
    hero.hp += heal;
    monk.state = 'heal';
  }
}
