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

// ============ Враги — существа из пака enemies/ (TZ §A) ============
// Все спрайт-листы лежат в src/assets/tiny-swords/enemies/ и грузятся в
// BootScene циклом по CREATURE_SHEETS. Анимации называются `${kind}-<имя>`.

export type EnemyKind =
  | 'goblin' | 'thief' | 'gnoll' | 'skull' | 'shaman'
  | 'pig-rider' | 'bomb-fish'
  | 'spider' | 'snake' | 'lizard' | 'turtle'
  | 'gnome' | 'panda' | 'spear-goblin' | 'harpoon-shark' | 'paddle-shark'
  | 'bear' | 'minotaur' | 'boss';

export interface EnemyDef {
  kind: EnemyKind;
  name: string;
  /** Ширина кадра спрайт-листа (192 / 256 / 320 / 384) */
  frameW: number;
  scale: number;
  /** Круг коллизии в координатах кадра (измерен по контенту спрайтов) */
  body: { cx: number; cy: number; r: number };
  /** Y стопы в кадре — по нему ставится тень */
  groundY: number;
  /** Высота головы от центра кадра — по ней рисуется HP-бар крупных */
  headOffset?: number;
  /**
   * Ориентация листа: `false` — спрайт нарисован лицом влево.
   * По умолчанию листы считаются смотрящими вправо; флаг явно выставлен у
   * gnome, panda, spear-goblin, harpoon-shark и paddle-shark, чтобы `faceDir`
   * не заставлял этих существ двигаться спиной вперёд.
   */
  facesRight?: boolean;
  hp: number;
  speed: number;
  damage: number;
  xp: number;
  gem: string;          // текстура дропа
  isElite?: boolean;
  isBoss?: boolean;
  explodeDmg?: number;   // для рыбы-бомбы
  explodeRadius?: number;
  armorFront?: number;   // Доля входящего урона, которую гасит защита вида
  auraSpeed?: number;    // Шаман: радиус ауры ускорения союзников
  /** Урон по зданиям за удар (TZ §E.4.1, вариант A ×0.65) — НЕ производное от damage */
  buildingDmg?: number;
}

