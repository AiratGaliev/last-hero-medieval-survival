import Phaser from 'phaser';
import { Cursor } from '../systems/Cursor';
import { FONT } from '../constants';
import { makePanel, makeRibbon, makeButton, fitTextWidth, type Button } from '../systems/Ui';
import { audio } from '../systems/Audio';
import { t, num, clock, type TranslationKey } from '../../i18n';
import { submitScore, LEADERBOARD_DAILY, LEADERBOARD_ENDLESS } from '../../platform/leaderboard';
import { isAuthorized, displayName } from '../../platform/player';
import {
  placementAvailable, placementBlockReason, registerRunOutcome, showInterstitial, showPlacementRewarded,
  showStickyBanner, refundPlacement,
} from '../../platform/ads';
import { gameplayStop } from '../../platform/lifecycle';
import { track } from '../../platform/analytics';
import { loadText, saveText } from '../storage';
import {
  addGlory, challengeVictoryToday, contractDef, gloryDoubleExtra, loadMetaState, markChallengeVictory, saveRunConfig,
} from '../meta';
import { depositGold } from '../shop';
import { claimStoreOfferForSession, type StoreOfferKind } from '../storeOffers';

// ============ Экран конца матча: статистика + рекорд + монетизация ============
// Всё внутри Phaser: гость вводит имя в нативный <input> (DOMElement),
// авторизованный игрок Яндекса получает имя из профиля. Рекорд уходит
// либо в общий зал Яндекс Игр, либо в локальную таблицу (см. platform/leaderboard).
//
// Вёрстка. Тело (статистика, урон по оружию, новые достижения) скроллится,
// низ (имя, воскрешение, сохранение, действия) закреплён у нижней границы.
// Раньше всё складывалось одной переменной `cursor` сверху вниз, и на
// 1280×720 с полным набором оружия кнопка «Сохранить» уезжала за экран —
// рекорд было физически не сохранить.
//
// Монетизация конца матча (§J.3, точки R5/R9): компактные ×2-кнопки рядом
// с сохранением (или отдельным рядом над ним, если по ширине не встают)
// и вход в бесконечный режим третьей кнопкой в ряду действий.

export interface GameOverStats {
  victory: boolean;
  time: number;
  kills: number;
  level: number;
  gold: number;
  score: number;
  /** Контрактный счёт только для результата; primary leaderboard использует score. */
  contractScore?: { id: string; multiplier: number; baseScore: number; adjustedScore: number };
  hero?: string;
  difficulty?: string;
  difficultyId?: string;
  bestCombo?: number;
  weapons?: { id: string; icon: string; name: string; dmg: number; kills: number; evolved?: boolean }[];
  newAch?: { name: string; emoji: string }[];
  // Поселение (§E.8, §H.3): ставки, хроника и near-miss
  loseCause?: string;
  ideal?: boolean;
  settlement?: {
    defence: number;
    population: number;
    buildings: number;
    pawns: number;
    castleHp: number;
    siegesTotal: number;
    siegesDefended: number;
    monasteryFallenAt: string | null;
    monasteryVictims: number;
    bledOutName?: string | null;
    bledOutShort?: number;
  };
  veterans?: Array<{ name: string; stars: number }>;
  // Раунд 2 (фазы Q/S): итоги применения рана к мета-состоянию.
  // Заполняется GameScene в gameOver() через applyRunToMeta().
  meta?: {
    glory: { base: number; bonus: number; total: number; cap: number } | null;
    questsDone: number;
    questsTotal: number;
    questsCompletedNow: { descKey: string; reward: number }[];
    passLevels: number;
    passRewards: { kind: string; amount: number }[];
    chainUnlocks: { nameKey: string; tier: number }[];
    /** Скин сезона, выданный после достижения пятой вехи. */
    seasonStepReward?: string | null;
    endlessWave: number;
    crownsEarned: number;
    /** False means the run's meta rewards were not committed durably. */
    persisted?: boolean;
    /** False means a run's separate gold wallet credit was not persisted. */
    walletRewardSaved?: boolean;
    /** Тип контекстного предложения, рассчитанный после фиксации текущего рана. */
    storeOffer?: StoreOfferKind;
    /** Сохраняет уже показанное предложение при перерисовке экрана после resize. */
    storeOfferSessionClaimed?: boolean;
    /** False means a successful daily challenge did not persist its daily reward. */
    challengeRewardSaved?: boolean;
    challenge: boolean;
    ukaz: string | null;
    endless: boolean;
    weeklyChallenge?: boolean;
    weeklyChallengeBest?: number;
  };
}

interface GameOverData {
  stats: GameOverStats;
  /** Первое обучение хронике показываем на её собственных строках. */
  showChronicleTutorial?: boolean;
  /** Успешный рендер одноразового tutorial фиксирует аккаунтный FTUE-маркер. */
  onChronicleTutorialShown?: () => void;
}

/** План ряда действий: третья кнопка «ДЕРЖАТЬ КРЕПОСТЬ» (§H.7). */
interface ActionPlan {
  threeInRow: boolean;
  rowY: number;
  wAgain: number;
  wEndless: number;
  wMenu: number;
}

/** План ×2-кнопок: рядом с сохранением или отдельным рядом над ним (§J.3). */
interface X2Layout {
  gold: boolean;
  glory: boolean;
  flank: boolean;
  rowY: number;
  saveW: number;
  goldW: number;
  gloryW: number;
}

/** ×2-кнопки компактнее основных; тач-гейт §I.6 — не меньше 44 px. */
const X2_H = 44;
const X2_FONT = 13;

/**
 * Глубина затемнения внутри сцены итогов.
 *
 * Вся сцена лежит на нулевой глубине, и порядок отрисовки задаётся порядком
 * добавления. Затемнение с минусовой глубиной гасит ИГРОВУЮ сцену (сцены
 * рисуются по порядку запуска, а не по глубине), но остаётся под лентой,
 * панелью и кнопками самого окна.
 */
const DEPTH_LOW = -1;

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** Что удалось показать игрок�� после сохранения. */
type SaveTarget = 'none' | 'online' | 'local' | 'error';

export class GameOverScene extends Phaser.Scene {
  private payload!: GameOverData;
  /** Состояние сохранения переживает рестарт сцены (ресайз) — но не новый матч */
  private saveState: SaveState = 'idle';
  private lastStatsRef: GameOverStats | null = null;
  private nameValue = '';
  private nameInput: Phaser.GameObjects.DOMElement | null = null;
  private saveBtn: Button | null = null;
  private saveMsg: Phaser.GameObjects.Text | null = null;
  private saveTarget: SaveTarget = 'none';
  private saveY = 0;
  // ×2-кнопки (R5/R9): удвоение переживает рестарт сцены (ресайз),
  // но сбрасывается новым матчем — как saveState по lastStatsRef
  private goldBtn: Button | null = null;
  private gloryBtn: Button | null = null;
  private goldDoubled = false;
  private gloryDoubled = false;
  /** Причина недоступности ×2-кнопок (§J.3: гаснет С ПОДПИСЬЮ причины). */
  private goldBlock: 'platform' | 'limit' | null = null;
  private gloryBlock: 'platform' | 'limit' | null = null;
  private goldNote = '';
  private gloryNote = '';
  /** R9 при нулевой прибавке (слава у потолка) — показ бессмысленен. */
  private gloryDead = false;
  /** Разовые за матч действия: исход для рекламы, вызов дня, вторичные борды. */
  private matchHandled: GameOverStats | null = null;
  /** Не допускаем повторные запросы рекламы/рестарта при быстрых тапах. */
  private restartPending = false;

  constructor() {
    super('GameOver');
  }

  /** Курсор в стиле Tiny Swords: следит за наведением и переключает
   *  состояние. В CSS у курсора !important — он перебивает инлайновый
   *  cursor, который Phaser ставит через useHandCursor. */
  private cursor!: Cursor;

