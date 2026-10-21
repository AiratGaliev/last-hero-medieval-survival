// ============ Мета-состояние раунда 2 (TZ §H.16–H.18, §J, ROADMAP фазы Q/S) ============
//
// Единый источник мета-прогресса:
//   • слава и дерево «Хроника Долины» (§H.16);
//   • задания дня и указы короля (§H.17);
//   • сезонная ось и испытание недели (§H.18);
//   • ежедневный бонус, вызов дня, контракты, кодекс, цепочки достижений,
//     бесконечный режим (§H.7–H.12);
//   • кроны, скины, расходники, пропуск «Хроника» (§J, фаза S).
//
// Модуль без Phaser-зависимостей. Названия узлов/заданий хранятся как ключи
// i18n и переводятся в момент отрисовки — словарь грузится до сцены, а этот
// модуль может вычисляться раньше. Хранение — localStorage (SDK Яндекса
// подменяет его надёжным облачным хранилищем, см. platform/sdk.ts).
//
// ⚠️ Норматив заповедника славы (TZ §H.16, гейт 38): слава НЕ продаётся —
// ни одна функция здесь не тратит её и не конвертирует в неё другие валюты.
// Единственный источник — gloryForRun() по итогам матча.

import { loadJson, saveJson } from './storage';
import {
  depositGold, loadShop, restoreShopState, setShopSavedListener, type ShopState,
} from './shop';
import { serverNow } from '../platform/sdk';
import { track } from '../platform/analytics';
import {
  persistExperimentFlagsToPlayerData,
  readPlayerDataEntry,
  writePlayerDataValue,
} from '../platform/player';
import { FTUE_MATCH_GATE } from './data';

// ============================================================
// Справочник дерева «Хроника Долины» (§H.16): 30 узлов, 3 ветви
// ============================================================

export type TreeBranch = 'economy' | 'defence' | 'military';
export type NodeId = string;

export interface TreeNodeDef {
  id: NodeId;
  branch: TreeBranch;
  nameKey: string;
  descKey: string;
  cost: number;
  /** Ключ эффекта — применяется через NodeEffects (см. ниже). */
  effect: keyof NodeEffects | 'passiveKeep' | 'xpKeep1' | 'xpKeep2';
}

/**
 * Эффекты дерева. Правило честности лидерборда (§H.16, нормативно):
 * ни один узел не даёт урона, HP героя, множителей XP и очков — только
 * стартовые удобства, экономику и выживание поселения. Единственное
 * исключение — «Первый урок» (startLevel: +1 стартовый уровень).
 */
export interface NodeEffects {
  pawnSpeedMult: number;       // «Торопливые ноги» — скорость пешек ×1.08
  workSpeedMult: number;       // «Умелые топоры» — работа у ресурса ×1.10
  buildCostMult: number;       // «Скидки казны» — цены зданий ×0.85
  startWood: number;           // «Стартовые припасы» — +15 дерева
  startOre: number;            // «Стартовые припасы» — +10 руды
  extraCollector: number;      // «Дополнительный сборщик» — старт 3 сборщика
  extraBuildSpots: number;     // «Шестое пятно» — +1 пятно под дом
  sheepYieldMult: number;      // «Пастбище» — мясо овцы ×1.25
  hireCostMult: number;        // «Сытые вербовщики» — наём воинов ×0.80
  veinYieldMult: number;       // «Золотая жила» — руда ×1.25
  gloryCapBonus: number;       // «Почётный гражданин» — потолок славы +100
  buildingHpMult: number;      // «Каменные стены» — HP зданий ×1.10
  healHpsBonus: number;        // «Чистые перевязи» — лечение обители +3 HP/с
  siegeWarnBonus: number;      // «Дозорные» — анонс осады +2 сек
  repairCostMult: number;      // «Сметливые ремонтники» — ремонт ×0.75
  startSword: boolean;         // «Гарнизон долины» — стартовый мечник
  monkHpsBonus: number;        // «Братья-целители» — монах +2 HP/с
  healWoodMult: number;        // «Бережные руки» — дерево за лечение ×0.70
  heroShieldMs: number;        // «Вторые ворота» — щит героя 5 сек
  garrisonSlotsBonus: number;  // «Ополчение» — +1 слот военных глобально
  houseHpMult: number;         // «Неприступный дом» — HP домов ×1.25
  startLevelBonus: number;     // «Первый урок» — +1 стартовый уровень героя
  successionCostMult: number;  // «Дорога героя» — цена преемства ×0.90
  xpKeep: number;              // «Крепкая память I/II» — преемник хранит 25/50% XP
  bowMonkCostMult: number;     // «Верный конёк» — наём лучника и монаха ×0.80
  hireTimeMult: number;        // «Наёмная гильдия» — вербовка 8 с → 5 с (×0.625)
  barracksSlotsBonus: number;  // «Знамя дружины» — +1 слот мечников на казармы
  successionPassiveKeep: boolean; // «Наследие мастера» — преемник хранит пассивку I
  gloryMult: number;           // «Легенда Долины» — слава за матч ×1.10 (до потолка)
}

const NEUTRAL: NodeEffects = {
  pawnSpeedMult: 1, workSpeedMult: 1, buildCostMult: 1,
  startWood: 0, startOre: 0, extraCollector: 0, extraBuildSpots: 0,
  sheepYieldMult: 1, hireCostMult: 1, veinYieldMult: 1, gloryCapBonus: 0,
  buildingHpMult: 1, healHpsBonus: 0, siegeWarnBonus: 0, repairCostMult: 1,
  startSword: false, monkHpsBonus: 0, healWoodMult: 1, heroShieldMs: 0,
  garrisonSlotsBonus: 0, houseHpMult: 1, startLevelBonus: 0,
  successionCostMult: 1, xpKeep: 0, bowMonkCostMult: 1, hireTimeMult: 1,
  barracksSlotsBonus: 0, successionPassiveKeep: false, gloryMult: 1,
};

export const TREE_NODES: TreeNodeDef[] = [
  // Экономика (§H.16)
  { id: 'e1', branch: 'economy', nameKey: 'tree.e1.name', descKey: 'tree.e1.desc', cost: 50, effect: 'pawnSpeedMult' },
  { id: 'e2', branch: 'economy', nameKey: 'tree.e2.name', descKey: 'tree.e2.desc', cost: 100, effect: 'workSpeedMult' },
  { id: 'e3', branch: 'economy', nameKey: 'tree.e3.name', descKey: 'tree.e3.desc', cost: 150, effect: 'buildCostMult' },
  { id: 'e4', branch: 'economy', nameKey: 'tree.e4.name', descKey: 'tree.e4.desc', cost: 150, effect: 'startWood' },
  { id: 'e5', branch: 'economy', nameKey: 'tree.e5.name', descKey: 'tree.e5.desc', cost: 200, effect: 'extraCollector' },
  { id: 'e6', branch: 'economy', nameKey: 'tree.e6.name', descKey: 'tree.e6.desc', cost: 200, effect: 'extraBuildSpots' },
  { id: 'e7', branch: 'economy', nameKey: 'tree.e7.name', descKey: 'tree.e7.desc', cost: 250, effect: 'sheepYieldMult' },
  { id: 'e8', branch: 'economy', nameKey: 'tree.e8.name', descKey: 'tree.e8.desc', cost: 250, effect: 'hireCostMult' },
  { id: 'e9', branch: 'economy', nameKey: 'tree.e9.name', descKey: 'tree.e9.desc', cost: 300, effect: 'veinYieldMult' },
  { id: 'e10', branch: 'economy', nameKey: 'tree.e10.name', descKey: 'tree.e10.desc', cost: 500, effect: 'gloryCapBonus' },
  // Оборона (§H.16)
  { id: 'd1', branch: 'defence', nameKey: 'tree.d1.name', descKey: 'tree.d1.desc', cost: 50, effect: 'buildingHpMult' },
  { id: 'd2', branch: 'defence', nameKey: 'tree.d2.name', descKey: 'tree.d2.desc', cost: 100, effect: 'healHpsBonus' },
  { id: 'd3', branch: 'defence', nameKey: 'tree.d3.name', descKey: 'tree.d3.desc', cost: 150, effect: 'siegeWarnBonus' },
  { id: 'd4', branch: 'defence', nameKey: 'tree.d4.name', descKey: 'tree.d4.desc', cost: 150, effect: 'repairCostMult' },
  { id: 'd5', branch: 'defence', nameKey: 'tree.d5.name', descKey: 'tree.d5.desc', cost: 200, effect: 'startSword' },
  { id: 'd6', branch: 'defence', nameKey: 'tree.d6.name', descKey: 'tree.d6.desc', cost: 200, effect: 'monkHpsBonus' },
  { id: 'd7', branch: 'defence', nameKey: 'tree.d7.name', descKey: 'tree.d7.desc', cost: 250, effect: 'healWoodMult' },
  { id: 'd8', branch: 'defence', nameKey: 'tree.d8.name', descKey: 'tree.d8.desc', cost: 250, effect: 'heroShieldMs' },
  { id: 'd9', branch: 'defence', nameKey: 'tree.d9.name', descKey: 'tree.d9.desc', cost: 300, effect: 'garrisonSlotsBonus' },
  { id: 'd10', branch: 'defence', nameKey: 'tree.d10.name', descKey: 'tree.d10.desc', cost: 500, effect: 'houseHpMult' },
  // Воинство (§H.16)
  { id: 'm1', branch: 'military', nameKey: 'tree.m1.name', descKey: 'tree.m1.desc', cost: 150, effect: 'startLevelBonus' },
  { id: 'm2', branch: 'military', nameKey: 'tree.m2.name', descKey: 'tree.m2.desc', cost: 150, effect: 'successionCostMult' },
  { id: 'm3', branch: 'military', nameKey: 'tree.m3.name', descKey: 'tree.m3.desc', cost: 200, effect: 'xpKeep1' },
  { id: 'm4', branch: 'military', nameKey: 'tree.m4.name', descKey: 'tree.m4.desc', cost: 200, effect: 'bowMonkCostMult' },
  { id: 'm5', branch: 'military', nameKey: 'tree.m5.name', descKey: 'tree.m5.desc', cost: 200, effect: 'hireTimeMult' },
  { id: 'm6', branch: 'military', nameKey: 'tree.m6.name', descKey: 'tree.m6.desc', cost: 250, effect: 'barracksSlotsBonus' },
  { id: 'm7', branch: 'military', nameKey: 'tree.m7.name', descKey: 'tree.m7.desc', cost: 300, effect: 'xpKeep2' },
  { id: 'm8', branch: 'military', nameKey: 'tree.m8.name', descKey: 'tree.m8.desc', cost: 300, effect: 'startSword' },
  // «Клятва долины» (m8) — стартовый мечник получает +20 HP: буст применяется сценой.
  { id: 'm9', branch: 'military', nameKey: 'tree.m9.name', descKey: 'tree.m9.desc', cost: 350, effect: 'passiveKeep' },
  { id: 'm10', branch: 'military', nameKey: 'tree.m10.name', descKey: 'tree.m10.desc', cost: 500, effect: 'gloryMult' },
];

const NODE_EFFECT_VALUES: Partial<Record<keyof NodeEffects, number | boolean>> = {
  pawnSpeedMult: 1.08,
  workSpeedMult: 1.10,
  buildCostMult: 0.85,
  startWood: 15,
  startOre: 10,
  extraCollector: 1,
  extraBuildSpots: 1,
  sheepYieldMult: 1.25,
  hireCostMult: 0.80,
  veinYieldMult: 1.25,
  gloryCapBonus: 100,
  buildingHpMult: 1.10,
  healHpsBonus: 3,
  siegeWarnBonus: 2,
  repairCostMult: 0.75,
  startSword: true,
  monkHpsBonus: 2,
  healWoodMult: 0.70,
  heroShieldMs: 5000,
  garrisonSlotsBonus: 1,
  houseHpMult: 1.25,
  startLevelBonus: 1,
  successionCostMult: 0.90,
  bowMonkCostMult: 0.80,
  hireTimeMult: 0.625,
  barracksSlotsBonus: 1,
  successionPassiveKeep: true,
  gloryMult: 1.10,
  // xpKeep складывается узлами I (0.25) и II (0.50) — мультипликативно не считается
};

/** Суммарные эффекты купленных узлов дерева. */
export function nodeEffects(nodes: string[]): NodeEffects {
  const out: NodeEffects = { ...NEUTRAL };
  let xpKeep = 0;
  for (const id of nodes) {
    const def = TREE_NODES.find((n) => n.id === id);
    if (!def) continue;
    if (def.effect === 'xpKeep1') { xpKeep = Math.max(xpKeep, 0.25); continue; }
    if (def.effect === 'xpKeep2') { xpKeep = Math.max(xpKeep, 0.50); continue; }
    if (def.effect === 'passiveKeep') { out.successionPassiveKeep = true; continue; }
    const v = NODE_EFFECT_VALUES[def.effect as keyof NodeEffects];
    if (v === undefined) continue;
    if (typeof v === 'boolean') {
      (out[def.effect as 'startSword' | 'successionPassiveKeep'] as boolean) = true;
      continue;
    }
    const key = def.effect as keyof NodeEffects;
    const cur = out[key] as number;
    // Мультипликативные эффекты перемножаются, аддитивные складываются
    (out[key] as number) = key.toLowerCase().includes('mult') ? cur * (v as number) : cur + (v as number);
  }
  // «Клятва долины» (m8): стартовый мечник получает +20 HP — отдельный флаг
  out.xpKeep = xpKeep;
  return out;
}

