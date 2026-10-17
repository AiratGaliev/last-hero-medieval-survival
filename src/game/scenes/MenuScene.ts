import Phaser from 'phaser';
import { Cursor } from '../systems/Cursor';
import { makeCornerFrame, type CornerFrame } from '../systems/Corners';
import { FONT } from '../constants';
import { HEROES, WEAPONS, PASSIVES, DIFFICULTIES, EVOLUTIONS, type HeroId, type DifficultyId } from '../data';
import { audio } from '../systems/Audio';
import { makePanel, makeButton, fitTextWidth } from '../systems/Ui';
import { loadShop, buyUpgrade, SHOP_UPGRADES } from '../shop';
import { ACHIEVEMENTS, loadUnlocked, loadMeta } from '../achievements';
import { t, num, clock, type TranslationKey, type TranslateParams } from '../../i18n';
import { topScores } from '../../platform/leaderboard';
import { notifyReady } from '../../platform/lifecycle';
import { loadText, saveText, removeKey } from '../storage';
import { isAuthorized, offerAuth, displayName } from '../../platform/player';
import { isOnYandex } from '../../platform/sdk';
import { placementAvailable, showPlacementRewarded, showStickyBanner, rewardedAvailable } from '../../platform/ads';
import { track } from '../../platform/analytics';
import {
  BLESSINGS,
  bonusAvailable,
  challengeForToday,
  challengeVictoryToday,
  CHALLENGE_MODS,
  claimDailyBonus,
  claimDailyChest,
  CONSUMABLES,
  CONSUMABLE_MAX,
  contractDef,
  CONTRACTS,
  DAILY_BONUS,
  dailyChestLeft,
  loadMetaState,
  matchesPlayed,
  ORDERS,
  ordersUnlocked,
  rollBlessings,
  saveMetaState,
  saveRunConfig,
  type ConsumableId,
  type ContractId,
  type DailyBonusKind,
  type OrderId,
  type RunModifiers,
} from '../meta';

// ============ Главное меню: герой + сложность + вся мета-навигация ============
// Вся оболочка игры живёт здесь: «Как играть», «Зал славы», «Лавка торговца»
// (покупки за золото), «Достижения» и «Хроника воина» (localStorage).

/** Строка зала славы. Формат единый для локальной таблицы и данных SDK. */
interface ScoreRow {
  rank: number;
  name: string;
  score: number;
  kills: number;
  level: number;
  timeSurvived: number;
  victory: boolean;
  online: boolean;
}

interface HeroCard {
  container: Phaser.GameObjects.Container;
  frame: CornerFrame;
  heroId: HeroId;
}

interface DiffChip {
  container: Phaser.GameObjects.Container;
  frame: CornerFrame;
  diffId: DifficultyId;
}

const HERO_ORDER: HeroId[] = ['warrior', 'archer', 'lancer', 'monk'];
const DIFF_ORDER: DifficultyId[] = ['normal', 'nightmare'];

/** Размер файла портрета в ui/avatars: 256×256, персонаж лежит в рамке HeroDef.portrait.box */
const PORTRAIT_SIZE = 256;

/**
 * Три части меча как отдельные фреймы той же текстуры: рукоять с гардой,
 * ровная часть клинка и наконечник. Тянется только клинок — остальное
 * должно остаться натуральной формы.
 *
 * Границы сняты с готовой текстуры 261×128: профиль высот показывает, что
 * гарда кончается на x = 88, ровная часть клинка идёт до x = 216 (дальше
 * начинается спад к острию). Отдельными файлами эти куски не стали бы —
 * три фрейма в одной текстуре экономят и загрузку, и файлы в бандле.
 */
function swordParts(scene: Phaser.Scene, key: string): void {
  const texture = scene.textures.get(key);
  for (const [name, x, w] of [['hilt', 0, 88], ['blade', 88, 128], ['tip', 216, 45]] as const) {
    if (!texture.has(name)) texture.add(name, 0, x, 0, w, 128);
  }
}

export class MenuScene extends Phaser.Scene {
  private overlay: Phaser.GameObjects.Container | null = null;
  /** Интерактивные элементы оверлея вне контейнера (кнопки, строки лавки) */
  private overlayExtras: Phaser.GameObjects.GameObject[] = [];
  private heroCards: HeroCard[] = [];
  private diffChips: DiffChip[] = [];
  private selectedHero: HeroId = 'warrior';
  private selectedDiff: DifficultyId = 'normal';
  /** Выбор уже инициализирован (из localStorage) — рестарты сцены (ресайз)
  *  не должны сбрасывать выбор, сделанный игроком в этой сессии */
  private selectionInited = false;
  /** Виртуальное полотно (на мобильных меньше реального экрана — камера зумит) */
  private vw = 0;
  private vh = 0;
  private menuZoom = 1;

  // Лавка
  private shopRowEls: Phaser.GameObjects.Container[] = [];
  private shopBalanceText: Phaser.GameObjects.Text | null = null;
  private shopRowsY = 0;
  /** Высота строки лавки — подгоняется под высоту экрана. */
  private shopRowH = 64;
  // Зал славы: фильтр (все/победы) + кэш строк для перерисовки без повторного запроса
  private recordsFilter: 'all' | 'win' = 'all';
  private recordsRows: ScoreRow[] = [];
  /** Данные пришли из общего зала Яндекса (true) или из локальной таблицы. */
  private recordsOnline = false;
  private recordsListEls: Phaser.GameObjects.GameObject[] = [];

  // Мета-фаза Q/S: чип дара дня, пре-ран выбор, расходники
  private bonusChip: Phaser.GameObjects.Container | null = null;
  private preChipTexts: Array<Phaser.GameObjects.Text | null> = [null, null, null, null];
  private preChipW = 0;
  private preChipFont = 10;
  private consRowEls: Phaser.GameObjects.GameObject[] = [];

  // Достижения
  private achDesc: Phaser.GameObjects.Text | null = null;

  constructor() {
    super('Menu');
  }

  /** Курсор в стиле Tiny Swords: следит за наведением и переключает
   *  состояние. В CSS у курсора !important — он перебивает инлайновый
   *  cursor, который Phaser ставит через useHandCursor. */
  private cursor!: Cursor;

