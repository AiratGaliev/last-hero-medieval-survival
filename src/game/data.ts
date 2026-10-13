// ============ Данные: оружия, пассивки, враги, волны ============
// Источник баланса: docs/TZ.md

export type WeaponId = 'sword' | 'bow' | 'spear' | 'hammer' | 'bomb' | 'aura' | 'knives';
export type PassiveId = 'boots' | 'armor' | 'magnet' | 'regen' | 'might' | 'haste' | 'vitality' | 'luck' | 'wisdom';

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
    name: 'Меч воина',
    desc: 'Вихревой взмах по дуге вокруг воина',
    icon: 'icon-sword',
    levels: [
      { dmg: 12, cd: 900, count: 1 },
      { dmg: 16, cd: 850, count: 1 },
      { dmg: 21, cd: 800, count: 1 },
      { dmg: 27, cd: 750, count: 2 },
      { dmg: 34, cd: 700, count: 2 },
    ],
  },
  bow: {
    id: 'bow',
    name: 'Стрелы лучника',
    desc: 'Самонаводящиеся стрелы в ближайших врагов',
    icon: 'icon-bow',
    levels: [
      { dmg: 10, cd: 1100, count: 1, pierce: 1 },
      { dmg: 13, cd: 1000, count: 1, pierce: 1 },
      { dmg: 17, cd: 950, count: 2, pierce: 1 },
      { dmg: 22, cd: 900, count: 2, pierce: 2 },
      { dmg: 28, cd: 850, count: 3, pierce: 3 },
    ],
  },
  spear: {
    id: 'spear',
    name: 'Копьё копейщика',
    desc: 'Бросок копья по направлению движения, пробивает всех',
    icon: 'icon-spear',
    levels: [
      { dmg: 15, cd: 900, count: 1 },
      { dmg: 20, cd: 850, count: 1 },
      { dmg: 26, cd: 800, count: 2 },
      { dmg: 33, cd: 750, count: 2 },
      { dmg: 42, cd: 700, count: 3 },
    ],
  },
  hammer: {
    id: 'hammer',
    name: 'Молот кузнеца',
    desc: 'Мощный удар по земле с отбросом врагов',
    icon: 'icon-hammer',
    levels: [
      { dmg: 25, cd: 2500, radius: 110, count: 1 },
      { dmg: 33, cd: 2300, radius: 125, count: 1 },
      { dmg: 43, cd: 2100, radius: 140, count: 1 },
      { dmg: 55, cd: 1900, radius: 160, count: 2 },
      { dmg: 70, cd: 1700, radius: 180, count: 2 },
    ],
  },
  bomb: {
    id: 'bomb',
    name: 'Пороховая бочка',
    desc: 'Бочка летит в толпу и взрывается',
    icon: 'icon-bomb',
    levels: [
      { dmg: 30, cd: 3000, radius: 130, count: 1 },
      { dmg: 40, cd: 2800, radius: 145, count: 1 },
      { dmg: 52, cd: 2600, radius: 160, count: 1 },
      { dmg: 66, cd: 2400, radius: 180, count: 2 },
      { dmg: 84, cd: 2200, radius: 200, count: 2 },
    ],
  },
  aura: {
    id: 'aura',
    name: 'Огненная аура',
    desc: 'Пылающее кольцо, обжигающее всех вокруг',
    icon: 'icon-aura',
    levels: [
      { dmg: 4, cd: 600, radius: 90 },
      { dmg: 6, cd: 600, radius: 105 },
      { dmg: 8, cd: 550, radius: 120 },
      { dmg: 11, cd: 500, radius: 140 },
      { dmg: 15, cd: 450, radius: 165 },
    ],
  },
  knives: {
    id: 'knives',
    name: 'Метательные ножи',
    desc: 'Веер острых ножей в направлении движения',
    icon: 'icon-knives',
    levels: [
      { dmg: 8, cd: 1050, count: 3, pierce: 2 },
      { dmg: 11, cd: 1000, count: 4, pierce: 2 },
      { dmg: 15, cd: 950, count: 4, pierce: 3 },
      { dmg: 20, cd: 900, count: 5, pierce: 3 },
      { dmg: 26, cd: 850, count: 6, pierce: 4 },
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
    id: 'boots', name: 'Сапоги скорохода', max: 5, icon: 'icon-boots',
    desc: (l) => `Скорость передвижения +${l * 10}%`,
  },
  armor: {
    id: 'armor', name: 'Крепкий щит', max: 5, icon: 'icon-shield',
    desc: (l) => `Входящий урон −${l * 8}%`,
  },
  magnet: {
    id: 'magnet', name: 'Магнит жадности', max: 5, icon: 'icon-magnet',
    desc: (l) => `Радиус подбора опыта +${l * 30}%`,
  },
  regen: {
    id: 'regen', name: 'Сердце льва', max: 5, icon: 'icon-heart',
    desc: (l) => `Регенерация +${(l * 0.5).toFixed(1)} HP/с`,
  },
  might: {
    id: 'might', name: 'Мощь воина', max: 5, icon: 'icon-might',
    desc: (l) => `Урон оружия +${l * 12}%`,
  },
  haste: {
    id: 'haste', name: 'Молниеносность', max: 5, icon: 'icon-haste',
    desc: (l) => `Перезарядка оружия −${l * 8}%`,
  },
  vitality: {
    id: 'vitality', name: 'Пир мясника', max: 5, icon: 'icon-meat',
    desc: (l) => `Максимум HP +${l * 25}`,
  },
  luck: {
    id: 'luck', name: 'Удача авантюриста', max: 5, icon: 'icon-coin',
    desc: (l) => `Шанс критического удара +${l * 15}%`,
  },
  wisdom: {
    id: 'wisdom', name: 'Мудрость искателя', max: 5, icon: 'icon-gem',
    desc: (l) => `Получаемый опыт +${l * 15}%`,
  },
};