  create(payload: GameOverData): void {
    this.cursor = new Cursor(this);
    this.payload = payload;
    if (this.lastStatsRef !== payload.stats) {
      // Новый матч — сбрасываем прогресс сохранения и ×2-удвоения.
      this.saveState = 'idle';
      this.lastStatsRef = payload.stats;
      this.saveTarget = 'none';
      this.nameValue = loadText('tss-name') ?? '';
      this.goldDoubled = false;
      this.gloryDoubled = false;
      this.matchHandled = null;
      this.restartPending = false;
    }
    this.nameInput = null;
    this.saveBtn = null;
    this.saveMsg = null;
    this.goldBtn = null;
    // Стики-баннер (§J.5): экран конца — вне рана
    showStickyBanner();
    this.gloryBtn = null;

    // Бой окончен — площадка не должна считать это активным геймплеем
    gameplayStop();

    const s = this.payload.stats;
    const { width, height } = this.scale;
    const compact = height < 520;

    // Разовые за матч действия (исход для политики рекламы, награда вызова
    // дня, авто-сабмит вторичных бордов) — рестарт сцены их не повторяет
    this.handleMatchOnce(s);

    // Затемнение ложится под весь контент окна (см. DEPTH_LOW ниже), но
    // ВЫШЕ игровой сцены: сцены рисуются по порядку запуска, поэтому
    // отрицательной глубины достаточно, чтобы гасить мир и HUD, и при этом
    // не гасить собственные заголовок, панель и кнопки.
    this.add.rectangle(width / 2, height / 2, width + 40, height + 40, 0x0a0a12, 0.78)
      .setScrollFactor(0).setDepth(DEPTH_LOW);

    // ---------- Бюджет высоты ----------
    // Шапка и низ получают фиксированную долю экрана, тело — остаток.
    // Каждый блок тела умещается в отведённую высоту и ничего не выходит
    // за нижнюю границу, поэтому кнопки всегда доступны на любом размере.
    const actH = compact ? 40 : 50;
    const saveH = compact ? 38 : 44;
    const inputH = compact ? 34 : 44;

    // Кнопка бесконечного режима (§H.7): видна после первой победы
    const showEndless = loadMetaState().firstWin || !!s.meta?.endless;
    const actRowH = showEndless ? Math.max(44, actH) : actH;
    // §H.3: «после блока 3 — кнопка „ЕЩЁ РАЗ“ КРУПНЕЕ ВСЕХ ОСТАЛЬНЫХ».
    // Раньше ширина считалась по контенту, и на широком экране
    // «ДЕРЖАТЬ КРЕПОСТЬ» выходила шире — главный призыв к рестарту выглядел
    // второстепенным. Теперь у «ЕЩЁ РАЗ» и шрифт на ступень больше, и
    // минимальная ширина не меньше, чем у соседей по ряду.
    const endlessPlan: ActionPlan | null = showEndless
      ? {
          wAgain: this.btnWidthFor(t('over.again'), 18, 150, 300),
          wEndless: this.btnWidthFor(t('over.endlessEnter'), 15, 150, Math.min(260, Math.max(160, width - 40))),
          wMenu: this.btnWidthFor(t('over.toMenu'), 15, 96, 200),
          threeInRow: false,
          rowY: 0,
        }
      : null;
    if (endlessPlan) {
      endlessPlan.threeInRow =
        endlessPlan.wAgain + endlessPlan.wEndless + endlessPlan.wMenu + 20 + 24 <= width;
    }

    // §J.3: «Кнопка недоступна → гаснет с подписью причины». Паттерн применяется
    // ко ВСЕМ точкам реестра, не только к преемственности. Раньше кнопки
    // просто исчезали, и игрок не понимал, почему реклама недоступна.
    // У R9 дополнительно гасим при нулевой прибавке: показ ролика за 0 славы
    // — это трата внимания впустую.
    const goldBlock = placementBlockReason('wallet-x2');
    const gloryBlock = placementBlockReason('glory-x2');
    const gloryGain = s.meta?.glory ? gloryDoubleExtra(s.meta.glory) : 0;
    const gloryDead = gloryGain <= 0;
    const x2 = {
      gold: !compact && s.gold > 0 && (this.goldDoubled || placementAvailable('wallet-x2')),
      glory: !compact && !!s.meta?.glory && !gloryDead
        && (this.gloryDoubled || placementAvailable('glory-x2')),
    };
    const x2Note = (block: 'platform' | 'limit' | null): string =>
      this.goldDoubled || this.gloryDoubled ? t('over.x2Done')
        : block === 'limit' ? t('ad.reasonLimit')
          : block === 'platform' ? t('ad.reasonUnavailable') : '';
    // Сохраняем причины для applyX2State — она вызывается и при повторном
    // входе в экран (рестарт сцены), когда x2 уже вычислены заново.
    this.goldBlock = goldBlock;
    this.goldNote = x2Note(goldBlock);
    this.gloryBlock = gloryBlock;
    this.gloryNote = x2Note(gloryBlock);
    this.gloryDead = gloryDead;
    const saveW = Math.min(280, width - 70);
    // Обе кнопки рядом обязаны влезать в ряд: ограничиваем ширину заранее
    const x2Cap = x2.gold && x2.glory ? Math.floor((width - 42) / 2) : Math.max(120, width - 70);
    const x2GoldW = x2.gold ? this.btnWidthFor(t('over.goldX2'), X2_FONT, 120, Math.max(120, x2Cap)) : 0;
    const x2GloryW = x2.glory ? this.btnWidthFor(t('over.gloryX2'), X2_FONT, 120, Math.max(120, x2Cap)) : 0;
    const x2Sum = (x2GoldW > 0 ? x2GoldW + 12 : 0) + (x2GloryW > 0 ? x2GloryW + 12 : 0);
    // Хватает ли ширины, чтобы поставить ×2 рядом с кнопкой сохранения
    const x2Flank = x2Sum > 0 && saveW + x2Sum + 24 <= width;

    // Низ: считаем снизу вверх — так он гарантированно на экране
    let fy = height - actRowH / 2 - 8;
    const actionsY = fy;
    fy -= actRowH / 2 + 10;

    // Узкий экран: «ДЕРЖАТЬ КРЕПОСТЬ» уходит отдельным рядом сверху
    if (endlessPlan && !endlessPlan.threeInRow) {
      endlessPlan.rowY = fy - actRowH / 2;
      fy = endlessPlan.rowY - actRowH / 2 - 10;
    }

    this.saveY = fy - saveH / 2;
    fy = this.saveY - saveH / 2 - 8;

    // Если рядом с сохранением ×2 не развернулись — отдельный ряд над ним
    let x2RowY = 0;
    if (x2Sum > 0 && !x2Flank) {
      x2RowY = fy - X2_H / 2;
      fy = x2RowY - X2_H / 2 - 6;
    }

    const inputY = fy - inputH / 2;
    const bodyBottom = Math.max(40, inputY - inputH / 2 - 12);

    // Шапка — ЛЕНТА из пака, на любой высоте экрана.
    //
    // Раньше здесь стоял девятислайс-баннер `banner9` высотой 200 px. На
    // скриншотах он рисовался РАЗОРВАННЫМ: между тайлами видны чёрные
    // дыры, а завитки по нижнему краю отрываются и висят отдельно. Слайсы
    // баннера (68 сверху, 111 снизу, всего 179) не помещались в 200 px, и
    // Phaser рисовал торцы поверх середины — тот же дефект, что был с
    // лентами до перехода на три отдельных куска.
    //
    // Держать сломанный ассет ради «большой шапки» смысла нет: лента
    // рисуется корректно на любой высоте (ею оформлены «Лавка», «Хроника»,
    // LevelUp, пауза и преемственность) и даёт тот же узнаваемый заголовок.
    // Заодно шапка перестала съедать 200 px, которые уходили телу итогов.
    const titleSize = compact ? 22 : Phaser.Math.Clamp(height * 0.045, 28, 38);
    // Высота ленты считается от кегля заголовка, чтобы надпись не
    // наезжала на изгибы по краям.
    const ribbonH = Math.round(titleSize * 1.55);
    const ribbonW = Math.min(width - 40, Math.max(240, width * 0.46));
    const ribbonY = ribbonH / 2 + 8;
    makeRibbon(this, width / 2, ribbonY, ribbonW, 'ribbon-red', ribbonH)
      .setScrollFactor(0).setDepth(1);

    // Origin по вертикали в центре: заголовок центрируется ВНУТРИ ленты.
    // С origin «верх» приходилось вручную вычитать половину высоты, и при
    // смене кегля надпись съезжала.
    this.add.text(width / 2, ribbonY, s.victory ? t('over.win') : t('over.lose'), {
      fontFamily: FONT, fontSize: `${titleSize}px`,
      color: s.victory ? '#ffd700' : '#ff6b5e',
      stroke: '#1b1008', strokeThickness: Math.max(5, Math.round(titleSize / 4)),
    }).setOrigin(0.5, 0.5).setScrollFactor(0).setDepth(2);
    let headerBottom = ribbonY + ribbonH / 2 + (compact ? 6 : 8);
    // Бейдж идеальной победы (§E.7, слой 3): босс убит + замок цел + ≥3 пешек
    if (s.ideal) {
      const badge = this.add.text(width / 2, headerBottom + 2, t('over.idealVictory'), {
        fontFamily: FONT, fontSize: compact ? '13px' : '16px', color: '#ffd700',
        stroke: '#5a0808', strokeThickness: 6,
      }).setOrigin(0.5, 0).setScrollFactor(0);
      this.tweens.add({ targets: badge, scale: { from: 0.7, to: 1 }, duration: 380, ease: 'Back.easeOut' });
      headerBottom = badge.y + badge.height + 4;
    }

    // ---------- Тело ----------
    // Если шапка съела слишком много, тело начинается ниже: итоги важнее
    // расстояния между блоками.
    const bodyTop = Math.min(headerBottom, Math.max(40, bodyBottom - 40));
    this.buildBody(s, width, bodyTop, bodyBottom, compact);

    // ---------- Низ ----------
    this.createNameInput(inputY, inputH);
    this.createSaveUi(saveH);
    this.createActions(actionsY, actRowH, width, endlessPlan);
    this.createDoubleButtons({
      gold: x2.gold, glory: x2.glory, flank: x2Flank, rowY: x2RowY, saveW,
      goldW: x2GoldW, gloryW: x2GloryW,
    });

    // При изменении размера окна (поворот телефона) — перерисовать на новых координатах
    this.scale.on('resize', this.rebuild, this);
    this.events.once('shutdown', () => {
      // Нативный input мог остаться в DOM-слое — убираем вручную
      try {
        (this.nameInput?.node as HTMLElement | undefined)?.remove();
      } catch {
        // элемент уже удалён
      }
      this.nameInput = null;
      this.scale.off('resize', this.rebuild, this);
    });
  }

