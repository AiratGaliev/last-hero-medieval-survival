// ============ Данные: оружия, пассивки, враги, волны ============
// Источник баланса: docs/TZ.md
//
// Имена и описания берутся из словаря i18n. Этот модуль вычисляется на
// этапе импорта, поэтому язык обязан быть определён раньше (см. src/main.ts).

import { t } from '../i18n';

export type WeaponId = 'sword' | 'bow' | 'spear' | 'hammer' | 'bomb' | 'aura' | 'knives';
export type PassiveId = 'boots' | 'armor' | 'magnet' | 'regen' | 'might' | 'haste' | 'vitality' | 'luck' | 'wisdom';

// ============ Эволюции оружия (v1.10) ============
// Максимальный уровень оружия (5) + пассивка-партнёр (любой уровень) →
// карточка ЭВОЛЮЦИИ на левел-апе. Оружие заменяется улучшенной формой
// (уровень 6) с новым поведением и усиленными характеристиками.
export interface EvolutionDef {
  weapon: WeaponId;
  partner: PassiveId;   // требуемая пассивка (достаточно владеть)
  name: string;         // имя эволюционной формы
  desc: string;         // что меняет эволюция
}

export const EVOLUTIONS: Record<WeaponId, EvolutionDef> = {
  sword:   { weapon: 'sword',   partner: 'might',    name: t('evo.sword.name'), desc: t('evo.sword.desc') },
  bow:     { weapon: 'bow',     partner: 'haste',    name: t('evo.bow.name'), desc: t('evo.bow.desc') },
  spear:   { weapon: 'spear',   partner: 'vitality', name: t('evo.spear.name'), desc: t('evo.spear.desc') },
  hammer:  { weapon: 'hammer',  partner: 'armor',    name: t('evo.hammer.name'), desc: t('evo.hammer.desc') },
  bomb:    { weapon: 'bomb',    partner: 'luck',     name: t('evo.bomb.name'), desc: t('evo.bomb.desc') },
  aura:    { weapon: 'aura',    partner: 'regen',    name: t('evo.aura.name'), desc: t('evo.aura.desc') },
  knives:  { weapon: 'knives',  partner: 'boots',    name: t('evo.knives.name'), desc: t('evo.knives.desc') },
};

export interface WeaponLevel {
  dmg: number;
  cd: number;        // мс между атаками
  count?: number;    // снарядов/взмахов/ударов
  radius?: number;   // AoE радиус
  pierce?: number;   // пробитие
}

