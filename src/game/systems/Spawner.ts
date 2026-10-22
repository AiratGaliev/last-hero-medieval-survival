import Phaser from 'phaser';
import { WORLD, SIEGE } from '../constants';
import { WAVE_EVENTS, SIEGE_SCHEDULE, pickRegularKind, hpScale, dmgScale, DIFFICULTIES, type DifficultyId, type DifficultyDef, type EnemyKind, type SiegeProfile } from '../data';
import type { SeasonModifier } from '../meta';
import { audio } from './Audio';
import { t } from '../../i18n';

// ============ Директор волн: тайминг, состав, спец-события, осады ============

/** QA-параметр URL (?qa_siege=N) — читается один раз, работает только в dev. */
function qaNumber(key: string): number | null {
  try {
    if (!import.meta.env.DEV) return null;
    const v = new URLSearchParams(window.location.search).get(key);
    const n = v === null ? NaN : parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export interface SpawnerCtx {
  /** Создаёт врага. false — упёрлись в лимит толпы. */
  spawn(kind: EnemyKind, x: number, y: number): boolean;
  spawnElite(kind: EnemyKind): void;
  /** hpMult — множитель HP (бесконечный режим §H.12: новый босс +50% HP). */
  spawnBoss(hpMult?: number): void;
  playerX(): number;
  playerY(): number;
  announce(text: string, color?: string): void;
  spawnRadius(): number;
  /** Точка у края экрана для добора отложенной волны. */
  randomSpawnX(): number;
  randomSpawnY(): number;
  /** Осада: анонс + отряд с флагом siege (TZ §E.4) */
  beginSiege(profile: SiegeProfile, index: number): void;
}

/**
 * Мета-модификаторы директора волн (фазы Q/S). Все опции optional —
 * обычный режим работает ровно как раньше.
 */
/**
 * Множитель интервала спавна для добровольного указа и вызова дня.
 * Оба horde-модификатора дают одинаковые −15% и не складываются друг с другом;
 * возвращённый коэффициент применяется поверх множителя выбранной сложности.
 */
export function resolveSpawnRateFactor(
  ukaz: string | null | undefined,
  challengeHorde: boolean,
): number {
  return ukaz === 'ukaz_horde' || challengeHorde ? 0.85 : 1;
}

export interface SpawnerOpts {
  /** Бесконечный режим (§H.12): осады каждые 90 с, боссы каждые 300 с. */
  endless?: boolean;
  /** Фиксированный интервал осад в сек (контракт «Осадное положение»/
   *  указ «Двойные осады» — 180, сезон «Долгая осада» — 270, §H.9/§H.17/§H.18). */
  siegeIntervalSec?: number | null;
  /** Множитель интервала поверх rateMult сложности (указ/вызов «Орда» ×0.85). */
  rateMultFactor?: number;
  /** Сезонный модификатор мира (§H.18). */
  season?: SeasonModifier | null;
  /** Контракт «Тихий час» (§H.9): без текстовых анонсов осад. */
  contractQuiet?: boolean;
  /** Мод вызова «Кровавая луна» (A2): резерв под скорость врагов. */
  bloodMoon?: boolean;
  /** Сезон «Красная долина» (§H.18): в 7–12 мин веса черепа/шамана ×1.25. */
  redValley?: boolean;
  /** Благословение «Первая осада» (A2): состав первой осады −1 юнит. */
  firstSiegeTrim?: number;
  /** «Золотая лихорадка» (A2): +1 осада к расписанию §E.4.3. */
  extraSiege?: boolean;
  /** FTUE (§I.2): тепличный первый матч — плотность волн −20% первые 3 минуты. */
  ftueSoftStart?: boolean;
  /** Поднабор врагов из ежедневного вызова; undefined сохраняет обычный рандом. */
  dailyPool?: readonly EnemyKind[];
  /** Seed-генератор состава волн; вне режима поведение остаётся случайным. */
  random?: () => number;
  /** Независимый seed-генератор координат спавна и расстановки отрядов. */
  spawnRandom?: () => number;
  /** Ранг карты «Набат»: 8/11 сек предупреждения на рангах I/II. */
  alarmLevel?: () => number;
}

export class Spawner {
  private scene: Phaser.Scene;
  private ctx: SpawnerCtx;
  private timer = 1200;
  private interval = 850;
  private eventIdx = 0;
  private elapsed = 0;
  private diff: DifficultyDef;
  private siegeIdx = 0;
  private siegeAnnounced = false;
  private o: SpawnerOpts;
  /** Бесконечный режим: номер босса для эскалации HP (§H.12). */
  private bossCount = 0;
  /** Бесконечный режим: момент следующего босса после штатного (900 с). */
  private nextBossAt = 1200;
  stopped = false;

  private random(): number {
    return this.o.random?.() ?? Math.random();
  }

  private spawnRandom(): number {
    return this.o.spawnRandom?.() ?? this.random();
  }

  constructor(scene: Phaser.Scene, ctx: SpawnerCtx, difficulty: DifficultyId = 'normal', opts: SpawnerOpts = {}) {
    this.scene = scene;
    this.ctx = ctx;
    this.diff = DIFFICULTIES[difficulty];
    this.o = opts;
    // QA-хук (?qa_siege=N, dev-сборки): интервал осад бесконечного в секундах —
    // позволяет проверить волны/эскалацию E2E без 15-минутного ожидания.
    const q = qaNumber('qa_siege');
    if (q && this.o.endless) this.o.siegeIntervalSec = q;
    const rate = this.diff.rateMult * (opts.rateMultFactor ?? 1);
    this.interval = 850 * rate;
    this.timer = 1200 * rate;
  }

  get minute(): number {
    return this.elapsed / 60;
  }

  /** Сколько осад уже началось = номер волны бесконечного (§H.12). */
  get wave(): number {
    return this.siegeIdx;
  }

  update(dtSec: number): void {
    if (this.stopped) return;
    this.elapsed += dtSec;

    // ---- Осады: расписание §E.4.3 / интервал-оверрайд / волны бесконечного ----
    if (this.o.endless) this.endlessSiegeTick();
    else this.scheduleSiegeTick();

    // Обработка событий по таймингу. Сезон «Возвращение огра» (§H.18):
    // босс приходит в 12:00 вместо 15:00 — читаем время события с поправкой.
    while (this.eventIdx < WAVE_EVENTS.length) {
      const ev = WAVE_EVENTS[this.eventIdx];
      const evT = ev.type === 'boss' && this.o.season === 'ogre_return' ? 720 : ev.t;
      if (evT > this.elapsed) break;
      this.eventIdx++;
      // Событие может быть привязано к конкретной сложности
      if (ev.diff && ev.diff !== this.diff.id) continue;
      switch (ev.type) {
        case 'rate':
          if (ev.interval) this.interval = ev.interval * this.diff.rateMult * (this.o.rateMultFactor ?? 1);
          break;
        case 'ring':
          if (ev.enemy && ev.count) {
            this.spawnRing(ev.enemy, ev.count);
            // Особые отряды анонсируем — игрок должен понять новую угрозу
            if (ev.note) {
              const label = t(`spawn.${ev.enemy}` as Parameters<typeof t>[0]);
              this.ctx.announce(label, '#ffaa44');
            }
          }
          break;
        case 'elite':
          if (ev.enemy) {
            audio.play('boss');
            // Заставка с аватаром показывается в GameScene.spawnElite
            this.ctx.spawnElite(ev.enemy);
          }
          break;
        case 'boss':
          audio.play('boss');
          // Анонс — кино-заставка HUD.bossIntro (вызывается из spawnBoss).
          // Бесконечный режим: первый босс ×1, дальше +50% за каждого (§H.12),
          // и спавн НЕ останавливается — матч продолжается.
          this.ctx.spawnBoss(this.o.endless ? 1.5 ** this.bossCount : undefined);
          this.bossCount++;
          if (!this.o.endless) this.stopped = true;
          break;
      }
    }

    // Бесконечный режим: после 15:00 новый босс каждые 300 с (§H.12)
    if (this.o.endless) this.endlessBossTick();

    // Регулярный спавн (лимит толпы ENEMY_CAP проверяется в GameScene.spawnEnemy).
    // Бесконечный: после 15:00 rate фиксированный 250 мс, без множителей (§H.12).
    if (this.o.endless && this.elapsed > 900) this.interval = 250;
    // FTUE-теплица (§I.2): первый матч, первые 3 минуты — интервал ×1.25
    const soft = this.o.ftueSoftStart && this.elapsed < 180 ? 1.25 : 1;
    this.timer -= dtSec * 1000 / soft;
    if (this.timer <= 0) {
      this.timer += this.interval;
      this.spawnAtEdge(this.pickKind());
    }
  }

  /** Выбор вида обычного врага: тиры §A.3 + сезон «Красная долина» (§H.18). */
  private pickKind(): EnemyKind {
    const minute = this.minute;
    // Бесконечный: с 21:00 — 100% «чёрный» состав (§H.12)
    if (this.o.endless && minute >= 21) {
      const black: EnemyKind[] = ['skull', 'shaman', 'pig-rider', 'bomb-fish'];
      return black[Math.floor(this.random() * black.length)];
    }
    const kind = pickRegularKind(minute, () => this.random(), this.o.dailyPool);
    // «Красная долина»: в окне 7–12 минут черепа и шаманы приходят на 25%
    // чаще — если выпало другое существо, с вероятностью 0.2 перебрасываем
    // ещё раз (буст ~×1.25 к доле этих видов без правки весов data.ts).
    if (this.o.redValley && minute >= 7 && minute < 12
      && kind !== 'skull' && kind !== 'shaman' && this.random() < 0.2) {
      return pickRegularKind(minute, () => this.random(), this.o.dailyPool);
    }
    return kind;
  }

  /** Ранг «Набата» даёт +3 секунды предупреждения за уровень: 5 → 8 → 11. */
  private siegeAlarmSeconds(): number {
    const rank = Math.max(0, Math.min(2, Math.floor(this.o.alarmLevel?.() ?? 0)));
    const externalBonus = Math.max(0, Number(this.scene.registry.get('tss-siege-warn') ?? 0));
    return SIEGE.ANNOUNCE_SEC + 3 * rank + externalBonus;
  }

  /** Осады по расписанию §E.4.3 или по фиксированному интервалу-оверрайду. */
  private scheduleSiegeTick(): void {
    // «Набат» (карта §H.5) — 8 сек; «Дозорные» (узел d3, §H.16) — +2 сек (итого 7)
    const alarm = this.siegeAlarmSeconds();
    const interval = this.o.siegeIntervalSec ?? null;
    if (interval !== null) {
      // Контракт «Осадное положение» / указ «Двойные осады» / сезон «Долгая
      // осада»: профили §E.4.3 крутятся по кругу с шагом interval (§H.9/§H.17/§H.18)
      const at = interval * (this.siegeIdx + 1);
      const s = this.maybeTrim(
        { ...SIEGE_SCHEDULE[this.siegeIdx % SIEGE_SCHEDULE.length], t: at },
        this.siegeIdx,
      );
      if (!this.siegeAnnounced && this.elapsed >= at - alarm) {
        this.siegeAnnounced = true;
        if (!this.o.contractQuiet) {
          this.ctx.announce(`${t('siege.warn')} — ${t(s.name as Parameters<typeof t>[0])}`, '#ff5544');
        }
        this.scene.events.emit('siege_warn', s);
      }
      if (this.elapsed >= at) {
        this.ctx.beginSiege(s, this.siegeIdx);
        this.siegeIdx++;
        this.siegeAnnounced = false;
      }
      return;
    }
    if (this.siegeIdx < SIEGE_SCHEDULE.length + (this.o.extraSiege ? 1 : 0)) {
      // «Золотая лихорадка» (A2): к пяти осадам расписания добавляется шестая
      const s0 = this.siegeIdx < SIEGE_SCHEDULE.length
        ? SIEGE_SCHEDULE[this.siegeIdx]
        : { ...SIEGE_SCHEDULE[SIEGE_SCHEDULE.length - 1], t: 900 };
      const s = this.maybeTrim(s0, this.siegeIdx);
      if (!this.siegeAnnounced && this.elapsed >= s.t - alarm) {
        this.siegeAnnounced = true;
        if (!this.o.contractQuiet) {
          this.ctx.announce(`${t('siege.warn')} — ${t(s.name as Parameters<typeof t>[0])}`, '#ff5544');
        }
        this.scene.events.emit('siege_warn', s);
      }
      if (this.elapsed >= s.t) {
        this.ctx.beginSiege(s, this.siegeIdx);
        this.siegeIdx++;
        this.siegeAnnounced = false;
      }
    }
  }

  /** Бесконечный режим: синтетическая волна каждые 90 сек (§H.12). */
  private endlessSiegeTick(): void {
    const interval = this.o.siegeIntervalSec ?? 90;
    const wave = this.siegeIdx + 1;
    const at = interval * wave;
    const alarm = this.siegeAlarmSeconds();
    let s = this.endlessProfile(wave, at);
    // Благословение «Первая осада» работает и в бесконечном (A2)
    if (this.siegeIdx === 0 && (this.o.firstSiegeTrim ?? 0) > 0) s = this.maybeTrim(s, 0);
    if (!this.siegeAnnounced && this.elapsed >= at - alarm && this.elapsed < at) {
      this.siegeAnnounced = true;
      if (!this.o.contractQuiet) {
        this.ctx.announce(`${t('siege.warn')} — ${t(s.name as Parameters<typeof t>[0])}`, '#ff5544');
      }
      this.scene.events.emit('siege_warn', s);
    }
    if (this.elapsed >= at) {
      this.ctx.beginSiege(s, this.siegeIdx);
      this.siegeIdx++;
      this.siegeAnnounced = false;
    }
  }

  /** Профиль волны бесконечного: ротация §E.4.3, +1 юнит за волну, лимит ранений +1 за 3 волны. */
  private endlessProfile(wave: number, t: number): SiegeProfile {
    const base = SIEGE_SCHEDULE[(wave - 1) % SIEGE_SCHEDULE.length];
    const squad = base.squad.map((part) => ({ ...part }));
    squad[0].n += wave - 1; // эскалация состава §H.12
    return { ...base, t, woundCap: base.woundCap + Math.floor(wave / 3) };
  }

  /** Благословение «Первая осада» (A2): −1 юнит из самого крупного отряда. */
  private maybeTrim(p: SiegeProfile, index: number): SiegeProfile {
    const trim = this.o.firstSiegeTrim ?? 0;
    if (index !== 0 || trim <= 0) return p;
    const squad = p.squad.map((part) => ({ ...part }));
    let biggest = 0;
    for (let i = 1; i < squad.length; i++) if (squad[i].n > squad[biggest].n) biggest = i;
    squad[biggest].n = Math.max(1, squad[biggest].n - trim);
    return { ...p, squad };
  }

  /** Бесконечный: боссы после штатного (900 с) — каждые 300 с, HP ×1.5^n (§H.12). */
  private endlessBossTick(): void {
    if (this.elapsed < this.nextBossAt) return;
    this.nextBossAt += 300;
    audio.play('boss');
    this.ctx.spawnBoss(1.5 ** this.bossCount);
    this.bossCount++;
  }

  /** Кольцо врагов вокруг игрока */
  spawnRing(kind: EnemyKind, count: number): void {
    const r = this.ctx.spawnRadius();
    const cx = this.ctx.playerX();
    const cy = this.ctx.playerY();
    const m = WORLD.GRASS_MARGIN + 60;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + this.spawnRandom() * 0.2;
      let x = cx + Math.cos(a) * r;
      let y = cy + Math.sin(a) * r;
      x = Phaser.Math.Clamp(x, m, WORLD.SIZE - m);
      y = Phaser.Math.Clamp(y, m, WORLD.SIZE - m);
      this.ctx.spawn(kind, x, y);
    }
  }

  /** Спавн за экраном в случайном направлении */
  spawnAtEdge(kind: EnemyKind): void {
    const r = this.ctx.spawnRadius() * (0.85 + this.spawnRandom() * 0.3);
    const a = this.spawnRandom() * Math.PI * 2;
    const cx = this.ctx.playerX();
    const cy = this.ctx.playerY();
    const m = WORLD.GRASS_MARGIN + 50;
    let x = cx + Math.cos(a) * r;
    let y = cy + Math.sin(a) * r;
    // Если точка за пределами мира — прижимаем внутрь
    if (x < m || x > WORLD.SIZE - m || y < m || y > WORLD.SIZE - m) {
      const toC = Math.atan2(WORLD.SIZE / 2 - cy, WORLD.SIZE / 2 - cx);
      x = cx + Math.cos(toC) * r;
      y = cy + Math.sin(toC) * r;
      x = Phaser.Math.Clamp(x, m, WORLD.SIZE - m);
      y = Phaser.Math.Clamp(y, m, WORLD.SIZE - m);
    }
    this.ctx.spawn(kind, x, y);
  }

  get hpMult(): number { return hpScale(this.minute) * this.diff.hpMult; }
  get dmgMult(): number { return dmgScale(this.minute) * this.diff.dmgMult; }

  /** Сколько осад уже началось (для телеметрии). */
  get siegesStarted(): number {
    return this.siegeIdx;
  }
}