  /**
   * Разовые за матч действия: регистрация исхода для рекламной политики,
   * награда за победу в вызове дня, авто-сабмит вторичных бордов.
   * Переживает рестарт сцены (ресайз) — повторяется только в новом матче.
   */
  private handleMatchOnce(s: GameOverStats): void {
    if (this.matchHandled === s) return;
    this.matchHandled = s;

    // Политике interstitial (§J.4) нужен исход ровно один раз: create()
    // вызывается повторно при каждом ресайзе с той же статистикой
    registerRunOutcome(s.victory);

    const m = s.meta;
    if (!m) return;

    // Победа в вызове дня: награда раз в UTC-день.
    // Если сохранить награду не удалось, итоговый экран обязан сообщить об этом.
    if (m.challenge && s.victory && !challengeVictoryToday()) {
      m.challengeRewardSaved = markChallengeVictory();
    }

    // Авто-сабмит технических бордов. Имя — без зависимости от input:
    // гость берётся из 'tss-name', авторизованному подставит профиль
    const name = displayName(this.nameValue);
    if (m.endless) {
      void submitScore(
        { name, score: s.score, kills: s.kills, level: s.level, timeSurvived: s.time, victory: s.victory },
        LEADERBOARD_ENDLESS,
      );
    }
    if (m.challenge) {
      void submitScore(
        { name, score: s.score, kills: s.kills, level: s.level, timeSurvived: s.time, victory: s.victory },
        LEADERBOARD_DAILY,
      );
    }
  }

  // ================================================================
  // Тело экрана
  // ================================================================