export interface WeaponDef {
  id: WeaponId;
  name: string;
  desc: string;
  icon: string;
  levels: WeaponLevel[]; // 5 уровней
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  sword: {
    id: 'sword',
    name: t('weapon.sword.name'),
    desc: t('weapon.sword.desc'),
    icon: 'icon-sword',
    levels: [
      { dmg: 12, cd: 900, count: 1 },
      { dmg: 16, cd: 850, count: 1 },
      { dmg: 21, cd: 800, count: 1 },
      { dmg: 27, cd: 750, count: 2 },
      { dmg: 34, cd: 700, count: 2 },
      // Эволюция «Клинок зари»: полный круг ×3 + молнии-цепи
      { dmg: 50, cd: 520, count: 3 },
    ],
  },
  bow: {
    id: 'bow',
    name: t('weapon.bow.name'),
    desc: t('weapon.bow.desc'),
    icon: 'icon-bow',
    levels: [
      { dmg: 10, cd: 1100, count: 1, pierce: 1 },
      { dmg: 13, cd: 1000, count: 1, pierce: 1 },
      { dmg: 17, cd: 950, count: 2, pierce: 1 },
      { dmg: 22, cd: 900, count: 2, pierce: 2 },
      { dmg: 28, cd: 850, count: 3, pierce: 3 },
      // Эволюция «Град стрел»: двойной залп по 6 стрел
      { dmg: 38, cd: 600, count: 6, pierce: 6 },
    ],
  },
  spear: {
    id: 'spear',
    name: t('weapon.spear.name'),
    desc: t('weapon.spear.desc'),
    icon: 'icon-spear',
    levels: [
      { dmg: 15, cd: 900, count: 1 },
      { dmg: 20, cd: 850, count: 1 },
      { dmg: 26, cd: 800, count: 2 },
      { dmg: 33, cd: 750, count: 2 },
      { dmg: 42, cd: 700, count: 3 },
      // Эволюция «Гунгнир»: два гигантских возвращающихся копья.
      // Копьё бьёт на пути туда и обратно, поэтому фактический урон
      // вдвое выше показанного — как и у остальных эволюций с числом
      // попаданий. Прежние 70/640/1 давали 109 DPS против 180 у пятого
      // уровня, то есть эволюция ухудшала оружие.
      { dmg: 75, cd: 600, count: 2 },
    ],
  },
  hammer: {
    id: 'hammer',
    name: t('weapon.hammer.name'),
    desc: t('weapon.hammer.desc'),
    icon: 'icon-hammer',
    levels: [
      { dmg: 25, cd: 2500, radius: 110, count: 1 },
      { dmg: 33, cd: 2300, radius: 125, count: 1 },
      { dmg: 43, cd: 2100, radius: 140, count: 1 },
      { dmg: 55, cd: 1900, radius: 160, count: 2 },
      { dmg: 70, cd: 1700, radius: 180, count: 2 },
      // Эволюция «Молот приговора»: 3 слэма + цепные эхо-удары
      { dmg: 100, cd: 1350, radius: 230, count: 3 },
    ],
  },
  bomb: {
    id: 'bomb',
    name: t('weapon.bomb.name'),
    desc: t('weapon.bomb.desc'),
    icon: 'icon-bomb',
    levels: [
      { dmg: 30, cd: 3000, radius: 130, count: 1 },
      { dmg: 40, cd: 2800, radius: 145, count: 1 },
      { dmg: 52, cd: 2600, radius: 160, count: 1 },
      { dmg: 66, cd: 2400, radius: 180, count: 2 },
      { dmg: 84, cd: 2200, radius: 200, count: 2 },
      // Эволюция «Кластерный залп»: взрыв рождает 4 мини-бомбы.
      // Радиус не уменьшаем: эволюция должна быть строго лучше 5-го уровня.
      // Было 95/1800 = 105 DPS против 76 у пятого — выигрыш в 1.4 раза,
      // самый скромный в игре. Теперь 130*2/1.7 = 153, и к этому
      // добавляются четыре мини-бомбы.
      { dmg: 130, cd: 1700, radius: 235, count: 2 },
    ],
  },
  aura: {
    id: 'aura',
    name: t('weapon.aura.name'),
    desc: t('weapon.aura.desc'),
    icon: 'icon-aura',
    levels: [
      { dmg: 6, cd: 560, radius: 100 },
      { dmg: 9, cd: 540, radius: 115 },
      { dmg: 13, cd: 500, radius: 135 },
      { dmg: 18, cd: 460, radius: 160 },
      { dmg: 24, cd: 420, radius: 185 },
      // Эволюция «Нимб искупления»: нова-импульс + лечение.
      // Раньше эволюция давала 63 DPS — в десять раз меньше эволюции
      // ножей, за шесть карточек и полную прокачку «Регена».
      { dmg: 38, cd: 340, radius: 240 },
    ],
  },
  knives: {
    id: 'knives',
    name: t('weapon.knives.name'),
    desc: t('weapon.knives.desc'),
    icon: 'icon-knives',
    levels: [
      { dmg: 8, cd: 1050, count: 3, pierce: 2 },
      { dmg: 11, cd: 1000, count: 4, pierce: 2 },
      { dmg: 15, cd: 950, count: 4, pierce: 3 },
      { dmg: 20, cd: 900, count: 5, pierce: 3 },
      { dmg: 26, cd: 850, count: 6, pierce: 4 },
      // Эволюция «Танец клинков»: рикошет между врагами
      { dmg: 36, cd: 620, count: 9, pierce: 6 },
    ],
  },
};

export interface PassiveDef {
  id: PassiveId;
  name: string;
  desc: (lvl: number) => string;
  icon: string;
  max: number;
}