// ============ Герои ============

export type HeroId = 'warrior' | 'archer' | 'lancer' | 'monk';

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
}

export const HEROES: Record<HeroId, HeroDef> = {
  warrior: {
    id: 'warrior', name: 'Воин', title: 'Крепкий как скала',
    traits: ['+10% HP', 'старт: Меч'],
    frameW: 192, scale: 0.55, startWeapon: 'sword',
    maxHp: 110, speed: 200, baseRegen: 0,
    anims: { idle: 'player-idle', run: 'player-run', atk1: 'player-atk1', atk2: 'player-atk2' },
  },
  archer: {
    id: 'archer', name: 'Лучница', title: 'Быстрая стрела',
    traits: ['+15% скорость', '−10 HP', 'старт: Лук'],
    frameW: 192, scale: 0.55, startWeapon: 'bow',
    maxHp: 90, speed: 230, baseRegen: 0,
    anims: { idle: 'hero-archer-idle', run: 'hero-archer-run', atk1: 'hero-archer-atk', atk2: 'hero-archer-atk' },
  },
  lancer: {
    id: 'lancer', name: 'Копейщик', title: 'Стена из стали',
    traits: ['+30 HP', '−5% скорость', 'старт: Копьё'],
    frameW: 320, scale: 0.34, startWeapon: 'spear',
    maxHp: 130, speed: 190, baseRegen: 0,
    anims: { idle: 'hero-lancer-idle', run: 'hero-lancer-run', atk1: 'hero-lancer-atk', atk2: 'hero-lancer-atk' },
  },
  monk: {
    id: 'monk', name: 'Монах', title: 'Верный целитель',
    traits: ['+0.5 HP/с регенерация', 'старт: Аура'],
    frameW: 192, scale: 0.55, startWeapon: 'aura',
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
    id: 'normal', name: 'Поход', tagline: 'классическое приключение',
    hpMult: 1, dmgMult: 1, speedMult: 1, rateMult: 1, scoreMult: 1,
  },
  nightmare: {
    id: 'nightmare', name: 'Кошмар', tagline: 'враги свирепее, очки ×1.6',
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
  frameW: number;       // ширина кадра (192 или 320)
  scale: number;
  bodyRadius: number;
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
    kind: 'grunt', name: 'Пешка', texture: 'enemy-grunt', frameW: 192, scale: 0.5,
    bodyRadius: 20, hp: 12, speed: 70, damage: 8, xp: 1, gem: 'gem-blue',
  },
  swarm: {
    kind: 'swarm', name: 'Бегун', texture: 'enemy-swarm', frameW: 192, scale: 0.45,
    bodyRadius: 18, hp: 8, speed: 130, damage: 6, xp: 1, gem: 'gem-blue',
  },
  brute: {
    kind: 'brute', name: 'Громила', texture: 'enemy-brute', frameW: 192, scale: 0.62,
    bodyRadius: 26, hp: 55, speed: 55, damage: 16, xp: 3, gem: 'gem-green',
  },
  archer: {
    kind: 'archer', name: 'Лучник', texture: 'enemy-archer', frameW: 192, scale: 0.5,
    bodyRadius: 20, hp: 20, speed: 60, damage: 8, xp: 3, gem: 'gem-green',
  },
  bomber: {
    kind: 'bomber', name: 'Бочка-камикадзе', texture: 'barrel', frameW: 192, scale: 0.42,
    bodyRadius: 17, hp: 16, speed: 105, damage: 4, xp: 2, gem: 'gem-green',
    explodeDmg: 24, explodeRadius: 150,
  },
  // --- Новые враги 5–9 минут (v1.8) ---
  guard: {
    // Гвардеец: щит гасит половину урона; при потере 55% HP щит ломается —
    // ярость (без брони, но быстрее). HP понижено в R10: с 85 копились
    // неразменными стенами к 13-й минуте (эфф. HP 525 против 212 у громилы)
    kind: 'guard', name: 'Гвардеец', texture: 'guard-idle', frameW: 192, scale: 0.58,
    bodyRadius: 24, hp: 62, speed: 62, damage: 14, xp: 4, gem: 'gem-green',
    armorFront: 0.5,
  },
  taskmaster: {
    // Приказчик с молотом: разгоняет толпу (аура +30% скорости союзникам).
    // Приоритетная цель — убей его и толпа замедлится
    kind: 'taskmaster', name: 'Приказчик', texture: 'taskmaster-idle', frameW: 192, scale: 0.5,
    bodyRadius: 20, hp: 30, speed: 78, damage: 10, xp: 5, gem: 'gem-purple',
    auraSpeed: 250,
  },
  mercenary: {
    // Наёмник-копейщик: телеграф + рывок (облегчённая версия элиты)
    kind: 'mercenary', name: 'Копейщик-наёмник', texture: 'merc-idle', frameW: 320, scale: 0.55,
    bodyRadius: 24, hp: 48, speed: 88, damage: 18, xp: 4, gem: 'gem-green',
  },
  'elite-lancer': {
    kind: 'elite-lancer', name: 'Копейщик-изгой', texture: 'enemy-lancer', frameW: 320, scale: 0.75,
    bodyRadius: 34, hp: 400, speed: 90, damage: 25, xp: 25, gem: 'gem-red', isElite: true,
  },
  'elite-monk': {
    kind: 'elite-monk', name: 'Тёмный монах', texture: 'enemy-monk', frameW: 192, scale: 0.6,
    bodyRadius: 24, hp: 350, speed: 75, damage: 12, xp: 25, gem: 'gem-red', isElite: true,
  },
  midboss: {
    kind: 'midboss', name: 'ТЁМНЫЙ МОНАХ', texture: 'enemy-monk', frameW: 192, scale: 0.92,
    bodyRadius: 32, hp: 1500, speed: 82, damage: 20, xp: 0, gem: 'gem-red', isMidboss: true,
  },
  boss: {
    kind: 'boss', name: 'ЧЁРНЫЙ КОПЕЙЩИК', texture: 'boss', frameW: 320, scale: 2.0,
    bodyRadius: 80, hp: 4000, speed: 110, damage: 40, xp: 0, gem: 'gem-red', isBoss: true,
  },
  'boss-minion': {
    kind: 'boss-minion', name: 'Прислужник', texture: 'enemy-swarm', frameW: 192, scale: 0.5,
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
  { t: 330, type: 'ring', enemy: 'guard', count: 6, note: 'стена щитов' },
  { t: 390, type: 'ring', enemy: 'bomber', count: 8, note: 'бочковый залп' },
  { t: 410, type: 'ring', enemy: 'taskmaster', count: 3, note: 'надсмотрщики' },
  { t: 420, type: 'rate', interval: 450 },
  { t: 450, type: 'ring', enemy: 'mercenary', count: 5, note: 'отряд наёмников' },
  { t: 480, type: 'ring', enemy: 'swarm', count: 32 },
  { t: 480, type: 'rate', interval: 400 },
  { t: 540, type: 'ring', enemy: 'guard', count: 8, note: 'стена щитов' },
  { t: 600, type: 'elite', enemy: 'elite-monk', diff: 'normal' },
  { t: 600, type: 'elite', enemy: 'midboss', diff: 'nightmare' },
  { t: 600, type: 'rate', interval: 370 },
  { t: 780, type: 'rate', interval: 340 },
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
  kind: 'weapon-new' | 'weapon-up' | 'passive' | 'heal' | 'gold';
  id?: WeaponId | PassiveId;
  title: string;
  subtitle: string;
  desc: string;
  icon: string;
  levelFrom?: number;
  levelTo?: number;
}