  /**
   * Итоги матча, урон по оружию и новые достижения.
   *
   * Содержимое подгоняется под доступную высоту: список оружия показывает
   * столько строк, сколько помещается (и не показывает ни одной, если
   * места нет), достижения при нехватке места сворачиваются в одну строку.
   * Итоги матча видны всегда — они важнее деталей.
   *
   * Маски в Phaser 4 работают только в Canvas-рендерере, а игра идёт в WebGL,
   * поэтому вариант «отрезать контейнер по высоте» физически не работает.
   */
  private buildBody(
    s: GameOverStats, width: number, top: number, bottom: number, compact: boolean,
  ): void {
    const body = this.add.container(0, 0).setScrollFactor(0);
    const pad = compact ? 8 : 14;
    const cx = width / 2;
    // Строим от нуля, в конце сдвигаем контейнер: при свободном месте
    // (например, на 1920×1080) блок не прилипал к шапке, а стоял по центру.
    let y = 0;

    // --- Итоги матча ---
    // На широких экранах идём в две колонки: одна колонка из семи строк
    // занимала ~190 px и съедала место, где уместен разбор урона оружием.
    const heroLine = s.hero ? t('over.hero', { v: s.hero.toUpperCase() }) : '';
    const pairs: Array<[string, string]> = [
      [t('over.time', { v: clock(s.time) }), t('over.kills', { v: num(s.kills) })],
      [t('over.level', { v: num(s.level) }), (s.bestCombo ?? 0) >= 5 ? t('over.combo', { v: s.bestCombo ?? 0 }) : ''],
      [t('over.gold', { v: num(s.gold) }), t('over.score', { v: num(s.score) })],
    ];
    if (s.contractScore) {
      const contract = contractDef(s.contractScore.id);
      pairs.push([
        t('over.contractLabel', {
          name: contract ? t(contract.nameKey as TranslationKey) : t('contract.title'),
          mult: s.contractScore.multiplier,
        }),
        t('over.contractScore', { v: num(s.contractScore.adjustedScore) }),
      ]);
    }

    const avail = Math.max(60, bottom - top - pad);
    const statFont = compact ? 12 : avail < 220 ? 13 : 15;
    const statSpacing = compact ? 4 : 6;
    const twoCol = width >= 470 && !compact;

    const statStyle: Phaser.Types.GameObjects.Text.TextStyle = {
      fontFamily: FONT, fontSize: `${statFont}px`, color: '#3b2410',
      align: 'center', lineSpacing: statSpacing,
    };

    if (twoCol) {
      if (heroLine) {
        body.add(this.add.text(cx, y, heroLine, { ...statStyle, color: '#9a6a08' }).setOrigin(0.5, 0));
        y += statFont + 10;
      }
      const colW = Math.min(240, width * 0.42);
      const probe = this.add.text(0, 0, 'x', { ...statStyle }).setOrigin(0.5, 0);
      const rowH = probe.height + 2;
      probe.destroy();
      pairs.forEach((pair, i) => {
        const ry = y + i * rowH;
        body.add(this.add.text(cx - colW / 2, ry, pair[0], statStyle).setOrigin(0.5, 0));
        body.add(this.add.text(cx + colW / 2, ry, pair[1], { ...statStyle, color: '#9a6a08' }).setOrigin(0.5, 0));
      });
      y += pairs.length * rowH + 10;
    } else {
      const lines = [
        heroLine,
        ...pairs.map(([a, b]) => [a, b].filter(Boolean).join('   ')),
      ].filter((l) => l.trim().length > 0);
      const statsText = this.add.text(cx, y, lines.join('\n'), statStyle).setOrigin(0.5, 0);
      body.add(statsText);
      y += statsText.height + (compact ? 8 : 12);
    }

    // --- Сложность ---
    if (s.difficulty && top + y + 20 <= bottom) {
      // Знак ☠ ставится по id сложности, а не по переведённому названию:
      // сравнение со строкой «КОШМАР» не срабатывало в английской сборке.
      const mark = s.difficultyId === 'nightmare' ? ' ☠' : '';
      body.add(this.add.text(cx, y, `${t('over.difficulty', { v: s.difficulty.toUpperCase() })}${mark}`, {
        fontFamily: FONT, fontSize: compact ? '11px' : '13px', color: '#6b4a1e',
      }).setOrigin(0.5, 0));
      y += compact ? 18 : 22;
    }

    // --- ЗАЩИТА / НАСЕЛЕНИЕ (§E.8) — ставка слоя 2 в итогах ---
    const st = s.settlement;
    if (st && top + y + 20 <= bottom) {
      body.add(this.add.text(cx, y, `${t('over.statsSettlement', { v: num(st.defence) })}   ${t('over.statsPopulation', { v: num(st.population) })}`, {
        fontFamily: FONT, fontSize: compact ? '11px' : '13px', color: '#3b6ea5',
      }).setOrigin(0.5, 0));
      y += compact ? 18 : 22;
    }

    // --- Мета-итоги (фазы Q/S): слава, задания, пропуск, цепи, вызов, волны ---
    y = this.renderMetaLines(body, s, y, width, compact, bottom - top - y - pad);

    // --- Хроника поселения (§H.3, блок 1): 3–6 строк авто-текста по фактам ---
    y = this.renderChronicle(body, s, y, width, compact, bottom - top - y - pad);

    // --- Near-miss (§H.3, блок 2): ровно одна строка, приоритет сверху вниз ---
    y = this.renderNearMiss(body, s, y, width, compact, bottom - top - y - pad);
    y = this.renderStoreOffer(body, s, y, width, compact, bottom - top - y - pad);

    // --- Урон по оружию ---
    y = this.renderWeaponStats(body, s, y, width, compact, bottom - top - y - pad);

    // --- Новые достижения ---
    const ach = s.newAch ?? [];
    if (ach.length > 0 && top + y + 24 <= bottom) {
      const wrap = Math.min(480, width - 60);
      const items = ach.map((a) => `${a.emoji} ${a.name}`).join('  •  ');
      // Полный вариант меряем заранее и рисуем только если он влезает
      const probe = this.add.text(cx, 0, items, {
        fontFamily: FONT, fontSize: '12px', wordWrap: { width: wrap },
      }).setOrigin(0.5, 0);
      const needFull = 16 + probe.height + 6;
      probe.destroy();

      if (bottom - top - y >= needFull) {
        body.add(this.add.text(cx, y, t('over.newAch'), {
          fontFamily: FONT, fontSize: '12px', color: '#9a6a08',
        }).setOrigin(0.5, 0));
        body.add(this.add.text(cx, y + 16, items, {
          fontFamily: FONT, fontSize: '12px', color: '#3b2410',
          align: 'center', wordWrap: { width: wrap },
        }).setOrigin(0.5, 0));
      } else {
        // Не влезает — одна строка с числом и первыми названиями
        const names = ach.slice(0, 2).map((a) => a.name).join(', ');
        const more = ach.length > 2 ? ` +${ach.length - 2}` : '';
        body.add(this.add.text(cx, y + 2, `${t('over.newAch')} ${ach.length} · ${names}${more}`, {
          fontFamily: FONT, fontSize: '12px', color: '#9a6a08',
          wordWrap: { width: wrap },
          align: 'center',
        }).setOrigin(0.5, 0));
      }
    }

    // Ставим блок в доступную область: при нехватке места — сверху,
    // при запасе — по центру.
    const regionH = Math.max(40, bottom - top - pad);
    body.y = top + pad + Math.max(0, (regionH - y) / 2);

    // Подложка под итоги — обычный кремовый пергамент, как строки «Лавки».
    //
    // Раньше здесь стоял «особый пергамент» (`special-paper-clipping`) —
    // тёмно-синий лист с золотыми уголками. Он был единственным тёмным
    // пятном в игре: «Лавка» и «Хроника» держались на кремовой бумаге, а
    // итоги матча выглядели как вклеенная выписка из чужого документа.
    // Текст на нём тоже приходилось делать светлым с тёмной обводкой —
    // золотой «Опыт: +1» на синем фоне читался плохо. Теперь материал и
    // текст взяты из палитры остальных окон.
    if (y > 30) {
      const sheetW = Math.min(520, width - 40);
      // Поле пергамента под его декоративную рамку (~45 px сверху и снизу).
      //
      // Раньше лист был шире содержимого всего на 18 px, и последняя строка
      // хроники («Идеальная победа: да.») ложилась прямо на тёмную кайму —
      // визуально обрезалась. Поле теперь не меньше рамки и никогда не
      // выходит за пределы отведённой области.
      const inset = Math.min(52, Math.max(18, (regionH - y) / 2));
      const sheetH = Math.min(regionH, y + 2 * inset);
      const sheet = makePanel(this, cx, y / 2, 'paper', sheetW, sheetH)
        .setScrollFactor(0)
        .setAlpha(0.96);
      body.addAt(sheet, 0);
    }
  }

  /**
   * Мета-итоги (фазы Q/S): начисление славы с потолком и бонусом, задания
   * дня, пропуск и цепочки, победа в вызове, волны бесконечного режима.
   * Компактные строки между сводкой поселения и хроникой; строка рисуется,
   * только если влезает в остаток тела.
   */
  private renderMetaLines(
    body: Phaser.GameObjects.Container, s: GameOverStats, cursor: number,
    width: number, compact: boolean, avail: number,
  ): number {
    const m = s.meta;
    if (!m || avail < 14) return cursor;
    const cx = width / 2;
    const fs = compact ? 10 : 12;
    const lines: Array<{ text: string; color: string }> = [];
    if (m.persisted === false || m.walletRewardSaved === false || m.challengeRewardSaved === false) {
      lines.push({ text: t('meta.runSaveFailed'), color: '#b3261e' });
    }

    // Начисление славы за матч; потолок и бонус идеальной победы (§H.16)
    if (m.glory) {
      let text = t('over.glory', { v: num(m.glory.total) });
      if (m.glory.base >= m.glory.cap) text += ` · ${t('over.gloryCap', { v: num(m.glory.cap) })}`;
      if (m.glory.bonus > 0) text += ` · ${t('over.gloryIdeal', { v: num(m.glory.bonus) })}`;
      lines.push({ text, color: '#9a6a08' });
    }

    if (m.weeklyChallenge) {
      lines.push({
        text: t('weekly.runResult', { score: num(s.score), best: num(m.weeklyChallengeBest ?? s.score) }),
        color: '#9a6a08',
      });
    }

    // Показываем ежедневный прогресс каждый раз, даже если в этом ране
    // ни одно задание не закрыто: игрок должен видеть остаток до 3/3.
    if (m.questsTotal > 0) {
      lines.push({
        text: t('over.questsProgress', { done: num(m.questsDone), total: num(m.questsTotal) }),
        color: '#3b2410',
      });
    }
    const doneNow = m.questsCompletedNow ?? [];
    if (doneNow.length > 0) {
      const list = doneNow.map((q) => t(q.descKey as TranslationKey)).join(' · ');
      lines.push({ text: `${t('over.questsNow', { v: num(doneNow.length) })}: ${list}`, color: '#3b2410' });
    }

    // Пропуск «Хроника» и цепочки достижений — по числу (§J, §H.12)
    const passParts: string[] = [];
    if (m.passLevels > 0) passParts.push(t('over.passUp', { v: num(m.passLevels) }));
    if ((m.chainUnlocks ?? []).length > 0) {
      passParts.push(t('over.chainsUp', { v: num(m.chainUnlocks.length) }));
    }
    if (passParts.length > 0) lines.push({ text: passParts.join('   '), color: '#3b2410' });
    if (m.seasonStepReward) {
      const skinKey = `skins.skin.${m.seasonStepReward.replace(/^skin_/, '')}` as TranslationKey;
      lines.push({ text: t('over.seasonReward', { v: t(skinKey) }), color: '#9a6a08' });
    }

    // Победа в вызове дня (§H.8) и волны бесконечного режима (§H.7)
    if (m.challenge && s.victory) lines.push({ text: t('over.challengeWin'), color: '#9a6a08' });
    if (m.endless) lines.push({ text: t('endless.result', { v: num(m.endlessWave) }), color: '#3b2410' });

    const wrap = Math.min(520, Math.max(160, width - 50));
    let y = cursor;
    for (const line of lines) {
      const txt = this.add.text(cx, y, line.text, {
        fontFamily: FONT, fontSize: `${fs}px`, color: line.color,
        align: 'center', wordWrap: { width: wrap }, lineSpacing: 2,
      }).setOrigin(0.5, 0);
      if (txt.height > avail - (y - cursor)) {
        // Не влезло — дальше тоже тесно: важнее итоги матча, чем детали
        txt.destroy();
        break;
      }
      body.add(txt);
      y += txt.height + (compact ? 2 : 4);
    }
    return y;
  }