// ============================================================
// Слава (§H.16)
// ============================================================

export const GLORY = {
  /** floor(SCORE / 100) — счёт 8000–15000 даёт 80–150 славы. */
  PER_SCORE: 100,
  /** Кап за матч: модификаторы и ×2 за рекламу его НЕ поднимают. */
  CAP: 300,
  /** Бонус идеальной победы — единственный способ превысить кап (+100). */
  IDEAL_BONUS: 100,
} as const;

export interface GloryResult {
  /** Начислено по формуле с учётом множителей, но до бонуса. */
  base: number;
  /** Бонус идеальной победы (слой 3). */
  bonus: number;
  /** Итого к зачислению в MetaState. */
  total: number;
  /** Действующий потолок (300 или 400 с «Почётным гражданином»). */
  cap: number;
}

/**
 * Слава за матч. Все множители (указ короля, «Легенда Долины», ×2 за
 * рекламу R9) применяются ДО потолка — кап невозможно обойти.
 */
export function gloryForRun(
  score: number,
  ideal: boolean,
  opts: { ukazMult?: number; gloryMult?: number; doubled?: number; gloryCapBonus?: number } = {},
): GloryResult {
  const cap = GLORY.CAP + Math.max(0, Math.floor(opts.gloryCapBonus ?? 0));
  const raw = Math.floor(Math.max(0, score) / GLORY.PER_SCORE);
  const mult = Math.max(0, opts.ukazMult ?? 1) * Math.max(0, opts.gloryMult ?? 1) * Math.max(0, opts.doubled ?? 1);
  const base = Math.min(cap, Math.floor(raw * mult));
  const bonus = ideal ? GLORY.IDEAL_BONUS : 0;
  return { base, bonus, total: base + bonus, cap };
}

/**
 * Сколько славы добавит точка R9 (×2 за рекламу, end-экран). Удваивает
 * начисление в пределах того же потолка — сам потолок не поднимает (§H.16).
 */
export function gloryDoubleExtra(g: GloryResult): number {
  return Math.max(0, Math.min(g.cap, g.base * 2) - g.base);
}

// ============================================================
// Задания дня (§H.17): 3 из пула 18, ротация по серверной дате
// ============================================================

export type QuestMetric =
  | 'buildings' | 'siegesDefended' | 'monasteryHealed' | 'healHp' | 'idealWin'
  | 'hires' | 'successionBoss' | 'kills' | 'firstHouseMin' | 'barracks'
  | 'monastery' | 'archery' | 'veterans' | 'gold' | 'score' | 'time'
  | 'bestCombo' | 'noSuccessionBoss';

export interface QuestDef {
  id: string;
  metric: QuestMetric;
  goal: number;
  /** Награда — только слава (§H.17). */
  reward: number;
  /** true — прогресс «лучший за матч», false — накапливается за день. */
  perRun: boolean;
  descKey: string;
}

export const QUEST_POOL: QuestDef[] = [
  { id: 'q_new_house', metric: 'buildings', goal: 3, reward: 40, perRun: true, descKey: 'quest.q_new_house' },
  { id: 'q_shield_wall', metric: 'siegesDefended', goal: 2, reward: 50, perRun: true, descKey: 'quest.q_shield_wall' },
  { id: 'q_mercy', metric: 'monasteryHealed', goal: 5, reward: 40, perRun: true, descKey: 'quest.q_mercy' },
  { id: 'q_bright_hand', metric: 'healHp', goal: 60, reward: 35, perRun: true, descKey: 'quest.q_bright_hand' },
  { id: 'q_ideal_final', metric: 'idealWin', goal: 1, reward: 100, perRun: true, descKey: 'quest.q_ideal_final' },
  { id: 'q_druzhina', metric: 'hires', goal: 3, reward: 35, perRun: true, descKey: 'quest.q_druzhina' },
  { id: 'q_heir', metric: 'successionBoss', goal: 1, reward: 70, perRun: true, descKey: 'quest.q_heir' },
  { id: 'q_kills_150', metric: 'kills', goal: 150, reward: 35, perRun: true, descKey: 'quest.q_kills_150' },
  { id: 'q_first_house', metric: 'firstHouseMin', goal: 2, reward: 35, perRun: true, descKey: 'quest.q_first_house' },
  { id: 'q_barracks', metric: 'barracks', goal: 1, reward: 40, perRun: true, descKey: 'quest.q_barracks' },
  { id: 'q_monastery', metric: 'monastery', goal: 1, reward: 45, perRun: true, descKey: 'quest.q_monastery' },
  { id: 'q_archery', metric: 'archery', goal: 1, reward: 40, perRun: true, descKey: 'quest.q_archery' },
  { id: 'q_veteran', metric: 'veterans', goal: 1, reward: 45, perRun: true, descKey: 'quest.q_veteran' },
  { id: 'q_gold_800', metric: 'gold', goal: 800, reward: 40, perRun: true, descKey: 'quest.q_gold_800' },
  { id: 'q_score_10k', metric: 'score', goal: 10000, reward: 45, perRun: true, descKey: 'quest.q_score_10k' },
  { id: 'q_survive_10', metric: 'time', goal: 600, reward: 35, perRun: true, descKey: 'quest.q_survive_10' },
  { id: 'q_combo_50', metric: 'bestCombo', goal: 50, reward: 45, perRun: true, descKey: 'quest.q_combo_50' },
  { id: 'q_no_death', metric: 'noSuccessionBoss', goal: 1, reward: 50, perRun: true, descKey: 'quest.q_no_death' },
];

export interface QuestDayState {
  date: string;                                  // 'YYYY-MM-DD' (серверная дата)
  ids: string[];                                 // 3 активных задания
  progress: Record<string, number>;              // текущий прогресс
  done: string[];                                // выполненные (награда начислена)
  rerolls: number;                               // израсходовано рероллов за день
}

// ============================================================
// Указы короля (§H.17): 6 модификаторов, открытие после 10-го матча,
// премия ТОЛЬКО к славе — лидерборд очков не затрагивается
// ============================================================

export type OrderId = 'ukaz_double_siege' | 'ukaz_fragile' | 'ukaz_lone'
  | 'ukaz_silent_monastery' | 'ukaz_drought' | 'ukaz_horde';

export interface OrderDef {
  id: OrderId;
  nameKey: string;
  descKey: string;
  /** Премия к славе: 0.5 → +50%. */
  gloryPremium: number;
}

export const ORDERS: OrderDef[] = [
  { id: 'ukaz_double_siege', nameKey: 'ukaz.double_siege.name', descKey: 'ukaz.double_siege.desc', gloryPremium: 0.5 },
  { id: 'ukaz_fragile', nameKey: 'ukaz.fragile.name', descKey: 'ukaz.fragile.desc', gloryPremium: 0.4 },
  { id: 'ukaz_lone', nameKey: 'ukaz.lone.name', descKey: 'ukaz.lone.desc', gloryPremium: 0.4 },
  { id: 'ukaz_silent_monastery', nameKey: 'ukaz.silent_monastery.name', descKey: 'ukaz.silent_monastery.desc', gloryPremium: 0.6 },
  { id: 'ukaz_drought', nameKey: 'ukaz.drought.name', descKey: 'ukaz.drought.desc', gloryPremium: 0.35 },
  { id: 'ukaz_horde', nameKey: 'ukaz.horde.name', descKey: 'ukaz.horde.desc', gloryPremium: 0.3 },
];

/** Указы открываются после 10-го матча (гейт 48). */
export const UKAZ_AFTER_MATCH = FTUE_MATCH_GATE.kingOrders;
/** Вкладка дерева открывается после 3-го матча (гейт 48). */
export const TREE_AFTER_MATCH = FTUE_MATCH_GATE.valleyChronicle;

// ============================================================
// Контракты (§H.9): 0 или 1 на ран, множитель к SCORE
// ============================================================

export type ContractId = 'c_no_repair' | 'c_quiet' | 'c_hunger' | 'c_lone_hero'
  | 'c_black_market' | 'c_pacifist' | 'c_siege_state' | 'c_night';

export interface ContractDef {
  id: ContractId;
  nameKey: string;
  descKey: string;
  mult: number;
}

export const CONTRACTS: ContractDef[] = [
  { id: 'c_no_repair', nameKey: 'contract.no_repair.name', descKey: 'contract.no_repair.desc', mult: 1.2 },
  { id: 'c_quiet', nameKey: 'contract.quiet.name', descKey: 'contract.quiet.desc', mult: 1.25 },
  { id: 'c_hunger', nameKey: 'contract.hunger.name', descKey: 'contract.hunger.desc', mult: 1.15 },
  { id: 'c_lone_hero', nameKey: 'contract.lone_hero.name', descKey: 'contract.lone_hero.desc', mult: 1.3 },
  { id: 'c_black_market', nameKey: 'contract.black_market.name', descKey: 'contract.black_market.desc', mult: 1.15 },
  { id: 'c_pacifist', nameKey: 'contract.pacifist.name', descKey: 'contract.pacifist.desc', mult: 1.1 },
  { id: 'c_siege_state', nameKey: 'contract.siege_state.name', descKey: 'contract.siege_state.desc', mult: 1.4 },
  { id: 'c_night', nameKey: 'contract.night.name', descKey: 'contract.night.desc', mult: 1.25 },
];

export function contractDef(id: string | null | undefined): ContractDef | null {
  if (!id) return null;
  return CONTRACTS.find((c) => c.id === id) ?? null;
}

// ============================================================
// Ежедневный вызов (§H.8): один сид на день + 2 модификатора из A2
// ============================================================

export type ChallengeModId = 'cm_gold_rush' | 'cm_plague' | 'cm_winter' | 'cm_stone'
  | 'cm_blood_moon' | 'cm_scarcity' | 'cm_martial' | 'cm_fog';

export interface ChallengeModDef {
  id: ChallengeModId;
  nameKey: string;
  descKey: string;
}

export const CHALLENGE_MODS: ChallengeModDef[] = [
  { id: 'cm_gold_rush', nameKey: 'challenge.gold_rush.name', descKey: 'challenge.gold_rush.desc' },
  { id: 'cm_plague', nameKey: 'challenge.plague.name', descKey: 'challenge.plague.desc' },
  { id: 'cm_winter', nameKey: 'challenge.winter.name', descKey: 'challenge.winter.desc' },
  { id: 'cm_stone', nameKey: 'challenge.stone.name', descKey: 'challenge.stone.desc' },
  { id: 'cm_blood_moon', nameKey: 'challenge.blood_moon.name', descKey: 'challenge.blood_moon.desc' },
  { id: 'cm_scarcity', nameKey: 'challenge.scarcity.name', descKey: 'challenge.scarcity.desc' },
  { id: 'cm_martial', nameKey: 'challenge.martial.name', descKey: 'challenge.martial.desc' },
  { id: 'cm_fog', nameKey: 'challenge.fog.name', descKey: 'challenge.fog.desc' },
];

export function challengeModsForDate(date: string, rerollSalt = ''): ChallengeModId[] {
  const rng = mulberry32(hashStr(`challenge:${date}:${rerollSalt}`));
  const pool = [...CHALLENGE_MODS.map((m) => m.id)];
  const picked: ChallengeModId[] = [];
  for (let i = 0; i < 2 && pool.length > 0; i++) {
    picked.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  }
  return picked;
}

// ============================================================
// Благословения (Приложение A2, точка R4): 1 из 3 на ран
// ============================================================

export type BlessingId = 'bl_pawn_speed' | 'bl_castle_hp' | 'bl_first_siege'
  | 'bl_vein' | 'bl_heal_wood' | 'bl_wood_start' | 'bl_combo' | 'bl_speedup_token';

export interface BlessingDef {
  id: BlessingId;
  nameKey: string;
  descKey: string;
}

export const BLESSINGS: BlessingDef[] = [
  { id: 'bl_pawn_speed', nameKey: 'blessing.pawn_speed.name', descKey: 'blessing.pawn_speed.desc' },
  { id: 'bl_castle_hp', nameKey: 'blessing.castle_hp.name', descKey: 'blessing.castle_hp.desc' },
  { id: 'bl_first_siege', nameKey: 'blessing.first_siege.name', descKey: 'blessing.first_siege.desc' },
  { id: 'bl_vein', nameKey: 'blessing.vein.name', descKey: 'blessing.vein.desc' },
  { id: 'bl_heal_wood', nameKey: 'blessing.heal_wood.name', descKey: 'blessing.heal_wood.desc' },
  { id: 'bl_wood_start', nameKey: 'blessing.wood_start.name', descKey: 'blessing.wood_start.desc' },
  { id: 'bl_combo', nameKey: 'blessing.combo.name', descKey: 'blessing.combo.desc' },
  { id: 'bl_speedup_token', nameKey: 'blessing.speedup_token.name', descKey: 'blessing.speedup_token.desc' },
];