export const PASSIVES: Record<PassiveId, PassiveDef> = {
  boots: {
    id: 'boots', name: t('passive.boots.name'), max: 5, icon: 'icon-boots',
    desc: (l) => t('passive.boots.desc', { v: l * 10 }),
  },
  armor: {
    id: 'armor', name: t('passive.armor.name'), max: 5, icon: 'icon-shield',
    desc: (l) => t('passive.armor.desc', { v: l * 8 }),
  },
  magnet: {
    id: 'magnet', name: t('passive.magnet.name'), max: 5, icon: 'icon-magnet',
    desc: (l) => t('passive.magnet.desc', { v: l * 30 }),
  },
  regen: {
    id: 'regen', name: t('passive.regen.name'), max: 5, icon: 'icon-heart',
    desc: (l) => t('passive.regen.desc', { v: (l * 0.5).toFixed(1) }),
  },
  might: {
    id: 'might', name: t('passive.might.name'), max: 5, icon: 'icon-might',
    desc: (l) => t('passive.might.desc', { v: l * 12 }),
  },
  haste: {
    id: 'haste', name: t('passive.haste.name'), max: 5, icon: 'icon-haste',
    desc: (l) => t('passive.haste.desc', { v: l * 8 }),
  },
  vitality: {
    id: 'vitality', name: t('passive.vitality.name'), max: 5, icon: 'icon-meat',
    desc: (l) => t('passive.vitality.desc', { v: l * 25 }),
  },
  luck: {
    id: 'luck', name: t('passive.luck.name'), max: 5, icon: 'icon-coin',
    desc: (l) => t('passive.luck.desc', { v: l * 15 }),
  },
  wisdom: {
    id: 'wisdom', name: t('passive.wisdom.name'), max: 5, icon: 'icon-gem',
    desc: (l) => t('passive.wisdom.desc', { v: l * 15 }),
  },
};

// ============ Герои ============

export type HeroId = 'warrior' | 'archer' | 'lancer' | 'monk';

/**
 * Портрет героя: файл из `ui/avatars` пака плюс прямоугольник, в котором внутри
 * картинки 256×256 лежит сам персонаж (по краям пустое поле).
 *
 * Отдельных обрезанных копий в `src/assets/game` не делаем — грузим исходник
 * целиком и рисуем его со смещением: `origin` = центр этого прямоугольника,
 * масштаб = размер портрета / большая сторона рамки. Прямоугольники измерены
 * по файлам пака; какой портрет какому герю — в scripts/prepare-assets.mjs.
 */
export interface PortraitDef {
  /** Путь относительно src/assets/tiny-swords */
  file: string;
  /** Границы персонажа внутри картинки 256×256 */
  box: { x: number; y: number; w: number; h: number };
}

export interface HeroDef {
  id: HeroId;
  name: string;
  title: string;
  traits: string[];
  frameW: 192 | 320;
  scale: number;
  startWeapon: WeaponId;
  maxHp: number;
  speed: number;
  baseRegen: number;   // innate HP/s (монах)
  anims: { idle: string; run: string; atk1: string; atk2: string };
  /** Портрет из ui/avatars для карточки выбора */
  portrait: PortraitDef;
}