  // ================================================================
  // Панель статистики оружия: урон/убийства каждого ствола матча
  // ================================================================

  private renderWeaponStats(
    body: Phaser.GameObjects.Container, s: GameOverStats, cursor: number,
    width: number, compact: boolean, avail: number,
  ): number {
    const list = (s.weapons ?? []).filter((w) => w.dmg > 0);
    if (list.length === 0) return cursor;
    const cx = width / 2;
    const ROW = 22;
    const HEAD = 18;

    if (compact) {
      // Компактный ландшафт: одна строка с топ-3 оружием
      const top = list.slice(0, 3)
        .map((w) => `${w.name} ${this.fmtDmg(w.dmg)}⚡${w.kills}`)
        .join(' • ');
      body.add(this.add.text(cx, cursor, top, {
        fontFamily: FONT, fontSize: '12px', color: '#9a6a08',
      }).setOrigin(0.5, 0)
        .setWordWrapWidth(Math.min(460, width - 40)));
      return cursor + 28;
    }

    // Полный режим: заголовок + строки с полосами урона
    body.add(this.add.text(cx, cursor, t('over.damageTitle'), {
      fontFamily: FONT, fontSize: '12px', color: '#6b4a1e',
    }).setOrigin(0.5, 0));
    cursor += HEAD;

    const maxDmg = Math.max(...list.map((w) => w.dmg), 1);
    const rowW = Math.min(380, width - 90);
    const barMax = Math.max(20, rowW - 150);
    // Сколько строк реально помещается — по высоте. Если не помещается
    // ни одна, раздел не рисуется вовсе: важнее показать итоги матча,
    // чем накрыть собой поле ввода имени.
    const limit = Math.min(7, width < 420 ? 5 : 7);
    const cap = Math.max(0, Math.min(list.length, limit, Math.floor((avail - HEAD) / ROW)));
    if (cap <= 0) return cursor;
    const shown = list.slice(0, cap);

    shown.forEach((w, i) => {
      const y = cursor + HEAD + i * ROW + 8;
      const icon = this.add.image(cx - rowW / 2 + 10, y, w.icon).setDisplaySize(20, 20);
      if (w.evolved) icon.setTint(0xffe9a0);
      body.add(icon);
      const nameW = barMax - 16;
      const nameText = this.add.text(cx - rowW / 2 + 26, y, w.name, {
        fontFamily: FONT, fontSize: '12px', color: w.evolved ? '#9a6a08' : '#3b2410',
      }).setOrigin(0, 0.5);
      // Название не должно наезжать на полосу урона и числа
      fitTextWidth(nameText, nameW, 10, 7);
      body.add(nameText);
      // Полоса урона (относительно лучшего оружия; эволюция — золотая)
      body.add(this.add.rectangle(cx - rowW / 2 + 128, y, barMax, 8, 0x2a1c10, 0.9)
        .setOrigin(0, 0.5));
      const bar = body.add(this.add.rectangle(
        cx - rowW / 2 + 128, y, 4, 6,
        w.evolved || i === 0 ? 0xffd76e : 0xd0883a,
      ).setOrigin(0, 0.5));
      this.tweens.add({ targets: bar, width: Math.max(4, Math.round(barMax * (w.dmg / maxDmg))), duration: 500, delay: 150 + i * 70, ease: 'Cubic.easeOut' });
      body.add(this.add.text(cx + rowW / 2, y, `${this.fmtDmg(w.dmg)}  ⚔${w.kills}`, {
        fontFamily: FONT, fontSize: '12px', color: '#9a6a08',
      }).setOrigin(1, 0.5));
    });
    return cursor + HEAD + shown.length * ROW + 10;
  }

  /** Ширина кнопки по тексту: кегль + запас на торцы девятислайса. */
  private btnWidthFor(label: string, fontSize: number, min: number, max: number): number {
    const probe = this.add.text(0, 0, label, { fontFamily: FONT, fontSize: `${fontSize}px` });
    const w = probe.width;
    probe.destroy();
    return Phaser.Math.Clamp(Math.ceil(w) + 44, min, max);
  }

  private fmtDmg(v: number): string {
    if (v >= 10000) return `${(v / 1000).toFixed(1)}k`;
    if (v >= 1000) return `${(v / 1000).toFixed(2)}k`;
    return `${Math.round(v)}`;
  }

