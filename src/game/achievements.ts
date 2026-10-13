// ============ Достижения + мета-статистика (localStorage) ============
// Модуль без Phaser-зависимостей: используется и игрой, и платформенным слоем.
//
// Для игр, залитых архивом на Yandex Games, SDK сама подменяет localStorage
// надёжным хранилищем — прогресс переживает перезагрузку и смену устройства.

import { depositGold } from './shop';
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

export function loadUnlocked(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(LS_ACH);
    if (!raw) return new Set();
    const arr: unknown = JSON.parse(raw);
    if (Array.isArray(arr)) return new Set(arr.filter((x): x is string => typeof x === 'string'));
  } catch {
    // повреждённые данные — начинаем с чистого листа
  }
  return new Set();
}

function saveUnlocked(set: Set<string>): void {
  try {
    window.localStorage.setItem(LS_ACH, JSON.stringify([...set]));
  } catch {
    // localStorage недоступен (приватный режим) — просто не сохраняем
  }
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

export function loadMeta(): MetaStats {
  if (typeof window === 'undefined') return { ...EMPTY_META };
  try {
    const raw = window.localStorage.getItem(LS_META);
    if (!raw) return { ...EMPTY_META };
    const m = JSON.parse(raw) as Partial<MetaStats>;
    return {
      matches: Number(m.matches ?? 0) || 0,
      victories: Number(m.victories ?? 0) || 0,
      kills: Number(m.kills ?? 0) || 0,
      gold: Number(m.gold ?? 0) || 0,
      bestScore: Number(m.bestScore ?? 0) || 0,
      playTime: Number(m.playTime ?? 0) || 0,
    };
  } catch {
    return { ...EMPTY_META };
  }
}

export function saveMeta(m: MetaStats): void {
  try {
    window.localStorage.setItem(LS_META, JSON.stringify(m));
  } catch {
    // игнорируем
  }
}

// ---------- Трекер внутри матча ----------

export type AchEvent =
  | { type: 'kills'; value: number }
  | { type: 'level'; value: number }
  | { type: 'gold'; value: number }
  | { type: 'chests'; value: number }
  | { type: 'elites'; value: number }
  | { type: 'guards'; value: number }
  | { type: 'taskmasters'; value: number }
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
      case 'guards':
        if (!this.unlocked.has('shieldbreaker') && ev.value >= 12) this.unlock('shieldbreaker');
        break;
      case 'taskmasters':
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
}

/** Финальное обновление мета-статистики (вызывается при конце матча). */
export function commitMeta(params: {
  victory: boolean;
  kills: number;
  gold: number;
  score: number;
  playTime: number;
}): void {
  const m = loadMeta();
  m.matches += 1;
  if (params.victory) m.victories += 1;
  m.kills += params.kills;
  m.gold += params.gold;
  m.bestScore = Math.max(m.bestScore, params.score);
  m.playTime += Math.max(0, Math.floor(params.playTime));
  saveMeta(m);
  // Золото матча пополняет кошелёк мета-магазина («Лавка торговца»)
  depositGold(params.gold);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('tss-meta-updated'));
  }
}