export const HEROES: Record<HeroId, HeroDef> = {
  warrior: {
    id: 'warrior', name: t('hero.warrior.name'), title: t('hero.warrior.title'),
    traits: [t('hero.warrior.t1'), t('hero.warrior.t2')],
    frameW: 192, scale: 0.55, startWeapon: 'sword',
    portrait: { file: 'ui/avatars/avatars-01.png', box: { x: 22, y: 31, w: 197, h: 182 } },
    maxHp: 110, speed: 200, baseRegen: 0,
    anims: { idle: 'player-idle', run: 'player-run', atk1: 'player-atk1', atk2: 'player-atk2' },
  },
  archer: {
    id: 'archer', name: t('hero.archer.name'), title: t('hero.archer.title'),
    traits: [t('hero.archer.t1'), t('hero.archer.t2'), t('hero.archer.t3')],
    frameW: 192, scale: 0.55, startWeapon: 'bow',
    portrait: { file: 'ui/avatars/avatars-03.png', box: { x: 64, y: 29, w: 140, h: 160 } },
    maxHp: 90, speed: 230, baseRegen: 0,
    anims: { idle: 'hero-archer-idle', run: 'hero-archer-run', atk1: 'hero-archer-atk', atk2: 'hero-archer-atk' },
  },
  lancer: {
    id: 'lancer', name: t('hero.lancer.name'), title: t('hero.lancer.title'),
    traits: [t('hero.lancer.t1'), t('hero.lancer.t2'), t('hero.lancer.t3')],
    frameW: 320, scale: 0.34, startWeapon: 'spear',
    portrait: { file: 'ui/avatars/avatars-02.png', box: { x: 52, y: 58, w: 149, h: 129 } },
    maxHp: 130, speed: 190, baseRegen: 0,
    anims: { idle: 'hero-lancer-idle', run: 'hero-lancer-run', atk1: 'hero-lancer-atk', atk2: 'hero-lancer-atk' },
  },
  monk: {
    id: 'monk', name: t('hero.monk.name'), title: t('hero.monk.title'),
    traits: [t('hero.monk.t1'), t('hero.monk.t2')],
    frameW: 192, scale: 0.55, startWeapon: 'aura',
    portrait: { file: 'ui/avatars/avatars-04.png', box: { x: 57, y: 44, w: 144, h: 155 } },
    maxHp: 100, speed: 195, baseRegen: 0.5,
    anims: { idle: 'hero-monk-idle', run: 'hero-monk-run', atk1: 'hero-monk-atk', atk2: 'hero-monk-atk' },
  },
};

// ============ Сложности ============

export type DifficultyId = 'normal' | 'nightmare';

export interface DifficultyDef {
  id: DifficultyId;
  name: string;
  tagline: string;
  hpMult: number;
  dmgMult: number;
  speedMult: number;
  rateMult: number;   // множитель интервала спавна (меньше = чаще)
  scoreMult: number;
}

export const DIFFICULTIES: Record<DifficultyId, DifficultyDef> = {
  normal: {
    id: 'normal', name: t('diff.normal.name'), tagline: t('diff.normal.tagline'),
    hpMult: 1, dmgMult: 1, speedMult: 1, rateMult: 1, scoreMult: 1,
  },
  nightmare: {
    id: 'nightmare', name: t('diff.nightmare.name'), tagline: t('diff.nightmare.tagline'),
    hpMult: 1.45, dmgMult: 1.25, speedMult: 1.1, rateMult: 0.85, scoreMult: 1.6,
  },
};

// ============ Враги ============

export type EnemyKind =
  | 'grunt' | 'swarm' | 'brute' | 'archer' | 'bomber'
  | 'guard' | 'taskmaster' | 'mercenary'
  | 'elite-lancer' | 'elite-monk' | 'boss' | 'boss-minion' | 'midboss';

export interface EnemyDef {
  kind: EnemyKind;
  name: string;
  texture: string;      // ключ текстуры спрайта
  frameW: number;       // ширина кадра (192, 320 или 64 у динамита)
  scale: number;
  bodyRadius: number;
  /** Круг коллизации в координатах кадра; если задан — заменяет расчёт от frameW */
  body?: { cx: number; cy: number; r: number };
  hp: number;
  speed: number;
  damage: number;
  xp: number;
  gem: string;          // текстура дропа
  isElite?: boolean;
  isBoss?: boolean;
  isMidboss?: boolean;  // промежуточный босс «Кошмара» (10-я минута)
  explodeDmg?: number;   // для бочки-камикадзе
  explodeRadius?: number;
  armorFront?: number;   // Гвардеец: доля урона, блокируемая щитом (0.5 = −50%)
  auraSpeed?: number;    // Приказчик: радиус ауры ускорения союзников
}