  create(): void {
    this.cursor = new Cursor(this);
    const realW = this.scale.width;
    const realH = this.scale.height;
    this.heroCards = [];
    this.diffChips = [];
    this.overlay = null;
    this.overlayExtras = [];
    this.shopRowEls = [];
    this.shopBalanceText = null;
    this.bonusChip = null;
    this.preChipTexts = [null, null, null, null];
    this.consRowEls = [];

    // Мобильная раскладка: контент позиционируется на виртуальном полотне 460×800,
    // затем камера уменьшает его до реального размера экрана — ничего не обрезается.
    const mobile = realW < 760;
    this.menuZoom = mobile ? Math.min(realW / 460, realH / 800) : 1;
    this.vw = mobile ? 460 : realW;
    this.vh = mobile ? 800 : realH;
    // centerOn центрирует виртуальное полотно (с учётом origin 0.5 камеры)
    this.cameras.main.setZoom(this.menuZoom);
    this.cameras.main.centerOn(this.vw / 2, this.vh / 2);
    const width = this.vw;
    const height = this.vh;
    // Полотно фона — с запасом, чтобы при зуме < 1 закрыть весь экран
    const coverW = this.vw / this.menuZoom + 240;
    const coverH = this.vh / this.menuZoom + 240;

    // Сохранённый герой + сложность — только при первом запуске сцены;
    // при ресайзе (scene.restart) сохраняем выбор игрока текущей сессии
    if (!this.selectionInited) {
      this.selectionInited = true;
      const saved = loadText('tss-hero');
      if (saved === 'warrior' || saved === 'archer' || saved === 'lancer' || saved === 'monk') {
        this.selectedHero = saved;
      }
      const savedDiff = loadText('tss-diff');
      if (savedDiff === 'normal' || savedDiff === 'nightmare') {
        this.selectedDiff = savedDiff;
      }
    }

    // Фон: травка + вода (полосы шире видимой области — под зум)
    // Кадр 'grass-tile' зарегистрирован в текстуре 'grass-source' (BootScene)
    this.add.tileSprite(width / 2, height / 2, coverW, coverH, 'grass-source', 'grass-tile');
    this.add.tileSprite(width / 2, -60, coverW + 400, 200, 'water-tile');
    this.add.tileSprite(width / 2, height + 60, coverW + 400, 200, 'water-tile');
    this.add.tileSprite(-80, height / 2, 200, coverH + 400, 'water-tile');
    this.add.tileSprite(width + 80, height / 2, 200, coverH + 400, 'water-tile');

    // Облака
    for (let i = 0; i < 6; i++) {
      const c = this.add.image(
        Phaser.Math.Between(0, width),
        Phaser.Math.Between(30, height * 0.45),
        `cloud${Phaser.Math.Between(1, 3)}`,
      ).setAlpha(0.6);
      this.tweens.add({
        targets: c,
        x: '+=500',
        duration: Phaser.Math.Between(50, 90) * 1000,
        repeat: -1,
        onRepeat: () => { c.x = -200; },
      });
    }

    // Замок на фоне. Раньше он стоял по центру верхней трети экрана — ровно
    // там, где теперь логотип, и стены проглядывали сквозь клинки. Убран в
    // левый верхний угол и уменьшен: меню сверху теперь занято названием.
    this.add.image(width * 0.17, height * 0.14, 'castle').setScale(0.5).setAlpha(0.45);
    const sheep = this.add.sprite(width * 0.1, height * 0.9, 'sheep').setScale(0.65).setAlpha(0.9);
    sheep.play('sheep-idle');
    const goblin = this.add.sprite(width * 0.9, height * 0.92, 'goblin-idle').setScale(0.5).setAlpha(0.9);
    goblin.play('goblin-idle');
    void sheep; void goblin;

    // ---------- Сетка карточек героя ----------
    // Считается до логотипа: над карточками теперь два меча, и им нужно
    // знать, сколько места сверху осталось. Блок упирается в подпись
    // «выбери героя» сверху, а снизу — в кнопки и строку версии, поэтому
    // сначала находим потолок для cardsY, а потом решаем, сдвигать ли блок
    // вниз за счёт запаса внизу экрана.
    const cols = width < 760 ? 2 : 4;
    const rows = Math.ceil(HERO_ORDER.length / cols);
    const gap = 14;
    const cardW = Math.min(width < 760 ? 205 : 225, (width - 36 - (cols - 1) * gap) / cols);
    const cardH = width < 760 ? 146 : 214;
    const blockH = rows * cardH + (rows - 1) * gap;
    // От низа карточек до низа экрана: 28 до чипов сложности, ряд пре-рана
    // (контракт/указ/расходники/вызов), кнопка «Играть» и навигация.
    const navStack = mobile ? 34 + 58 + 90 : 34 + 58 + 44;
    const maxCardsY = height - 18 - navStack - 77 - blockH / 2;
    const cardsY = Math.min(height * 0.55, maxCardsY);
    const heroTop = cardsY - blockH / 2;
    const heroBottom = cardsY + blockH / 2;

    // ---------- Логотип: два меча с названием ----------
    // Меч разложен на три части, как и в паке: рукоять с гардой и
    // наконечник не тянутся, тянется только ровная часть клинка — в паке
    // она и нарисована длинной пластиной под надпись. Высота меча
    // одинаковая у обоих слов и вдвое больше высоты надписи, длина — по
    // слову: у «СРЕДНЕКОВОЕ» меч длиннее, чем у «ВЫЖИВАНИЕ».
    const TEX = { h: 128, hilt: 88, blade: 128, tip: 45, inset: 12 };
    const FONT_MAX = 40;
    const titleTop = Math.max(30, height * 0.05);
    const swordGap = mobile ? 0 : 8;
    const roomH = heroTop - 34 - titleTop - 10 - swordGap;

    // Обводка — как у надписей на кнопках (systems/Ui.ts) по толщине,
    // обводка белая, а заливка берётся цвета самого меча
    const wordStyle = (size: number, color: string): Phaser.Types.GameObjects.Text.TextStyle => ({
      fontFamily: FONT,
      fontSize: `${size}px`,
      color,
      stroke: '#ffffff',
      strokeThickness: Math.max(4, size / 4),
    });

    const top = t('common.titleTop');
    const bottom = t('common.titleBottom');
    // Замеры на живом тексте: ширина и высота строки зависят от шрифта, и
    // выводить их из начертания — значит угадывать
    const probe = this.add.text(0, 0, top, wordStyle(FONT_MAX, '#000')).setVisible(false);
    const kTop = probe.width / FONT_MAX;    // ширина слова на единицу кегля
    const lineH = probe.height / FONT_MAX;  // высота строки на единицу кегля
    probe.setText(bottom);
    const kBottom = probe.width / FONT_MAX;
    probe.destroy();

    // Кегль по размеру самого длинного слова: и длина меча, и его высота
    // линейны по кеглю, поэтому перебор дешёвый и предсказуемый
    const swordWidth = (k: number, font: number): number => {
      const sc = (2 * lineH * font) / TEX.h;
      return k * font + (TEX.hilt + TEX.tip + 2 * TEX.inset) * sc;
    };
    let logoFont = FONT_MAX;
    while (logoFont > 9 && (
      4 * lineH * logoFont + swordGap > roomH
      || swordWidth(Math.max(kTop, kBottom), logoFont) > width - 24
    )) logoFont--;

    const scale = (2 * lineH * logoFont) / TEX.h;   // вертикальный масштаб меча
    const swordH = TEX.h * scale;
    const hiltW = TEX.hilt * scale;
    const tipW = TEX.tip * scale;
    const cyA = titleTop + swordH / 2;
    const cyB = titleTop + swordH + swordGap + swordH / 2;

    // Надписи создаются первыми: их ширина задаёт длину клинка. Depth 1 —
    // чтобы клинок, который добавится следом, их не накрыл.
    const txtTop = this.add.text(width / 2, cyA, top, wordStyle(logoFont, '#3c849c'))
      .setOrigin(0.5).setDepth(1);
    const txtBottom = this.add.text(width / 2, cyB, bottom, wordStyle(logoFont, '#a85454'))
      .setOrigin(0.5).setDepth(1);

    for (const key of ['sword-blue', 'sword-red']) swordParts(this, key);
    const drawSword = (key: string, cy: number, bladeW: number, flip: boolean): number => {
      const totalW = hiltW + bladeW + tipW;
      const box = this.add.container(width / 2, cy);
      // Отражается весь меч целиком: рукоять и наконечник меняются местами
      // вместе с клинком, иначе они смотрели бы в одну сторону
      if (flip) box.setScale(-1, 1);
      const left = -totalW / 2;
      box.add([
        this.add.image(left + hiltW / 2, 0, key, 'hilt').setDisplaySize(hiltW, swordH),
        this.add.image(left + hiltW + bladeW / 2, 0, key, 'blade').setDisplaySize(bladeW, swordH),
        this.add.image(left + hiltW + bladeW + tipW / 2, 0, key, 'tip').setDisplaySize(tipW, swordH),
      ]);
      // Смещение центра клинка от центра меча — на него встаёт надпись. У
      // отражённого меча знак минус: слово остаётся прямым
      return (left + hiltW + bladeW / 2) * (flip ? -1 : 1);
    };

    const bladePad = 2 * TEX.inset * scale;
    const bladeCxA = drawSword('sword-blue', cyA, txtTop.width + bladePad, false);
    const bladeCxB = drawSword('sword-red', cyB, txtBottom.width + bladePad, true);
    txtTop.setPosition(width / 2 + bladeCxA, cyA);
    txtBottom.setPosition(width / 2 + bladeCxB, cyB);

    // Кошелёк в углу — видно мета-золото до захода в лавку;
    // на подложке-пергаменте, чтобы облака не мешали чтению
    const wallet = loadShop().balance;
    if (wallet > 0) {
      const wtxt = num(wallet);
      const chipW = 52 + wtxt.length * 10;
      const chipX = width - 20 - chipW;
      const chipCY = cyA;   // по центру верхнего меча
      const walletChip = this.add.graphics();
      walletChip.fillStyle(0xf7e7c3, 0.95).fillRoundedRect(chipX, chipCY - 15, chipW, 30, 9);
      walletChip.lineStyle(2, 0xc9a25e, 1).strokeRoundedRect(chipX, chipCY - 15, chipW, 30, 9);
      this.add.image(chipX + 16, chipCY - 1, 'icon-coin').setDisplaySize(18, 18);
      this.add.text(chipX + 30, chipCY - 1, wtxt, {
        fontFamily: FONT, fontSize: '14px', color: '#7a4e0e',
      }).setOrigin(0, 0.5);
    }

    // ---------- Выбор героя ----------
    const label = this.add.text(width / 2, heroTop - 34, t('menu.chooseHero'), {
      fontFamily: FONT, fontSize: '14px', color: '#3b2410',
      stroke: '#ffe9c0', strokeThickness: 4,
    }).setOrigin(0.5).setAlpha(0.9);
    void label;

    HERO_ORDER.forEach((id, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = width / 2 - (cols * cardW + (cols - 1) * gap) / 2 + col * (cardW + gap) + cardW / 2;
      const y = heroTop + row * (cardH + gap) + cardH / 2;
      this.createHeroCard(x, y, id, cardW, cardH);
    });

    // ---------- Выбор сложности ----------
    const chipsY = heroBottom + 28;
    const chipW = Math.min(200, (width - 90) / 2);
    DIFF_ORDER.forEach((id, i) => {
      const x = width / 2 + (i === 0 ? -chipW / 2 - 8 : chipW / 2 + 8);
      this.createDiffChip(x, chipsY, chipW, 40, id);
    });

    // ---------- Пре-ран ряд: контракт / указ / расходники / вызов дня ----------
    const preY = chipsY + 38;
    this.createPreRow(width, preY, mobile);

    // ---------- Кнопки ----------
    const btnY = Math.min(height * 0.85, preY + 48);
    makeButton(this, width / 2, btnY, Math.min(320, width - 80), 58, t('menu.play'), () => {
      audio.unlock();
      saveText('tss-hero', this.selectedHero);
      saveText('tss-diff', this.selectedDiff);
      this.startRun();
    }, 'blue', mobile ? 20 : 24);

    // Навигация по мета-экранам — всё внутри Phaser. «Лавка торговца»
    // теперь отдельная сцена 'Shop' (фаза S), мета — сцена 'Meta' (фаза Q).
    const navItems: Array<[string, () => void]> = [
      [t('menu.howTo'), () => this.showHowTo()],
      [t('menu.records'), () => { void this.showRecords(); }],
      [t('menu.shop'), () => this.openOverlayScene('Shop')],
      [t('menu.achievements'), () => this.showAchievements()],
      [t('menu.chronicle'), () => this.showChronicle()],
      [t('meta.tab'), () => this.openOverlayScene('Meta')],
    ];
    const navY = btnY + 58;
    if (mobile) {
      // Два ряда по три: шесть кнопок мета-навигации
      const w3 = Math.min(150, (width - 60 - 24) / 3);
      navItems.slice(0, 3).forEach(([lbl, action], i) => {
        const x = width / 2 - (3 * w3 + 24) / 2 + i * (w3 + 12) + w3 / 2;
        makeButton(this, x, navY, w3, 42, lbl, action, 'red', 11);
      });
      navItems.slice(3).forEach(([lbl, action], i) => {
        const x = width / 2 - (3 * w3 + 24) / 2 + i * (w3 + 12) + w3 / 2;
        makeButton(this, x, navY + 48, w3, 42, lbl, action, 'red', 11);
      });
    } else {
      const gapN = 8;
      const bw = Math.min(160, (width - 80 - 5 * gapN) / 6);
      navItems.forEach(([lbl, action], i) => {
        const x = width / 2 - (6 * bw + 5 * gapN) / 2 + i * (bw + gapN) + bw / 2;
        makeButton(this, x, navY, bw, 44, lbl, action, 'red', 11);
      });
    }

    // ---------- Вход в аккаунт ----------
    // Общий зал рекордов доступен только авторизованным: setScore требует
    // входа. Площадка запрещает показывать окно входа без повода, поэтому
    // это явная кнопка — и заодно видно, под каким именем игрок записан.
    this.addAccountChip(width, height);

    // Чип дара дня (§H.7): виден, пока дар за сегодня не забран.
    // На мобильных прижат к верхнему левому углу, на десктопе — в ряд кошелька.
    if (bonusAvailable()) {
      this.createBonusChip(96, mobile ? 24 : cyA);
    }
    // Ежедневный сундук (R7 §J.3): 2 ролика в день — золото/жетоны.
    // Показывается только на Яндексе (rewarded недоступен гостям) и пока
    // лимит дня не исчерпан; встаёт рядом с чипом дара.
    if (rewardedAvailable() && dailyChestLeft() > 0) {
      const chipX = bonusAvailable() ? 262 : 96;
      this.createChestChip(chipX, mobile ? 24 : cyA);
    }

    this.add.text(width / 2, height - 12, t('menu.version'), {
      fontFamily: FONT, fontSize: '11px', color: '#3b2410',
    }).setOrigin(0.5).setAlpha(0.8);

    this.refreshSelection();
    this.scale.on('resize', this.layout, this);
    this.events.once('shutdown', () => this.scale.off('resize', this.layout, this));

    // Стики-баннер (§J.5): меню — вне рана, баннер уместен
    showStickyBanner();

    // Тихая тема меню (заставка живёт и после возврата из матча)
    audio.unlock();
    audio.startMusic(true);

    // Требование Yandex Games 1.19.2: LoadingAPI.ready() вызывается ровно
    // тогда, когда игрок уже может нажать «Играть». Раньше площадка держит
    // свою заставку поверх игры, позже — считает вызов некорректным.
    notifyReady();
  }

  /**
   * Плашка аккаунта: гость видит кнопку входа, авторизованный — своё имя.
   * Вне Яндекса (и в режиме песочницы без SDK) плашка не показывается.
   */
  private addAccountChip(width: number, height: number): void {
    if (!isOnYandex()) return;

    const signedIn = isAuthorized();
    const label = signedIn
      ? t('common.signedIn', { v: displayName('') })
      : t('common.signIn');
    const chipW = Math.min(300, width - 40);
    const chipH = 30;
    // Над заголовком меню, но ниже логотипа: на низких экранах ужимается
    const chipY = Math.max(16, Math.min(height * 0.06, height - 200));

    makeButton(this, width / 2, chipY, chipW, chipH, label, () => {
      void this.signIn();
    }, signedIn ? 'blue' : 'red', 11);
  }