export function rollBlessings(seed: string): BlessingId[] {
  const rng = mulberry32(hashStr(`bless:${seed}`));
  const pool = BLESSINGS.map((b) => b.id);
  const picked: BlessingId[] = [];
  for (let i = 0; i < 3 && pool.length > 0; i++) {
    picked.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  }
  return picked;
}

// ============================================================
// Расходники (§J.6.2, фаза S): максимум 2 активных, не суммируются
// ============================================================

export type ConsumableId = 'cs_horseshoe' | 'cs_horn' | 'cs_forester';

export interface ConsumableDef {
  id: ConsumableId;
  nameKey: string;
  descKey: string;
  /** Цена в кронах (или за рекламу — «Подкова удачи»). */
  price: number;
  /** Разрешён показ кнопки rewarded вместо крон. */
  forAd: boolean;
}

export const CONSUMABLES: ConsumableDef[] = [
  { id: 'cs_horseshoe', nameKey: 'consumable.horseshoe.name', descKey: 'consumable.horseshoe.desc', price: 40, forAd: true },
  { id: 'cs_horn', nameKey: 'consumable.horn.name', descKey: 'consumable.horn.desc', price: 50, forAd: false },
  { id: 'cs_forester', nameKey: 'consumable.forester.name', descKey: 'consumable.forester.desc', price: 50, forAd: false },
];

/** Максимум активных расходников на матч (§J.6.2, гейт 43). */
export const CONSUMABLE_MAX = 2;

// ============================================================
// Сезонная ось (§H.18): 14 дней, тематический модификатор мира
// ============================================================

export const SEASON_DAYS = 14;
export type SeasonModifier = 'red_valley' | 'long_siege' | 'gold_rush_world' | 'ogre_return';

export interface SeasonDef {
  id: number;
  themeKey: string;
  modifier: SeasonModifier;
  modDescKey: string;
  /** Скин-фокус сезона (id скина — выдаётся на 5-м шаге мини-прогресса). */
  skinReward: string;
}

export const SEASONS: SeasonDef[] = [
  { id: 0, themeKey: 'season.0.name', modifier: 'red_valley', modDescKey: 'season.0.desc', skinReward: 'skin_hero_monk_red' },
  { id: 1, themeKey: 'season.1.name', modifier: 'long_siege', modDescKey: 'season.1.desc', skinReward: 'skin_hero_warrior_yellow' },
  { id: 2, themeKey: 'season.2.name', modifier: 'gold_rush_world', modDescKey: 'season.2.desc', skinReward: 'skin_hero_archer_purple' },
  { id: 3, themeKey: 'season.3.name', modifier: 'ogre_return', modDescKey: 'season.3.desc', skinReward: 'skin_hero_lancer_black' },
];

export function seasonIndexFor(now = serverNow()): number {
  return Math.floor(now / (SEASON_DAYS * 86400_000));
}

export function seasonDef(index = seasonIndexFor()): SeasonDef {
  return SEASONS[((index % SEASONS.length) + SEASONS.length) % SEASONS.length];
}

/** Шаги мини-прогресса сезона (ранов): награды за 3/6/10/15/21 ранов сезона. */
export const SEASON_STEPS = [3, 6, 10, 15, 21];

// ============================================================
// Недельная цепочка «Хроники недели» (§H.17): 5 этапов → 150 крон
// ============================================================

export const WEEKLY_STAGES = [4, 8, 12, 16, 20];
/** Награда финала чередуется по неделям: 150 крон ↔ знамя. */
export function weeklyFinalReward(week: string): 'crowns' | 'banner' {
  return hashStr(`week-final:${week}`) % 2 === 0 ? 'crowns' : 'banner';
}

// ============================================================
// Кодекс (§H.10)
// ============================================================

export interface CodexSectionDef {
  id: string;
  nameKey: string;
  entries: CodexEntryDef[];
}

export interface CodexEntryDef {
  id: string;
  nameKey: string;
  /** Порог «изучено полностью» — по видам §H.10 (гоблин 30 → шаман 200). */
  masterAt?: number;
}

export const CODEX_SECTIONS: CodexSectionDef[] = [
  {
    id: 'enemies', nameKey: 'codex.section.enemies',
    entries: [
      { id: 'goblin', nameKey: 'codex.goblin', masterAt: 30 },
      { id: 'thief', nameKey: 'codex.thief' },
      { id: 'gnoll', nameKey: 'codex.gnoll', masterAt: 60 },
      { id: 'skull', nameKey: 'codex.skull', masterAt: 120 },
      { id: 'shaman', nameKey: 'codex.shaman', masterAt: 200 },
      { id: 'pig-rider', nameKey: 'codex.pig-rider' },
      { id: 'bomb-fish', nameKey: 'codex.bomb-fish' },
      // Дополнительные виды раунда 2: имя кодекса совпадает с боевой локализацией.
      { id: 'spider', nameKey: 'enemy.spider.name' },
      { id: 'snake', nameKey: 'enemy.snake.name' },
      { id: 'lizard', nameKey: 'enemy.lizard.name' },
      { id: 'turtle', nameKey: 'enemy.turtle.name' },
      { id: 'gnome', nameKey: 'enemy.gnome.name' },
      { id: 'panda', nameKey: 'enemy.panda.name' },
      { id: 'spear-goblin', nameKey: 'enemy.spearGoblin.name' },
      { id: 'harpoon-shark', nameKey: 'enemy.harpoonShark.name' },
      { id: 'paddle-shark', nameKey: 'enemy.paddleShark.name' },
      { id: 'bear', nameKey: 'codex.bear' },
      { id: 'minotaur', nameKey: 'codex.minotaur' },
      { id: 'boss', nameKey: 'codex.ogre' },
    ],
  },
  {
    id: 'buildings', nameKey: 'codex.section.buildings',
    entries: [
      { id: 'house', nameKey: 'codex.b_house' },
      { id: 'barracks', nameKey: 'codex.b_barracks' },
      { id: 'tower', nameKey: 'codex.b_tower' },
      { id: 'archery', nameKey: 'codex.b_archery' },
      { id: 'monastery', nameKey: 'codex.b_monastery' },
    ],
  },
  {
    id: 'weapons', nameKey: 'codex.section.weapons',
    entries: [
      { id: 'w_sword', nameKey: 'codex.w_sword' }, { id: 'w_bow', nameKey: 'codex.w_bow' },
      { id: 'w_spear', nameKey: 'codex.w_spear' }, { id: 'w_hammer', nameKey: 'codex.w_hammer' },
      { id: 'w_bomb', nameKey: 'codex.w_bomb' }, { id: 'w_aura', nameKey: 'codex.w_aura' },
      { id: 'w_knives', nameKey: 'codex.w_knives' },
      { id: 'e_sword', nameKey: 'codex.e_sword' }, { id: 'e_bow', nameKey: 'codex.e_bow' },
      { id: 'e_spear', nameKey: 'codex.e_spear' }, { id: 'e_hammer', nameKey: 'codex.e_hammer' },
      { id: 'e_bomb', nameKey: 'codex.e_bomb' }, { id: 'e_aura', nameKey: 'codex.e_aura' },
      { id: 'e_knives', nameKey: 'codex.e_knives' },
    ],
  },
  {
    id: 'cards', nameKey: 'codex.section.cards',
    entries: [
      { id: 'card_forestry', nameKey: 'codex.card_forestry' }, { id: 'card_masonry', nameKey: 'codex.card_masonry' },
      { id: 'card_provisions', nameKey: 'codex.card_provisions' }, { id: 'card_deepmines', nameKey: 'codex.card_deepmines' },
      { id: 'card_fieldmedic', nameKey: 'codex.card_fieldmedic' }, { id: 'card_militia', nameKey: 'codex.card_militia' },
      { id: 'card_alarm', nameKey: 'codex.card_alarm' }, { id: 'card_assembly', nameKey: 'codex.card_assembly' },
    ],
  },
  {
    id: 'bosses', nameKey: 'codex.section.bosses',
    entries: [
      { id: 'boss_bear', nameKey: 'codex.boss_bear' },
      { id: 'boss_minotaur', nameKey: 'codex.boss_minotaur' },
      { id: 'boss_ogre', nameKey: 'codex.boss_ogre' },
    ],
  },
];

/** Вехи полноты кодекса (§H.10): 50% — золото, 75% — титул, 100% — скин. */
export const CODEX_MILESTONES = [
  { at: 0.5, reward: 'gold200' },
  { at: 0.75, reward: 'title' },
  { at: 1.0, reward: 'skin_golden_goblin' },
] as const;

// ============================================================
// Цепочки достижений (§H.11): 8 цепочек × 3 ступени
// ============================================================

export interface ChainDef {
  id: string;
  nameKey: string;
  /** Метрика жизненного счётчика. */
  metric: 'siegesDefended' | 'idealWins' | 'successions' | 'healedUnits'
    | 'veterans' | 'contracts' | 'endlessWave' | 'buildings';
  tiers: [number, number, number];
}

export const CHAINS: ChainDef[] = [
  { id: 'ch_siege', nameKey: 'chain.siege', metric: 'siegesDefended', tiers: [1, 5, 25] },
  { id: 'ch_keeper', nameKey: 'chain.keeper', metric: 'idealWins', tiers: [1, 5, 15] },
  { id: 'ch_mentor', nameKey: 'chain.mentor', metric: 'successions', tiers: [1, 10, 30] },
  { id: 'ch_haven', nameKey: 'chain.haven', metric: 'healedUnits', tiers: [10, 100, 500] },
  { id: 'ch_veteran', nameKey: 'chain.veteran', metric: 'veterans', tiers: [1, 25, 100] },
  { id: 'ch_contractor', nameKey: 'chain.contractor', metric: 'contracts', tiers: [10, 50, 200] },
  { id: 'ch_endless', nameKey: 'chain.endless', metric: 'endlessWave', tiers: [5, 15, 30] },
  { id: 'ch_architect', nameKey: 'chain.architect', metric: 'buildings', tiers: [7, 10, 100] },
];

/** Награды ступеней: бронза 150 золота, серебро 300 золота + жетон благословения, золото 25 крон. */
export const CHAIN_REWARDS = { bronze: 150, silver: 300, gold: 25 } as const;

// ============================================================
// Пропуск «Хроника» (§J.6.3): 50 уровней, два трека
// ============================================================

export const PASS = {
  LEVELS: 50,
  XP_PER_LEVEL: 100,
  /** XP: раны +25, ежедневки +50, вызов +75, контракты +25, волны бесконечного +5, цепочки +25. */
  XP: { run: 25, quest: 50, challenge: 75, contract: 25, endlessWave: 5, chain: 25 },
} as const;

export type PassRewardKind = 'gold' | 'crowns' | 'token' | 'blessing' | 'skin' | 'title' | 'frame' | 'banner';

export interface PassReward { kind: PassRewardKind; amount: number; id?: string }

export interface PassLevelDef { level: number; free: PassReward; premium: PassReward }

/** Награды пропуска: игровая ценность — в бесплатной ветке (§J.6.3, гейт S). */
export function passReward(level: number, premium: boolean): PassReward | null {
  if (level < 1 || level > PASS.LEVELS) return null;
  if (!premium) {
    if (level === 30) return { kind: 'skin', amount: 1, id: 'skin_hero_warrior_red' };
    if (level % 10 === 0) return { kind: 'crowns', amount: 20 };
    if (level % 5 === 0) return { kind: 'token', amount: 1 };
    return { kind: 'gold', amount: 100 + level * 4 };
  }
  if (level === 50) return { kind: 'banner', amount: 1, id: 'banner_pass' };
  if (level === 10 || level === 25 || level === 45) return { kind: 'skin', amount: 1, id: `skin_prem_${level}` };
  if (level === 20 || level === 40) return { kind: 'title', amount: 1, id: `title_${level}` };
  if (level % 10 === 0) return { kind: 'crowns', amount: 30 };
  if (level % 5 === 0) return { kind: 'blessing', amount: 1 };
  return { kind: 'crowns', amount: 5 };
}

// ============================================================
// Скины (§J.6.2, фаза S): перекраска setTint, ноль новых ассетов
// ============================================================

export type SkinKind = 'hero' | 'building' | 'trail' | 'banner';

export interface SkinDef {
  id: string;
  kind: SkinKind;
  nameKey: string;
  /** Цена в кронах; 0 — добаётся игрой (сезон/пропуск/кодекс). */
  price: number;
  /** Hero: id героя; building: раскраска построек; trail: эффект. */
  appliesTo?: string;
  /** Tint 0xRRGGBB. */
  tint: number;
}