export const ENEMIES: Record<EnemyKind, EnemyDef> = {
  goblin: {
    // Гоблин с факелом (torch-goblin): базовая пехота с 0:00
    kind: 'goblin', name: t('enemy.goblin.name'), frameW: 192, scale: 0.5,
    body: { cx: 83, cy: 118, r: 20 }, groundY: 132,
    hp: 14, speed: 74, damage: 8, xp: 1, gem: 'gem-blue',
  },
  thief: {
    // Вор: быстрый фланговый, много HP не держит
    kind: 'thief', name: t('enemy.thief.name'), frameW: 192, scale: 0.5,
    body: { cx: 92, cy: 115, r: 16 }, groundY: 131,
    hp: 9, speed: 132, damage: 6, xp: 1, gem: 'gem-blue',
  },
  gnoll: {
    // Гнолл: держит дистанцию и швыряет вращающуюся кость (proj-bone)
    kind: 'gnoll', name: t('enemy.gnoll.name'), frameW: 192, scale: 0.6,
    body: { cx: 92, cy: 120, r: 22 }, groundY: 134,
    hp: 24, speed: 66, damage: 8, xp: 3, gem: 'gem-green',
    buildingDmg: 2,     // обычная кость: 2 HP за 1.5 с ≈ 1.3 HP/с
  },
  skull: {
    // Скелет-щитоносец: щит гасит 45% урона; при потере 40% HP — ярость
    kind: 'skull', name: t('enemy.skull.name'), frameW: 192, scale: 0.72,
    body: { cx: 95, cy: 116, r: 18 }, groundY: 129,
    hp: 60, speed: 56, damage: 13, xp: 5, gem: 'gem-green',
    armorFront: 0.45,
    buildingDmg: 1.3,   // 1.3 HP за удар × (1/1.5с) ≈ 0.8 HP/с (§E.4.1)
  },
  shaman: {
    // Гекс-шаман: колдун — держится поодаль, швыряет магический шар и
    // разгоняет толпу аурой (+30% скорости союзникам в 250 px)
    kind: 'shaman', name: t('enemy.shaman.name'), frameW: 192, scale: 0.62,
    body: { cx: 92, cy: 120, r: 20 }, groundY: 136,
    hp: 32, speed: 72, damage: 9, xp: 5, gem: 'gem-purple',
    auraSpeed: 250,
    buildingDmg: 5,     // огненный шар: 5 HP + 3 поджог каждые 3 с ≈ 2.6 HP/с
  },
  'pig-rider': {
    // Гоблин-всадник: телеграф 480 мс → рывок 420 px/s → отдых
    kind: 'pig-rider', name: t('enemy.pig-rider.name'), frameW: 256, scale: 0.55,
    body: { cx: 127, cy: 145, r: 32 }, groundY: 165,
    hp: 54, speed: 92, damage: 17, xp: 4, gem: 'gem-green',
    buildingDmg: 2.6,   // 2.6 HP/удар ≈ 1.6 HP/с + рывок 8 HP раз в 8 с
  },
  'bomb-fish': {
    // Рыба-бомба: камикадзе — разгоняется, мигает и взрывается
    kind: 'bomb-fish', name: t('enemy.bomb-fish.name'), frameW: 192, scale: 0.5,
    body: { cx: 92, cy: 118, r: 18 }, groundY: 134,
    hp: 18, speed: 108, damage: 4, xp: 2, gem: 'gem-green',
    explodeDmg: 24, explodeRadius: 150,
  },
  // Резервный набор раунда 2: эти существа могут входить в ежедневный пул.
  // Ориентация, хитбоксы и высота стоп заданы на каждый конкретный лист (§C.2).
  spider: {
    kind: 'spider', name: t('enemy.spider.name'), frameW: 192, scale: 0.5,
    body: { cx: 96, cy: 122, r: 18 }, groundY: 140,
    hp: 20, speed: 96, damage: 7, xp: 2, gem: 'gem-blue',
  },
  snake: {
    kind: 'snake', name: t('enemy.snake.name'), frameW: 192, scale: 0.52,
    body: { cx: 96, cy: 125, r: 16 }, groundY: 143,
    hp: 16, speed: 124, damage: 8, xp: 2, gem: 'gem-blue',
  },
  lizard: {
    kind: 'lizard', name: t('enemy.lizard.name'), frameW: 192, scale: 0.56,
    body: { cx: 96, cy: 124, r: 20 }, groundY: 143,
    hp: 32, speed: 78, damage: 12, xp: 4, gem: 'gem-green',
  },
  turtle: {
    kind: 'turtle', name: t('enemy.turtle.name'), frameW: 320, scale: 0.6,
    body: { cx: 160, cy: 210, r: 29 }, groundY: 239,
    hp: 90, speed: 38, damage: 16, xp: 8, gem: 'gem-green',
    armorFront: 0.2, // Панцирь уменьшает любой входящий урон.
  },
  gnome: {
    kind: 'gnome', name: t('enemy.gnome.name'), frameW: 192, scale: 0.53,
    body: { cx: 94, cy: 122, r: 18 }, groundY: 141, facesRight: false,
    hp: 18, speed: 112, damage: 7, xp: 2, gem: 'gem-blue',
  },
  panda: {
    kind: 'panda', name: t('enemy.panda.name'), frameW: 256, scale: 0.82,
    body: { cx: 128, cy: 160, r: 30 }, groundY: 188, facesRight: false,
    hp: 75, speed: 65, damage: 15, xp: 8, gem: 'gem-green',
    armorFront: 0.1, // Плотная стойка панды снижает входящий урон.
  },
  'spear-goblin': {
    kind: 'spear-goblin', name: t('enemy.spearGoblin.name'), frameW: 256, scale: 0.55,
    body: { cx: 128, cy: 145, r: 27 }, groundY: 167, facesRight: false,
    hp: 38, speed: 86, damage: 13, xp: 5, gem: 'gem-green',
  },
  'harpoon-shark': {
    kind: 'harpoon-shark', name: t('enemy.harpoonShark.name'), frameW: 192, scale: 0.58,
    body: { cx: 96, cy: 136, r: 23 }, groundY: 155, facesRight: false,
    hp: 42, speed: 78, damage: 12, xp: 5, gem: 'gem-green',
    buildingDmg: 2,
  },
  'paddle-shark': {
    kind: 'paddle-shark', name: t('enemy.paddleShark.name'), frameW: 192, scale: 0.5,
    body: { cx: 96, cy: 130, r: 22 }, groundY: 151, facesRight: false,
    hp: 30, speed: 100, damage: 10, xp: 4, gem: 'gem-green',
  },
  bear: {
    // Пещерный медведь (элита 5:00).
    kind: 'bear', name: t('enemy.bear.name'), frameW: 256, scale: 1.1,
    body: { cx: 131, cy: 150, r: 34 }, groundY: 178, headOffset: 49,
    hp: 400, speed: 84, damage: 24, xp: 25, gem: 'gem-red', isElite: true,
  },
  minotaur: {
    // Минотавр (элита 10:00): погон + периодический рывок с телеграфом
    kind: 'minotaur', name: t('enemy.minotaur.name'), frameW: 320, scale: 0.85,
    body: { cx: 130, cy: 180, r: 42 }, groundY: 213, headOffset: 77,
    hp: 1500, speed: 78, damage: 26, xp: 36, gem: 'gem-red', isElite: true,
  },
  boss: {
    // Огр-разрушитель: кульминация 15-минутного матча. Фазы:
    // замах (windup) → удар с рывком + ударная волна → восстановление.
    // Призыв гоблинов при HP < 65%, ярость при HP < 30%.
    kind: 'boss', name: t('enemy.boss.name'), frameW: 384, scale: 1.5,
    body: { cx: 198, cy: 250, r: 54 }, groundY: 296, headOffset: 111,
    hp: 4000, speed: 105, damage: 40, xp: 200, gem: 'gem-red', isBoss: true,
    buildingDmg: 8,     // фаза 2: по замку, ×3 темп = 15 HP/с (§E.6); НЕ ×0.65
  },
};