  /** Открывает окно входа площадки и пересобирает меню. */
  private async signIn(): Promise<void> {
    const ok = await offerAuth();
    // Пересборка сцены обновляет плашку и зал славы под новым именем
    this.scene.restart();
    if (!ok) this.events.once('create', () => this.showToast(t('common.signInFailed')));
  }

  /** Короткое всплывающее сообщение. */
  private showToast(text: string): void {
    const toast = this.add.text(this.vw / 2, this.vh * 0.84, text, {
      fontFamily: FONT, fontSize: '13px', color: '#ffe9b0',
      stroke: '#1b1008', strokeThickness: 5,
      align: 'center', wordWrap: { width: Math.min(420, this.vw - 60) },
    }).setOrigin(0.5).setDepth(20000);
    this.tweens.add({
      targets: toast, alpha: 0, y: toast.y - 30, delay: 1900, duration: 420,
      onComplete: () => toast.destroy(),
    });
  }

  private createHeroCard(x: number, y: number, heroId: HeroId, cardW: number, cardH: number): void {
    const hero = HEROES[heroId];
    const container = this.add.container(x, y);
    const paper = makePanel(this, 0, 0, 'paper', cardW, cardH);
    container.add(paper);

    // Портрет из ui/avatars: в 4 раза детальнее анимированного спрайта,
    // поэтому на карточке 200 px он читается, а спрайт превращался в пятно.
    // Раньше рядом стоял ещё и сам спрайт героя и иконка стартового
    // оружия — на 200 px это две кляксы поверх бумаги, и выбранный герой
    // отличался от остальных только рамкой и «дыханием». Остались портрет
    // и рамка выделения.
    //
    // Файл портрета 256×256, персонаж занимает рамку portrait.box, остальное —
    // прозрачные поля. Поэтому origin ставится в центр рамки, а масштаб
    // считается от неё: пустое поле не «съедает» место на карточке.
    const portraitSize = Math.min(cardH * (cardW < 215 ? 0.34 : 0.40), cardW * 0.62);
    const box = hero.portrait.box;
    const portrait = this.add.image(0, -cardH * 0.27, `avatar-${hero.id}`)
      .setOrigin((box.x + box.w / 2) / PORTRAIT_SIZE, (box.y + box.h / 2) / PORTRAIT_SIZE)
      .setScale(portraitSize / Math.max(box.w, box.h));
    container.add(portrait);

    const name = this.add.text(0, cardH * 0.05, hero.name, {
      fontFamily: FONT, fontSize: '17px', color: '#3b2410',
    }).setOrigin(0.5);
    container.add(name);

    const title = this.add.text(0, cardH * 0.17, hero.title, {
      fontFamily: FONT, fontSize: '11px', color: '#8a5b12',
    }).setOrigin(0.5);
    container.add(title);

    const traits = hero.traits.map((t) => `• ${t}`).join('\n');
    const narrow = cardW < 215;
    const body = this.add.text(0, cardH * (narrow ? 0.23 : 0.25), traits, {
      fontFamily: FONT, fontSize: narrow ? '10px' : '11px', color: '#4a3517',
      align: 'center', lineSpacing: narrow ? 2 : 3, wordWrap: { width: cardW - 26 },
    }).setOrigin(0.5, 0);
    container.add(body);

    // Рамка выделения: четыре угла, повёрнутых по сторонам. Единственный
    // признак выбранного героя — портрет и текст на карточке одинаковые
    // у всех, отличается только рамка (плюс размер самой карточки).
    const frame = makeCornerFrame(this, 0, 0, cardW + 6, cardH + 6, {
      cornerScale: 0.62, depth: 6,
    });
    container.add(frame.container);
    frame.setVisible(false);

    container.setSize(cardW, cardH);
    container.setInteractive({ useHandCursor: true });
    container.on('pointerover', () => {
      if (this.selectedHero !== heroId) {
        this.tweens.add({ targets: container, scale: 1.04, duration: 110 });
      }
    });
    container.on('pointerout', () => {
      if (this.selectedHero !== heroId) {
        this.tweens.add({ targets: container, scale: 1, duration: 110 });
      }
    });
    container.on('pointerdown', () => {
      audio.play('click');
      this.selectHero(heroId);
    });

    this.heroCards.push({ container, frame, heroId });
  }

  private createDiffChip(x: number, y: number, w: number, h: number, diffId: DifficultyId): void {
    const def = DIFFICULTIES[diffId];
    const container = this.add.container(x, y);
    const paper = makePanel(this, 0, 0, 'paper', w, h);
    container.add(paper);

    const isNightmare = diffId === 'nightmare';
    const icon = this.add.text(-w / 2 + 16, 0, isNightmare ? '☠' : '⚔', {
      fontFamily: FONT, fontSize: '16px', color: isNightmare ? '#7a1010' : '#3b2410',
    }).setOrigin(0.5);
    container.add(icon);

    const name = this.add.text(-w / 2 + 34, -7, def.name.toUpperCase(), {
      fontFamily: FONT, fontSize: '13px', color: isNightmare ? '#7a1010' : '#3b2410',
    }).setOrigin(0, 0.5);
    container.add(name);

    const tag = this.add.text(-w / 2 + 34, 7, def.tagline, {
      fontFamily: FONT, fontSize: '8px', color: '#8a5b12',
    }).setOrigin(0, 0.5);
    container.add(tag);

    // Углы рамки — те же, что у карточки героя (см. systems/Corners.ts):
    // размер чипа постоянный, тянуть рамку не нужно
    const frame = makeCornerFrame(this, 0, 0, w + 6, h + 6, {
      cornerScale: 0.55, depth: 6,
    });
    container.add(frame.container);
    frame.setVisible(false);

    container.setSize(w, h);
    container.setInteractive({ useHandCursor: true });
    container.on('pointerover', () => {
      if (this.selectedDiff !== diffId) this.tweens.add({ targets: container, scale: 1.04, duration: 100 });
    });
    container.on('pointerout', () => {
      if (this.selectedDiff !== diffId) this.tweens.add({ targets: container, scale: 1, duration: 100 });
    });
    container.on('pointerdown', () => {
      audio.play('click');
      if (this.selectedDiff !== diffId) {
        this.selectedDiff = diffId;
        this.refreshSelection();
      }
    });

    this.diffChips.push({ container, frame, diffId });
  }

  private selectHero(heroId: HeroId): void {
    if (this.selectedHero === heroId) return;
    this.selectedHero = heroId;
    this.refreshSelection();
  }

  private refreshSelection(): void {
    for (const c of this.heroCards) {
      const selected = c.heroId === this.selectedHero;
      c.frame.setVisible(selected);
      if (selected) {
        c.container.setScale(1.07);
      } else {
        c.container.setScale(1);
      }
    }
    for (const d of this.diffChips) {
      const selected = d.diffId === this.selectedDiff;
      d.frame.setVisible(selected);
      d.container.setAlpha(selected ? 1 : 0.72);
      if (selected) {
        d.container.setScale(1.05);
      } else {
        d.container.setScale(1);
      }
    }
  }

  private layout(): void {
    this.scene.restart();
  }

  // ================================================================
  // Общий каркас оверлеев (затемнение + блокировщик кликов)
  // ================================================================

  private beginOverlay(): void {
    this.closeOverlay();
    const width = this.vw;
    const height = this.vh;
    const cover = Math.max(width / this.menuZoom, height / this.menuZoom) + 160;
    this.overlay = this.add.container(0, 0);
    const dim = this.add.rectangle(width / 2, height / 2, cover, cover, 0x0a0a12, 0.72);
    this.overlay.add(dim);
    // Блокировщик: меню под оверлеем не должно реагировать на клики
    const blocker = this.add.rectangle(width / 2, height / 2, cover, cover, 0x000000, 0.001)
      .setInteractive({ useHandCursor: false });
    this.overlayExtras.push(blocker);
  }

  private backButton(y?: number): void {
    const width = this.vw;
    const height = this.vh;
    const by = Math.min(y ?? height / 2 + Math.min(300, height * 0.36), height - 38);
    const b = makeButton(this, width / 2, by, 170, 54, t('common.back'), () => this.closeOverlay(), 'red', 16);
    this.overlayExtras.push(b.img, b.txt, b.hit);
  }

  private closeOverlay(): void {
    this.overlay?.destroy(true);
    this.overlay = null;
    for (const o of this.overlayExtras) o.destroy();
    this.overlayExtras = [];
    for (const r of this.shopRowEls) r.destroy(true);
    this.shopRowEls = [];
    this.shopBalanceText = null;
    for (const r of this.consRowEls) r.destroy();
    this.consRowEls = [];
    this.achDesc = null;
  }

  // ================================================================
  // «Как играть»
  // ================================================================

  private showHowTo(): void {
    this.beginOverlay();
    const width = this.vw;
    const height = this.vh;
    const paperW = Math.min(560, width - 50);
    const paperH = Math.min(paperW * 1.24, height - 40);
    const paper = makePanel(this, width / 2, height / 2, 'paper', paperW, paperH);
    const top = height / 2 - paperH / 2;
    const header = this.add.text(width / 2, top + 34, t('howto.title'), {
      fontFamily: FONT, fontSize: '26px', color: '#3b2410',
    }).setOrigin(0.5);
    const lines = [
      t('howto.hero'),
      t('howto.move'),
      '',
      t('howto.auto'),
      t('howto.loot'),
    ];
    const body = this.add.text(width / 2, top + 64, lines.join('\n'), {
      fontFamily: FONT, fontSize: '14px', color: '#57431f', align: 'center', lineSpacing: 6,
    }).setOrigin(0.5, 0);
    this.overlay?.add([paper, header, body]);

    // ===== Раздел «Эволюции оружия» с рецептами =====
    const evoTitle = this.add.text(width / 2, top + 172, t('howto.evoTitle'), {
      fontFamily: FONT, fontSize: '16px', color: '#9a6a08',
    }).setOrigin(0.5);
    const evoHint = this.add.text(width / 2, top + 194,
      t('howto.evoRecipe'), {
      fontFamily: FONT, fontSize: '11px', color: '#8a5b12',
    }).setOrigin(0.5);
    this.overlay?.add([evoTitle, evoHint]);

    const recipeY0 = top + 222;
    const recipeGap = 26;
    Object.values(EVOLUTIONS).forEach((evo, i) => {
      const y = recipeY0 + i * recipeGap;
      const cx = width / 2;
      // [оружие] + [пассивка] → ★ Имя
      // Колонки: [оружие] + [пассивка] → ★ эволюция.
      // Ширины делят пергамент поровну, названия ужимаются под свою колонку.
      const iconW = 18;
      const half = paperW / 2 - 24;
      const wTextX = cx - half + iconW + 6;
      const plusX = cx - 12;
      const pIconX = cx + 2;
      const pTextX = pIconX + iconW + 6;
      const arrowX = pTextX + half * 0.44;
      const evoX = arrowX + 12;
      const wColW = plusX - wTextX - 10;
      const pColW = arrowX - pTextX - 10;
      const evoColW = cx + half - evoX - 4;

      const wIcon = this.add.image(cx - half + iconW / 2, y, WEAPONS[evo.weapon].icon)
        .setDisplaySize(iconW, iconW);
      const wName = this.add.text(wTextX, y, WEAPONS[evo.weapon].name, {
        fontFamily: FONT, fontSize: '11px', color: '#57431f',
      }).setOrigin(0, 0.5);
      fitTextWidth(wName, wColW, 11, 8);
      const plus = this.add.text(plusX, y, '+', {
        fontFamily: FONT, fontSize: '11px', color: '#8a5b12',
      }).setOrigin(0.5);
      const pIcon = this.add.image(pIconX + iconW / 2, y, PASSIVES[evo.partner].icon)
        .setDisplaySize(iconW, iconW);
      const pName = this.add.text(pTextX, y, PASSIVES[evo.partner].name, {
        fontFamily: FONT, fontSize: '11px', color: '#57431f',
      }).setOrigin(0, 0.5);
      fitTextWidth(pName, pColW, 11, 8);
      const arrow = this.add.text(arrowX, y, '→', {
        fontFamily: FONT, fontSize: '12px', color: '#9a6a08',
      }).setOrigin(0.5);
      const evoName = this.add.text(evoX, y, `★ ${evo.name}`, {
        fontFamily: FONT, fontSize: '11px', color: '#9a6a08',
        stroke: '#f7e7c3', strokeThickness: 2,
      }).setOrigin(0, 0.5);
      fitTextWidth(evoName, evoColW, 11, 8);
      this.overlay?.add([wIcon, wName, plus, pIcon, pName, arrow, evoName]);
    });

    const footerY = recipeY0 + 7 * recipeGap + 14;
    const footer = this.add.text(width / 2, footerY, [
      t('howto.goal1'),
      t('howto.goal2'),
      t('howto.goal3'),
    ].join('\n'), {
      fontFamily: FONT, fontSize: '13px', color: '#57431f', align: 'center', lineSpacing: 6,
    }).setOrigin(0.5, 0);
    this.overlay?.add([footer]);
    this.backButton();
  }