  /** Хроника поселения (§H.3): сторителлинг итога по фактам матча. */
  private renderChronicle(
    body: Phaser.GameObjects.Container, s: GameOverStats, cursor: number,
    width: number, compact: boolean, avail: number,
  ): number {
    const st = s.settlement;
    if (!st || avail < 56) return cursor;
    const cx = width / 2;
    const lines: string[] = [
      s.victory ? t('chron.line.survived') : t('chron.line.fell'),
    ];
    if (s.veterans && s.veterans.length >= 2) {
      lines.push(t('chron.line.veterans', { a: s.veterans[0].name, b: s.veterans[1].name, n: 3 }));
    }
    if (st.monasteryFallenAt) {
      lines.push(t('chron.line.monastery', { t: st.monasteryFallenAt, v: st.monasteryVictims }));
    }
    if (st.castleHp > 0) lines.push(t('chron.line.castleHp', { v: st.castleHp }));
    else lines.push(t('chron.line.castleFell'));
    lines.push(t('chron.line.summary', { a: st.pawns, b: st.buildings }));
    lines.push(s.ideal ? t('chron.line.ideal') : t('chron.line.idealNo'));

    const wrap = Math.min(500, width - 60);
    const text = lines.join('\n');
    // Замер — с ТЕМ ЖЕ lineSpacing, что и рендер: без него need занижался
    // на 4 px × (строк−1), и следующий блок (near-miss) налезал на хронику.
    const probe = this.add.text(0, 0, text, {
      fontFamily: FONT, fontSize: compact ? '10px' : '12px', wordWrap: { width: wrap }, align: 'center', lineSpacing: 4,
    });
    const chronicleHeight = 16 + probe.height + 8;
    probe.destroy();
    if (avail < chronicleHeight) return cursor;

    const showTutorial = this.payload.showChronicleTutorial === true;
    const tutorialHeight = compact ? 34 : 38;
    const tutorialGap = 6;
    // Сначала убеждаемся, что поместятся и подсказка, и сама хроника. Если
    // экран слишком короткий, не расходуем одноразовый маркер на невидимый текст.
    const renderTutorial = showTutorial
      && avail >= chronicleHeight + tutorialHeight + tutorialGap;
    if (renderTutorial) {
      const panelW = Math.min(wrap, width - 48);
      const panelY = cursor + tutorialHeight / 2;
      const panel = makePanel(this, cx, panelY, 'paper', panelW, tutorialHeight);
      body.add(panel);
      body.add(this.add.text(cx, panelY, t('hint.chronicle'), {
        fontFamily: FONT,
        fontSize: compact ? '9px' : '10px',
        color: '#3b2410',
        align: 'center',
        wordWrap: { width: panelW - 20 },
        lineSpacing: 2,
      }).setOrigin(0.5));
      // Короткая золотая стрелка указывает на заголовок и строки хроники.
      const arrowY = cursor + tutorialHeight + 5;
      const arrow = this.add.graphics();
      arrow.lineStyle(2, 0xffd76e, 0.95);
      arrow.beginPath();
      arrow.moveTo(cx, cursor + tutorialHeight);
      arrow.lineTo(cx, arrowY);
      arrow.strokePath();
      arrow.fillStyle(0xffd76e, 0.95);
      arrow.beginPath();
      arrow.moveTo(cx, arrowY + 4);
      arrow.lineTo(cx - 4, arrowY - 1);
      arrow.lineTo(cx + 4, arrowY - 1);
      arrow.closePath();
      arrow.fillPath();
      body.add(arrow);

      cursor += tutorialHeight + tutorialGap;
      this.payload.showChronicleTutorial = false;
      this.payload.onChronicleTutorialShown?.();
    }

    body.add(this.add.text(cx, cursor, t('over.chronicleTitle'), {
      fontFamily: FONT, fontSize: '12px', color: '#6b4a1e',
    }).setOrigin(0.5, 0));
    body.add(this.add.text(cx, cursor + 16, text, {
      fontFamily: FONT, fontSize: compact ? '10px' : '12px', color: '#3b2410',
      align: 'center', wordWrap: { width: wrap }, lineSpacing: 4,
    }).setOrigin(0.5, 0));
    return cursor + chronicleHeight;
  }

  /** Контекстное предложение (§J.6.4) появляется только на экране итога и по выбору игрока. */
  private renderStoreOffer(
    body: Phaser.GameObjects.Container,
    s: GameOverStats,
    cursor: number,
    width: number,
    compact: boolean,
    avail: number,
  ): number {
    const meta = s.meta;
    const offer = meta?.storeOffer;
    if (!meta || !offer) return cursor;

    const messageKey: Record<StoreOfferKind, TranslationKey> = {
      starter: 'store.offerStarterMessage',
      monastery: 'store.offerMonasteryMessage',
      pass: 'store.offerPassMessage',
    };
    const message = this.add.text(width / 2, cursor, t(messageKey[offer]), {
      fontFamily: FONT,
      fontSize: compact ? '10px' : '12px',
      color: '#6b4a1e',
      align: 'center',
      lineSpacing: 2,
      wordWrap: { width: Math.min(500, width - 52) },
    }).setOrigin(0.5, 0);

    const buttonH = 44;
    const gap = compact ? 5 : 8;
    const needed = message.height + gap + buttonH + 4;
    if (avail < needed) {
      message.destroy();
      return cursor;
    }

    if (!meta.storeOfferSessionClaimed) {
      if (!claimStoreOfferForSession()) {
        message.destroy();
        // Сессия уже использовала предложение или хранилище недоступно:
        // не показываем повтор и не нарушаем лимит §J.9.
        meta.storeOffer = undefined;
        return cursor;
      }
      meta.storeOfferSessionClaimed = true;
      track('store_offer_shown', { offer });
    }

    body.add(message);
    const buttonW = Math.min(270, width - 48);
    const buttonY = cursor + message.height + gap + buttonH / 2;
    const button = makeButton(
      this, width / 2, buttonY, buttonW, buttonH, t('store.offerOpen'),
      () => this.openStoreOffer(offer), 'blue', compact ? 10 : 12,
      { hitW: buttonW, hitH: buttonH, stopPropagation: true },
    );
    button.img.setScrollFactor(0);
    button.txt.setScrollFactor(0);
    button.hit.setScrollFactor(0);
    body.add([button.img, button.txt, button.hit]);
    return cursor + needed;
  }

  private openStoreOffer(offer: StoreOfferKind): void {
    const tab = offer === 'pass' ? 'pass' : 'crowns';
    if (this.scene.isActive('Shop')) return;
    track('store_offer_opened', { offer, tab });
    this.scene.launch('Shop', { tab });
  }

  /** Near-miss (§H.3, блок 2): «чуть-чуть» — триггер ещё одного рана. */
  private renderNearMiss(
    body: Phaser.GameObjects.Container, s: GameOverStats, cursor: number,
    width: number, compact: boolean, avail: number,
  ): number {
    if (avail < 26) return cursor;
    const st = s.settlement;
    let line = '';
    if (!s.victory) {
      if (s.loseCause === 'castle' && st) line = t('chron.line.nearCastle', { v: Math.max(0, Math.round(st.castleHp)) });
      else if (s.loseCause === 'population') line = t('chron.line.fell');
      else if (st?.bledOutName) line = t('chron.line.nearBleed', { v: st.bledOutName, n: st.bledOutShort ?? 45 });
      else if (st && st.castleHp < 500) line = t('chron.line.nearCastle', { v: Math.max(1, Math.round(500 - st.castleHp)) });
      else line = t('chron.line.nearBoss', { v: clock(Math.max(0, 900 - s.time)) });
    } else if (!s.ideal && st) {
      line = st.castleHp < 500
        ? t('chron.line.idealNo')
        : t('chron.line.nearIdeal', { v: t('chron.needPawns') });
    }
    if (!line) return cursor;
    body.add(this.add.text(width / 2, cursor, `${t('over.nearMiss')} ${line}`, {
      fontFamily: FONT, fontSize: compact ? '10px' : '12px', color: '#9a6a08',
      align: 'center', wordWrap: { width: Math.min(500, width - 60) },
    }).setOrigin(0.5, 0));
    return cursor + (compact ? 20 : 24);
  }

  // ================================================================
  // Имя игрока
  // ================================================================