// ============ Директор волн ============

export type WaveEventType = 'ring' | 'elite' | 'boss' | 'rate' | 'siege';

export interface WaveEvent {
  t: number;            // секунды от начала матча
  type: WaveEventType;
  enemy?: EnemyKind;
  count?: number;
  interval?: number;    // новый интервал спавна (мс)
  note?: string;
  diff?: DifficultyId;  // событие только для указанной сложности
  /** Осада: состав отряда, цель профиля и лимит ранений (TZ §E.4.3) */
  siege?: { squad: Array<{ kind: EnemyKind; n: number; firer?: boolean }>; target: 'houses' | 'barracks' | 'monastery' | 'castle'; index: number };
}

export const WAVE_EVENTS: WaveEvent[] = [
  { t: 0,   type: 'rate', interval: 850 },
  // 1:00 — первое кольцо гоблинов
  { t: 60,  type: 'ring', enemy: 'goblin', count: 24 },
  { t: 60,  type: 'rate', interval: 700 },
  { t: 120, type: 'rate', interval: 620 },
  { t: 180, type: 'rate', interval: 560 },
  // 3:30 — воры заходят флангами
  { t: 210, type: 'ring', enemy: 'thief', count: 14, note: t('wave.note.thieves') },
  // 4:00 — первый стрелковый урон: гноллы
  { t: 240, type: 'ring', enemy: 'gnoll', count: 8, note: t('wave.note.gnolls') },
  { t: 240, type: 'rate', interval: 500 },
  // 5:00 — элита: пещерный медведь
  { t: 300, type: 'elite', enemy: 'bear' },
  // 5:30 — стена щитов скелетов
  { t: 330, type: 'ring', enemy: 'skull', count: 6, note: t('wave.note.shields') },
  { t: 420, type: 'rate', interval: 420 },
  // 7:30 — колдуны ведут толпу
  { t: 450, type: 'ring', enemy: 'shaman', count: 3, note: t('wave.note.shamans') },
  { t: 510, type: 'ring', enemy: 'goblin', count: 30 },
  { t: 540, type: 'rate', interval: 400 },
  { t: 570, type: 'ring', enemy: 'thief', count: 20, note: t('wave.note.thieves') },
  // 10:00 — элита: минотавр
  { t: 600, type: 'elite', enemy: 'minotaur' },
  { t: 630, type: 'ring', enemy: 'gnoll', count: 12, note: t('wave.note.gnolls') },
  { t: 630, type: 'rate', interval: 370 },
  { t: 690, type: 'ring', enemy: 'shaman', count: 5, note: t('wave.note.shamans') },
  { t: 720, type: 'rate', interval: 350 },
  // 12:30 — всадники с рывками
  { t: 750, type: 'ring', enemy: 'pig-rider', count: 5, note: t('wave.note.riders') },
  // 13:30 — рыбы-подрывники по плотной толпе
  { t: 810, type: 'ring', enemy: 'bomb-fish', count: 8, note: t('wave.note.bombfish') },
  { t: 840, type: 'rate', interval: 330 },
  // 14:00 — финальная орда гоблинов ~40 голов (TZ §A.3)
  { t: 840, type: 'ring', enemy: 'goblin', count: 40 },
  // 15:00 — Огр-разрушитель
  { t: 900, type: 'boss', enemy: 'boss' },
];

