// ============ Данные: оружия, пассивки, враги, волны ============
// Источник баланса: docs/TZ.md

export type WeaponId = 'sword' | 'bow' | 'spear' | 'hammer' | 'bomb' | 'aura';
export type PassiveId = 'boots' | 'armor' | 'magnet' | 'regen' | 'might' | 'haste' | 'vitality' | 'luck';

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
};

// ============ Враги ============

export type EnemyKind =
  | 'grunt' | 'swarm' | 'brute' | 'archer'
  | 'elite-lancer' | 'elite-monk' | 'boss' | 'boss-minion';

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
  'elite-lancer': {
    kind: 'elite-lancer', name: 'Копейщик-изгой', texture: 'enemy-lancer', frameW: 320, scale: 0.75,
    bodyRadius: 34, hp: 400, speed: 90, damage: 25, xp: 25, gem: 'gem-red', isElite: true,
  },
  'elite-monk': {
    kind: 'elite-monk', name: 'Тёмный монах', texture: 'enemy-monk', frameW: 192, scale: 0.6,
    bodyRadius: 24, hp: 350, speed: 75, damage: 12, xp: 25, gem: 'gem-red', isElite: true,
  },
  boss: {
    kind: 'boss', name: 'ЧЁРНЫЙ КОПЕЙЩИК', texture: 'boss', frameW: 320, scale: 2.0,
    bodyRadius: 80, hp: 3000, speed: 110, damage: 40, xp: 0, gem: 'gem-red', isBoss: true,
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
  { t: 420, type: 'rate', interval: 450 },
  { t: 480, type: 'ring', enemy: 'swarm', count: 32 },
  { t: 480, type: 'rate', interval: 400 },
  { t: 600, type: 'elite', enemy: 'elite-monk' },
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