  // ================================================================
  // «Рекорды» — таблица из /api/scores
  // ================================================================

  private async showRecords(): Promise<void> {
    this.beginOverlay();
    const width = this.vw;
    const height = this.vh;
    const container = this.add.container(0, 0);
    // Переносим затемнение из каркасного контейнера в новый (для guard-проверки active)
    this.overlay?.destroy(true);
    this.overlay = container;
    const cover = Math.max(width / this.menuZoom, height / this.menuZoom) + 160;
    const dim = this.add.rectangle(width / 2, height / 2, cover, cover, 0x0a0a12, 0.72);
    container.add(dim);

    const paperW = Math.min(600, width - 50);
    const paperH = Math.min(470, height - 60);
    // Подвал: подсказка об источнике + формула подсчёта очков.
    // Строки таблицы не должны заезжать на него — считаем вместимость.
    const footerTop = top_ => top_ + paperH - 92;
    const rowsTop = top_ => top_ + 136;
    const rowCapFor = (t: number): number =>
      Math.max(3, Math.floor((footerTop(t) - rowsTop(t) - 8) / 26));
    const cx = width / 2;
    const cy = height / 2;
    const paper = makePanel(this, cx, cy, 'paperSpecial', paperW, paperH);
    container.add(paper);
    const top = cy - paperH / 2;
    const footerTopAbs = footerTop(top);
    const rowsTopAbs = rowsTop(top);
    const rowCap = rowCapFor(top);

    container.add(this.add.text(cx, top + 38, t('records.title'), {
      fontFamily: FONT, fontSize: '24px', color: '#ffe9c0',
      stroke: '#1b1008', strokeThickness: 5,
    }).setOrigin(0.5));

    const loading = this.add.text(cx, cy, t('records.loading'), {
      fontFamily: FONT, fontSize: '15px', color: '#cbb389',
    }).setOrigin(0.5);
    container.add(loading);

    // Колонки таблицы
    const left = cx - paperW / 2 + 30;
    const right = cx + paperW / 2 - 30;
    const colName = left + 28;
    const colScore = right - 92;
    const colKills = right - 40;

    const headerStyle: Phaser.Types.GameObjects.Text.TextStyle = {
      fontFamily: FONT, fontSize: '10px', color: '#cbb389',
    };
    container.add(this.add.text(left, top + 100, '#', { ...headerStyle }).setOrigin(0, 0.5));
    container.add(this.add.text(colName, top + 100, t('records.colHero'), { ...headerStyle }).setOrigin(0, 0.5));
    container.add(this.add.text(colScore, top + 100, t('records.colScore'), { ...headerStyle }).setOrigin(1, 0.5));
    container.add(this.add.text(colKills, top + 100, t('records.colKills'), { ...headerStyle }).setOrigin(1, 0.5));
    container.add(this.add.text(right, top + 100, t('records.colTime'), { ...headerStyle }).setOrigin(1, 0.5));
    const hr = this.add.graphics();
    hr.lineStyle(1, 0x8a6d3b, 0.6).lineBetween(left, top + 114, right, top + 114);
    container.add(hr);

    // ---------- Фильтр: все заезды / только победы ----------
    const chipY = top + 76;
    const chipW = 96;
    const chips: Array<{ key: 'all' | 'win'; label: string }> = [
      { key: 'all', label: t('records.filterAll') },
      { key: 'win', label: t('records.filterWins') },
    ];
    const chipEls: Array<{ bg: Phaser.GameObjects.Rectangle; txt: Phaser.GameObjects.Text }> = [];
    chips.forEach((c, i) => {
      const x = cx + (i === 0 ? -chipW - 4 : 4) + chipW / 2;
      const bg = this.add.rectangle(x, chipY, chipW, 24, 0x3b2410, 1)
        .setStrokeStyle(2, this.recordsFilter === c.key ? 0xffd76e : 0x8a6d3b, 1);
      const txt = this.add.text(x, chipY, c.label, {
        fontFamily: FONT, fontSize: '11px', color: this.recordsFilter === c.key ? '#ffd76e' : '#cbb389',
      }).setOrigin(0.5);
      const hit = this.add.zone(x, chipY, chipW + 8, 30).setInteractive({ useHandCursor: true });
      hit.on('pointerdown', () => {
        if (this.recordsFilter === c.key) return;
        audio.play('click');
        this.recordsFilter = c.key;
        this.renderRecords(container, left, right, colName, colScore, colKills, rowsTopAbs, rowCap);
        // Перекрасить чипы
        chipEls.forEach((els, j) => {
          const active = this.recordsFilter === chips[j].key;
          els.txt.setColor(active ? '#ffd76e' : '#cbb389');
          els.bg.setStrokeStyle(2, active ? 0xffd76e : 0x8a6d3b, 1);
        });
      });
      container.add([bg, txt, hit]);
      chipEls.push({ bg, txt });
    });

    try {
      // Общий зал Яндекс Игр для авторизованных, локальная таблица — для гостей
      const res = await topScores(10);
      if (!container.active) return; // оверлей закрыли, пока грузился ответ
      loading.destroy();
      this.recordsRows = res.entries;
      this.recordsOnline = res.online;
      this.renderRecords(container, left, right, colName, colScore, colKills, rowsTopAbs, rowCap);
    } catch {
      if (!container.active) return;
      loading.destroy();
      container.add(this.add.text(cx, cy, t('records.failed'), {
        fontFamily: FONT, fontSize: '15px', color: '#ff8a7a',
      }).setOrigin(0.5));
    }

    // Подсказка об источнике данных: локальный рейтинг vs общий зал Яндекса
    container.add(this.add.text(cx, footerTopAbs + 6, this.recordsOnline ? t('records.onlineHint') : t('records.localHint'), {
      fontFamily: FONT, fontSize: '9px', color: '#8a7a5c', align: 'center',
    }).setOrigin(0.5).setScrollFactor(0));

    container.add(this.add.text(cx, footerTopAbs + 34, [
      t('records.formula1'),
      t('records.formula2'),
    ].join('\n'), {
      fontFamily: FONT, fontSize: '10px', color: '#cbb389', align: 'center', lineSpacing: 6,
    }).setOrigin(0.5));

    this.backButton(top + paperH + 42);
  }

  /** Отрисовка строк таблицы рекордов с учётом активного фильтра */
  private renderRecords(
    container: Phaser.GameObjects.Container,
    left: number, right: number, colName: number, colScore: number, colKills: number,
    rowsTop: number, rowCap: number,
  ): void {
    for (const o of this.recordsListEls) o.destroy();
    this.recordsListEls = [];
    const cx = this.vw / 2;
    const cy = this.vh / 2;
    const rows = this.recordsFilter === 'win'
      ? this.recordsRows.filter((r) => r.victory)
      : this.recordsRows;
    if (rows.length === 0) {
      const empty = this.add.text(cx, cy + 20, this.recordsFilter === 'win'
        ? t('records.emptyWin')
        : t('records.emptyAll'), {
        fontFamily: FONT, fontSize: '15px', color: '#cbb389', align: 'center', lineSpacing: 8,
      }).setOrigin(0.5);
      container.add(empty);
      this.recordsListEls.push(empty);
      return;
    }
    const style: Phaser.Types.GameObjects.Text.TextStyle = {
      fontFamily: FONT, fontSize: '13px', color: '#ffe9c0',
    };
    // Имя занимает всё свободное место до колонки «СЧЁТ»
    const nameMaxW = Math.max(60, colScore - colName - 30);
    // Если строк больше, чем помещается, показываем верхние и считаем остальные
    const shownRows = rows.slice(0, rowCap);
    shownRows.forEach((r, i) => {
      const y = rowsTop + i * 26;
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
      // Длинные имена ужимаем под колонку, а не обрезаем по 13 символов
      const nameText = this.add.text(colName, y, `${r.name}${r.victory ? ' ★' : ''}`, {
        ...style, color: i === 0 ? '#ffd76e' : '#ffe9c0',
      }).setOrigin(0, 0.5);
      fitTextWidth(nameText, nameMaxW, 13);
      const els: Phaser.GameObjects.GameObject[] = [
        this.add.text(left, y, medal, {
          ...style, color: i < 3 ? '#ffd76e' : '#cbb389',
        }).setOrigin(0, 0.5),
        nameText,
        this.add.text(colScore, y, num(r.score), {
          ...style, color: '#ffd76e',
        }).setOrigin(1, 0.5),
        this.add.text(colKills, y, `${r.kills}`, { ...style }).setOrigin(1, 0.5),
      ];
      els.push(this.add.text(right, y, clock(r.timeSurvived), { ...style }).setOrigin(1, 0.5));
      container.add(els);
      this.recordsListEls.push(...els);
    });
  }

  // ================================================================
  // «Лавка торговца» — мета-магазин за золото матчей
  // ================================================================