// ============ Осады (TZ §E.4.3): расписание и профили целей ============
// Ротация целей: окраины → ядро. Первая осада учит на домах, замок бьют
// последней. Приоритет §G.7 (замок > монастырь > казармы) работает ВНУТРИ
// профиля — если цель профиля отсутствует.
export interface SiegeProfile {
  t: number;
  name: string;         // ключ i18n
  squad: Array<{ kind: EnemyKind; n: number; firer?: boolean }>;
  target: 'houses' | 'barracks' | 'monastery' | 'castle';
  /** Вторичная цель: отряды поочерёдно распределяются между двумя объектами. */
  secondaryTarget?: 'houses' | 'barracks' | 'monastery' | 'castle';
  /** Explicit spawn geometry; omitted profiles keep the standard one-flank layout. */
  formation?: 'pincer';
  woundCap: number;
}

export const SIEGE_SCHEDULE: SiegeProfile[] = [
  { t: 360,  name: 'siege.profile.scout',  squad: [{ kind: 'skull', n: 3 }],                          target: 'houses', secondaryTarget: 'houses', woundCap: 1 },
  { t: 480,  name: 'siege.profile.raid',   squad: [{ kind: 'skull', n: 5 }],                          target: 'houses', secondaryTarget: 'barracks', woundCap: 1 },
  { t: 600,  name: 'siege.profile.burn',   squad: [{ kind: 'skull', n: 4 }, { kind: 'shaman', n: 2, firer: true }], target: 'monastery', woundCap: 2 },
  { t: 720,  name: 'siege.profile.pincer', squad: [{ kind: 'skull', n: 6 }, { kind: 'pig-rider', n: 4 }],           target: 'houses', secondaryTarget: 'barracks', formation: 'pincer', woundCap: 2 },
  { t: 810,  name: 'siege.profile.assault',squad: [{ kind: 'skull', n: 6 }, { kind: 'shaman', n: 2, firer: true }, { kind: 'pig-rider', n: 3 }], target: 'castle', woundCap: 3 },
];