/** Палитры тиров §C.2 (жёлтый/фиолетовый/красный/чёрный) поверх hero-* спрайтов. */
export const SKINS: SkinDef[] = [
  { id: 'skin_hero_warrior_red', kind: 'hero', nameKey: 'skins.skin.hero_warrior_red', price: 120, appliesTo: 'warrior', tint: 0xd85840 },
  { id: 'skin_hero_warrior_yellow', kind: 'hero', nameKey: 'skins.skin.hero_warrior_yellow', price: 120, appliesTo: 'warrior', tint: 0xd8a040 },
  { id: 'skin_hero_archer_red', kind: 'hero', nameKey: 'skins.skin.hero_archer_red', price: 130, appliesTo: 'archer', tint: 0xd85840 },
  { id: 'skin_hero_archer_purple', kind: 'hero', nameKey: 'skins.skin.hero_archer_purple', price: 130, appliesTo: 'archer', tint: 0x9a5cc0 },
  { id: 'skin_hero_lancer_red', kind: 'hero', nameKey: 'skins.skin.hero_lancer_red', price: 140, appliesTo: 'lancer', tint: 0xd85840 },
  { id: 'skin_hero_lancer_black', kind: 'hero', nameKey: 'skins.skin.hero_lancer_black', price: 140, appliesTo: 'lancer', tint: 0x5a5a66 },
  { id: 'skin_hero_monk_red', kind: 'hero', nameKey: 'skins.skin.hero_monk_red', price: 150, appliesTo: 'monk', tint: 0xd85840 },
  { id: 'skin_hero_monk_yellow', kind: 'hero', nameKey: 'skins.skin.hero_monk_yellow', price: 150, appliesTo: 'monk', tint: 0xd8a040 },
  { id: 'skin_bld_red', kind: 'building', nameKey: 'skins.skin.bld_red', price: 200, appliesTo: 'red', tint: 0xd85840 },
  { id: 'skin_bld_purple', kind: 'building', nameKey: 'skins.skin.bld_purple', price: 220, appliesTo: 'purple', tint: 0x9a5cc0 },
  { id: 'skin_bld_yellow', kind: 'building', nameKey: 'skins.skin.bld_yellow', price: 240, appliesTo: 'yellow', tint: 0xd8a040 },
  { id: 'skin_bld_black', kind: 'building', nameKey: 'skins.skin.bld_black', price: 300, appliesTo: 'black', tint: 0x5a5a66 },
  { id: 'trail_gold', kind: 'trail', nameKey: 'skins.skin.trail_gold', price: 90, appliesTo: 'fx-heal', tint: 0xffd76e },
  { id: 'trail_ember', kind: 'trail', nameKey: 'skins.skin.trail_ember', price: 90, appliesTo: 'fx-heal', tint: 0xff8855 },
  // Наградные скины (кодекс 100%, пропуск L10/L25/L45) — только за игру
  { id: 'golden_goblin', kind: 'hero', nameKey: 'skins.skin.golden_goblin', price: 0, appliesTo: 'goblin', tint: 0xffd76e },
  { id: 'skin_prem_10', kind: 'hero', nameKey: 'skins.skin.skin_prem_10', price: 0, appliesTo: 'warrior', tint: 0xff9a44 },
  { id: 'skin_prem_25', kind: 'hero', nameKey: 'skins.skin.skin_prem_25', price: 0, appliesTo: 'archer', tint: 0x60c0c0 },
  { id: 'skin_prem_45', kind: 'hero', nameKey: 'skins.skin.skin_prem_45', price: 0, appliesTo: 'lancer', tint: 0xb060ff },
];

// ============================================================
// Знамёна поселения (§J.6.2): 8 штук, видны над замком с 1-й секунды
// ============================================================

export interface BannerDef {
  id: string;
  nameKey: string;
  /** Источник: кодекс (4), задания (1), пропуск (1), инапы (2). */
  source: 'codex' | 'quests' | 'pass' | 'store';
  tint: number;
}

export const BANNERS: BannerDef[] = [
  { id: 'banner_codex_50', nameKey: 'banner.codex_50', source: 'codex', tint: 0xc9a25e },
  { id: 'banner_codex_75', nameKey: 'banner.codex_75', source: 'codex', tint: 0x9fd8ff },
  { id: 'banner_codex_100', nameKey: 'banner.codex_100', source: 'codex', tint: 0xffd76e },
  { id: 'banner_codex_all', nameKey: 'banner.codex_all', source: 'codex', tint: 0xb060ff },
  { id: 'banner_weekly', nameKey: 'banner.weekly', source: 'quests', tint: 0x7dc95e },
  { id: 'banner_pass', nameKey: 'banner.pass', source: 'pass', tint: 0xd85840 },
  { id: 'banner_store_1', nameKey: 'banner.store_1', source: 'store', tint: 0xff9a44 },
  { id: 'banner_store_2', nameKey: 'banner.store_2', source: 'store', tint: 0x60c0c0 },
];

// ============================================================
// Конфиг рана (передаётся в GameScene через 'tss-run')
// ============================================================

export interface RunModifiers {
  contract: ContractId | null;
  ukaz: OrderId | null;
  challenge: { mods: ChallengeModId[]; rerolled: boolean } | null;
  blessing: BlessingId | null;
  consumables: ConsumableId[];
  endless: boolean;
  /** Испытание недели — тот же указ, но с локальной мини-таблицей. */
  weeklyChallenge: boolean;
}

export const RUN_KEY = 'tss-run';

export function saveRunConfig(cfg: RunModifiers): void {
  saveJson(RUN_KEY, cfg);
}

/** Читает и погашает конфиг рана: повторный старт — уже обычный ран. */
export function consumeRunConfig(): RunModifiers {
  const raw = loadJson<Partial<RunModifiers> | null>(RUN_KEY);
  const cfg: RunModifiers = {
    contract: null,
    ukaz: null,
    challenge: null,
    blessing: null,
    consumables: [],
    endless: false,
    weeklyChallenge: false,
  };
  if (raw) {
    cfg.contract = typeof raw.contract === 'string' ? raw.contract : null;
    cfg.ukaz = typeof raw.ukaz === 'string' ? raw.ukaz : null;
    if (raw.challenge && Array.isArray(raw.challenge.mods)) {
      cfg.challenge = { mods: raw.challenge.mods.slice(0, 2) as ChallengeModId[], rerolled: raw.challenge.rerolled === true };
    }
    cfg.blessing = typeof raw.blessing === 'string' ? raw.blessing : null;
    if (Array.isArray(raw.consumables)) {
      cfg.consumables = raw.consumables.filter((c): c is ConsumableId =>
        CONSUMABLES.some((d) => d.id === c)).slice(0, CONSUMABLE_MAX);
    }
    cfg.endless = raw.endless === true;
    cfg.weeklyChallenge = raw.weeklyChallenge === true;
  }
  return cfg;
}

// ============================================================
// Ежедневный бонус (§H.7): 7-дневный цикл, сброс 26 ч
// ============================================================

export type DailyBonusKind = 'gold' | 'chest' | 'blessing' | 'crowns';

export interface DailyBonusDef { kind: DailyBonusKind; amount: number }

/** День 7 до фазы S — 300 золота, после S — 15 крон (§H.7); выдаём кроны сразу. */
export const DAILY_BONUS: DailyBonusDef[] = [
  { kind: 'gold', amount: 100 },
  { kind: 'chest', amount: 1 },
  { kind: 'gold', amount: 150 },
  { kind: 'blessing', amount: 1 },
  { kind: 'gold', amount: 200 },
  { kind: 'chest', amount: 1 },
  { kind: 'crowns', amount: 15 },
];

/** Пропуск дня откатывает стрик на ОДИН шаг, а не в ноль (§H.7, гейт Q). */
export const BONUS_RESET_HOURS = 26;
/** Минимальный интервал между дарами: защищает от двойного забора на границе UTC-дней. */
export const BONUS_MIN_INTERVAL_HOURS = 24;

// ============================================================
// Константы гейтов и лимитов (Приложение A3)
// ============================================================

/** Витрина крон скрыта до 5-го матча (§J.6.4, гейт 45). */
export const STOREFRONT_AFTER_MATCH = FTUE_MATCH_GATE.storefront;
/** Конвертация крон → золото: 100 крон = 600 золота, лимит 3/день (§J.8). */
export const CROWNS_TO_GOLD = { crowns: 100, gold: 600, perDay: 3 } as const;
/** F2P-капля (§J.7): вызов дня 3 кроны за победу; волны бесконечного 5/10/20. */
export const CHALLENGE_CROWNS = 3;
export const ENDLESS_WAVE_CROWNS = [
  { wave: 10, crowns: 5 }, { wave: 20, crowns: 10 }, { wave: 30, crowns: 20 },
] as const;

// ============================================================
// Состояние
// ============================================================

export interface MetaState {
  v: 2;
  /** Время последней мутации для выбора более свежего локального/облачного снимка. */
  savedAt: number;
  glory: number;
  nodes: NodeId[];
  matchesPlayed: number;
  /** Сохранённые A/B-варианты; синхронизируются с Player Data. */
  flags: Record<string, string>;
  codex: Record<string, number>;
  quests: QuestDayState;
  weekly: { week: string; progress: number; stage: number; claimed: boolean };
  dailyBonus: { last: string; lastAt: number; streak: number };
  contractsDone: number;
  chains: { counters: Record<string, number>; claimed: string[] };
  pass: { season: string; xp: number; premium: boolean; claimedFree: number; claimedPrem: number };
  crowns: number;
  crownConvert: { date: string; count: number };
  skins: { owned: string[]; hero: string; building: string; trail: string; banner: string };
  consumables: Record<ConsumableId, number>;
  speedupTokens: number;
  blessingTokens: number;
  /** Ежедневный сундук (R7 §J.3): показов за сегодня (макс 2/день). */
  dailyChest: { date: string; count: number };
  /** Момент первой победы (мс эпохи) — окно 48ч для starter_castellan (§J.6.2). */
  firstWinAt: number;
  season: { index: number; runs: number; claimed: number };
  firstWin: boolean;
  weeklyChallenge: { week: string; best: number };
  endlessBestWave: number;
  /** Дата победы в вызове дня ('YYYY-MM-DD') — 3 кроны раз в день. */
  challengeWinDate: string;
  purchasedSkus: string[];
  /** SDK receipt tokens already granted; stored atomically with the reward. */
  processedIapTokens: string[];
}

const LS_META2 = 'tss-meta2';

function todayKey(now = serverNow()): string {
  // Для всех игроков граница ежедневок едина: используем UTC-день серверной эпохи,
  // а не часовой пояс конкретного браузера.
  return new Date(now).toISOString().slice(0, 10);
}

function weekKey(now = serverNow()): string {
  const d = new Date(now);
  const day = (d.getUTCDay() + 6) % 7; // понедельник = 0, UTC
  d.setUTCDate(d.getUTCDate() - day);
  return todayKey(d.getTime());
}

/** Неделя лайфстайл-хранения: смена понедельника — новая цепочка. */
export function currentWeekKey(): string {
  return weekKey();
}