  /**
   * Авторизованному игроку Яндекса показываем имя из профиля — вводить своё
   * незачем (требование 1.2: лишние поля без пользы только раздражают).
   * Гость по-прежнему вводит имя в нативный <input>.
   */
  private createNameInput(y: number, h = 44): void {
    const width = this.scale.width;

    if (isAuthorized()) {
      const name = displayName(this.nameValue);
      this.add.text(width / 2, y, name, {
        fontFamily: FONT, fontSize: '17px', color: '#ffe9b0',
        stroke: '#1b1008', strokeThickness: 5,
      }).setOrigin(0.5).setScrollFactor(0);
      this.nameValue = name;
      return;
    }

    const el = document.createElement('input');
    el.type = 'text';
    el.maxLength = 24;
    el.autocomplete = 'off';
    el.spellcheck = false;
    el.placeholder = t('over.namePlaceholder');
    el.value = this.nameValue;
    el.setAttribute('aria-label', t('over.nameAria'));
    el.style.width = `${Math.min(340, width - 80)}px`;
    el.style.height = `${h - 6}px`;
    el.style.boxSizing = 'border-box';
    // Поле ввода — часть пергамента, а не белый прямоугольник из другого
    // интерфейса: та же бумага, та же рамка, тот же шрифт. Раньше фон был
    // заметно светлее бумаги, и на экране итогов поле выглядело вклеенным.
    el.style.background = '#f6e7c9';
    el.style.border = '3px solid #a9722a';
    el.style.borderRadius = '8px';
    el.style.boxShadow = 'inset 0 2px 0 rgba(59, 36, 16, 0.18)';
    el.style.color = '#3b2410';
    el.style.fontFamily = FONT;
    el.style.fontSize = '16px';
    el.style.textAlign = 'center';
    el.style.outline = 'none';
    el.style.padding = '0 10px';
    el.style.pointerEvents = 'auto';
    el.addEventListener('input', () => {
      this.nameValue = el.value;
    });
    // Enter — сохранить
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void this.saveScore();
      }
    });
    this.nameInput = this.add.dom(width / 2, y, el);
    this.nameInput.setOrigin(0.5);
  }

  private getName(): string {
    const node = this.nameInput?.node as HTMLInputElement | undefined;
    if (node && typeof node.value === 'string') return node.value;
    return this.nameValue;
  }

  // ================================================================
  // Сохранение рекорда
  // ================================================================

  private savedLabel(): string {
    if (this.saveTarget === 'online') return t('over.savedOnline');
    if (this.saveTarget === 'error') return t('over.savedLocalOffline');
    return t('over.savedLocal');
  }

  private createSaveUi(h = 44): void {
    const width = this.scale.width;

    // Сообщение о результате — всегда на одном месте, кнопка исчезает
    const showMsg = (text: string, color: string): void => {
      this.saveBtn?.destroy();
      this.saveBtn = null;
      this.saveMsg?.destroy();
      this.saveMsg = this.add.text(width / 2, this.saveY, text, {
        fontFamily: FONT, fontSize: '14px', color,
        stroke: '#1b1008', strokeThickness: 5,
        align: 'center', wordWrap: { width: width - 60 },
      }).setOrigin(0.5).setScrollFactor(0);
    };

    if (this.saveState === 'saved') {
      showMsg(this.savedLabel(), this.saveTarget === 'error' ? '#ffd76e' : '#7dc95e');
      return;
    }

    const label = this.saveState === 'error' ? t('over.retry') : t('over.save');
    const b = makeButton(this, width / 2, this.saveY, Math.min(280, width - 70), h, label, () => {
      void this.saveScore();
    }, 'blue', 15);
    b.img.setScrollFactor(0);
    b.txt.setScrollFactor(0);
    b.hit.setScrollFactor(0);
    this.saveBtn = b;

    if (this.saveState === 'error') {
      this.saveMsg = this.add.text(width / 2, this.saveY - 32, t('over.saveFailed'), {
        fontFamily: FONT, fontSize: '12px', color: '#ff8a7a',
        stroke: '#1b1008', strokeThickness: 3,
        align: 'center', wordWrap: { width: width - 60 },
      }).setOrigin(0.5).setScrollFactor(0);
    }
  }

  /**
   * Сохраняет результат: локально всегда, в общий зал Яндекса — авторизованным.
   *
   * Разница между «сохранилось» и «сохранилось в общий зал» игроку показывается
   * явно: раньше submitScore никогда не бросал исключение, catch был недостижим,
   * и неудачная отправка в общий зал выглядела как обычный успех.
   */
  private saveScore = async (): Promise<void> => {
    if (this.saveState === 'saving' || this.saveState === 'saved') return;
    this.saveState = 'saving';
    this.saveBtn?.txt.setText(t('over.saving'));

    const s = this.payload.stats;
    const raw = this.getName().trim();
    const name = displayName(raw || t('over.defaultName'));

    try {
      const result = await submitScore({
        name,
        score: s.score,
        kills: s.kills,
        level: s.level,
        timeSurvived: s.time,
        victory: s.victory,
      });
      this.saveState = 'saved';
      this.saveTarget = result.online ? 'online' : result.reason === 'error' ? 'error' : 'local';

      if (!isAuthorized()) saveText('tss-name', name);

      audio.play('ach');
      // Перерисовываем нижний блок: кнопка сменяется сообщением о результате
      this.createSaveUi();
    } catch (err) {
      console.warn('[gameover] сохранение не удалось:', err);
      this.saveState = 'error';
      this.saveBtn?.setLabel(t('over.retry'));
      this.saveMsg?.destroy();
      this.saveMsg = this.add.text(this.scale.width / 2, this.saveY - 32, t('over.saveFailed'), {
        fontFamily: FONT, fontSize: '12px', color: '#ff8a7a',
        stroke: '#1b1008', strokeThickness: 3,
        align: 'center', wordWrap: { width: this.scale.width - 60 },
      }).setOrigin(0.5).setScrollFactor(0);
    }
  };

  // ================================================================
  // ×2-кнопки конца матча (TZ §J.3, точки R5/R9)
  // ================================================================

  /**
   * Две компактные кнопки (высота 40, ширина по тексту): удвоение золота
   * матча и удвоение начисления славы за матч. Встают по бокам кнопки
   * сохранения, а если по ширине не помещаются — отдельным рядом над ней
   * (план и бюджет высоты считает create(), чтобы низ не поехал).
   * В компактном режиме (height < 520) не рисуются вовсе.
   */
  private createDoubleButtons(L: X2Layout): void {
    const width = this.scale.width;
    const make = (label: string, w: number, x: number, y: number, onClick: () => void): Button =>
      makeButton(this, x, y, w, X2_H, label, onClick, 'blue', X2_FONT, {
        // Хит-зоны почти вплотную: широкие зоны по умолчанию перекрывали
        // бы хит-зону кнопки сохранения
        hitW: w + 12, hitH: X2_H + 14,
      });

    const scroll = (b: Button): Button => {
      b.img.setScrollFactor(0);
      b.txt.setScrollFactor(0);
      b.hit.setScrollFactor(0);
      return b;
    };

    /** Центр ×2-кнопки сбоку от сохранения: side −1 — слева, 1 — справа. */
    const nextToSave = (w: number, side: 1 | -1): number =>
      width / 2 + side * (L.saveW / 2 + 12 + w / 2);

    if (L.gold && L.glory) {
      if (L.flank) {
        this.goldBtn = scroll(make(t('over.goldX2'), L.goldW, nextToSave(L.goldW, -1), this.saveY, this.watchGoldX2));
        this.gloryBtn = scroll(make(t('over.gloryX2'), L.gloryW, nextToSave(L.gloryW, 1), this.saveY, this.watchGloryX2));
      } else {
        const total = L.goldW + 12 + L.gloryW;
        this.goldBtn = scroll(make(t('over.goldX2'), L.goldW, width / 2 - total / 2 + L.goldW / 2, L.rowY, this.watchGoldX2));
        this.gloryBtn = scroll(make(t('over.gloryX2'), L.gloryW, width / 2 + total / 2 - L.gloryW / 2, L.rowY, this.watchGloryX2));
      }
    } else if (L.gold) {
      this.goldBtn = L.flank
        ? scroll(make(t('over.goldX2'), L.goldW, nextToSave(L.goldW, 1), this.saveY, this.watchGoldX2))
        : scroll(make(t('over.goldX2'), L.goldW, width / 2, L.rowY, this.watchGoldX2));
    } else if (L.glory) {
      this.gloryBtn = L.flank
        ? scroll(make(t('over.gloryX2'), L.gloryW, nextToSave(L.gloryW, 1), this.saveY, this.watchGloryX2))
        : scroll(make(t('over.gloryX2'), L.gloryW, width / 2, L.rowY, this.watchGloryX2));
    }

    // Уже удвоено в этом матче (переживает рестарт сцены) — рисуем выключенной.
    // Если кнопка показана, но показ недоступен — гасим С ПОДПИСЬЮ ПРИЧИНЫ.
    if (this.goldBtn) {
      if (this.goldDoubled) {
        this.goldBtn.setEnabled(false);
        this.goldBtn.setLabel(t('over.x2Done'));
      } else if (this.goldBlock) {
        this.goldBtn.setEnabled(false);
        this.goldBtn.setLabel(this.goldNote);
      }
    }
    if (this.gloryBtn) {
      if (this.gloryDoubled || this.gloryDead) {
        this.gloryBtn.setEnabled(false);
        this.gloryBtn.setLabel(this.gloryDoubled ? t('over.x2Done') : t('over.gloryX2Cap'));
      } else if (this.gloryBlock) {
        this.gloryBtn.setEnabled(false);
        this.gloryBtn.setLabel(this.gloryNote);
      }
    }
  }

  /** R5: ролик — и золото матча второй раз уходит в кошелёк (итог ×2). */
  private watchGoldX2 = async (): Promise<void> => {
    const gold = this.payload.stats.gold;
    if (gold <= 0 || this.goldDoubled) return;
    this.goldBtn?.setEnabled(false);
    const res = await showPlacementRewarded('wallet-x2', {
      pause: () => audio.silence(),
      resume: () => audio.unsilence(),
    });
    if (res.rewarded) {
      if (!depositGold(gold)) {
        refundPlacement('wallet-x2');
        this.goldBtn?.setLabel(t('over.x2SaveFailed'));
        this.goldBtn?.setEnabled(placementAvailable('wallet-x2'));
        return;
      }
      this.goldDoubled = true;
      this.goldBtn?.setLabel(t('over.x2Done'));
      audio.play('ach');
      return;
    }
    // Не досмотрел — вернём кнопку, если показ ещё доступен
    this.goldBtn?.setEnabled(placementAvailable('wallet-x2'));
  };

  /** R9: ролик — начисление удваивается в пределах того же потолка (§H.16). */
  private watchGloryX2 = async (): Promise<void> => {
    const g = this.payload.stats.meta?.glory;
    if (!g || this.gloryDoubled) return;
    this.gloryBtn?.setEnabled(false);
    const res = await showPlacementRewarded('glory-x2', {
      pause: () => audio.silence(),
      resume: () => audio.unsilence(),
    });
    if (res.rewarded) {
      if (!addGlory(gloryDoubleExtra(g))) {
        refundPlacement('glory-x2');
        this.gloryBtn?.setLabel(t('over.x2SaveFailed'));
        this.gloryBtn?.setEnabled(placementAvailable('glory-x2'));
        return;
      }
      this.gloryDoubled = true;
      this.gloryBtn?.setLabel(t('over.x2Done'));
      audio.play('ach');
      return;
    }
    this.gloryBtn?.setEnabled(placementAvailable('glory-x2'));
  };

  // ================================================================
  // Воскрешение за rewarded-ролик удалено (TZ §F.12): его роль перешла
  // к преемственности (SuccessionScene).
  // ================================================================

  // ================================================================
  // Навигация
  // ================================================================

  private rebuild = (): void => {
    // Рестарт с той же статистикой — элементы встанут по новым размерам экрана
    this.scene.restart({ stats: this.payload.stats });
  };

  /**
   * Ряд действий. Без бесконечного режима — прежние две кнопки.
   * С ним (§H.7): на широких экранах три кнопки в ряд (ЕЩЁ РАЗ /
   * ДЕРЖАТЬ КРЕПОСТЬ / В МЕНЮ, ширины по контенту), на узких —
   * «ДЕРЖАТЬ КРЕПОСТЬ» отдельным рядом сверху.
   */
  private createActions(y: number, actH: number, width: number, plan: ActionPlan | null): void {
    const w1 = Math.min(240, width * 0.55);
    const w2 = Math.min(150, width * 0.30);
    const gapB = 12;
    const sideBySide = w1 + w2 + gapB <= width - 30;

    if (!plan) {
      if (sideBySide) {
        this.btn(width / 2 - (w1 + w2 + gapB) / 2 + w1 / 2, y, t('over.again'), 'blue', w1, actH, () => this.restart(), 16);
        this.btn(width / 2 + (w1 + w2 + gapB) / 2 - w2 / 2, y, t('over.toMenu'), 'red', w2, actH, () => this.toMenu(), 15);
      } else {
        this.btn(width / 2, y - actH * 0.55, t('over.again'), 'blue', w1, actH, () => this.restart(), 15);
        this.btn(width / 2, y + actH * 0.55, t('over.toMenu'), 'red', w2, Math.max(30, actH - 6), () => this.toMenu(), 14);
      }
      return;
    }

    if (plan.threeInRow) {
      const gap = 10;
      const x0 = width / 2 - (plan.wAgain + plan.wEndless + plan.wMenu + gap * 2) / 2;
      this.btn(x0 + plan.wAgain / 2, y, t('over.again'), 'blue', plan.wAgain, actH, () => this.restart(), 16);
      this.btn(x0 + plan.wAgain + gap + plan.wEndless / 2, y, t('over.endlessEnter'), 'blue', plan.wEndless, actH, () => this.enterEndless(), 15);
      this.btn(x0 + plan.wAgain + gap + plan.wEndless + gap + plan.wMenu / 2, y, t('over.toMenu'), 'red', plan.wMenu, actH, () => this.toMenu(), 15);
      return;
    }

    // Узкий экран: сверху — «ДЕРЖАТЬ КРЕПОСТЬ», снизу — привычный ряд
    this.btn(width / 2, plan.rowY, t('over.endlessEnter'), 'blue', plan.wEndless, actH, () => this.enterEndless(), 15);
    if (sideBySide) {
      this.btn(width / 2 - (w1 + w2 + gapB) / 2 + w1 / 2, y, t('over.again'), 'blue', w1, actH, () => this.restart(), 16);
      this.btn(width / 2 + (w1 + w2 + gapB) / 2 - w2 / 2, y, t('over.toMenu'), 'red', w2, actH, () => this.toMenu(), 15);
    } else {
      this.btn(width / 2, y - actH * 0.55, t('over.again'), 'blue', w1, actH, () => this.restart(), 15);
      this.btn(width / 2, y + actH * 0.55, t('over.toMenu'), 'red', w2, Math.max(30, actH - 6), () => this.toMenu(), 14);
    }
  }

  /** Вход в бесконечный режим: чистый ран с флагом endless (§H.7). */
  private enterEndless = (): void => {
    track('end_screen_action', { block: 'chronicle', action: 'endless' });
    saveRunConfig({
      contract: null, ukaz: null, challenge: null, blessing: null,
      consumables: [], endless: true, weeklyChallenge: false,
    });
    // Гасим возможные зависшие оверлеи — как в restart()
    this.scene.stop('LevelUp');
    this.scene.stop('Pause');
    this.scene.stop('Succession');
    this.scene.stop('Game');
    this.scene.start('Game');
  };

  private restart = async (): Promise<void> => {
    if (this.restartPending) return;
    this.restartPending = true;
    track('end_screen_action', { block: 'chronicle', action: 'rerun' });

    // По §J.4 межстраничная реклама должна завершиться ДО старта следующего рана.
    // showInterstitial разрешает пропуск при недоступности рекламы/ошибке.
    await showInterstitial({ pause: () => audio.silence(), resume: () => audio.unsilence() });
    if (!this.scene.isActive()) return;

    // Гасим возможные зависшие оверлеи только после закрытия/пропуска рекламы.
    this.scene.stop('LevelUp');
    this.scene.stop('Pause');
    this.scene.stop('Succession');
    this.scene.stop('Game');
    this.scene.start('Game');
  };

  private toMenu = (): void => {
    track('end_screen_action', { block: 'chronicle', action: 'close' });
    this.scene.stop('LevelUp');
    this.scene.stop('Pause');
    this.scene.stop('Succession');
    this.scene.stop('Game');
    this.scene.start('Menu');
  };

  private btn(x: number, y: number, label: string, variant: 'blue' | 'red', w: number, h: number, onClick: () => void, fontSize: number): void {
    const b = makeButton(this, x, y, w, h, label, onClick, variant, fontSize);
    b.img.setScrollFactor(0);
    b.txt.setScrollFactor(0);
    b.hit.setScrollFactor(0);
  }
}