// Состав обычного спавна по минутам (веса, TZ §A.3): с каждой минутой
// в пул входят более опасные существа и перераспределяют долю мелочи.
const SPAWN_WEIGHTS: Array<{ from: number; weights: Partial<Record<EnemyKind, number>> }> = [
  { from: 0,  weights: { goblin: 1 } },
  { from: 2,  weights: { goblin: 3, thief: 1 } },
  { from: 3,  weights: { goblin: 11, thief: 4, gnoll: 5 } },
  { from: 5,  weights: { goblin: 8, thief: 3, gnoll: 5, skull: 4 } },
  { from: 7,  weights: { goblin: 6, thief: 2.4, gnoll: 4, skull: 4, shaman: 3.6 } },
  { from: 9,  weights: { goblin: 5, thief: 2, gnoll: 3, skull: 3, shaman: 3, 'pig-rider': 4 } },
  { from: 11, weights: { goblin: 4, thief: 1.6, gnoll: 2.4, skull: 2.4, shaman: 2.4, 'pig-rider': 3.2, 'bomb-fish': 4 } },
];

/** Набор регулярных врагов, доступный в ежедневном варианте раунда 2. */
const DAILY_POOL_CANDIDATES: EnemyKind[] = [
  'goblin', 'thief', 'gnoll', 'skull', 'shaman', 'pig-rider', 'bomb-fish',
  'spider', 'snake', 'lizard', 'turtle', 'gnome', 'panda', 'spear-goblin',
  'harpoon-shark', 'paddle-shark',
];

/**
 * Стабильный поднабор врагов дня. Функция намеренно не использует Math.random:
 * одна дата/seed должна давать один и тот же набор во всех браузерах и прогонах.
 * Три базовых вида сохраняют читаемую кривую сложности, ещё шесть ротируются.
 */
export function pickDailyPool(seed: string): EnemyKind[] {
  let state = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    state ^= seed.charCodeAt(i);
    state = Math.imul(state, 16777619);
  }
  const required: EnemyKind[] = ['goblin', 'thief', 'gnoll'];
  const optional = DAILY_POOL_CANDIDATES.filter((kind) => !required.includes(kind));
  for (let i = optional.length - 1; i > 0; i--) {
    // xorshift32 даёт детерминированный Fisher–Yates без зависимости от среды.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const j = (state >>> 0) % (i + 1);
    [optional[i], optional[j]] = [optional[j], optional[i]];
  }
  return [...required, ...optional.slice(0, 6)];
}

export function pickRegularKind(
  minute: number,
  rng: () => number,
  allowedPool?: readonly EnemyKind[],
): EnemyKind {
  let source = SPAWN_WEIGHTS[0].weights;
  for (const row of SPAWN_WEIGHTS) {
    if (minute >= row.from) source = row.weights;
  }
  // В обычном ране используется исходная кривая без изменений. В ежедневном
  // ране отфильтровываем её по пулу и даём резервным видам небольшой вес,
  // чтобы новые виды действительно встречались, а не оставались только в кодексе.
  let weights: Partial<Record<EnemyKind, number>> = source;
  if (allowedPool?.length) {
    const filtered: Partial<Record<EnemyKind, number>> = {};
    for (const kind of allowedPool) {
      if (ENEMIES[kind].isElite || ENEMIES[kind].isBoss) continue;
      filtered[kind] = source[kind] ?? 1;
    }
    if (Object.keys(filtered).length > 0) weights = filtered;
  }
  let total = 0;
  for (const k in weights) total += weights[k] ?? 0;
  let r = rng() * total;
  for (const k in weights) {
    r -= weights[k] ?? 0;
    if (r < 0) return k as EnemyKind;
  }
  return 'goblin';
}

// Масштабирование врагов по минутам
export const hpScale = (minute: number) => 1 + minute * 0.22;
export const dmgScale = (minute: number) => 1 + minute * 0.12;