/** Детерминированный хэш строки (для сидов даты). */
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Закрепляет вариант A/B за идентичностью игрока; raw identity не отправляется в аналитику. */
export function getOrAssignExperimentVariant(
  experiment: string,
  identity: string,
  variants: readonly string[] = ['control', 'variant'],
): string {
  const experimentId = experiment.trim().slice(0, 64);
  const choices = [...new Set(variants.filter((value) =>
    typeof value === 'string' && value.length > 0 && value.length <= 48,
  ))];
  if (!experimentId || !identity || choices.length === 0) {
    throw new Error('Для A/B-эксперимента нужны имя, identity и минимум один вариант');
  }

  // MetaState локален для браузера, поэтому область ключа фиксирует профиль.
  // Другой аккаунт на общем устройстве не должен наследовать это плечо.
  const identityScope = hashStr(identity).toString(36);
  const key = `ab:${experimentId}:${identityScope}`;
  const state = loadMetaState();
  const existing = state.flags[key];
  if (existing && choices.includes(existing)) return existing;

  const variant = choices[hashStr(`${experimentId}:${identity}`) % choices.length]!;
  state.flags[key] = variant;
  const persisted = saveMetaState(state);
  persistExperimentFlagsToPlayerData(state.flags);
  track('ab_assignment', { experiment: experimentId, variant, persisted });
  return variant;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ротация заданий: 3 различных из пула 18 по сиду даты (§H.17). */
export function rotateQuests(date: string): string[] {
  const rng = mulberry32(hashStr(`quests:${date}`));
  const pool = QUEST_POOL.map((q) => q.id);
  const picked: string[] = [];
  for (let i = 0; i < 3 && pool.length > 0; i++) {
    picked.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  }
  return picked;
}

const EMPTY: MetaState = {
  v: 2,
  savedAt: 0,
  glory: 0,
  nodes: [],
  matchesPlayed: 0,
  flags: {},
  codex: {},
  quests: { date: '', ids: [], progress: {}, done: [], rerolls: 0 },
  weekly: { week: '', progress: 0, stage: 0, claimed: false },
  dailyBonus: { last: '', lastAt: 0, streak: 0 },
  contractsDone: 0,
  chains: { counters: {}, claimed: [] },
  pass: { season: '', xp: 0, premium: false, claimedFree: 0, claimedPrem: 0 },
  crowns: 0,
  crownConvert: { date: '', count: 0 },
  skins: { owned: [], hero: '', building: '', trail: '', banner: '' },
  consumables: { cs_horseshoe: 0, cs_horn: 0, cs_forester: 0 },
  speedupTokens: 0,
  blessingTokens: 0,
  dailyChest: { date: '', count: 0 },
  firstWinAt: 0,
  season: { index: -1, runs: 0, claimed: 0 },
  firstWin: false,
  weeklyChallenge: { week: '', best: 0 },
  endlessBestWave: 0,
  challengeWinDate: '',
  purchasedSkus: [],
  processedIapTokens: [],
};

/** Санитизация: мусор из хранилища не роняет игру. */
function sanitize(raw: unknown): MetaState {
  const o = (raw ?? {}) as Partial<MetaState>;
  const int = (v: unknown): number => Math.max(0, Math.floor(Number(v) || 0));
  const strArr = (v: unknown, known?: Set<string>): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && (!known || known.has(x))) : [];

  const knownNodes = new Set(TREE_NODES.map((n) => n.id));
  const knownSkins = new Set(SKINS.map((s) => s.id));
  const knownBanners = new Set(BANNERS.map((b) => b.id));

  const q = (o.quests ?? {}) as Partial<QuestDayState>;
  const w = (o.weekly ?? {}) as Partial<MetaState['weekly']>;
  const db = (o.dailyBonus ?? {}) as Partial<MetaState['dailyBonus']>;
  const ch = (o.chains ?? {}) as Partial<MetaState['chains']>;
  const p = (o.pass ?? {}) as Partial<MetaState['pass']>;
  const cc = (o.crownConvert ?? {}) as Partial<MetaState['crownConvert']>;
  const sk = (o.skins ?? {}) as Partial<MetaState['skins']>;
  const se = (o.season ?? {}) as Partial<MetaState['season']>;
  const wc = (o.weeklyChallenge ?? {}) as Partial<MetaState['weeklyChallenge']>;
  const cons = (o.consumables ?? {}) as Partial<Record<ConsumableId, number>>;

  const consumables: Record<ConsumableId, number> = { cs_horseshoe: 0, cs_horn: 0, cs_forester: 0 };
  for (const c of CONSUMABLES) consumables[c.id] = int(cons[c.id]);

  const counters: Record<string, number> = {};
  if (ch.counters && typeof ch.counters === 'object') {
    for (const [k, v] of Object.entries(ch.counters)) counters[k] = int(v);
  }

  return {
    v: 2,
    savedAt: int(o.savedAt),
    glory: int(o.glory),
    nodes: strArr(o.nodes, knownNodes),
    matchesPlayed: int(o.matchesPlayed),
    flags: (() => {
      const out: Record<string, string> = {};
      if (o.flags && typeof o.flags === 'object' && !Array.isArray(o.flags)) {
        for (const [key, value] of Object.entries(o.flags)) {
          if (key.startsWith('ab:') && key.length <= 100
            && typeof value === 'string' && value.length > 0 && value.length <= 48) {
            out[key] = value;
          }
        }
      }
      return out;
    })(),
    codex: (() => {
      const out: Record<string, number> = {};
      if (o.codex && typeof o.codex === 'object') {
        for (const [k, v] of Object.entries(o.codex)) out[k] = int(v);
      }
      return out;
    })(),
    quests: {
      date: typeof q.date === 'string' ? q.date.slice(0, 10) : '',
      ids: strArr(q.ids, new Set(QUEST_POOL.map((x) => x.id))),
      progress: (() => {
        const out: Record<string, number> = {};
        if (q.progress && typeof q.progress === 'object') {
          for (const [k, v] of Object.entries(q.progress)) out[k] = int(v);
        }
        return out;
      })(),
      done: strArr(q.done, new Set(QUEST_POOL.map((x) => x.id))),
      rerolls: int(q.rerolls),
    },
    weekly: {
      week: typeof w.week === 'string' ? w.week.slice(0, 10) : '',
      progress: int(w.progress),
      stage: int(w.stage),
      claimed: w.claimed === true,
    },
    // Старые сохранения не содержали времени получения: lastAt=0 означает
    // один безопасный переход без штрафа, после чего точный timestamp сохраняется.
    dailyBonus: {
      last: typeof db.last === 'string' ? db.last.slice(0, 10) : '',
      lastAt: int(db.lastAt),
      streak: int(db.streak),
    },
    dailyChest: ((): MetaState['dailyChest'] => {
      const dc = (o.dailyChest ?? {}) as Partial<MetaState['dailyChest']>;
      return { date: typeof dc.date === 'string' ? dc.date.slice(0, 10) : '', count: int(dc.count) };
    })(),
    firstWinAt: int(o.firstWinAt),
    contractsDone: int(o.contractsDone),
    chains: { counters, claimed: strArr(ch.claimed) },
    pass: {
      season: typeof p.season === 'string' ? p.season.slice(0, 10) : '',
      xp: int(p.xp),
      premium: p.premium === true,
      claimedFree: int(p.claimedFree),
      claimedPrem: int(p.claimedPrem),
    },
    crowns: int(o.crowns),
    crownConvert: { date: typeof cc.date === 'string' ? cc.date.slice(0, 10) : '', count: int(cc.count) },
    skins: {
      owned: strArr(sk.owned, knownSkins),
      hero: typeof sk.hero === 'string' ? sk.hero : '',
      building: typeof sk.building === 'string' ? sk.building : '',
      trail: typeof sk.trail === 'string' ? sk.trail : '',
      banner: typeof sk.banner === 'string' && knownBanners.has(sk.banner) ? sk.banner : '',
    },
    consumables,
    speedupTokens: int(o.speedupTokens),
    blessingTokens: int(o.blessingTokens),
    season: { index: int(se.index), runs: int(se.runs), claimed: int(se.claimed) },
    firstWin: o.firstWin === true,
    weeklyChallenge: { week: typeof wc.week === 'string' ? wc.week.slice(0, 10) : '', best: int(wc.best) },
    endlessBestWave: int(o.endlessBestWave),
    challengeWinDate: typeof (o as { challengeWinDate?: unknown }).challengeWinDate === 'string'
      ? String((o as { challengeWinDate?: unknown }).challengeWinDate).slice(0, 10) : '',
    purchasedSkus: strArr(o.purchasedSkus),
    processedIapTokens: strArr(o.processedIapTokens),
  };
}

let cached: MetaState | null = null;

/** Облачный снимок хранится отдельным ключом и не конфликтует с Player Data других подсистем. */
const META_PLAYER_DATA_KEY = 'tss-meta-state-v1';
const META_CLOUD_WRITE_INTERVAL_MS = 20_000;

interface MetaCloudEnvelope {
  version: 1;
  savedAt: number;
  state: MetaState;
  shop?: ShopState;
}

let metaCloudHydrated = false;
let metaCloudDirty = false;
let metaCloudSaveTimer: ReturnType<typeof setTimeout> | null = null;
let metaCloudWriteInFlight: Promise<boolean> | null = null;
let lastMetaCloudWriteAt: number | null = null;
let metaCloudLifecycleInstalled = false;

/** Текущее мета-состояние (кэшируется; мутируйте через helpers + saveMetaState()). */
export function loadMetaState(): MetaState {
  if (cached) return cached;
  if (typeof window === 'undefined') {
    cached = structuredCloneSafe(EMPTY);
  } else {
    cached = sanitize(loadJson<unknown>(LS_META2));
  }
  return cached;
}

function structuredCloneSafe(s: MetaState): MetaState {
  return JSON.parse(JSON.stringify(s)) as MetaState;
}

function installMetaCloudLifecycle(): void {
  if (metaCloudLifecycleInstalled || typeof window === 'undefined' || typeof document === 'undefined') return;
  metaCloudLifecycleInstalled = true;
  const flush = (): void => { void flushMetaStateToPlayerData(); };
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}

function scheduleMetaCloudSave(): void {
  if (!metaCloudHydrated || !metaCloudDirty || metaCloudSaveTimer !== null) return;
  // Yandex Player.setData имеет лимит запросов; сохраняем полный снимок не чаще
  // одного раза в 20 секунд, объединяя частые обновления боевого матча.
  const wait = lastMetaCloudWriteAt === null
    ? 0
    : Math.max(0, META_CLOUD_WRITE_INTERVAL_MS - (performance.now() - lastMetaCloudWriteAt));
  metaCloudSaveTimer = setTimeout(() => {
    metaCloudSaveTimer = null;
    void persistMetaStateToPlayerData(false);
  }, wait);
}

function persistMetaStateToPlayerData(flush: boolean): Promise<boolean> {
  if (!metaCloudHydrated || !metaCloudDirty) return Promise.resolve(false);
  if (metaCloudWriteInFlight) {
    // Изменение, произошедшее во время предыдущей записи, сохранится следующим
    // снимком: не запускаем параллельные setData и не теряем последний state.
    metaCloudDirty = true;
    return metaCloudWriteInFlight;
  }

  const snapshot = structuredCloneSafe(loadMetaState());
  const envelope: MetaCloudEnvelope = {
    version: 1,
    savedAt: snapshot.savedAt,
    state: snapshot,
    shop: loadShop(),
  };
  metaCloudDirty = false;
  lastMetaCloudWriteAt = performance.now();
  const write = writePlayerDataValue(META_PLAYER_DATA_KEY, envelope, flush)
    .then((success) => {
      if (!success || loadMetaState().savedAt !== snapshot.savedAt) metaCloudDirty = true;
      return success;
    })
    .catch((error: unknown) => {
      metaCloudDirty = true;
      console.warn('[meta] не удалось сохранить облачный прогресс:', error);
      return false;
    })
    .finally(() => {
      metaCloudWriteInFlight = null;
      if (metaCloudDirty) scheduleMetaCloudSave();
    });
  metaCloudWriteInFlight = write;
  return write;
}

function isValidCloudMetaState(raw: unknown): raw is Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const state = raw as Record<string, unknown>;
  const dailyBonus = state.dailyBonus;
  const quests = state.quests;
  return state.v === 2
    && Number.isSafeInteger(state.savedAt) && Number(state.savedAt) >= 0
    && typeof state.glory === 'number' && Number.isFinite(state.glory) && state.glory >= 0
    && typeof state.matchesPlayed === 'number' && Number.isFinite(state.matchesPlayed) && state.matchesPlayed >= 0
    && Array.isArray(state.nodes)
    && !!dailyBonus && typeof dailyBonus === 'object' && !Array.isArray(dailyBonus)
    && !!quests && typeof quests === 'object' && !Array.isArray(quests);
}

function isValidCloudShopState(raw: unknown): raw is ShopState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const shop = raw as Partial<ShopState>;
  if (typeof shop.balance !== 'number' || !Number.isSafeInteger(shop.balance) || shop.balance < 0
    || !shop.upgrades || typeof shop.upgrades !== 'object' || Array.isArray(shop.upgrades)) return false;
  const ids = ['might', 'vitality', 'speed', 'magnet', 'luck'] as const;
  return ids.every((id) => {
    const level = shop.upgrades?.[id];
    return typeof level === 'number' && Number.isInteger(level) && level >= 0 && level <= 3;
  });
}

/**
 * Восстанавливает общий мета-прогресс до создания игровых сцен.
 * При недоступности Player Data ничего не перезаписываем: локальный прогресс
 * продолжает работать, а неизвестное или повреждённое облачное состояние не затирается.
 */
export async function hydrateMetaStateFromPlayerData(): Promise<void> {
  if (typeof window === 'undefined') return;

  let cloud: Awaited<ReturnType<typeof readPlayerDataEntry>>;
  try {
    cloud = await readPlayerDataEntry(META_PLAYER_DATA_KEY);
  } catch {
    return;
  }
  if (!cloud.available) return;

  metaCloudHydrated = true;
  installMetaCloudLifecycle();

  const local = loadMetaState();
  const value = cloud.value as Partial<MetaCloudEnvelope> | null;
  const envelopeSavedAt = Number(value?.savedAt);
  const remoteState = value?.version === 1 && isValidCloudMetaState(value.state)
    ? sanitize(value.state)
    : null;
  const validEnvelope = remoteState !== null
    && Number.isSafeInteger(envelopeSavedAt)
    && envelopeSavedAt >= 0
    && remoteState.savedAt === envelopeSavedAt;

  if (validEnvelope && remoteState && envelopeSavedAt >= local.savedAt) {
    // Облачный снимок новее или равен локальному; его sanitized-форма
    // записывается локально без обновления savedAt и без обратной записи в облако.
    cached = remoteState;
    saveJson(LS_META2, remoteState);
    if (isValidCloudShopState(value?.shop)) {
      restoreShopState(value.shop);
      metaCloudDirty = false;
    } else {
      // Не затираем локальный кошелёк повреждёнными/устаревшими данными магазина.
      metaCloudDirty = true;
      scheduleMetaCloudSave();
    }
    return;
  }

  // Облако отсутствует/повреждено или локальный снимок новее. Поднимаем
  // монотонную метку и ставим локальный снимок в очередь на первую синхронизацию.
  cached = local;
  metaCloudDirty = true;
  saveMetaState(local);
}

/** Немедленно отправляет последний снимок при скрытии/закрытии страницы. */
export async function flushMetaStateToPlayerData(): Promise<boolean> {
  if (!metaCloudHydrated || !metaCloudDirty) return false;
  if (metaCloudSaveTimer !== null) {
    clearTimeout(metaCloudSaveTimer);
    metaCloudSaveTimer = null;
  }
  if (metaCloudWriteInFlight) await metaCloudWriteInFlight;
  // Ошибка или незавершённая запись может поставить debounce-таймер уже во время
  // ухода со страницы. Перед явным flush отменяем его, чтобы не было гонки снимков.
  if (metaCloudSaveTimer !== null) {
    clearTimeout(metaCloudSaveTimer);
    metaCloudSaveTimer = null;
  }
  if (!metaCloudDirty) return true;

  return persistMetaStateToPlayerData(true);
}