export const ENEMIES: Record<EnemyKind, EnemyDef> = {
  grunt: {
    kind: 'grunt', name: t('enemy.grunt.name'), texture: 'enemy-grunt', frameW: 192, scale: 0.5,
    bodyRadius: 20, hp: 12, speed: 70, damage: 8, xp: 1, gem: 'gem-blue',
  },
  swarm: {
    kind: 'swarm', name: t('enemy.swarm.name'), texture: 'enemy-swarm', frameW: 192, scale: 0.45,
    bodyRadius: 18, hp: 8, speed: 130, damage: 6, xp: 1, gem: 'gem-blue',
  },
  brute: {
    kind: 'brute', name: t('enemy.brute.name'), texture: 'enemy-brute', frameW: 192, scale: 0.62,
    bodyRadius: 26, hp: 55, speed: 55, damage: 16, xp: 3, gem: 'gem-green',
  },
  archer: {
    kind: 'archer', name: t('enemy.archer.name'), texture: 'enemy-archer', frameW: 192, scale: 0.5,
    bodyRadius: 20, hp: 20, speed: 60, damage: 8, xp: 3, gem: 'gem-green',
  },
  bomber: {
    // Динамит-камикадзе: спрайт-лист 384×64 (6 кадров по 64×64, горит фитиль).
    // Круг коллизии — по кадру 64×64: содержимое динамита 58×52 @ 20,1.
    kind: 'bomber', name: t('enemy.bomber.name'), texture: 'barrel', frameW: 64, scale: 0.42,
    bodyRadius: 17, body: { cx: 49, cy: 27, r: 24 },
    hp: 16, speed: 105, damage: 4, xp: 2, gem: 'gem-green',
    explodeDmg: 24, explodeRadius: 150,
  },
  // --- Новые враги 5–9 минут (v1.8) ---
  guard: {
    // Гвардеец: щит гасит половину урона; при потере 45% HP щит ломается —
    // ярость (без брони, но быстрее). HP понижено в R10: с 85 копились
    // неразменными стенами к 13-й минуте (эфф. HP 525 против 212 у громилы)
    kind: 'guard', name: t('enemy.guard.name'), texture: 'guard-idle', frameW: 192, scale: 0.58,
    // 5 XP за ~96 эффективного HP = 19 на опыт — сопоставимо с громилой
    // (18). Прежние 4 давали 24: плата за щит была выше выгоды.
    bodyRadius: 24, hp: 62, speed: 62, damage: 14, xp: 5, gem: 'gem-green',
    armorFront: 0.5,
  },
  taskmaster: {
    // Приказчик с молотом: разгоняет толпу (аура +30% скорости союзникам).
    // Приоритетная цель — убей его и толпа замедлится
    kind: 'taskmaster', name: t('enemy.taskmaster.name'), texture: 'taskmaster-idle', frameW: 192, scale: 0.5,
    bodyRadius: 20, hp: 30, speed: 78, damage: 10, xp: 5, gem: 'gem-purple',
    auraSpeed: 250,
  },
  mercenary: {
    // Наёмник-копейщик: телеграф + рывок (облегчённая версия элиты)
    kind: 'mercenary', name: t('enemy.mercenary.name'), texture: 'merc-idle', frameW: 320, scale: 0.55,
    bodyRadius: 24, hp: 48, speed: 88, damage: 18, xp: 4, gem: 'gem-green',
  },
  'elite-lancer': {
    kind: 'elite-lancer', name: t('enemy.elite-lancer.name'), texture: 'enemy-lancer', frameW: 320, scale: 0.75,
    bodyRadius: 34, hp: 400, speed: 90, damage: 25, xp: 25, gem: 'gem-red', isElite: true,
  },
  'elite-monk': {
    kind: 'elite-monk', name: t('enemy.elite-monk.name'), texture: 'enemy-monk', frameW: 192, scale: 0.6,
    bodyRadius: 24, hp: 350, speed: 75, damage: 12, xp: 25, gem: 'gem-red', isElite: true,
  },
  midboss: {
    kind: 'midboss', name: t('enemy.midboss.name'), texture: 'enemy-monk', frameW: 192, scale: 0.92,
    bodyRadius: 32, hp: 1500, speed: 82, damage: 20, xp: 36, gem: 'gem-red', isMidboss: true,
  },
  boss: {
    kind: 'boss', name: t('enemy.boss.name'), texture: 'boss', frameW: 320, scale: 2.0,
    // Босс — кульминация 15-минутного матча и обязан платить лучше
    // мидбосса: 200 XP и щедрая награда выдаются при смерти в GameScene.
    bodyRadius: 80, hp: 4000, speed: 110, damage: 40, xp: 200, gem: 'gem-red', isBoss: true,
  },
  'boss-minion': {
    kind: 'boss-minion', name: t('enemy.boss-minion.name'), texture: 'enemy-swarm', frameW: 192, scale: 0.5,
    bodyRadius: 20, hp: 14, speed: 140, damage: 10, xp: 5, gem: 'gem-purple',
  },
};