  private showShop(): void {
    this.beginOverlay();
    const width = this.vw;
    const height = this.vh;
    const paperW = Math.min(560, width - 50);
    const paperH = Math.min(590, height - 50);
    const cx = width / 2;
    const cy = height / 2;
    const paper = makePanel(this, cx, cy, 'paper', paperW, paperH);
    this.overlay?.add(paper);
    const top = cy - paperH / 2;

    this.overlay?.add(this.add.text(cx, top + 38, t('shop.title'), {
      fontFamily: FONT, fontSize: '26px', color: '#3b2410',
    }).setOrigin(0.5));
    this.overlay?.add(this.add.text(cx, top + 62, t('shop.subtitle'), {
      fontFamily: FONT, fontSize: '11px', color: '#8a5b12',
    }).setOrigin(0.5));

    // Кошелёк
    const balBg = this.add.graphics();
    balBg.fillStyle(0xf7e7c3, 1).fillRoundedRect(cx - 112, top + 78, 224, 36, 9);
    balBg.lineStyle(2, 0xc9a25e, 1).strokeRoundedRect(cx - 112, top + 78, 224, 36, 9);
    this.overlay?.add(balBg);
    this.overlay?.add(this.add.image(cx - 90, top + 96, 'icon-coin').setDisplaySize(22, 22));
    this.shopBalanceText = this.add.text(cx + 16, top + 96, '0', {
      fontFamily: FONT, fontSize: '18px', color: '#7a4e0e',
    }).setOrigin(0.5);
    this.overlay?.add(this.shopBalanceText);

    // Строки лавки подгоняются под свободную высоту пергамента
    const shopFooterY = top + paperH - 44;
    this.shopRowsY = top + 132;
    this.shopRowH = Math.max(
      44,
      Math.min(64, (shopFooterY - this.shopRowsY - 4 * 10) / SHOP_UPGRADES.length),
    );
    this.renderShopRows();

    this.overlay?.add(this.add.text(cx, top + paperH - 28, t('shop.footer'), {
      fontFamily: FONT, fontSize: '10px', color: '#8a5b12',
    }).setOrigin(0.5));

    this.backButton(top + paperH + 42);
    this.refreshShopBalance();
  }

  private renderShopRows(flashIdx?: number): void {
    for (const r of this.shopRowEls) r.destroy(true);
    this.shopRowEls = [];
    const st = loadShop();
    const width = this.vw;
    const paperW = Math.min(560, width - 50);
    const rowW = paperW - 56;
    const rowH = this.shopRowH;
    const gap = 10;
    // На низких экранах иконка и подписи ужимаются вместе со строкой
    const dense = rowH < 58;
    const iconSize = dense ? 24 : 32;
    const nameY = dense ? -rowH * 0.2 : -14;
    const descY = dense ? rowH * 0.18 : 8;
    const btnH = dense ? Math.max(26, rowH - 20) : 34;

    SHOP_UPGRADES.forEach((u, i) => {
      const lvl = st.upgrades[u.id];
      const maxed = lvl >= 3;
      const price = maxed ? null : u.costs[lvl];
      const affordable = price !== null && st.balance >= price;
      const y = this.shopRowsY + i * (rowH + gap) + rowH / 2;

      const row = this.add.container(width / 2, y);
      const bg = this.add.graphics();
      bg.fillStyle(0xfff6df, 1).fillRoundedRect(-rowW / 2, -rowH / 2, rowW, rowH, 10);
      bg.lineStyle(2, 0xc9a25e, 1).strokeRoundedRect(-rowW / 2, -rowH / 2, rowW, rowH, 10);
      row.add(bg);

      const icon = this.add.image(-rowW / 2 + 22, 0, u.icon).setDisplaySize(iconSize, iconSize);
      row.add(icon);

      const textX = -rowW / 2 + 22 + iconSize / 2 + 8;
      const name = this.add.text(textX, nameY, u.name, {
        fontFamily: FONT, fontSize: dense ? '12px' : '14px', color: '#3b2410',
      }).setOrigin(0, 0.5);
      row.add(name);

      const desc = this.add.text(textX, descY, u.desc, {
        fontFamily: FONT, fontSize: dense ? '8px' : '9px', color: '#8a5b12',
      }).setOrigin(0, 0.5);
      row.add(desc);

      const dots = this.add.text(rowW / 2 - (dense ? 118 : 132), -2, '●'.repeat(lvl) + '○'.repeat(3 - lvl), {
        fontFamily: FONT, fontSize: dense ? '9px' : '11px', color: '#b0803a',
      }).setOrigin(0.5);
      row.add(dots);

      if (maxed) {
        row.add(this.add.text(rowW / 2 - 56, 0, t('shop.max'), {
          fontFamily: FONT, fontSize: dense ? '11px' : '13px', color: '#2e7d32',
          stroke: '#dcecc9', strokeThickness: 3,
        }).setOrigin(0.5));
      } else {
        // Кнопка занимает всю строку: так по ней попасть проще, чем по
        // маленькой ценке, а состояния (наведение/нажатие/недоступно)
        // достаются из makeButton.
        const buy = (): void => {
          const res = buyUpgrade(u.id);
          if (res.ok) {
            audio.play('levelup');
            this.renderShopRows(i);
            this.refreshShopBalance();
          } else if (res.reason === 'poor') {
            // Не хватило золота: короткая встряска самой кнопки
            const btnImg = priceBtn.img;
            this.tweens.add({
              targets: btnImg, x: { from: btnImg.x - 5, to: btnImg.x }, duration: 180,
            });
          }
        };
        const priceBtn = makeButton(
          this, rowW / 2 - 56, 0, 92, btnH, String(price), buy, 'blue', dense ? 10 : 12,
          { disabled: !affordable, hitW: rowW, hitH: rowH, stopPropagation: true },
        );
        row.add([priceBtn.img, priceBtn.txt, priceBtn.hit]);
        if (!affordable) {
          row.setAlpha(0.62);
          priceBtn.txt.setColor('#f0e4c8');
        }
      }

      row.setSize(rowW, rowH);

      if (i === flashIdx) {
        row.setScale(1.12);
        this.tweens.add({ targets: row, scale: 1, duration: 260, ease: 'Back.easeOut' });
      }
      this.shopRowEls.push(row);
    });
  }

  private refreshShopBalance(): void {
    const st = loadShop();
    this.shopBalanceText?.setText(num(st.balance));
  }

  // ================================================================
  // «Достижения»
  // ================================================================

  private showAchievements(): void {
    this.beginOverlay();
    const width = this.vw;
    const height = this.vh;
    const unlocked = loadUnlocked();
    const count = unlocked.size;
    const total = ACHIEVEMENTS.length;

    const paperW = Math.min(560, width - 50);
    const paperH = Math.min(560, height - 50);
    const cx = width / 2;
    const cy = height / 2;
    const paper = makePanel(this, cx, cy, 'paper', paperW, paperH);
    this.overlay?.add(paper);
    const top = cy - paperH / 2;

    this.overlay?.add(this.add.text(cx, top + 38, t('ach.title'), {
      fontFamily: FONT, fontSize: '26px', color: '#3b2410',
    }).setOrigin(0.5));
    this.overlay?.add(this.add.text(cx, top + 64, `${count} / ${total}`, {
      fontFamily: FONT, fontSize: '15px', color: '#8a5b12',
    }).setOrigin(0.5));

    // Полоса прогресса
    const barW = paperW - 130;
    const bar = this.add.graphics();
    bar.fillStyle(0x3b2a1a, 1).fillRoundedRect(cx - barW / 2, top + 82, barW, 12, 6);
    if (count > 0) {
      bar.fillStyle(0xd9a520, 1).fillRoundedRect(cx - barW / 2 + 2, top + 84, Math.max(8, (barW - 4) * (count / total)), 8, 4);
    }
    this.overlay?.add(bar);

    // Сетка: число колонок подбирается под ширину, высота ячейки — под
    // оставшуюся высоту пергамента. До правки сетка жёстко была 3×3 при
    // 12 достижениях, то есть 4 ряда, и нижний ряд ложился на подсказку.
    const cellGap = 12;
    const cols = paperW >= 560 ? 4 : 3;
    const rows = Math.ceil(ACHIEVEMENTS.length / cols);
    const gridTop = top + 112;
    const hintH = 34;
    const footerH = ACHIEVEMENTS.length > 0 && unlocked.size === ACHIEVEMENTS.length ? 30 : 0;
    const gridRoom = top + paperH - gridTop - hintH - footerH - 14;
    const cellH = Math.max(64, Math.min(104, (gridRoom - (rows - 1) * cellGap) / rows));
    const cellW = (paperW - 56 - (cols - 1) * cellGap) / cols;
    const small = width < 500;

    this.achDesc = this.add.text(cx, top + paperH - hintH - 6, t('ach.hint'), {
      fontFamily: FONT, fontSize: '11px', color: '#57431f', align: 'center',
      wordWrap: { width: paperW - 70 }, lineSpacing: 5,
    }).setOrigin(0.5);
    this.overlay?.add(this.achDesc);

    ACHIEVEMENTS.forEach((a, i) => {
      const col = i % cols;
      const rowI = Math.floor(i / cols);
      const x = cx - (cols * cellW + (cols - 1) * cellGap) / 2 + col * (cellW + cellGap) + cellW / 2;
      const y = gridTop + rowI * (cellH + cellGap) + cellH / 2;
      const has = unlocked.has(a.id);

      const cell = this.add.container(x, y);
      const g = this.add.graphics();
      if (has) {
        g.fillStyle(0xffe9b0, 1).fillRoundedRect(-cellW / 2, -cellH / 2, cellW, cellH, 10);
        g.lineStyle(3, 0xd9a520, 1).strokeRoundedRect(-cellW / 2, -cellH / 2, cellW, cellH, 10);
      } else {
        g.fillStyle(0xefe6d0, 1).fillRoundedRect(-cellW / 2, -cellH / 2, cellW, cellH, 10);
        g.lineStyle(2, 0xbfa77a, 1).strokeRoundedRect(-cellW / 2, -cellH / 2, cellW, cellH, 10);
      }
      cell.add(g);

      const iconSize = Math.max(22, Math.min(34, cellH * 0.32));
      const icon = this.add.image(0, -cellH * 0.28, a.icon).setDisplaySize(iconSize, iconSize);
      if (!has) icon.setTint(0x8d8577);
      cell.add(icon);

      const achFont = small ? 9 : cellH < 78 ? 9 : 10;
      const achText = this.add.text(0, cellH * 0.26, a.name, {
        fontFamily: FONT, fontSize: `${achFont}px`,
        color: has ? '#3b2410' : '#8d8577', align: 'center',
        wordWrap: { width: cellW - 12 }, lineSpacing: 2,
      }).setOrigin(0.5);
      // Название не должно обрезаться по краю ячейки
      if (achText.height <= achFont * 2.4) fitTextWidth(achText, cellW - 12, achFont, 7);
      else achText.setWordWrapWidth(cellW - 12);
      cell.add(achText);

      cell.setSize(cellW, cellH);
      cell.setInteractive({ useHandCursor: true });
      const showDesc = (): void => {
        this.achDesc?.setText(has
          ? `${a.emoji} ${a.name} — ${a.desc}`
          : `🔒 ${a.name} — ${a.desc}`);
      };
      cell.on('pointerover', showDesc);
      cell.on('pointerdown', showDesc);
      this.overlayExtras.push(cell);
    });

    if (count === total && count > 0) {
      this.overlay?.add(this.add.text(cx, top + paperH - 24, t('ach.allDone'), {
        fontFamily: FONT, fontSize: '13px', color: '#8a5b12',
      }).setOrigin(0.5));
    }

    this.backButton(top + paperH + 42);
  }

  // ================================================================
  // «Хроника воина» — мета-статистика
  // ================================================================