export function saveMetaState(st: MetaState): boolean {
  // Не даём двум мутациям в одной миллисекунде получить одинаковую версию
  // снимка: это важно, чтобы фоновая синхронизация не перезаписала более новый state.
  st.savedAt = Math.max(Math.floor(serverNow()), (st.savedAt ?? 0) + 1);
  cached = st;
  const saved = saveJson(LS_META2, st);
  if (metaCloudHydrated) {
    metaCloudDirty = true;
    scheduleMetaCloudSave();
  }
  return saved;
}

/** Изменения постоянного кошелька/апгрейдов должны попасть в тот же облачный снимок. */
setShopSavedListener(() => {
  if (metaCloudHydrated) saveMetaState(loadMetaState());
});


/** Гарантирует актуальность дневных/недельных/сезонных секций. */
export function rollMetaDay(): MetaState {
  const st = loadMetaState();
  const today = todayKey();
  if (st.quests.date !== today) {
    st.quests = { date: today, ids: rotateQuests(today), progress: {}, done: [], rerolls: 0 };
    saveMetaState(st);
  }
  const week = weekKey();
  if (st.weekly.week !== week) {
    // Недельная цепочка: пропуск этапа не обнуляет прогресс (§H.17) —
    // старая неделя уходит, начинается новая с нулевого прогресса.
    st.weekly = { week, progress: 0, stage: 0, claimed: false };
    saveMetaState(st);
  }
  const sIdx = seasonIndexFor();
  if (st.season.index !== sIdx) {
    // Сезон НЕ обнуляет дерево и славу (§H.18) — только мини-прогресс.
    st.season = { index: sIdx, runs: 0, claimed: 0 };
    saveMetaState(st);
  }
  // Пропуск живёт один сезон (30 дней §J.6.3): смена сезона сбрасывает XP.
  // Премиум не переносится — покупка следующего сезона выдаёт догон заново.
  const pSeason = `s${seasonIndexFor()}`;
  if (st.pass.season !== pSeason) {
    st.pass = { season: pSeason, xp: 0, premium: false, claimedFree: 0, claimedPrem: 0 };
    saveMetaState(st);
  }
  if (st.crownConvert.date !== today) {
    st.crownConvert = { date: today, count: 0 };
    saveMetaState(st);
  }
  return st;
}

/** Дни между датами 'YYYY-MM-DD' (для стрика бонуса). */
export function daysBetween(a: string, b: string): number {
  const da = Date.parse(`${a}T00:00:00Z`);
  const dbb = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(da) || Number.isNaN(dbb)) return 999;
  return Math.round((dbb - da) / 86400_000);
}

// ============================================================
// Сводка рана → обновление мета-состояния (§K.2 run_end → мета)
// ============================================================

/** Счётчики матча, которые сцена собирает за ран. */
export interface RunSummary {
  victory: boolean;
  ideal: boolean;
  endless: boolean;
  wave: number;              // волны бесконечного (осады) — 0 вне режима
  time: number;
  kills: number;
  level: number;
  gold: number;
  score: number;
  difficulty: string;
  buildingsBuilt: number;
  pawnsAlive: number;
  siegesDefended: number;
  siegesTotal: number;
  monasteryHealed: number;
  healHp: number;
  hires: number;
  successions: number;
  veterans: number;
  firstHouseMin: number;
  barracks: number;
  monastery: number;
  archery: number;
  bestCombo: number;
  bossKilled: boolean;
  killsByKind: Record<string, number>;
  cardsPicked: string[];
  contract: string | null;
  ukaz: string | null;
  challengeMods: string[];
  blessing: string | null;
  consumables: string[];
}

export interface RunMetaResult {
  glory: GloryResult | null;
  questsCompleted: QuestDef[];
  quests: QuestDayState;
  passLevelsGained: number;
  passLevel: number;
  passRewards: PassReward[];
  chainUnlocked: Array<{ id: string; tier: number; nameKey: string }>;
  seasonStepReward: string | null;
  crownsEarned: number;
  endlessWaveCrowns: number;
  weeklyClaimReady: boolean;
  newMatchesPlayed: number;
}

/**
 * Применяет итоги матча к мета-состоянию. Вызывается РОВНО ОДИН раз за ран
 * (из gameOver сцены, до перехода на экран результата).
 */
export function applyRunToMeta(s: RunSummary): RunMetaResult {
  const st = rollMetaDay();
  const res: RunMetaResult = {
    glory: null, questsCompleted: [], quests: st.quests,
    passLevelsGained: 0, passLevel: 0, passRewards: [],
    chainUnlocked: [], seasonStepReward: null,
    crownsEarned: 0, endlessWaveCrowns: 0, weeklyClaimReady: false,
    newMatchesPlayed: st.matchesPlayed,
  };

  st.matchesPlayed += 1;
  res.newMatchesPlayed = st.matchesPlayed;

  // --- Слава (§H.16): floor(score/100), кап 300 (+100 идеальная), множители до капа
  if (!s.endless) {
    const order = ORDERS.find((o) => o.id === s.ukaz);
    const fx = nodeEffects(st.nodes);
    const g = gloryForRun(s.score, s.ideal, {
      ukazMult: 1 + (order?.gloryPremium ?? 0),
      gloryMult: fx.gloryMult,
      gloryCapBonus: fx.gloryCapBonus,
    });
    st.glory += g.total;
    res.glory = g;
    track('glory_earned', { amount: g.total, base: g.base, ideal: s.ideal });
  }

  // --- Задания дня (§H.17): параллельный прогресс, лучший за матч
  const runValue = (m: QuestMetric): number => {
    switch (m) {
      case 'buildings': return s.buildingsBuilt;
      case 'siegesDefended': return s.siegesDefended;
      case 'monasteryHealed': return s.monasteryHealed;
      case 'healHp': return Math.round(s.healHp);
      case 'idealWin': return s.ideal ? 1 : 0;
      case 'hires': return s.hires;
      case 'successionBoss': return s.successions > 0 && s.bossKilled ? 1 : 0;
      case 'kills': return s.kills;
      case 'firstHouseMin': return s.firstHouseMin > 0 ? Math.floor(s.firstHouseMin) : 99;
      case 'barracks': return s.barracks;
      case 'monastery': return s.monastery;
      case 'archery': return s.archery;
      case 'veterans': return s.veterans;
      case 'gold': return s.gold;
      case 'score': return s.score;
      case 'time': return Math.floor(s.time);
      case 'bestCombo': return s.bestCombo;
      case 'noSuccessionBoss': return s.successions === 0 && s.bossKilled ? 1 : 0;
      default: return 0;
    }
  };
  for (const id of st.quests.ids) {
    const def = QUEST_POOL.find((q) => q.id === id);
    if (!def || st.quests.done.includes(id)) continue;
    const rv = runValue(def.metric);
    // firstHouseMin — «чем меньше, тем лучше»: цель «построить дом до N мин»
    const achieved = def.metric === 'firstHouseMin' ? rv <= def.goal : rv >= def.goal;
    const prev = st.quests.progress[id] ?? 0;
    const next = def.metric === 'firstHouseMin'
      ? (prev > 0 ? Math.min(prev, rv) : rv)
      : Math.max(prev, rv);
    st.quests.progress[id] = next;
    // §K.2 требует `quest_progress` — без него воронка заданий (§K.3)
    // не строится: видно только терминальное закрытие, а не то, где
    // игроки отваливаются по дороге.
    if (next !== prev) {
      track('quest_progress', { quest: def.id, value: next, goal: def.goal, done: achieved });
    }
    if (achieved) {
      st.quests.done.push(id);
      st.glory += def.reward;
      res.questsCompleted.push(def);
      track('quest_done', { quest: def.id, reward: def.reward });
      addPassXp(st, res, PASS.XP.quest);
      bumpWeekly(st, 1);
    }
  }
  res.weeklyClaimReady = st.weekly.stage >= WEEKLY_STAGES.length && !st.weekly.claimed;

  // --- Кодекс: счётчики встречи (§H.10)
  for (const [k, v] of Object.entries(s.killsByKind)) {
    st.codex[k] = (st.codex[k] ?? 0) + v;
  }
  st.codex['b_house'] = (st.codex['b_house'] ?? 0) + s.buildingsBuilt;
  if (s.barracks > 0) st.codex['b_barracks'] = (st.codex['b_barracks'] ?? 0) + 1;
  if (s.monastery > 0) st.codex['b_monastery'] = (st.codex['b_monastery'] ?? 0) + 1;
  if (s.archery > 0) st.codex['b_archery'] = (st.codex['b_archery'] ?? 0) + 1;
  if (s.bossKilled) st.codex['boss_ogre'] = (st.codex['boss_ogre'] ?? 0) + 1;
  for (const c of s.cardsPicked) st.codex[`card_${c}`] = (st.codex[`card_${c}`] ?? 0) + 1;

  // --- Вехи полноты кодекса (§H.10): 50% золото, 75% титул, 100% скин
  const beforeRatio = codexProgress().ratio;
  if (beforeRatio >= 0.5 && !st.chains.claimed.includes('codex:50')) {
    st.chains.claimed.push('codex:50');
    depositGoldWallet(200);
  }
  if (beforeRatio >= 0.75 && !st.chains.claimed.includes('codex:75')) {
    st.chains.claimed.push('codex:75'); // титул — косметический статус
  }
  if (beforeRatio >= 1 && !st.chains.claimed.includes('codex:100')) {
    st.chains.claimed.push('codex:100');
    grantSkin(st, 'golden_goblin');
  }
  // Хроники оружия/эволюций: кодекс-отметки начисляет сцена (markCodex).

  // --- Цепочки достижений (§H.11): жизненные счётчики
  const c = st.chains.counters;
  c.siegesDefended = (c.siegesDefended ?? 0) + s.siegesDefended;
  if (s.ideal) c.idealWins = (c.idealWins ?? 0) + 1;
  c.successions = (c.successions ?? 0) + s.successions;
  c.healedUnits = (c.healedUnits ?? 0) + s.monasteryHealed;
  c.veterans = (c.veterans ?? 0) + s.veterans;
  if (s.contract) {
    c.contracts = (c.contracts ?? 0) + 1;
    st.contractsDone += 1;
    addPassXp(st, res, PASS.XP.contract);
  }
  c.buildings = (c.buildings ?? 0) + s.buildingsBuilt;
  if (s.endless) c.endlessWave = Math.max(c.endlessWave ?? 0, s.wave);
  st.endlessBestWave = Math.max(st.endlessBestWave, s.endless ? s.wave : 0);

  for (const chain of CHAINS) {
    const val = st.chains.counters[chain.metric] ?? 0;
    for (let tier = 0; tier < 3; tier++) {
      const key = `${chain.id}:${tier}`;
      if (val >= chain.tiers[tier] && !st.chains.claimed.includes(`${key}:seen`)) {
        st.chains.claimed.push(`${key}:seen`);
        res.chainUnlocked.push({ id: chain.id, tier, nameKey: chain.nameKey });
        addPassXp(st, res, PASS.XP.chain);
        bumpWeekly(st, 1);
      }
    }
  }
  res.weeklyClaimReady = res.weeklyClaimReady || (st.weekly.stage >= WEEKLY_STAGES.length && !st.weekly.claimed);

  // --- Сезонная ось (§H.18): мини-прогресс 5 шагов, дерево не сбрасывается
  st.season.runs += 1;
  while (st.season.claimed < SEASON_STEPS.length && st.season.runs >= SEASON_STEPS[st.season.claimed]) {
    st.season.claimed += 1;
    const sd = seasonDef();
    grantSkin(st, sd.skinReward);
    res.seasonStepReward = sd.skinReward;
  }

  // --- Бесконечный режим (§H.12): кроны за волны 10/20/30 (по лучшему разу)
  if (s.endless) {
    const prevBest = st.endlessBestWave;
    st.endlessBestWave = Math.max(st.endlessBestWave, s.wave);
    for (const w of ENDLESS_WAVE_CROWNS) {
      if (prevBest < w.wave && st.endlessBestWave >= w.wave) {
        st.crowns += w.crowns;
        res.crownsEarned += w.crowns;
        res.endlessWaveCrowns += w.crowns;
      }
    }
    addPassXp(st, res, PASS.XP.endlessWave * s.wave);
  }

  // --- Пропуск: XP за ран (§J.6.3)
  addPassXp(st, res, PASS.XP.run);

  // --- Недельная цепочка: раны двигают прогресс (§H.17)
  bumpWeekly(st, 1);

  // --- Испытание недели (§H.18): локальная мини-таблица
  if (s.ukaz) {
    const week = st.weekly.week;
    if (st.weeklyChallenge.week !== week) st.weeklyChallenge = { week, best: 0 };
    st.weeklyChallenge.best = Math.max(st.weeklyChallenge.best, s.score);
  }

  // --- Первая победа открывает бесконечный режим (§H.12) и окно 48ч
  // стартового набора (§J.6.2: starter_castellan продаётся двое суток)
  if (s.victory && !s.endless) {
    st.firstWin = true;
    if (!st.firstWinAt) st.firstWinAt = Date.now();
  }

  saveMetaState(st);
  res.quests = st.quests;
  res.passLevel = Math.min(PASS.LEVELS, Math.floor(st.pass.xp / PASS.XP_PER_LEVEL));
  return res;
}