// ============ Директор волн ============

export interface WaveEvent {
  t: number;            // секунды от начала матча
  type: 'ring' | 'elite' | 'boss' | 'rate';
  enemy?: EnemyKind;
  count?: number;
  interval?: number;    // новый интервал спавна (мс)
  note?: string;
  diff?: DifficultyId;  // событие только для указанной сложности
}

export const WAVE_EVENTS: WaveEvent[] = [
  { t: 0,   type: 'rate', interval: 850 },
  { t: 60,  type: 'ring', enemy: 'swarm', count: 24 },
  { t: 60,  type: 'rate', interval: 700 },
  { t: 120, type: 'rate', interval: 620 },
  { t: 180, type: 'rate', interval: 560 },
  { t: 240, type: 'ring', enemy: 'brute', count: 14 },
  { t: 300, type: 'elite', enemy: 'elite-lancer' },
  { t: 300, type: 'rate', interval: 500 },
  { t: 330, type: 'ring', enemy: 'guard', count: 6, note: t('wave.note.shields') },
  { t: 390, type: 'ring', enemy: 'bomber', count: 8, note: t('wave.note.bombardment') },
  { t: 410, type: 'ring', enemy: 'taskmaster', count: 3, note: t('wave.note.overseers') },
  { t: 420, type: 'rate', interval: 450 },
  { t: 450, type: 'ring', enemy: 'mercenary', count: 5, note: t('wave.note.mercs') },
  { t: 480, type: 'ring', enemy: 'swarm', count: 32 },
  { t: 480, type: 'rate', interval: 400 },
  { t: 540, type: 'ring', enemy: 'guard', count: 8, note: t('wave.note.shields') },
  { t: 600, type: 'elite', enemy: 'elite-monk', diff: 'normal' },
  { t: 600, type: 'elite', enemy: 'midboss', diff: 'nightmare' },
  { t: 600, type: 'rate', interval: 370 },
  // 11:00 — смешанная волна: собираем всё, что уже встречалось
  { t: 660, type: 'ring', enemy: 'mercenary', count: 9, note: t('wave.note.mercs') },
  { t: 690, type: 'rate', interval: 350 },
  // 12:00 — бочки-камикадзе по плотной толпе
  { t: 720, type: 'ring', enemy: 'bomber', count: 14, note: t('wave.note.bombardment') },
  // 12:30 — приказчики: без игрока-цели толпа вязнет
  { t: 750, type: 'ring', enemy: 'taskmaster', count: 5, note: t('wave.note.overseers') },
  { t: 780, type: 'rate', interval: 330 },
  // 13:30 — щитоносцы, к моменту когда у игрока уже есть чем их вскрыть
  { t: 810, type: 'ring', enemy: 'guard', count: 12, note: t('wave.note.shields') },
  { t: 840, type: 'ring', enemy: 'brute', count: 20 },
  { t: 900, type: 'boss', enemy: 'boss' },
];

// Состав обычного спавна по минутам (веса)
export function pickRegularKind(minute: number, rng: () => number): EnemyKind {
  const r = rng();
  if (minute >= 3 && r < 0.22) return 'brute';
  if (minute >= 5 && r < 0.38) return 'archer';
  if (minute >= 1 && r < 0.62) return 'swarm';
  if (minute >= 4 && r < 0.74) return 'bomber';
  if (minute >= 5 && r < 0.86) return 'guard';
  if (minute >= 6 && r < 0.92) return 'taskmaster';
  if (minute >= 7 && r < 0.99) return 'mercenary';
  return 'grunt';
}

// Масштабирование врагов по минутам
export const hpScale = (minute: number) => 1 + minute * 0.22;
export const dmgScale = (minute: number) => 1 + minute * 0.12;

// ============ Карты апгрейдов ============

export interface UpgradeCard {
  kind: 'weapon-new' | 'weapon-up' | 'weapon-evolve' | 'passive' | 'heal' | 'gold';
  id?: WeaponId | PassiveId;
  title: string;
  subtitle: string;
  desc: string;
  icon: string;
  levelFrom?: number;
  levelTo?: number;
}