  private showChronicle(): void {
    this.beginOverlay();
    const width = this.vw;
    const height = this.vh;
    const meta = loadMeta();

    const paperW = Math.min(520, width - 50);
    const paperH = meta.matches === 0 && meta.kills === 0
      ? Math.min(340, height - 60)
      : Math.min(430, height - 50);
    const cx = width / 2;
    const cy = height / 2;
    const paper = makePanel(this, cx, cy, 'paper', paperW, paperH);
    this.overlay?.add(paper);
    const top = cy - paperH / 2;

    this.overlay?.add(this.add.text(cx, top + 38, t('chron.title'), {
      fontFamily: FONT, fontSize: '26px', color: '#3b2410',
    }).setOrigin(0.5));

    if (meta.matches === 0 && meta.kills === 0) {
      this.overlay?.add(this.add.text(cx, cy + 10, [
        t('chron.empty1'),
        t('chron.empty2'),
        t('chron.empty3'),
      ].join('\n'), {
        fontFamily: FONT, fontSize: '14px', color: '#57431f', align: 'center', lineSpacing: 10,
      }).setOrigin(0.5));
    } else {
      const winRate = meta.matches > 0 ? Math.round((meta.victories / meta.matches) * 100) : 0;
      if (meta.matches > 0) {
        const chip = this.add.graphics();
        chip.fillStyle(0xdff0d8, 1).fillRoundedRect(cx - 74, top + 56, 148, 26, 13);
        chip.lineStyle(2, 0x5b8a51, 1).strokeRoundedRect(cx - 74, top + 56, 148, 26, 13);
        this.overlay?.add(chip);
        this.overlay?.add(this.add.text(cx, top + 69, t('chron.winRate', { v: winRate }), {
          fontFamily: FONT, fontSize: '12px', color: '#2e5d28',
        }).setOrigin(0.5));
      }

      const fmt = (n: number): string => num(n);
      const h = Math.floor(meta.playTime / 3600);
      const m = Math.floor((meta.playTime % 3600) / 60);
      const timeStr = h > 0
        ? t('chron.hoursMins', { h, m })
        : m > 0
          ? t('chron.mins', { m })
          : t('chron.secs', { s: meta.playTime });
      const items: Array<[string, string]> = [
        [t('chron.matches'), fmt(meta.matches)],
        [t('chron.victories'), fmt(meta.victories)],
        [t('chron.kills'), fmt(meta.kills)],
        [t('chron.gold'), fmt(meta.gold)],
        [t('chron.best'), fmt(meta.bestScore)],
        [t('chron.playtime'), timeStr],
      ];

      const cellGap = 10;
      const cellW = (paperW - 56 - cellGap) / 2;
      const cellH = 58;
      const gridTop = top + 100;
      items.forEach(([lbl, val], i) => {
        const col = i % 2;
        const rowI = Math.floor(i / 2);
        const x = cx - (2 * cellW + cellGap) / 2 + col * (cellW + cellGap) + cellW / 2;
        const y = gridTop + rowI * (cellH + cellGap) + cellH / 2;
        const g = this.add.graphics();
        g.fillStyle(0xfff6df, 1).fillRoundedRect(-cellW / 2, -cellH / 2, cellW, cellH, 9);
        g.lineStyle(2, 0xc9a25e, 0.8).strokeRoundedRect(-cellW / 2, -cellH / 2, cellW, cellH, 9);
        this.overlay?.add(g);
        g.setPosition(x, y);
        this.overlay?.add(this.add.text(x, y - 14, lbl, {
          fontFamily: FONT, fontSize: '9px', color: '#8a5b12',
        }).setOrigin(0.5));
        this.overlay?.add(this.add.text(x, y + 9, val, {
          fontFamily: FONT, fontSize: '17px', color: '#3b2410',
        }).setOrigin(0.5));
      });

      this.overlay?.add(this.add.text(cx, top + paperH - 26, t('chron.footer'), {
        fontFamily: FONT, fontSize: '10px', color: '#8a5b12',
      }).setOrigin(0.5));
    }

    this.backButton(top + paperH + 42);
  }

  // ================================================================
  // Мета-фаза Q/S (TZ §H.7–H.12, §J): чипы и оверлеи выбора
  // ================================================================

  /** Перевод по строковому ключу справочников meta.ts (nameKey и т.п.). */
  private tr(key: string, params?: TranslateParams): string {
    return t(key as TranslationKey, params);
  }

  /** Лаунч сцены-оверлея ('Meta' | 'Shop') с защитой от дублей. */
  private openOverlayScene(key: string): void {
    audio.unlock();
    if (this.scene.isActive(key)) this.scene.stop(key);
    this.scene.launch(key);
  }

  /** Чип дара дня у верхнего левого угла: лёгкий пульс, клик — оверлей. */
  private createBonusChip(x: number, y: number): void {
    const streak = loadMetaState().dailyBonus.streak;
    const chip = this.add.container(x, y);
    const g = this.add.graphics();
    g.fillStyle(0xf7e7c3, 0.95).fillRoundedRect(-75, -20, 150, 40, 10);
    g.lineStyle(2, 0xc9a25e, 1).strokeRoundedRect(-75, -20, 150, 40, 10);
    chip.add(g);
    chip.add(this.add.text(0, -8, t('bonus.title'), {
      fontFamily: FONT, fontSize: '12px', color: '#7a4e0e',
    }).setOrigin(0.5));
    chip.add(this.add.text(0, 9, t('bonus.streak', { v: streak }), {
      fontFamily: FONT, fontSize: '9px', color: '#8a5b12',
    }).setOrigin(0.5));
    // Хит-зона 156×48 ≥ MIN_TOUCH: сама плашка 150×40 чуть меньше тач-гейта
    chip.setSize(156, 48);
    chip.setInteractive({ useHandCursor: true });
    chip.on('pointerdown', () => {
      audio.play('click');
      this.showBonusOverlay();
    });
    this.tweens.add({
      targets: chip, scale: { from: 1, to: 1.06 }, duration: 850, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    });
    this.bonusChip = chip;
  }

  /** После забора дара чип исчезает (вернётся при следующем рестарте меню). */
  private refreshBonusChip(): void {
    if (!bonusAvailable() && this.bonusChip) {
      this.bonusChip.destroy();
      this.bonusChip = null;
    }
  }

  /** Чип ежедневного сундука (R7 §J.3): «ролик — награда». */
  private chestChip: Phaser.GameObjects.Container | null = null;
  private chestChipPos = { x: 96, y: 24 };

  private createChestChip(x: number, y: number): void {
    this.chestChipPos = { x, y };
    const left = dailyChestLeft();
    const chip = this.add.container(x, y);
    const g = this.add.graphics();
    g.fillStyle(0xf3d9a4, 0.95).fillRoundedRect(-80, -20, 160, 40, 10);
    g.lineStyle(2, 0xb98a3a, 1).strokeRoundedRect(-80, -20, 160, 40, 10);
    chip.add(g);
    chip.add(this.add.text(0, -8, t('chest.title'), {
      fontFamily: FONT, fontSize: '12px', color: '#6e4a08',
    }).setOrigin(0.5));
    chip.add(this.add.text(0, 9, t('chest.left', { v: left }), {
      fontFamily: FONT, fontSize: '9px', color: '#8a5b12',
    }).setOrigin(0.5));
    chip.setSize(166, 48); // ≥ MIN_TOUCH с учётом полей (§I.6)
    chip.setInteractive({ useHandCursor: true });
    chip.on('pointerdown', () => {
      audio.play('click');
      void this.openDailyChest();
    });
    this.tweens.add({
      targets: chip, scale: { from: 1, to: 1.05 }, duration: 1000, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    });
    this.chestChip = chip;
  }

  /** R7: ролик → награда сундука (золото кошелька / жетоны). */
  private async openDailyChest(): Promise<void> {
    if (dailyChestLeft() <= 0) return;
    const res = await showPlacementRewarded('daily-chest', {
      pause: () => audio.silence(),
      resume: () => audio.unsilence(),
    });
    if (!res.rewarded) {
      this.showToast(t('speedup.adUnavailable'));
      return;
    }
    const reward = claimDailyChest();
    if (!reward) return;
    const label = reward.kind === 'gold'
      ? t('bonus.kind.gold', { v: reward.amount })
      : reward.kind === 'blessing'
        ? t('chest.blessing', { v: reward.amount })
        : t('chest.speedup', { v: reward.amount });
    this.showToast(t('chest.won', { v: label }));
    audio.play('ach');
    this.chestChip?.destroy();
    this.chestChip = null;
    // Лимит дня 2 показа: пока есть остальные — чип возвращается (R7 §J.3)
    if (dailyChestLeft() > 0) {
      this.createChestChip(this.chestChipPos.x, this.chestChipPos.y);
    }
    track('daily_chest_claim', { kind: reward.kind, amount: reward.amount });
  }

  /** Ряд из четырёх чипов пре-рана под чипами сложности. */
  private createPreRow(width: number, preY: number, mobile: boolean): void {
    const gap = 10;
    const chipW = Math.min(mobile ? 118 : 178, (width - 60 - 3 * gap) / 4);
    this.preChipW = chipW;
    this.preChipFont = mobile ? 8 : 10;

    const ukazLocked = !ordersUnlocked();
    const challengeLocked = matchesPlayed() < 3;
    const chips: Array<{ label: string; enabled: boolean; action: () => void }> = [
      { label: t('contract.pick', { v: this.contractPickName() }), enabled: true, action: () => this.showContractOverlay() },
      {
        label: ukazLocked ? t('ukaz.locked') : t('ukaz.pick', { v: this.ukazPickName() }),
        enabled: !ukazLocked,
        action: () => this.showUkazOverlay(),
      },
      { label: t('consumable.pick', { v: this.loadPickedConsumables().length }), enabled: true, action: () => this.showConsumablesOverlay() },
      {
        label: challengeLocked ? t('challenge.locked') : t('challenge.title'),
        enabled: !challengeLocked,
        action: () => this.showChallengeOverlay(),
      },
    ];

    chips.forEach((c, i) => {
      const x = width / 2 - (4 * chipW + 3 * gap) / 2 + i * (chipW + gap) + chipW / 2;
      const bg = this.add.graphics();
      bg.fillStyle(0xf7e7c3, 0.95).fillRoundedRect(x - chipW / 2, preY - 16, chipW, 32, 9);
      bg.lineStyle(2, 0xc9a25e, 1).strokeRoundedRect(x - chipW / 2, preY - 16, chipW, 32, 9);
      if (!c.enabled) bg.setAlpha(0.72);
      const txt = this.add.text(x, preY, c.label, {
        fontFamily: FONT, fontSize: `${this.preChipFont}px`,
        color: c.enabled ? '#3b2410' : '#8d8577', align: 'center',
        wordWrap: { width: chipW - 10 },
      }).setOrigin(0.5);
      fitTextWidth(txt, chipW - 10, this.preChipFont, 7);
      const hit = this.add.zone(x, preY, chipW + 8, 44).setInteractive({ useHandCursor: c.enabled });
      hit.on('pointerdown', () => {
        if (!c.enabled) return;
        audio.play('click');
        c.action();
      });
      this.preChipTexts[i] = txt;
    });
  }

  /** Обновляет подписи чипов пре-рана после выбора в оверлеях. */
  private refreshPreChips(): void {
    const ukazLocked = !ordersUnlocked();
    const challengeLocked = matchesPlayed() < 3;
    const labels: Array<string | null> = [
      t('contract.pick', { v: this.contractPickName() }),
      ukazLocked ? null : t('ukaz.pick', { v: this.ukazPickName() }),
      t('consumable.pick', { v: this.loadPickedConsumables().length }),
      challengeLocked ? t('challenge.locked') : t('challenge.title'),
    ];
    labels.forEach((label, i) => {
      const txt = this.preChipTexts[i];
      if (!txt || label === null) return;
      txt.setText(label);
      fitTextWidth(txt, this.preChipW - 10, this.preChipFont, 7);
    });
  }

