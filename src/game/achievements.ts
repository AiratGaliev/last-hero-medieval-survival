// ============ Достижения + мета-статистика (localStorage) ============
// Модуль без Phaser-зависимостей: используется и игрой, и платформенным слоем.
//
// Для игр, залитых архивом на Yandex Games, SDK сама подменяет localStorage
// надёжным хранилищем — прогресс переживает перезагрузку и смену устройства.

import { depositGold } from './shop';
import { loadJson, saveJson } from './storage';
import { t } from '../i18n';

export interface AchievementDef {
  id: string;
  name: string;
  desc: string;
  icon: string;   // текстура Phaser (в игре)
  emoji: string;  // для React-сайдбара
}

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'first-blood', name: t('ach.first-blood.name'), desc: t('ach.first-blood.desc'), icon: 'icon-sword', emoji: '🩸' },
  { id: 'evolution-first', name: t('ach.evolution-first.name'), desc: t('ach.evolution-first.desc'), icon: 'icon-might', emoji: '⭐' },
  { id: 'kills-100', name: t('ach.kills-100.name'), desc: t('ach.kills-100.desc'), icon: 'icon-spear', emoji: '⚔️' },
  { id: 'kills-500', name: t('ach.kills-500.name'), desc: t('ach.kills-500.desc'), icon: 'icon-aura', emoji: '💀' },
  { id: 'level-10', name: t('ach.level-10.name'), desc: t('ach.level-10.desc'), icon: 'icon-gem', emoji: '📈' },
  { id: 'gold-500', name: t('ach.gold-500.name'), desc: t('ach.gold-500.desc'), icon: 'icon-coin', emoji: '💰' },
  { id: 'chests-3', name: t('ach.chests-3.name'), desc: t('ach.chests-3.desc'), icon: 'icon-knives', emoji: '🗝️' },
  { id: 'elites-2', name: t('ach.elites-2.name'), desc: t('ach.elites-2.desc'), icon: 'icon-might', emoji: '🗡️' },
  { id: 'shieldbreaker', name: t('ach.shieldbreaker.name'), desc: t('ach.shieldbreaker.desc'), icon: 'icon-shield', emoji: '🛡️' },
  { id: 'riot-quell', name: t('ach.riot-quell.name'), desc: t('ach.riot-quell.desc'), icon: 'icon-haste', emoji: '🔨' },
  { id: 'boss-slayer', name: t('ach.boss-slayer.name'), desc: t('ach.boss-slayer.desc'), icon: 'icon-hammer', emoji: '👑' },
  { id: 'nightmare-win', name: t('ach.nightmare-win.name'), desc: t('ach.nightmare-win.desc'), icon: 'icon-bomb', emoji: '🔥' },
];

const LS_ACH = 'tss-ach';
const LS_META = 'tss-meta';

// ---------- Хранилище достижений ----------

/** Известные id — по ним отсеиваем мусор из хранилища. */
const KNOWN_IDS = new Set(ACHIEVEMENTS.map((a) => a.id));

export function loadUnlocked(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  const arr = loadJson<unknown>(LS_ACH);
  if (!Array.isArray(arr)) return new Set();
  // Оставляем только строки с существующим id: иначе счётчик «n / 12»
  // разъезжался бы, а полоска прогресса показывала больше 100 %.
  return new Set(arr.filter((x): x is string => typeof x === 'string' && KNOWN_IDS.has(x)));
}

function saveUnlocked(set: Set<string>): boolean {
  return saveJson(LS_ACH, [...set]);
}

// ---------- Мета-статистика ----------

export interface MetaStats {
  matches: number;
  victories: number;
  kills: number;
  gold: number;
  bestScore: number;
  playTime: number; // суммарные секунды
}

const EMPTY_META: MetaStats = { matches: 0, victories: 0, kills: 0, gold: 0, bestScore: 0, playTime: 0 };

const num = (v: unknown): number => Math.max(0, Math.floor(Number(v) || 0));

export function loadMeta(): MetaStats {
  if (typeof window === 'undefined') return { ...EMPTY_META };
  const m = loadJson<Partial<MetaStats>>(LS_META);
  if (!m) return { ...EMPTY_META };
  return {
    matches: num(m.matches),
    victories: num(m.victories),
    kills: num(m.kills),
    gold: num(m.gold),
    bestScore: num(m.bestScore),
    playTime: num(m.playTime),
  };
}