// ============ Поселение: пешки, ресурсы, здания (TZ §B) ============

export type PawnKind = 'collector' | 'builder' | 'repairer' | 'fighter' | 'healer';
export type PawnClass = 'civilian' | 'garrison';
export type PawnWeapon = 'sword' | 'lance' | 'bow' | 'staff';
export type PawnState =
  | 'idle' | 'walk' | 'work' | 'carry' | 'flee'
  | 'fight' | 'retreat' | 'kite' | 'heal'
  | 'wounded' | 'bleeding' | 'cooldown';
export type ResourceKind = 'wood' | 'meat' | 'ore';
export type BuildingKind = 'castle' | 'house' | 'barracks' | 'tower' | 'archery' | 'monastery';

export interface ResourceCost { wood?: number; ore?: number; meat?: number; }

export interface PawnDef {
  kind: PawnKind;
  cls: PawnClass;
  prefix: string;          // 'pawn' (синяя) / 'pawny' (жёлтая)
  speed: number;
  hp: number;
  /** Инструменты работы: work-анимация подбирается по ресурсу (§B.2). */
  tools?: Array<'axe' | 'pickaxe' | 'knife' | 'hammer'>;
  weapon?: PawnWeapon;
}

export const PAWNS: Record<PawnKind, PawnDef> = {
  collector: { kind: 'collector', cls: 'civilian', prefix: 'pawn', speed: 180, hp: 40, tools: ['axe', 'pickaxe', 'knife'] },
  builder:   { kind: 'builder',   cls: 'civilian', prefix: 'pawny', speed: 170, hp: 40, tools: ['hammer'] },
  repairer:  { kind: 'repairer',  cls: 'civilian', prefix: 'pawny', speed: 170, hp: 40, tools: ['hammer'] },
  fighter:   { kind: 'fighter',   cls: 'garrison', prefix: 'pawn', speed: 150, hp: 120, weapon: 'sword' },
  healer:    { kind: 'healer',    cls: 'garrison', prefix: 'pawn', speed: 150, hp: 90, weapon: 'staff' },
};

/**
 * Гарнизон: боевые характеристики. Никогда не умножаются на hpScale/dmgScale
 * и сложность — на 13-й минуте мечник остаётся 120 HP (TZ §C.3).
 */
export interface FighterDef {
  hp: number;
  dmg: number;
  range: number;
  period: number;      // мс между атаками
  speed: number;
  /** Копьё: рывок и телеграф (мс). */
  charge?: number;
  telegraph?: number;
  /** Лучник: приоритетная цель — осадный шаман (§B.7.1). */
  prioritise?: 'shaman';
}

export const FIGHTERS: Record<PawnWeapon, FighterDef> = {
  sword: { hp: 120, dmg: 14, range: 40, period: 1200, speed: 150 },
  lance: { hp: 100, dmg: 18, range: 200, period: 8000, speed: 170, charge: 400, telegraph: 480 },
  bow:   { hp: 70,  dmg: 10, range: 300, period: 1500, speed: 160, prioritise: 'shaman' },
  staff: { hp: 90,  dmg: 0,  range: 0,   period: 0,    speed: 150 },
};

/** Ресурсные узлы (TZ §B.3): дерево / овца / золотая жила. */
export interface ResourceDef {
  kind: ResourceKind;
  workMs: number;       // время одного тика работы
  yieldPerCycle: number;
  /** Сколько тиков работы даёт узел (дерево 5×0.8с → 5 дерева за цикл). */
  ticksPerCycle: number;
}

export const RESOURCES: Record<ResourceKind, ResourceDef> = {
  wood: { kind: 'wood', workMs: 800,  yieldPerCycle: 5,  ticksPerCycle: 5 },
  meat: { kind: 'meat', workMs: 750,  yieldPerCycle: 3,  ticksPerCycle: 4 },
  ore:  { kind: 'ore',  workMs: 1000, yieldPerCycle: 20, ticksPerCycle: 5 }, // 5 с работы → 20 руды за цикл, 4 цикла (§B.3)
};