function addPassXp(
  st: MetaState,
  res: Pick<RunMetaResult, 'passLevelsGained' | 'passRewards'> | null,
  xp: number,
): void {
  if (xp <= 0) return;
  const before = Math.floor(st.pass.xp / PASS.XP_PER_LEVEL);
  st.pass.xp += xp;
  const after = Math.min(PASS.LEVELS, Math.floor(st.pass.xp / PASS.XP_PER_LEVEL));
  if (after > before) {
    const gained = after - before;
    if (res) res.passLevelsGained += gained;
    track('pass_level', { levels: gained, level: after });
    // Выдаём бесплатную ветку автоматически (§J.6.3), премиум — по владению
    for (let lv = before + 1; lv <= after; lv++) {
      const fr = passReward(lv, false);
      if (fr) {
        res?.passRewards.push(fr);
        grantPassReward(st, fr);
      }
      if (st.pass.premium) {
        const pr = passReward(lv, true);
        if (pr) {
          res?.passRewards.push(pr);
          grantPassReward(st, pr);
        }
      }
    }
  }
}

function grantPassReward(st: MetaState, r: PassReward): void {
  switch (r.kind) {
    case 'gold': depositGoldWallet(r.amount); break;
    case 'crowns': st.crowns += r.amount; break;
    case 'token': st.speedupTokens += r.amount; break;
    case 'blessing': st.blessingTokens += r.amount; break;
    case 'skin': if (r.id) grantSkin(st, r.id); break;
    case 'title': case 'frame': break; // косметика-статус, хранение не требуется
    case 'banner': break;
  }
}

/** Золото в кошелёк лавки (единственный сток пропуска/цепочек/бонуса). */
function depositGoldWallet(gold: number): void {
  if (gold > 0) depositGold(Math.floor(gold));
}

/** Выдаёт скин в коллекцию (не назначает активным). */
export function grantSkin(st: MetaState, id: string): void {
  if (id && !st.skins.owned.includes(id)) st.skins.owned.push(id);
}

function bumpWeekly(st: MetaState, n: number): void {
  st.weekly.progress += n;
  // Пропуск этапа не обнуляет цепочку (§H.17): доступен следующий, финал ждёт
  while (st.weekly.stage < WEEKLY_STAGES.length && st.weekly.progress >= WEEKLY_STAGES[st.weekly.stage]) {
    st.weekly.stage += 1;
  }
}

/**
 * Забрать финал недельной цепочки (§H.17): 150 крон или знамя (чередование).
 */
export function claimWeeklyFinal(): { kind: 'crowns' | 'banner'; amount: number; id?: string } | null {
  const st = loadMetaState();
  if (st.weekly.claimed || st.weekly.stage < WEEKLY_STAGES.length) return null;
  st.weekly.claimed = true;
  const kind = weeklyFinalReward(st.weekly.week);
  let amount = 0;
  let id: string | undefined;
  if (kind === 'crowns') { amount = 150; st.crowns += amount; }
  else { id = 'banner_weekly'; grantSkin(st, id); }
  saveMetaState(st);
  return { kind, amount, id };
}

// ============================================================
// Ежедневный бонус: забор из меню одним кликом (§H.7)
// ============================================================

/** Прогрессивное раскрытие считает именно завершённые раны. Матч 3 начинается
 * после двух завершённых ранов; эти пороги используются UI и игровыми guard-ами. */
export const DAILY_BONUS_AFTER_MATCHES = FTUE_MATCH_GATE.dailyBonus;
export const CHALLENGE_AFTER_MATCHES = FTUE_MATCH_GATE.challenge;
export const CONTRACTS_AFTER_MATCHES = FTUE_MATCH_GATE.contracts;
export const CODEX_AFTER_MATCHES = FTUE_MATCH_GATE.codex;

export interface BonusClaimResult {
  ok: boolean;
  day: number;
  def: DailyBonusDef | null;
  doubled: boolean;
  streak: number;
}

/**
 * Забор дара дня одним кликом (§H.7). `useAd` — точка R11 (×2 дар, 1/день):
 * удваивает начисление, но не ломает цикл стрика.
 */
export function claimDailyBonus(useAd = false): BonusClaimResult {
  const st = rollMetaDay();
  const today = todayKey();
  const now = serverNow();
  const lastAt = st.dailyBonus.lastAt;
  const elapsed = lastAt > 0 ? now - lastAt : Number.POSITIVE_INFINITY;
  if (st.matchesPlayed < DAILY_BONUS_AFTER_MATCHES) {
    return { ok: false, day: st.dailyBonus.streak % 7, def: null, doubled: false, streak: st.dailyBonus.streak };
  }
  if (st.dailyBonus.last === today
    || (lastAt > 0 && elapsed < BONUS_MIN_INTERVAL_HOURS * 60 * 60 * 1000)) {
    return { ok: false, day: st.dailyBonus.streak % 7, def: null, doubled: false, streak: st.dailyBonus.streak };
  }
  // 26-часовое окно рассчитывается по серверному времени, а не по датам браузера.
  // Превышение окна снимает ровно одну ступень (§H.7); длинный перерыв не обнуляет стрик.
  const prev = st.dailyBonus.streak;
  const missedWindow = lastAt > 0
    && elapsed > BONUS_RESET_HOURS * 60 * 60 * 1000;
  const effective = missedWindow ? Math.max(0, prev - 1) : prev;
  const streak = effective + 1;
  st.dailyBonus = { last: today, lastAt: now, streak };
  const dayIdx = (streak - 1) % 7;
  const def = DAILY_BONUS[dayIdx];
  const doubled = useAd === true;
  applyBonus(st, def, doubled);
  saveMetaState(st);
  return { ok: true, day: dayIdx, def, doubled, streak };
}

export function applyBonus(st: MetaState, def: DailyBonusDef, doubled: boolean): void {
  const k = doubled ? 2 : 1;
  switch (def.kind) {
    case 'gold': depositGoldWallet(def.amount * k); break;
    case 'blessing': st.blessingTokens += def.amount * k; break;
    case 'crowns': st.crowns += def.amount * k; break;
    case 'chest': {
      // Сундук (§H.7): случайное из золота/ресурсов рана — золото и жетон
      const roll = hashStr(`chest:${todayKey()}:${st.matchesPlayed}`) % 3;
      if (roll === 0) depositGoldWallet(120 * k);
      else if (roll === 1) st.speedupTokens += 1 * k;
      else st.blessingTokens += 1 * k;
      break;
    }
  }
}

/** Требование R11: удвоение дара дня — только пока день не забран. */
export function bonusAvailable(): boolean {
  const st = rollMetaDay();
  const elapsed = st.dailyBonus.lastAt > 0 ? serverNow() - st.dailyBonus.lastAt : Number.POSITIVE_INFINITY;
  return st.matchesPlayed >= DAILY_BONUS_AFTER_MATCHES
    && st.dailyBonus.last !== todayKey()
    && !(st.dailyBonus.lastAt > 0 && elapsed < BONUS_MIN_INTERVAL_HOURS * 60 * 60 * 1000);
}

// ============================================================
// Ежедневный сундук — точка R7 (§J.3): 2 показа в день
// ============================================================

export const DAILY_CHEST_LIMIT = 2;

export interface DailyChestReward { kind: 'gold' | 'blessing' | 'speedup'; amount: number }

/** Осталось показов сундука сегодня (0 — кнопка скрыта). */
export function dailyChestLeft(): number {
  const st = rollMetaDay();
  if (st.matchesPlayed < DAILY_BONUS_AFTER_MATCHES) return 0;
  if (st.dailyChest.date !== todayKey()) return DAILY_CHEST_LIMIT;
  return Math.max(0, DAILY_CHEST_LIMIT - st.dailyChest.count);
}

/**
 * Ролик досмотрен — выдать награду сундука: золото кошелька / жетон
 * благословения / жетон ускорения (§J.3 R7). Возвращает null, если лимит
 * дня исчерпан или показ не засчитан.
 */
export function claimDailyChest(): DailyChestReward | null {
  if (dailyChestLeft() <= 0) return null;
  const st = rollMetaDay();
  if (st.dailyChest.date !== todayKey()) st.dailyChest = { date: todayKey(), count: 0 };
  st.dailyChest.count++;
  const roll = hashStr(`daily-chest:${todayKey()}:${st.dailyChest.count}`) % 100;
  let reward: DailyChestReward;
  if (roll < 60) {
    reward = { kind: 'gold', amount: 200 };
    depositGoldWallet(reward.amount);
  } else if (roll < 85) {
    reward = { kind: 'blessing', amount: 1 };
    st.blessingTokens += 1;
  } else {
    reward = { kind: 'speedup', amount: 1 };
    st.speedupTokens += 1;
  }
  saveMetaState(st);
  return reward;
}

// ============================================================
// Вызов дня (§H.8)
// ============================================================

export function challengeForToday(rerollSalt = ''): { mods: ChallengeModId[]; seed: string } {
  const st = rollMetaDay();
  return { mods: challengeModsForDate(st.quests.date, rerollSalt), seed: st.quests.date };
}

// ============================================================
// Кроны (§J.2, фаза S)
// ============================================================

/** Конвертация крон в золото лавки: 100 крон = 600 золота, 3/день. */
export function convertCrownsToGold(): { ok: boolean; reason?: 'limit' | 'poor' } {
  const st = rollMetaDay();
  const today = todayKey();
  if (st.crownConvert.date !== today) { st.crownConvert = { date: today, count: 0 }; }
  if (st.crownConvert.count >= CROWNS_TO_GOLD.perDay) return { ok: false, reason: 'limit' };
  if (st.crowns < CROWNS_TO_GOLD.crowns) return { ok: false, reason: 'poor' };
  st.crowns -= CROWNS_TO_GOLD.crowns;
  st.crownConvert.count += 1;
  saveMetaState(st);
  depositGoldWallet(CROWNS_TO_GOLD.gold);
  return { ok: true };
}

/** Кроны капают бесплатно (§J.7) — учитываются вне инапов, витрина честна. */

const PAID_SKIN_SKUS = [
  'skin_hero_warrior_red', 'skin_hero_warrior_yellow',
  'skin_hero_archer_red', 'skin_hero_archer_purple',
  'skin_hero_lancer_red', 'skin_hero_lancer_black',
  'skin_hero_monk_red', 'skin_hero_monk_yellow',
  'skin_bld_red', 'skin_bld_purple', 'skin_bld_yellow', 'skin_bld_black',
  'hero_trail_gold', 'hero_trail_ember',
] as const;
const GRANTABLE_IAP_SKUS = new Set([
  'crowns_s', 'crowns_m', 'crowns_l', 'crowns_xl',
  'starter_castellan', 'no_interstitial', 'pass_chronicle',
  ...PAID_SKIN_SKUS,
  'cs_horseshoe', 'cs_horn', 'cs_forester',
]);
const NON_REPLAYABLE_IAP_SKUS = new Set([
  'starter_castellan', 'no_interstitial', ...PAID_SKIN_SKUS,
]);

export interface IapGrantResult {
  supported: boolean;
  duplicate: boolean;
  /** False means the reward and receipt ledger could not be persisted safely. */
  persisted: boolean;
  granted: { crowns: number; skin?: string; consumable?: ConsumableId };
}

function applySkuGrant(st: MetaState, sku: string): { crowns: number; skin?: string; consumable?: ConsumableId } {
  if (!GRANTABLE_IAP_SKUS.has(sku)) return { crowns: 0 };
  if (!st.purchasedSkus.includes(sku)) st.purchasedSkus.push(sku);

  const PAKS: Record<string, { crowns: number }> = {
    crowns_s: { crowns: 90 },
    crowns_m: { crowns: 500 },
    crowns_l: { crowns: 1100 },
    crowns_xl: { crowns: 2500 },
  };
  let crowns = 0;
  let skin: string | undefined;
  let consumable: ConsumableId | undefined;
  if (PAKS[sku]) {
    // Первая покупка ×2 (§J.6.4)
    const first = !st.purchasedSkus.includes('first_topup');
    crowns = PAKS[sku].crowns * (first ? 2 : 1);
    if (first) st.purchasedSkus.push('first_topup');
    st.crowns += crowns;
  } else if (sku === 'starter_castellan') {
    crowns = 350; st.crowns += crowns;
    skin = 'skin_hero_warrior_red';
    grantSkin(st, skin);
    st.speedupTokens += 3;
  } else if (sku === 'no_interstitial') {
    // Entitlement is represented by purchasedSkus and restored from getPurchases().
  } else if (sku === 'pass_chronicle') {
    // Покупка задним числом: выдаёт все уже набранные премиум-уровни (§J.6.3)
    st.pass.premium = true;
    const lvl = Math.min(PASS.LEVELS, Math.floor(st.pass.xp / PASS.XP_PER_LEVEL));
    for (let i = 1; i <= lvl; i++) {
      const pr = passReward(i, true);
      if (pr) grantPassReward(st, pr);
    }
  } else if (sku.startsWith('skin_')) {
    skin = sku;
    grantSkin(st, sku);
  } else if (sku.startsWith('hero_trail_')) {
    skin = sku === 'hero_trail_gold' ? 'trail_gold' : 'trail_ember';
    grantSkin(st, skin);
  } else if (sku === 'cs_horseshoe' || sku === 'cs_horn' || sku === 'cs_forester') {
    consumable = sku;
    st.consumables[sku] += 1;
  }
  return { crowns, skin, consumable };
}