  private contractPickName(): string {
    const def = contractDef(loadText('tss-contract-pick'));
    return def ? this.tr(def.nameKey) : t('contract.none');
  }

  private ukazPickName(): string {
    const id = loadText('tss-ukaz-pick');
    const order = ORDERS.find((o) => o.id === id);
    return order ? this.tr(order.nameKey) : t('ukaz.none');
  }

  // ----- Оверлей контракта (§H.9): выбор/снятие, хранение 'tss-contract-pick' -----

  private showContractOverlay(): void {
    this.beginOverlay();
    const width = this.vw;
    const height = this.vh;
    const pick = loadText('tss-contract-pick');
    const paperW = Math.min(520, width - 50);
    const rowCount = CONTRACTS.length + 1;
    const rowH = Math.min(56, Math.max(46, Math.floor((height - 130) / rowCount)));
    const paperH = Math.min(108 + rowCount * rowH + 24, height - 50);
    const cx = width / 2;
    const cy = height / 2;
    this.overlay?.add(makePanel(this, cx, cy, 'paper', paperW, paperH));
    const top = cy - paperH / 2;

    this.overlay?.add(this.add.text(cx, top + 36, t('contract.title'), {
      fontFamily: FONT, fontSize: '24px', color: '#3b2410',
    }).setOrigin(0.5));

    const rowW = paperW - 48;
    const rowsTop = top + 70;

    const drawRow = (i: number, name: string, desc: string, mult: string, id: string | null): void => {
      const rowCy = rowsTop + i * rowH + rowH / 2;
      const active = id === null ? !pick : pick === id;
      const g = this.add.graphics();
      g.fillStyle(active ? 0xffe9b0 : 0xfff6df, 1)
        .fillRoundedRect(cx - rowW / 2, rowCy - rowH / 2 + 4, rowW, rowH - 8, 9);
      g.lineStyle(active ? 3 : 2, active ? 0xd9a520 : 0xc9a25e, 1)
        .strokeRoundedRect(cx - rowW / 2, rowCy - rowH / 2 + 4, rowW, rowH - 8, 9);
      this.overlay?.add(g);
      this.overlay?.add(this.add.text(cx - rowW / 2 + 14, rowCy - 9, active ? `✓ ${name}` : name, {
        fontFamily: FONT, fontSize: '12px', color: '#3b2410',
      }).setOrigin(0, 0.5));
      this.overlay?.add(this.add.text(cx - rowW / 2 + 14, rowCy + 10, desc, {
        fontFamily: FONT, fontSize: '9px', color: '#8a5b12',
      }).setOrigin(0, 0.5));
      this.overlay?.add(this.add.text(cx + rowW / 2 - 14, rowCy, mult, {
        fontFamily: FONT, fontSize: '11px', color: '#9a6a08',
      }).setOrigin(1, 0.5));
      const zone = this.add.zone(cx, rowCy, rowW, rowH).setInteractive({ useHandCursor: true });
      zone.on('pointerdown', () => {
        audio.play('click');
        if (id === null) {
          removeKey('tss-contract-pick');
        } else {
          saveText('tss-contract-pick', id);
          track('contract_signed', { id });
        }
        this.closeOverlay();
        this.refreshPreChips();
      });
      this.overlayExtras.push(zone);
    };

    drawRow(0, t('contract.none'), '', '', null);
    CONTRACTS.forEach((c, i) => {
      drawRow(i + 1, this.tr(c.nameKey), this.tr(c.descKey), t('contract.mult', { v: c.mult }), c.id);
    });

    this.backButton(top + paperH + 42);
  }

  // ----- Оверлей указа (§H.17): показывает активный, выбор — в «Хронике» -----

  private showUkazOverlay(): void {
    this.beginOverlay();
    const width = this.vw;
    const height = this.vh;
    const paperW = Math.min(460, width - 50);
    const paperH = Math.min(320, height - 60);
    const cx = width / 2;
    const cy = height / 2;
    this.overlay?.add(makePanel(this, cx, cy, 'paper', paperW, paperH));
    const top = cy - paperH / 2;

    this.overlay?.add(this.add.text(cx, top + 36, t('ukaz.title'), {
      fontFamily: FONT, fontSize: '24px', color: '#3b2410',
    }).setOrigin(0.5));

    const id = loadText('tss-ukaz-pick');
    const order = ORDERS.find((o) => o.id === id);
    this.overlay?.add(this.add.text(cx, top + 88, t('ukaz.pick', {
      v: order ? this.tr(order.nameKey) : t('ukaz.none'),
    }), {
      fontFamily: FONT, fontSize: '14px', color: '#3b2410', align: 'center',
      wordWrap: { width: paperW - 60 },
    }).setOrigin(0.5));
    if (order) {
      this.overlay?.add(this.add.text(cx, top + 118, [
        this.tr(order.descKey),
        this.tr('ukaz.premium', { v: Math.round(order.gloryPremium * 100) }),
      ].join('   '), {
        fontFamily: FONT, fontSize: '10px', color: '#8a5b12', align: 'center',
        wordWrap: { width: paperW - 60 },
      }).setOrigin(0.5));
    }

    const open = makeButton(this, cx, top + paperH - 74, 190, 44, t('meta.tab'), () => {
      this.closeOverlay();
      this.openOverlayScene('Meta');
    }, 'blue', 12);
    this.overlayExtras.push(open.img, open.txt, open.hit);

    this.backButton(top + paperH + 42);
  }

  // ----- Оверлей расходников (§J.6.2): запас, выбор до 2, подкова за рекламу -----

  private showConsumablesOverlay(): void {
    this.beginOverlay();
    const width = this.vw;
    const height = this.vh;
    const paperW = Math.min(520, width - 50);
    const paperH = Math.min(400, height - 60);
    const cx = width / 2;
    const cy = height / 2;
    this.overlay?.add(makePanel(this, cx, cy, 'paper', paperW, paperH));
    const top = cy - paperH / 2;

    this.overlay?.add(this.add.text(cx, top + 36, t('consumable.title'), {
      fontFamily: FONT, fontSize: '24px', color: '#3b2410',
    }).setOrigin(0.5));
    this.overlay?.add(this.add.text(cx, top + 62, t('consumable.limit'), {
      fontFamily: FONT, fontSize: '10px', color: '#8a5b12',
    }).setOrigin(0.5));

    this.renderConsumableRows(cx, top + 86, paperW - 48);
    this.backButton(top + paperH + 42);
  }

  private renderConsumableRows(cx: number, rowsTop: number, rowW: number): void {
    for (const r of this.consRowEls) r.destroy();
    this.consRowEls = [];
    const picked = this.loadPickedConsumables();
    const rowH = 66;

    CONSUMABLES.forEach((c, i) => {
      const y = rowsTop + i * rowH + rowH / 2;
      const stock = loadMetaState().consumables[c.id] ?? 0;
      const isPicked = picked.includes(c.id);
      const full = picked.length >= CONSUMABLE_MAX;

      const els: Phaser.GameObjects.GameObject[] = [];
      const g = this.add.graphics();
      g.fillStyle(isPicked ? 0xffe9b0 : 0xfff6df, 1)
        .fillRoundedRect(cx - rowW / 2, y - rowH / 2 + 4, rowW, rowH - 8, 9);
      g.lineStyle(isPicked ? 3 : 2, isPicked ? 0xd9a520 : 0xc9a25e, 1)
        .strokeRoundedRect(cx - rowW / 2, y - rowH / 2 + 4, rowW, rowH - 8, 9);
      els.push(g);
      els.push(this.add.text(cx - rowW / 2 + 14, y - 11, this.tr(c.nameKey), {
        fontFamily: FONT, fontSize: '12px', color: '#3b2410',
      }).setOrigin(0, 0.5));
      els.push(this.add.text(cx - rowW / 2 + 14, y + 9, this.tr(c.descKey), {
        fontFamily: FONT, fontSize: '9px', color: '#8a5b12',
      }).setOrigin(0, 0.5));
      els.push(this.add.text(cx + rowW / 2 - 128, y - 11, `×${stock}`, {
        fontFamily: FONT, fontSize: '12px', color: '#57431f',
      }).setOrigin(1, 0.5));

      const toggle = makeButton(this, cx + rowW / 2 - 62, y + 2, 104, 34,
        isPicked ? '✓'
          : stock > 0 && !full ? this.tr('consumable.pick', { v: stock })
            : stock > 0 ? t('consumable.active', { v: picked.length }) : t('consumable.out'),
        () => {
          const list = this.loadPickedConsumables();
          if (list.includes(c.id)) {
            this.savePickedConsumables(list.filter((x) => x !== c.id));
          } else {
            if (list.length >= CONSUMABLE_MAX || stock <= 0) return;
            this.savePickedConsumables([...list, c.id]);
          }
          this.refreshPreChips();
          this.renderConsumableRows(cx, rowsTop, rowW);
        }, 'blue', 9, { disabled: !isPicked && (stock <= 0 || full), hitW: 110, hitH: 44, stopPropagation: true });
      els.push(toggle.img, toggle.txt, toggle.hit);

      // «Подкова удачи» — единственный расходник за рекламу (R12)
      if (c.forAd && placementAvailable('consumable')) {
        const ad = makeButton(this, cx - 128, y + 2, 96, 30, t('consumable.ad'), () => {
          void this.buyConsumableAd(cx, rowsTop, rowW);
        }, 'red', 9, { hitW: 102, hitH: 44, stopPropagation: true });
        els.push(ad.img, ad.txt, ad.hit);
      }

      this.overlay?.add(els);
      this.consRowEls.push(...els);
    });
  }

  /** +1 «Подковы удачи» в запас за rewarded R12. */
  private async buyConsumableAd(cx: number, rowsTop: number, rowW: number): Promise<void> {
    const res = await showPlacementRewarded('consumable');
    if (!res.rewarded) return;
    const st = loadMetaState();
    st.consumables.cs_horseshoe += 1;
    saveMetaState(st);
    if (this.overlay) this.renderConsumableRows(cx, rowsTop, rowW);
  }

  private loadPickedConsumables(): ConsumableId[] {
    try {
      const raw = JSON.parse(loadText('tss-consumables-pick') ?? '[]') as unknown;
      if (Array.isArray(raw)) {
        return raw
          .filter((x): x is ConsumableId => CONSUMABLES.some((c) => c.id === x))
          .slice(0, CONSUMABLE_MAX);
      }
    } catch {
      // битый JSON — начинаем с пустого выбора
    }
    return [];
  }

  private savePickedConsumables(ids: ConsumableId[]): void {
    saveText('tss-consumables-pick', JSON.stringify(ids.slice(0, CONSUMABLE_MAX)));
  }

  // ----- Оверлей вызова дня (§H.8): 2 модификатора, реролл R6, старт -----