export const TOOL_BY_RESOURCE: Record<ResourceKind, 'axe' | 'knife' | 'pickaxe'> = {
  wood: 'axe',
  meat: 'knife',
  ore: 'pickaxe',
};

/** Здания (TZ §B.4): стоимость, время стройки, HP, функция. */
export interface BuildingPlan {
  kind: BuildingKind;
  cost: ResourceCost;
  timeMs: number;
  hp: number;
  sprites?: string[];        // варианты (дом 1/2/3)
  slots?: number;            // места лечения (монастырь)
  noRepair?: boolean;
  /** Кого нанимает и в каком количестве. */
  hire?: Partial<Record<PawnWeapon, number>>;
}

export const BUILDING_PLANS: Record<BuildingKind, BuildingPlan> = {
  castle:    { kind: 'castle',    cost: {},                     timeMs: 0,    hp: 500, noRepair: true },
  house:     { kind: 'house',     cost: { wood: 30 },           timeMs: 10000, hp: 150, sprites: ['house1', 'house2', 'house3'] },
  barracks:  { kind: 'barracks',  cost: { wood: 40, ore: 15 },  timeMs: 20000, hp: 250, hire: { sword: 2, lance: 2 } },
  tower:     { kind: 'tower',     cost: { wood: 50, ore: 20 },  timeMs: 15000, hp: 200 },
  archery:   { kind: 'archery',   cost: { wood: 45, ore: 25 },  timeMs: 20000, hp: 180, hire: { bow: 2 } },
  monastery: { kind: 'monastery', cost: { wood: 60, ore: 40 },  timeMs: 25000, hp: 360, slots: 10, hire: { staff: 1 } },
};

/** Пятна стройки вокруг замка: 6 под дома + 4 под крупные (TZ §B.4).
 *  Замок стоит в (S/2, S/2 − 460); пятна заданы относительно него. */
export interface BuildSpot { kind: BuildingKind; dx: number; dy: number; }

export const BUILD_SPOTS: BuildSpot[] = [
  // Крупные здания вынесены на внешний пояс, чтобы прямоугольники спрайтов
  // не пересекались с домами при штатных масштабах Building.
  { kind: 'barracks', dx: -460, dy: -120 },
  { kind: 'tower',    dx: 480,  dy: -100 },
  { kind: 'monastery', dx: 0,   dy: 560 },
  { kind: 'archery',  dx: -560, dy: 500 },
  { kind: 'house', dx: -260, dy: 180 },
  { kind: 'house', dx: 260,  dy: 180 },
  { kind: 'house', dx: -60,  dy: 320 },
  { kind: 'house', dx: 140,  dy: 340 },
  { kind: 'house', dx: -340, dy: 380 },
  { kind: 'house', dx: 340,  dy: 380 },
];

/** Порядок найма: казармы/тир/обитель дают своих бойцов (TZ §F.6). */
export const SUCCESSION_SOURCES: BuildingKind[] = ['barracks', 'archery', 'monastery'];

/** Преемственность (TZ §F.6–F.8): оружие → герой, здание-источник. */
export const SUCCESSION_TYPES: Array<{ weapon: PawnWeapon; hero: HeroId; source: BuildingKind }> = [
  { weapon: 'sword', hero: 'warrior', source: 'barracks' },
  { weapon: 'lance', hero: 'lancer', source: 'barracks' },
  { weapon: 'bow', hero: 'archer', source: 'archery' },
  { weapon: 'staff', hero: 'monk', source: 'monastery' },
];

/**
 * Здание-источник воина по его подтипу (TZ §B.2, §F.6).
 *
 * Живёт здесь, а не в Economy: PawnAI ↔ Economy импортируют друг друга
 * (цикл), и статический метод класса пришлось бы импортировать как значение,
 * что ломает цикл. Здесь модуль данных — Phaser-зависимостей нет.
 */