/** Local/dev grant. Platform purchases must use grantSkuForPurchase() instead. */
export function grantSku(sku: string): { crowns: number; skin?: string; consumable?: ConsumableId } {
  const st = rollMetaDay();
  const granted = applySkuGrant(st, sku);
  if (GRANTABLE_IAP_SKUS.has(sku)) saveMetaState(st);
  return granted;
}

/**
 * Atomically writes the reward and platform receipt token in the same metadata
 * record. Replaying getPurchases() therefore cannot credit a consumable twice.
 */
export function grantSkuForPurchase(sku: string, purchaseToken: string): IapGrantResult {
  const token = purchaseToken.trim();
  if (!GRANTABLE_IAP_SKUS.has(sku) || !token) {
    return { supported: false, duplicate: false, persisted: false, granted: { crowns: 0 } };
  }

  const st = rollMetaDay();
  if (st.processedIapTokens.includes(token)) {
    return { supported: true, duplicate: true, persisted: true, granted: { crowns: 0 } };
  }

  // Non-consumable/one-shot products may be present in getPurchases() forever.
  // Keep their entitlement, but never replay the original reward on a new token.
  // Keep a rollback snapshot: saveMetaState mutates the in-memory cache before storage.
  // If the browser denies persistence (quota/private mode), do not leave an
  // uncommitted token in that cache or the next retry could consume the receipt.
  const beforeGrant = structuredCloneSafe(st);
  const alreadyOwned = (NON_REPLAYABLE_IAP_SKUS.has(sku) && hasIapEntitlement(st, sku))
    || (sku === 'pass_chronicle' && st.pass.premium);
  const granted = alreadyOwned ? { crowns: 0 } : applySkuGrant(st, sku);
  st.processedIapTokens.push(token);
  const persisted = saveMetaState(st);
  if (!persisted) cached = beforeGrant;
  return { supported: true, duplicate: alreadyOwned, persisted, granted };
}

/** True when the profile already owns the entitlement represented by an IAP SKU. */
export function hasIapEntitlement(st: MetaState, sku: string): boolean {
  if (st.purchasedSkus.includes(sku)) return true;
  if (sku.startsWith('skin_')) return st.skins.owned.includes(sku);
  if (sku === 'hero_trail_gold') return st.skins.owned.includes('trail_gold');
  if (sku === 'hero_trail_ember') return st.skins.owned.includes('trail_ember');
  return false;
}

export function hasNoInterstitial(): boolean {
  return loadMetaState().purchasedSkus.includes('no_interstitial');
}

/** Активен ли расходник и его эффекты для рана. */
export function takeConsumables(ids: ConsumableId[]): void {
  const st = rollMetaDay();
  for (const id of ids) {
    if (st.consumables[id] > 0) st.consumables[id] -= 1;
  }
  saveMetaState(st);
}

/** Скин куплен за кроны прямо в витрине (цена — из SKINS). */
export function buySkinWithCrowns(id: string): { ok: boolean; reason?: 'unknown' | 'owned' | 'poor' } {
  const st = rollMetaDay();
  const def = SKINS.find((s) => s.id === id);
  if (!def) return { ok: false, reason: 'unknown' };
  if (st.skins.owned.includes(id)) return { ok: false, reason: 'owned' };
  if (st.crowns < def.price) return { ok: false, reason: 'poor' };
  st.crowns -= def.price;
  grantSkin(st, id);
  saveMetaState(st);
  return { ok: true };
}

/** Назначить активный скин (герой/постройки/шлейф/знамя). */
export function setActiveSkin(
  kind: 'hero' | 'building' | 'trail' | 'banner',
  id: string,
): boolean {
  const st = rollMetaDay();
  if (id !== '') {
    const def = SKINS.find((s) => s.id === id);
    const isBanner = BANNERS.some((b) => b.id === id);
    if (!def && !isBanner) return false;
    if (def && !st.skins.owned.includes(id)) return false;
    if (isBanner && !ownedBanners().includes(id)) return false;
  }
  if (kind === 'hero') st.skins.hero = id;
  else if (kind === 'building') st.skins.building = id;
  else if (kind === 'trail') st.skins.trail = id;
  else st.skins.banner = id;
  saveMetaState(st);
  return true;
}

/** Активный скин героя (tint или null). */
export function heroSkinTint(): number | null {
  const st = rollMetaDay();
  const def = SKINS.find((s) => s.kind === 'hero' && s.id === st.skins.hero);
  return def ? def.tint : null;
}

/** Активный скин построек (tint или null). */
export function buildingSkinTint(): number | null {
  const st = rollMetaDay();
  const def = SKINS.find((s) => s.kind === 'building' && s.id === st.skins.building);
  return def ? def.tint : null;
}

/** Активный шлейф героя (tint или null). */
export function trailSkinTint(): number | null {
  const st = rollMetaDay();
  const def = SKINS.find((s) => s.kind === 'trail' && s.id === st.skins.trail);
  return def ? def.tint : null;
}

/** Активное знамя поселения (над замком с первой секунды матча). */
export function activeBanner(): BannerDef | null {
  const st = rollMetaDay();
  return BANNERS.find((b) => b.id === st.skins.banner) ?? null;
}

/** Списать кроны (внутриигровые траты фазы S, кроме скинов). */
// ============================================================
// Утилиты доступа
// ============================================================

export function addGlory(n: number): void {
  if (n === 0) return;
  const st = rollMetaDay();
  st.glory = Math.max(0, st.glory + Math.floor(n));
  saveMetaState(st);
}

export function gloryBalance(): number {
  return rollMetaDay().glory;
}

/** Баланс жетонов ускорений (награды пропуска/сундуков, §J.6.2 → §G.8). */
export function speedupTokenBalance(): number {
  return rollMetaDay().speedupTokens;
}

/** Атомарное списание жетона ускорения (§J.9: без двойного списания). */
export function spendSpeedupToken(): boolean {
  const st = rollMetaDay();
  if (st.speedupTokens <= 0) return false;
  st.speedupTokens -= 1;
  // saveMetaState кэширует объект до записи. При отказе storage возвращаем
  // токен в тот же объект и запрещаем эффект, иначе ускорение стало бы бесплатным.
  if (!saveMetaState(st)) {
    st.speedupTokens += 1;
    return false;
  }
  return true;
}

export function matchesPlayed(): number {
  return rollMetaDay().matchesPlayed;
}

/** Узел дерева можно открыть после 3-го матча (гейт 48). */
export function treeUnlocked(): boolean {
  return rollMetaDay().matchesPlayed >= TREE_AFTER_MATCH;
}

/** Указы короля после 10-го матча (гейт 48). */
export function ordersUnlocked(): boolean {
  return rollMetaDay().matchesPlayed >= UKAZ_AFTER_MATCH;
}

/** Витрина крон после 5-го матча (гейт 45). */
export function showcaseUnlocked(): boolean {
  return rollMetaDay().matchesPlayed >= STOREFRONT_AFTER_MATCH;
}

/** Отдельный guard пропуска: порог объявлен отдельно, даже если совпадает с витриной. */
export function seasonPassUnlocked(): boolean {
  return rollMetaDay().matchesPlayed >= FTUE_MATCH_GATE.seasonPass;
}

export function buyNode(id: NodeId): { ok: boolean; reason?: 'locked' | 'poor' | 'owned' | 'unknown' } {
  const st = rollMetaDay();
  if (!treeUnlocked()) return { ok: false, reason: 'locked' };
  const def = TREE_NODES.find((n) => n.id === id);
  if (!def) return { ok: false, reason: 'unknown' };
  if (st.nodes.includes(id)) return { ok: false, reason: 'owned' };
  if (st.glory < def.cost) return { ok: false, reason: 'poor' };
  st.glory -= def.cost;
  st.nodes.push(id);
  saveMetaState(st);
  return { ok: true };
}

export function claimChainReward(chainId: string, tier: number): { ok: boolean; reward?: 'bronze' | 'silver' | 'gold' } {
  const st = rollMetaDay();
  const chain = CHAINS.find((c) => c.id === chainId);
  if (!chain || tier < 0 || tier > 2) return { ok: false };
  const key = `${chainId}:${tier}`;
  if (st.chains.claimed.includes(key)) return { ok: false };
  const val = st.chains.counters[chain.metric] ?? 0;
  if (val < chain.tiers[tier]) return { ok: false };
  st.chains.claimed.push(key);
  if (tier === 0) depositGoldWallet(CHAIN_REWARDS.bronze);
  else if (tier === 1) { depositGoldWallet(CHAIN_REWARDS.silver); st.blessingTokens += 1; }
  else { st.crowns += CHAIN_REWARDS.gold; }
  saveMetaState(st);
  return { ok: true, reward: tier === 0 ? 'bronze' : tier === 1 ? 'silver' : 'gold' };
}

export function chainClaimed(chainId: string, tier: number): boolean {
  return rollMetaDay().chains.claimed.includes(`${chainId}:${tier}`);
}

/** Отметить запись кодекса (встречено/использовано). */
export function markCodex(id: string, n = 1): void {
  if (!id) return;
  const st = rollMetaDay();
  const was = st.codex[id] ?? 0;
  st.codex[id] = was + n;
  saveMetaState(st);
  // §K.2: `codex_entry` — сигнал открытия записи. Без него нельзя понять,
  // какие записи кодекса реально открываются игроками (§H.10 — перфекционистский
  // двигатель возврата, его эффективность измеряется этим событием).
  if (was === 0) track('codex_entry', { entry: id });
}

/** Прогресс полноты кодекса: открытые записи / всего. */
export function codexProgress(): { seen: number; total: number; ratio: number } {
  const st = rollMetaDay();
  let seen = 0;
  let total = 0;
  for (const sec of CODEX_SECTIONS) {
    for (const e of sec.entries) {
      total += 1;
      // Запись открыта, если счётчик встречаемости > 0
      const count = e.id.startsWith('w_') ? (st.codex[e.id] ?? 0)
        : e.id.startsWith('e_') ? (st.codex[e.id] ?? 0)
        : e.id.startsWith('card_') ? (st.codex[e.id] ?? 0)
        : (st.codex[e.id] ?? 0);
      if (count > 0 || (e.id.startsWith('card_') && (st.codex[e.id] ?? 0) > 0)) seen += 1;
    }
  }
  return { seen, total, ratio: total > 0 ? seen / total : 0 };
}

export function codexCount(id: string): number {
  return rollMetaDay().codex[id] ?? 0;
}

/** Знамёна, доступные игроку по состоянию прогресса (§J.6.2). */
export function ownedBanners(): string[] {
  const st = rollMetaDay();
  const out: string[] = [];
  const { ratio } = codexProgress();
  if (ratio >= 0.5) out.push('banner_codex_50');
  if (ratio >= 0.75) out.push('banner_codex_75');
  if (ratio >= 1) out.push('banner_codex_100');
  if (st.weekly.claimed) out.push('banner_weekly');
  if (st.pass.premium) out.push('banner_pass');
  if (st.purchasedSkus.includes('starter_castellan')) out.push('banner_store_1');
  if (SKINS.some((s) => s.kind === 'building' && st.skins.owned.includes(s.id))) out.push('banner_store_2');
  return out;
}

/** Реролл задания дня за рекламу (R10, лимит 3/день). */
export function rerollQuestSlot(slot: number): { ok: boolean; reason?: 'limit' | 'bad-slot' } {
  const st = rollMetaDay();
  if (st.quests.rerolls >= 3) return { ok: false, reason: 'limit' };
  if (slot < 0 || slot >= st.quests.ids.length) return { ok: false, reason: 'bad-slot' };
  st.quests.rerolls += 1;
  const rng = mulberry32(hashStr(`reroll:${st.quests.date}:${st.quests.rerolls}:${slot}`));
  const current = new Set(st.quests.ids);
  const pool = QUEST_POOL.map((q) => q.id).filter((id) => !current.has(id));
  if (pool.length === 0) return { ok: false, reason: 'bad-slot' };
  const next = pool[Math.floor(rng() * pool.length)];
  const oldId = st.quests.ids[slot];
  delete st.quests.progress[oldId];
  st.quests.ids[slot] = next;
  saveMetaState(st);
  return { ok: true };
}

/** Вызов дня: была ли уже победа сегодня (для 3 крон §J.7). */
export function challengeVictoryToday(): boolean {
  return rollMetaDay().challengeWinDate === todayKey();
}

/** Победа в вызове дня: +3 кроны и +75 XP пропуска (§H.8, §J.7). */
export function markChallengeVictory(): void {
  const st = rollMetaDay();
  if (st.challengeWinDate === todayKey()) return;
  st.challengeWinDate = todayKey();
  st.crowns += CHALLENGE_CROWNS;
  addPassXp(st, null, PASS.XP.challenge);
  saveMetaState(st);
}