  private showChallengeOverlay(salt = ''): void {
    this.beginOverlay();
    const width = this.vw;
    const height = this.vh;
    const paperW = Math.min(500, width - 50);
    const paperH = Math.min(470, height - 60);
    const cx = width / 2;
    const cy = height / 2;
    this.overlay?.add(makePanel(this, cx, cy, 'paper', paperW, paperH));
    const top = cy - paperH / 2;

    this.overlay?.add(this.add.text(cx, top + 36, t('challenge.title'), {
      fontFamily: FONT, fontSize: '24px', color: '#3b2410',
    }).setOrigin(0.5));
    this.overlay?.add(this.add.text(cx, top + 64, t('challenge.mods'), {
      fontFamily: FONT, fontSize: '11px', color: '#8a5b12',
    }).setOrigin(0.5));

    const ch = challengeForToday(salt);
    ch.mods.forEach((mid, i) => {
      const def = CHALLENGE_MODS.find((m) => m.id === mid);
      if (!def) return;
      const y = top + 104 + i * 58;
      this.overlay?.add(this.add.text(cx, y, this.tr(def.nameKey), {
        fontFamily: FONT, fontSize: '14px', color: '#7a1010',
      }).setOrigin(0.5));
      this.overlay?.add(this.add.text(cx, y + 20, this.tr(def.descKey), {
        fontFamily: FONT, fontSize: '10px', color: '#57431f', align: 'center',
        wordWrap: { width: paperW - 70 },
      }).setOrigin(0.5));
    });

    this.overlay?.add(this.add.text(cx, top + 232, t('challenge.reward'), {
      fontFamily: FONT, fontSize: '9px', color: '#8a5b12', align: 'center',
    }).setOrigin(0.5));
    if (challengeVictoryToday()) {
      this.overlay?.add(this.add.text(cx, top + 252, t('challenge.done'), {
        fontFamily: FONT, fontSize: '10px', color: '#2e7d32',
      }).setOrigin(0.5));
    }

    const btnY = top + paperH - 92;
    if (placementAvailable('challenge-reroll')) {
      const reroll = makeButton(this, cx - 100, btnY, 180, 44, t('challenge.reroll'), () => {
        void (async () => {
          const res = await showPlacementRewarded('challenge-reroll');
          if (res.rewarded && this.overlay) this.showChallengeOverlay(`ad${Date.now()}`);
        })();
      }, 'red', 10);
      this.overlayExtras.push(reroll.img, reroll.txt, reroll.hit);
    }
    const start = makeButton(this, cx + 100, btnY, 180, 44, t('challenge.start'), () => {
      saveRunConfig({
        contract: null,
        ukaz: null,
        challenge: { mods: ch.mods, rerolled: salt !== '' },
        blessing: null,
        consumables: [],
        endless: false,
        weeklyChallenge: false,
      });
      track('challenge_start');
      this.scene.start('Game', { hero: this.selectedHero, diff: this.selectedDiff });
    }, 'blue', 12);
    this.overlayExtras.push(start.img, start.txt, start.hit);

    this.backButton(top + paperH + 42);
  }

  // ----- Оверлей дара дня (§H.7): 7 кружков недели, забор / ×2 (R11) -----

  private showBonusOverlay(): void {
    this.beginOverlay();
    const width = this.vw;
    const height = this.vh;
    const paperW = Math.min(470, width - 50);
    const paperH = Math.min(420, height - 60);
    const cx = width / 2;
    const cy = height / 2;
    this.overlay?.add(makePanel(this, cx, cy, 'paper', paperW, paperH));
    const top = cy - paperH / 2;

    const streak = loadMetaState().dailyBonus.streak;
    const todayIdx = streak % 7;
    this.overlay?.add(this.add.text(cx, top + 36, t('bonus.title'), {
      fontFamily: FONT, fontSize: '24px', color: '#3b2410',
    }).setOrigin(0.5));
    this.overlay?.add(this.add.text(cx, top + 64, [
      t('bonus.day', { v: todayIdx + 1 }),
      t('bonus.streak', { v: streak }),
    ].join('   '), {
      fontFamily: FONT, fontSize: '11px', color: '#8a5b12',
    }).setOrigin(0.5));

    const kindKeys: Record<DailyBonusKind, TranslationKey> = {
      gold: 'bonus.kind.gold',
      chest: 'bonus.kind.chest',
      blessing: 'bonus.kind.blessing',
      crowns: 'bonus.kind.crowns',
    };
    const circleY = top + 126;
    const span = paperW - 110;
    const step = span / 6;
    for (let i = 0; i < 7; i++) {
      const cxx = cx - span / 2 + i * step;
      const isToday = i === todayIdx;
      const passed = i < todayIdx;
      const r = isToday ? 19 : 15;
      const g = this.add.graphics();
      g.fillStyle(isToday ? 0xd9a520 : passed ? 0xffe9b0 : 0xefe6d0, 1).fillCircle(cxx, circleY, r);
      g.lineStyle(isToday ? 3 : 2, isToday ? 0x9a6a08 : 0xc9a25e, 1).strokeCircle(cxx, circleY, r);
      this.overlay?.add(g);
      this.overlay?.add(this.add.text(cxx, circleY, `${i + 1}`, {
        fontFamily: FONT, fontSize: isToday ? '13px' : '11px',
        color: isToday ? '#ffffff' : passed ? '#9a6a08' : '#8d8577',
      }).setOrigin(0.5));
    }

    const def = DAILY_BONUS[todayIdx];
    if (def) {
      const rewardText = def.kind === 'gold' || def.kind === 'crowns'
        ? t(kindKeys[def.kind], { v: num(def.amount) })
        : t(kindKeys[def.kind]);
      this.overlay?.add(this.add.text(cx, top + 170, rewardText, {
        fontFamily: FONT, fontSize: '13px', color: '#9a6a08', align: 'center',
        wordWrap: { width: paperW - 70 },
      }).setOrigin(0.5));
    }

    const btnY = top + paperH - 78;
    const claim = makeButton(this, cx - 90, btnY, 160, 48, t('bonus.claim'), () => {
      this.claimBonus(false);
    }, 'blue', 13);
    this.overlayExtras.push(claim.img, claim.txt, claim.hit);
    if (placementAvailable('bonus-x2')) {
      const x2 = makeButton(this, cx + 90, btnY, 160, 48, t('bonus.claimX2'), () => {
        void this.claimBonusWithAd();
      }, 'red', 13);
      this.overlayExtras.push(x2.img, x2.txt, x2.hit);
    }

    this.backButton(top + paperH + 42);
  }

  private claimBonus(doubled: boolean): void {
    const res = claimDailyBonus(doubled);
    if (res.ok) {
      track('daily_bonus_claim', { day: res.day, doubled });
      audio.play('levelup');
    }
    this.closeOverlay();
    this.refreshBonusChip();
    this.showToast(t('bonus.claimed'));
  }

  private async claimBonusWithAd(): Promise<void> {
    const res = await showPlacementRewarded('bonus-x2');
    if (!this.overlay) return;
    if (res.rewarded) this.claimBonus(true);
  }

  // ----- Благословение перед раном (R4): 1 из 3 за жетон, старт рана -----

  /** Поток кнопки «Играть»: сбор RunModifiers → оверлей благословения → старт. */
  private startRun(): void {
    const cfg: RunModifiers = {
      contract: (loadText('tss-contract-pick') || null) as ContractId | null,
      ukaz: ordersUnlocked() ? ((loadText('tss-ukaz-pick') || null) as OrderId | null) : null,
      challenge: null,
      blessing: null,
      consumables: this.loadPickedConsumables(),
      endless: false,
      weeklyChallenge: false,
    };
    const go = (): void => {
      // takeConsumables вызывает GameScene при старте рана — не здесь
      saveRunConfig(cfg);
      this.scene.start('Game', { hero: this.selectedHero, diff: this.selectedDiff });
    };
    // Оверлей благословения — только при жетонах или доступной рекламе R4
    const st = loadMetaState();
    if (st.blessingTokens > 0 || placementAvailable('blessing')) {
      this.showBlessingOverlay(cfg, go);
    } else {
      go();
    }
  }

  private showBlessingOverlay(cfg: RunModifiers, go: () => void): void {
    this.beginOverlay();
    const width = this.vw;
    const height = this.vh;
    const paperW = Math.min(470, width - 50);
    const paperH = Math.min(500, height - 60);
    const cx = width / 2;
    const cy = height / 2;
    this.overlay?.add(makePanel(this, cx, cy, 'paper', paperW, paperH));
    const top = cy - paperH / 2;

    this.overlay?.add(this.add.text(cx, top + 34, t('blessing.title'), {
      fontFamily: FONT, fontSize: '22px', color: '#3b2410',
    }).setOrigin(0.5));
    this.overlay?.add(this.add.text(cx, top + 60, t('blessing.pick'), {
      fontFamily: FONT, fontSize: '11px', color: '#8a5b12',
    }).setOrigin(0.5));
    this.overlay?.add(this.add.text(cx, top + 82,
      t('meta.blessingTokens', { v: loadMetaState().blessingTokens }), {
      fontFamily: FONT, fontSize: '11px', color: '#9a6a08',
    }).setOrigin(0.5));

    const options = rollBlessings(String(Date.now()));
    const rowH = 64;
    const rowW = paperW - 60;
    const tokens = loadMetaState().blessingTokens;
    options.forEach((bid, i) => {
      const def = BLESSINGS.find((b) => b.id === bid);
      if (!def) return;
      const rowCy = top + 108 + i * rowH + rowH / 2;
      const affordable = tokens > 0;
      const g = this.add.graphics();
      g.fillStyle(affordable ? 0xfff6df : 0xefe6d0, 1)
        .fillRoundedRect(cx - rowW / 2, rowCy - rowH / 2 + 4, rowW, rowH - 8, 9);
      g.lineStyle(2, affordable ? 0xc9a25e : 0xbfa77a, 1)
        .strokeRoundedRect(cx - rowW / 2, rowCy - rowH / 2 + 4, rowW, rowH - 8, 9);
      this.overlay?.add(g);
      this.overlay?.add(this.add.text(cx - rowW / 2 + 14, rowCy - 10, this.tr(def.nameKey), {
        fontFamily: FONT, fontSize: '13px', color: affordable ? '#3b2410' : '#8d8577',
      }).setOrigin(0, 0.5));
      this.overlay?.add(this.add.text(cx - rowW / 2 + 14, rowCy + 10, this.tr(def.descKey), {
        fontFamily: FONT, fontSize: '9px', color: '#8a5b12',
      }).setOrigin(0, 0.5));

      const zone = this.add.zone(cx, rowCy, rowW, rowH).setInteractive({ useHandCursor: affordable });
      zone.on('pointerdown', () => {
        if (!affordable) return;
        const st = loadMetaState();
        st.blessingTokens = Math.max(0, st.blessingTokens - 1);
        saveMetaState(st);
        cfg.blessing = bid;
        audio.play('levelup');
        this.closeOverlay();
        go();
      });
      this.overlayExtras.push(zone);
    });

    // «+1 жетон за ролик» (R4) и «Пропустить»
    const footY = top + paperH - 56;
    if (placementAvailable('blessing')) {
      const adBtn = makeButton(this, cx - 98, footY, 184, 44, t('blessing.adToken'), () => {
        void (async () => {
          const res = await showPlacementRewarded('blessing');
          if (res.rewarded && this.overlay) {
            const st = loadMetaState();
            st.blessingTokens += 1;
            saveMetaState(st);
            this.showBlessingOverlay(cfg, go);
          }
        })();
      }, 'red', 10);
      this.overlayExtras.push(adBtn.img, adBtn.txt, adBtn.hit);
    }
    const skip = makeButton(this, cx + 98, footY, 150, 44, t('common.back'), () => {
      this.closeOverlay();
      go();
    }, 'blue', 11);
    this.overlayExtras.push(skip.img, skip.txt, skip.hit);
  }
}