export function garrisonSourceOf(weapon: PawnWeapon): BuildingKind {
  return weapon === 'bow' ? 'archery'
    : weapon === 'staff' ? 'monastery'
      : 'barracks';
}

/** Эскалация цены преемственности за ресурсы (TZ §F.7). */
export const SUCCESSION_COST: ResourceCost[] = [
  { wood: 40, ore: 15 },
  { wood: 80, ore: 35 },
  { wood: 140, ore: 60 },
];
export const SUCCESSION_GOLD = [500, 900, 1500];

/** Карточки поселения (TZ §H.5): в пул левел-апа после первого дома. */
export interface SettlementCardDef {
  id: string;
  rarity: 'common' | 'rare' | 'epic';
  icon: string;
}

export const SETTLEMENT_CARDS: SettlementCardDef[] = [
  { id: 'forestry', rarity: 'common', icon: 'res-wood' },
  { id: 'masonry', rarity: 'common', icon: 'icon-shield' },
  { id: 'provisions', rarity: 'common', icon: 'res-meat' },
  { id: 'deepmines', rarity: 'rare', icon: 'res-ore' },
  { id: 'fieldmedic', rarity: 'rare', icon: 'icon-heart' },
  { id: 'militia', rarity: 'rare', icon: 'icon-sword' },
  { id: 'alarm', rarity: 'rare', icon: 'icon-haste' },
  { id: 'assembly', rarity: 'epic', icon: 'icon-coin' },
];

/** Имена пешек (Приложение A1): титул по роли — в i18n.
 *  RU-пул (PAWN_NAMES_RU) выбирается в Economy по lang(). */
export const PAWN_NAMES: Record<string, string[]> = {
  male: [
    'Thomas', 'Aldric', 'Cedric', 'Rowan', 'Bram', 'Godwin', 'Hal', 'Oswald',
    'Perrin', 'Wulfric', 'Edgar', 'Milo', 'Osbert', 'Ralf', 'Simon', 'Turin',
    'Wat', 'Yorick', 'Alwin', 'Dunstan',
  ],
  female: [
    'Agnes', 'Maud', 'Aveline', 'Beatrice', 'Cecilia', 'Edith', 'Gwyn', 'Hawise',
    'Ida', 'Joan', 'Katherine', 'Lettice', 'Matilda', 'Nesta', 'Odile', 'Philippa',
    'Rosamund', 'Sabina', 'Thomasin', 'Wulfhilda',
  ],
};

/** Имена пешек для русской локали (Приложение A1). */
export const PAWN_NAMES_RU: Record<string, string[]> = {
  male: [
    'Томас', 'Кузьма', 'Яромир', 'Милован', 'Радим', 'Захар', 'Лукьян', 'Демьян',
    'Прохор', 'Савелий', 'Елисей', 'Гордей', 'Матвей', 'Игнат', 'Фаддей', 'Влас',
    'Назар', 'Тихон', 'Устин', 'Фрол',
  ],
  female: [
    'Милана', 'Агата', 'Василиса', 'Злата', 'Лукерья', 'Пелагея', 'Дарёна', 'Улита',
    'Февронья', 'Глафира', 'Аксинья', 'Мирослава', 'Аграфена', 'Веста', 'Добрава',
    'Ждана', 'Забава', 'Любава', 'Неждана', 'Снежана',
  ],
};

// ============ Карты апгрейдов ============

export interface UpgradeCard {
  kind: 'weapon-new' | 'weapon-up' | 'weapon-evolve' | 'passive' | 'heal' | 'gold' | 'settlement';
  id?: WeaponId | PassiveId | string;
  title: string;
  subtitle: string;
  desc: string;
  icon: string;
  levelFrom?: number;
  levelTo?: number;
  rarity?: 'common' | 'rare' | 'epic';
}