export function saveMeta(m: MetaStats): boolean {
  return saveJson(LS_META, m);
}

// ---------- Трекер внутри матча ----------

export type AchEvent =
  | { type: 'kills'; value: number }
  | { type: 'level'; value: number }
  | { type: 'gold'; value: number }
  | { type: 'chests'; value: number }
  | { type: 'elites'; value: number }
  | { type: 'skulls'; value: number }
  | { type: 'shamans'; value: number }
  | { type: 'evolution' }
  | { type: 'victory'; difficulty: string };

export class AchTracker {
  private unlocked: Set<string>;
  readonly newlyUnlocked: AchievementDef[] = [];

  constructor(private onUnlock: (a: AchievementDef) => void) {
    this.unlocked = loadUnlocked();
  }

  /** Вызывается при изменении счётчиков. Возвращает список новых ачивок. */
  event(ev: AchEvent): void {
    switch (ev.type) {
      case 'kills':
        if (!this.unlocked.has('first-blood') && ev.value >= 1) this.unlock('first-blood');
        if (!this.unlocked.has('kills-100') && ev.value >= 100) this.unlock('kills-100');
        if (!this.unlocked.has('kills-500') && ev.value >= 500) this.unlock('kills-500');
        break;
      case 'level':
        if (!this.unlocked.has('level-10') && ev.value >= 10) this.unlock('level-10');
        break;
      case 'gold':
        if (!this.unlocked.has('gold-500') && ev.value >= 500) this.unlock('gold-500');
        break;
      case 'chests':
        if (!this.unlocked.has('chests-3') && ev.value >= 3) this.unlock('chests-3');
        break;
      case 'elites':
        if (!this.unlocked.has('elites-2') && ev.value >= 2) this.unlock('elites-2');
        break;
      case 'skulls':
        if (!this.unlocked.has('shieldbreaker') && ev.value >= 12) this.unlock('shieldbreaker');
        break;
      case 'shamans':
        if (!this.unlocked.has('riot-quell') && ev.value >= 8) this.unlock('riot-quell');
        break;
      case 'evolution':
        if (!this.unlocked.has('evolution-first')) this.unlock('evolution-first');
        break;
      case 'victory':
        if (!this.unlocked.has('boss-slayer')) this.unlock('boss-slayer');
        if (ev.difficulty === 'nightmare' && !this.unlocked.has('nightmare-win')) this.unlock('nightmare-win');
        break;
    }
  }

  private unlock(id: string): void {
    const def = ACHIEVEMENTS.find((a) => a.id === id);
    if (!def || this.unlocked.has(id)) return;
    this.unlocked.add(id);
    this.newlyUnlocked.push(def);
    saveUnlocked(this.unlocked);
    this.onUnlock(def);
  }

  get unlockedCount(): number {
    return this.unlocked.size;
  }

  /** Возвращает и очищает список ачивок, разблокированных за текущий матч.
   * Без очистки экран результата показывает одни и те же «НОВЫЕ ДОСТИЖЕНИЯ»
   * после каждого воскрешения, потому что массив только растёт. */
  consumeNewly(): AchievementDef[] {
    const out = [...this.newlyUnlocked];
    this.newlyUnlocked.length = 0;
    return out;
  }
}

/**
 * Обновление мета-статистики.
 *
 * Параметры — ПРИРАЩЕНИЯ, а не итоговые значения матча. Игрок может
 * воскреснуть после ролика и умереть снова: gameOver() вызывается дважды,
 * и при абсолютных значениях один матч засчитывался бы дважды — с двойным
 * числом игр, убийств и двойной зачисленной в лавку валютой.
 */
export function commitMeta(delta: {
  matches?: number;
  victories?: number;
  kills: number;
  gold: number;
  score: number;
  playTime: number;
}): void {
  const m = loadMeta();
  m.matches += delta.matches ?? 0;
  m.victories += delta.victories ?? 0;
  m.kills += delta.kills;
  m.gold += delta.gold;
  m.bestScore = Math.max(m.bestScore, delta.score);
  m.playTime += Math.max(0, Math.floor(delta.playTime));
  saveMeta(m);
  // Золото матча пополняет кошелёк мета-магазина («Лавка торговца»)
  depositGold(delta.gold);
}
