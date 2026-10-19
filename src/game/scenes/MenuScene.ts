import Phaser from 'phaser';
import { Cursor } from '../systems/Cursor';
import { makeCornerFrame, type CornerFrame } from '../systems/Corners';
import { FONT } from '../constants';
import { HEROES, WEAPONS, PASSIVES, DIFFICULTIES, EVOLUTIONS, type HeroId, type DifficultyId } from '../data';
import { audio } from '../systems/Audio';
import { makePanel, makeButton, makeChip, makeRibbon, fitTextWidth } from '../systems/Ui';
import { shrinkToHeight, FONT_FLOOR, FS } from '../systems/Text';
import { loadShop } from '../shop';
import { ACHIEVEMENTS, loadUnlocked, loadMeta } from '../achievements';
import { t, num, clock, type TranslationKey, type TranslateParams } from '../../i18n';
import { topScores } from '../../platform/leaderboard';
import { notifyReady } from '../../platform/lifecycle';
import { loadText, saveText, removeKey } from '../storage';
import { resetSafeInsets, safeInsets } from '../safeArea';
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

/** Кегль второго слова названия в компактном логотипе. */
const LOGO_SUB = 15;

/**
 * Размер файла портрета в ui/avatars: 256×256, персонаж лежит в рамке HeroDef.portrait.box
 */
const PORTRAIT_SIZE = 256;

/**
 * Глубина оверлеев меню.
 *
 * Логотип игры нарисован с глубиной 1, поэтому оверлеи (рекорды,
 * достижения, «Как играть») должны лежать выше — иначе название игры
 * перекрывало заголовок окна, а затемнение не гасило меню.
 */
const MENU_OVERLAY_DEPTH = 9000;

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
    this.bonusChip = null;
    this.preChipTexts = [null, null, null, null];
    this.consRowEls = [];

    // Мобильная раскладка: контент позиционируется на виртуальном полотне,
    // затем камера уменьшает его до реального размера экрана — ничего не
    // обрезается.
    //
    // Полотно берётся по ВИДИМОЙ области камеры, а не по фиксированным
    // 460×800: на высоком телефоне (390×844) старая сетка оставляла снизу
    // почти 200 пустых виртуальных пикселей, и меню упиралось в логотип.
    // Теперь полотно ровно по экрану, а зум подбирается так, чтобы ширина
    // укладывалась в проектную.
    //
    // На широком экране полотно 1280×720: при 1920×1080 зум камеры
    // становится 1.5, и меню занимает экран целиком, а не жмётся в
    // углу, как раньше.
    const narrow = realW < 760 || realH / realW > 1.15;
    // «Мобильная» раскладка: две колонки карточек, чипы пре-рана в два
    // ряда, кнопки навигации в два ряда.
    const mobile = narrow;
    const designW = narrow ? 460 : 1280;
    const designH = narrow ? 800 : 720;
    this.menuZoom = Math.min(realW / designW, realH / designH);
    this.vw = realW / this.menuZoom;
    this.vh = realH / this.menuZoom;
    // centerOn центрирует виртуальное полотно (с учётом origin 0.5 камеры)
    this.cameras.main.setZoom(this.menuZoom);
    this.cameras.main.centerOn(this.vw / 2, this.vh / 2);
    const width = this.vw;
    const height = this.vh;
    // Меню занимает весь экран, включая зоны выреза и жестовой полосы.
    // Переводим CSS inset в виртуальные координаты, чтобы верхние награды и
    // нижняя навигация оставались нажимаемыми в полноэкранном режиме.
    const insets = safeInsets();
    const safeTop = insets.top / this.menuZoom;
    const safeBottom = insets.bottom / this.menuZoom;
    const safeLeft = insets.left / this.menuZoom;
    const safeRight = insets.right / this.menuZoom;
    const utilityY = safeTop + 28;
    const accountY = mobile ? utilityY + 46 : utilityY;
    // Полотно фона — с запасом, чтобы при зуме < 1 закрыть весь экран.
    // Виртуальное полотно совпадает с видимой областью камеры, поэтому
    // запас нужен только на округление.
    const coverW = this.vw + 240;
    const coverH = this.vh + 240;

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
    // Раскладка считается СНИЗУ ВВЕРХ: строка версии, навигация, кнопка
    // «Играть», ряд пре-рана и чипы сложности прижаты к низу экрана, и
    // только блок карточек с логотипом занимает остаток. Так меню
    // одинаково помещается и на 360×640, и на 1920×1080: раньше нижние
    // кнопки считались от карточек сверху и на невысоких экранах уезжали
    // за край вместе со строкой версии.
    const cols = width < 760 ? 2 : 4;
    const rows = Math.ceil(HERO_ORDER.length / cols);
    const gap = 14;
    const cardW = Math.min(width < 760 ? 205 : 225, (width - 36 - (cols - 1) * gap) / cols);

    // ---- Нижняя группа: считаем снизу вверх ----
    //
    // На телефоне высоты не хватает на четыре секции с воздухом, поэтому
    // кнопки и промежутки там плотнее: на 360×640 иначе карточки героя
    // наезжали на логотип. Тач-гейт (44 px) соблюдается везде.
    const navRows = mobile ? 2 : 1;
    const navH = mobile ? 38 : 42;
    const navGap = 8;
    const navBlockH = navRows * navH + (navRows - 1) * navGap;
    const versionH = 24;
    const playH = mobile ? 52 : 58;
    const diffH = mobile ? 44 : 48;
    const preH = mobile ? 42 * 2 + 10 : 42;
    const gapPlay = mobile ? 14 : 16;
    const gapPre = mobile ? 12 : 14;
    const gapDiff = mobile ? 14 : 18;
    const gapChips = mobile ? 32 : 36;

    const versionY = height - safeBottom - 12;
    const navBottom = versionY - versionH / 2 - 6;
    const navTop = navBottom - navBlockH;
    const playBottom = navTop - gapPlay;
    const playY = playBottom - playH / 2;
    // Ряд пре-рана стоит НАД кнопкой «Играть», поэтому от её низа отступаем
    // на всю высоту кнопки, а не на один зазор.
    const preBottom = playBottom - playH - gapPre;
    const preTop = preBottom - preH;
    const diffBottom = preTop - gapDiff;
    const chipsY = diffBottom - diffH / 2;
    // Зазор до карточек: плашка сложности и рамка выделения карточки —
    // два тёмных контура, и в 26 px они сливались в одну полосу.
    const heroBottom = chipsY - gapChips;

    // ---------- Логотип: два меча с названием ----------
    // Меч разложен на три части, как и в паке: рукоять с гардой и
    // наконечник не тянутся, тянется только ровная часть клинка — в паке
    // она и нарисована длинной пластиной под надпись. Высота меча
    // одинаковая у обоих слов и вдвое больше высоты надписи, длина — по
    // слову: у «СРЕДНЕКОВОЕ» меч длиннее, чем у «ВЫЖИВАНИЕ».
    const TEX = { h: 128, hilt: 88, blade: 128, tip: 45, inset: 12 };
    const FONT_MAX = 40;
    // На телефоне сверху живут чипы дара дня и сундука — логотип начинается
    // ниже них, иначе плашка наезжала на первый меч с названием.
    // На телефоне под логотипом сначала стоит второй ряд утилит: так
    // авторизация не перекрывает мечи и не сталкивается с ежедневными чипами.
    const titleTop = Math.max(mobile ? utilityY + 68 : utilityY + 22, height * 0.05);
    const swordGap = mobile ? 0 : 8;
    // Плашка «выбери героя» стоит между логотипом и карточками, поэтому
    // место под неё резервируется ДО расчёта логотипа: раньше логотип
    // съедал этот зазор, ужимался до нечитаемого кегля и налезал на плашку.
    const heroLabelBand = mobile ? 34 : 56;

    // Обводка — как у надписей на кнопках (systems/Ui.ts) по толщине,
    // обводка белая, а заливка берётся цвета самого меча
    const strokeOf = (size: number): number => Math.max(4, Math.round(size / 4));
    const wordStyle = (size: number, color: string): Phaser.Types.GameObjects.Text.TextStyle => ({
      fontFamily: FONT,
      fontSize: `${size}px`,
      color,
      stroke: '#ffffff',
      strokeThickness: strokeOf(size),
    });

    const top = t('common.titleTop');
    const bottom = t('common.titleBottom');
    // Замеры на живом тексте: ширина и высота строки зависят от шрифта, и
    // выводить их из начертания — значит угадывать.
    //
    // Замер БЕЗ обводки: обводка добавляется к готовой строке одинаковым
    // числом пикселей с каждой стороны и на ширину влияет слабо, а вот в
    // высоту строки вмешивается сильно — и раньше именно из-за этого
    // логотип на телефоне получался вдвое мельче нужного.
    const probe = this.add.text(0, 0, 'M', {
      fontFamily: FONT, fontSize: `${FONT_MAX}px`,
    }).setVisible(false);
    const lineH = probe.height / FONT_MAX;  // высота строки на единицу кегля
    probe.setText(top);
    const kTop = probe.width / FONT_MAX;    // ширина слова на единицу кегля
    probe.setText(bottom);
    const kBottom = probe.width / FONT_MAX;
    probe.destroy();

    // Кегль по размеру самого длинного слова: и длина меча, и его высота
    // линейны по кеглю, поэтому перебор дешёвый и предсказуемый.
    //
    // Порядок расчёта: сначала логотип (с минимальным кеглем, иначе на
    // невысоком экране он превращался в нечитаемую полоску), затем под
    // оставшуюся высоту делят плашка подписи и карточки героя.
    const swordScale = (font: number): number => (2 * lineH * font) / TEX.h;
    const swordWidth = (k: number, font: number): number =>
      k * font + 2 * strokeOf(font) + (TEX.hilt + TEX.tip + 2 * TEX.inset) * swordScale(font);
    const LOGO_MIN = 18;
    const cardsCap = rows * (width < 760 ? 162 : 214) + (rows - 1) * gap;
    const logoRoom = heroBottom - titleTop - heroLabelBand - cardsCap;

    // Компактный вариант логотипа — на невысоких экранах (360×640).
    //
    // Два меча с названием занимают четыре строки кегля. На маленьком экране
    // под них не остаётся места, и логотип ужимался до нечитаемой полоски,
    // а карточки героя наезжали на него. В компакте меч остаётся один, а
    // второе слово становится обычной строкой: логотип узнаётся, высота
    // падает почти вдвое.
    const twoSwordHeight = (font: number): number => 4 * lineH * font + swordGap;
    // Компакт: один меч (две строки кегля) + строка-подпись + поле снизу.
    const oneSwordHeight = (font: number): number => 2 * lineH * font + LOGO_SUB * lineH * 1.5 + 10;
    let logoFont = FONT_MAX;
    let compactLogo = false;
    while (logoFont > LOGO_MIN && (
      twoSwordHeight(logoFont) > logoRoom
      || swordWidth(Math.max(kTop, kBottom), logoFont) > width - 40
    )) logoFont--;
    if (twoSwordHeight(logoFont) > logoRoom) {
      compactLogo = true;
      const subWidth = kBottom * LOGO_SUB;
      logoFont = FONT_MAX;
      while (logoFont > LOGO_MIN && (
        oneSwordHeight(logoFont) > logoRoom
        || swordWidth(kTop, logoFont) > width - 40
        || subWidth > width - 40
      )) logoFont--;
    }

    // Высота карточек: всё, что осталось между подписью и чипами.
    const logoBottom = titleTop + (compactLogo
      ? oneSwordHeight(logoFont)
      : twoSwordHeight(logoFont));
    const cardsTop = logoBottom + heroLabelBand;
    const cardH = Math.round(Phaser.Math.Clamp(
      (heroBottom - cardsTop - (rows - 1) * gap) / rows,
      // Нижняя граница карточки на телефоне намеренно скромная: на 360×640
      // под четыре блока места физически не хватает, и карточка должна
      // ужаться, а не наехать на логотип.
      width < 760 ? 112 : 200,
      width < 760 ? 162 : 214,
    ));
    const blockH = rows * cardH + (rows - 1) * gap;
    const cardsY = Math.min(height * 0.55, heroBottom - blockH / 2);
    const heroTop = cardsY - blockH / 2;

    const scale = swordScale(logoFont);   // вертикальный масштаб меча
    const swordH = TEX.h * scale;
    const hiltW = TEX.hilt * scale;
    const tipW = TEX.tip * scale;
    const cyA = titleTop + swordH / 2;
    // В компакте второй строкой идёт простая подпись, а не второй меч.
    const cyB = compactLogo
      ? titleTop + swordH + LOGO_SUB * lineH * 1.4 + 3
      : titleTop + swordH + swordGap + swordH / 2;

    // Надписи создаются первыми: их ширина задаёт длину клинка. Depth 1 —
    // чтобы клинок, который добавится следом, их не накрыл.
    const txtTop = this.add.text(width / 2, cyA, top, wordStyle(logoFont, '#3c849c'))
      .setOrigin(0.5).setDepth(1);
    const txtBottom = compactLogo
      ? this.add.text(width / 2, cyB, '', wordStyle(LOGO_SUB, '#a85454')).setOrigin(0.5).setDepth(1)
      : this.add.text(width / 2, cyB, bottom, wordStyle(logoFont, '#a85454'))
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
    txtTop.setPosition(width / 2 + bladeCxA, cyA);
    if (compactLogo) {
      txtBottom.setText(bottom);
    } else {
      const bladeCxB = drawSword('sword-red', cyB, txtBottom.width + bladePad, true);
      txtBottom.setPosition(width / 2 + bladeCxB, cyB);
    }

    // Кошелёк в углу — видно мета-золото до захода в лавку;
    // на подложке-пергаменте, чтобы облака не мешали чтению
    const wallet = loadShop().balance;
    if (wallet > 0) {
      const wtxt = num(wallet);
      const chipW = 62 + wtxt.length * 10;
      const chipX = width - 20 - chipW;
      const chipCY = cyA;   // по центру верхнего меча
      const walletChip = makeChip(this, chipX + chipW / 2, chipCY, chipW, 32, '', {
        fontSize: 12,
      });
      // Монета слева, сумма справа — как в игровых счётчиках
      const coin = this.add.image(chipX + 16, chipCY, 'icon-coin').setDisplaySize(18, 18);
      const sum = this.add.text(chipX + 30, chipCY, wtxt, {
        fontFamily: FONT, fontSize: '14px', color: '#7a4e0e',
      }).setOrigin(0, 0.5);
      walletChip.container.add([coin, sum]);
    }

    // ---------- Выбор героя ----------
    // Подсказка выбора героя. Ставится на пергаментную плашку: раньше тёмный
    // текст с кремовой обводкой лежал прямо на траве и читался как
    // светлая полоска, а не как подпись.
    const heroLabelY = logoBottom + heroLabelBand / 2;
    const heroLabel = t('menu.chooseHero');
    const heroLabelH = mobile ? 22 : 26;
    const heroLabelW = Math.min(width - 24, heroLabel.length * 8 + 40);
    const heroLabelBg = makePanel(this, width / 2, heroLabelY, 'paper', heroLabelW, heroLabelH);
    heroLabelBg.setAlpha(0.92).setDepth(2);
    this.add.text(width / 2, heroLabelY, heroLabel, {
      fontFamily: FONT, fontSize: mobile ? '13px' : '14px', color: '#3b2410',
    }).setOrigin(0.5).setAlpha(0.98).setDepth(3);
    if (!mobile) {
      // Подсказка про клавиатуру лежит прямо на траве, поэтому у неё
      // светлый текст с тёмной обводкой, а не тёмный «как на пергаменте»:
      // тёмно-коричневый по зелёной траве почти не читался.
      this.add.text(width / 2, heroLabelY + 22, t('menu.keyboardHint'), {
        fontFamily: FONT, fontSize: '11px', color: '#ffe9c0',
        stroke: '#1b1008', strokeThickness: 3,
      }).setOrigin(0.5).setDepth(3);
    }

    HERO_ORDER.forEach((id, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = width / 2 - (cols * cardW + (cols - 1) * gap) / 2 + col * (cardW + gap) + cardW / 2;
      const y = heroTop + row * (cardH + gap) + cardH / 2;
      this.createHeroCard(x, y, id, cardW, cardH);
    });

    // ---------- Выбор сложности ----------
    const chipW = Math.min(210, (width - 40) / 2);
    DIFF_ORDER.forEach((id, i) => {
      const x = width / 2 + (i === 0 ? -chipW / 2 - 8 : chipW / 2 + 8);
      this.createDiffChip(x, chipsY, chipW, diffH, id);
    });

    // ---------- Пре-ран ряд: контракт / указ / расходники / вызов дня ----------
    this.createPreRow(width, preTop, mobile);

    // ---------- Кнопки ----------
    makeButton(this, width / 2, playY, Math.min(320, width - 80), playH, t('menu.play'), () => {
      this.startSelectedRun();
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
    const navY = navBottom - navH / 2;
    if (mobile) {
      // Два ряда по три: шесть кнопок мета-навигации
      const w3 = Math.min(150, (width - 60 - 24) / 3);
      navItems.slice(0, 3).forEach(([lbl, action], i) => {
        const x = width / 2 - (3 * w3 + 24) / 2 + i * (w3 + 12) + w3 / 2;
        makeButton(this, x, navY, w3, navH, lbl, action, 'red', 12);
      });
      navItems.slice(3).forEach(([lbl, action], i) => {
        const x = width / 2 - (3 * w3 + 24) / 2 + i * (w3 + 12) + w3 / 2;
        makeButton(this, x, navY - navH - navGap, w3, navH, lbl, action, 'red', 12);
      });
    } else {
      const gapN = 8;
      const bw = Math.min(160, (width - 80 - 5 * gapN) / 6);
      navItems.forEach(([lbl, action], i) => {
        const x = width / 2 - (6 * bw + 5 * gapN) / 2 + i * (bw + gapN) + bw / 2;
        makeButton(this, x, navY, bw, navH, lbl, action, 'red', 12);
      });
    }

    // ---------- Вход в аккаунт ----------
    // Общий зал рекордов доступен только авторизованным: setScore требует
    // входа. Площадка запрещает показывать окно входа без повода, поэтому
    // это явная кнопка — и заодно видно, под каким именем игрок записан.
    this.addAccountChip(width, mobile, accountY, safeRight);

    // Чип дара дня (§H.7): виден, пока дар за сегодня не забран.
    // На мобильных прижат к верхнему левому углу, на десктопе — в ряд кошелька.
    if (bonusAvailable()) {
      this.createBonusChip(96 + safeLeft, mobile ? utilityY : cyA);
    }
    // Ежедневный сундук (R7 §J.3): 2 ролика в день — золото/жетоны.
    // Показывается только на Яндексе (rewarded недоступен гостям) и пока
    // лимит дня не исчерпан; встаёт рядом с чипом дара.
    if (rewardedAvailable() && dailyChestLeft() > 0) {
      const chipX = bonusAvailable() ? 262 : 96;
      this.createChestChip(chipX + safeLeft, mobile ? utilityY : cyA);
    }

    this.add.text(width / 2, versionY, t('menu.version'), {
      fontFamily: FONT, fontSize: '12px', color: '#ffe9c0',
      stroke: '#1b1008', strokeThickness: 3,
    }).setOrigin(0.5).setAlpha(0.85);

    this.refreshSelection();
    this.scale.on('resize', this.layout, this);
    const kb = this.input.keyboard;
    const keyBindings: Array<[string, () => void]> = [
      ['keydown-LEFT', () => this.cycleHero(-1)],
      ['keydown-A', () => this.cycleHero(-1)],
      ['keydown-RIGHT', () => this.cycleHero(1)],
      ['keydown-D', () => this.cycleHero(1)],
      ['keydown-ONE', () => this.chooseHeroByIndex(0)],
      ['keydown-TWO', () => this.chooseHeroByIndex(1)],
      ['keydown-THREE', () => this.chooseHeroByIndex(2)],
      ['keydown-FOUR', () => this.chooseHeroByIndex(3)],
      ['keydown-ENTER', () => this.startSelectedRun()],
      ['keydown-SPACE', () => this.startSelectedRun()],
      ['keydown-ESC', () => { if (this.overlay) this.closeOverlay(); }],
    ];
    for (const [event, handler] of keyBindings) kb?.on(event, handler);
    this.events.once('shutdown', () => {
      this.scale.off('resize', this.layout, this);
      for (const [event, handler] of keyBindings) kb?.off(event, handler);
    });

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
  private addAccountChip(width: number, mobile: boolean, y: number, safeRight: number): void {
    if (!isOnYandex()) return;

    const signedIn = isAuthorized();
    const label = signedIn
      ? t('common.signedIn', { v: displayName('') })
      : t('common.signIn');
    const chipW = Math.min(mobile ? 220 : 280, width - safeRight - 40);
    const chipH = 30;
    // Справа от заголовка на широком экране, отдельной строкой под
    // ежедневными чипами на телефоне. Хит-зона оставляет отступ от safe area.
    const chipX = width - safeRight - 20 - chipW / 2;

    makeButton(this, chipX, y, chipW, chipH, label, () => {
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
    const narrow = cardW < 215;
    const portraitSize = Math.min(cardH * (narrow ? 0.30 : 0.36), cardW * 0.58);
    const box = hero.portrait.box;
    const portrait = this.add.image(0, -cardH * 0.29, `avatar-${hero.id}`)
      .setOrigin((box.x + box.w / 2) / PORTRAIT_SIZE, (box.y + box.h / 2) / PORTRAIT_SIZE)
      .setScale(portraitSize / Math.max(box.w, box.h));
    container.add(portrait);

    const name = this.add.text(0, cardH * 0.06, hero.name, {
      fontFamily: FONT, fontSize: narrow ? '16px' : '18px', color: '#3b2410',
    }).setOrigin(0.5);
    fitTextWidth(name, cardW - 24, narrow ? 16 : 18);
    container.add(name);

    const title = this.add.text(0, cardH * 0.185, hero.title, {
      fontFamily: FONT, fontSize: '12px', color: '#8a5b12',
    }).setOrigin(0.5);
    fitTextWidth(title, cardW - 24, 12);
    container.add(title);

    // Черты характера: блок снизу карточки.
    //
    // Сначала пробуем уместить обе характеристики В ОДНУ строку через
    // разделитель («+10% HP · старт: Меч»): на низкой карточке (360×640,
    // где карточка ужимается примерно до 114 px) две строки не влезают даже
    // минимальным кеглем, и нижняя ложилась прямо на рамку пергамента.
    // Если в одну строку не влезает — остаётся список с буллетами.
    const traitFont = narrow ? 12 : 13;
    const probe = this.add.text(0, 0, '', {
      fontFamily: FONT, fontSize: `${traitFont}px`, wordWrap: { width: cardW - 24 },
    }).setVisible(false);
    const joined = hero.traits.join(' · ');
    probe.setText(joined);
    let traitSize = traitFont;
    while (traitSize > FONT_FLOOR && probe.getWrappedText().length > 1) {
      traitSize -= 1;
      probe.setFontSize(`${traitSize}px`);
    }
    const traitsFitOneLine = probe.getWrappedText().length === 1;
    probe.destroy();
    const traits = traitsFitOneLine ? joined : hero.traits.map((tr) => `• ${tr}`).join('\n');
    const bodyTop = traitsFitOneLine ? cardH * 0.28 : cardH * 0.26;
    const bodyRoom = cardH / 2 - bodyTop - 4;
    const body = this.add.text(0, bodyTop, traits, {
      fontFamily: FONT, fontSize: `${traitSize}px`, color: '#4a3517',
      align: 'center', lineSpacing: narrow ? 1 : 3, wordWrap: { width: cardW - 24 },
    }).setOrigin(0.5, 0);
    // Минимум здесь — FONT_FLOOR, а не FS.micro: на самых низких карточках
    // блок из двух строк иначе не помещался даже при 11 px.
    shrinkToHeight(body, bodyRoom, traitSize, FONT_FLOOR);
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

    // Подписи чипа ужимаются под его ширину: длинный слоган «Кошмар»
    // («урна, ожерелье, они ×1.5») иначе обрезался краем пергамента.
    //
    // Слоган держим В ОДНОЙ строке: кегль уменьшается, а не переносится.
    // С переносом «классическое приключение» разбивалось на две строки,
    // третья уезжала за нижний край плашки, и на телефоне подпись
    // превращалась в лесенку поверх рамки выделения.
    const textW = w - 44;
    const nameY = -h * 0.22;
    const name = this.add.text(-w / 2 + 34, nameY, def.name.toUpperCase(), {
      fontFamily: FONT, fontSize: '13px', color: isNightmare ? '#7a1010' : '#3b2410',
    }).setOrigin(0, 0.5);
    fitTextWidth(name, textW, 13);
    container.add(name);

    const tagY = h * 0.16;
    const tag = this.add.text(-w / 2 + 34, tagY, def.tagline, {
      fontFamily: FONT, fontSize: '12px', color: '#8a5b12',
    }).setOrigin(0, 0.5);
    fitTextWidth(tag, textW, 12);
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

  /** Клавиатура: A/D или стрелки меняют героя, 1–4 выбирают напрямую. */
  private cycleHero(direction: -1 | 1): void {
    if (!this.canHandleMenuInput()) return;
    const current = HERO_ORDER.indexOf(this.selectedHero);
    const next = (current + direction + HERO_ORDER.length) % HERO_ORDER.length;
    this.chooseHeroByIndex(next);
  }

  private chooseHeroByIndex(index: number): void {
    if (!this.canHandleMenuInput()) return;
    const heroId = HERO_ORDER[index];
    if (!heroId || heroId === this.selectedHero) return;
    audio.play('click');
    this.selectHero(heroId);
  }

  private canHandleMenuInput(): boolean {
    return !this.overlay && !this.scene.isActive('Shop') && !this.scene.isActive('Meta');
  }

  private startSelectedRun(): void {
    if (!this.canHandleMenuInput()) return;
    audio.unlock();
    saveText('tss-hero', this.selectedHero);
    saveText('tss-diff', this.selectedDiff);
    this.startRun();
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
    resetSafeInsets();
    this.scene.restart();
  }

  // ================================================================
  // Общий каркас оверлеев (затемнение + блокировщик кликов)
  // ================================================================

  /**
   * Добавляет объект поверх оверлея.
   *
   * Оверлеи лежат в контейнере с глубиной MENU_OVERLAY_DEPTH, а кнопки и
   * зоны клика создаются прямо в сцене — без глубины они оказывались
   * ПОД логотипом меню (тот нарисован с глубиной 1) и поверх пергамента
   * оверлея: логотип «СРЕДНЕВЕКОВОЕ ВЫЖИВАНИЕ» перекрывал заголовок
   * «ЗАЛ СЛАВЫ», а кнопка «НАЗАД» проваливалась под панель.
   */
  private addExtra<T extends Phaser.GameObjects.GameObject>(obj: T): T {
    const withDepth = obj as unknown as { setDepth(d: number): Phaser.GameObjects.GameObject };
    withDepth.setDepth(MENU_OVERLAY_DEPTH + 1);
    this.overlayExtras.push(obj);
    return obj;
  }

  private beginOverlay(): void {
    this.closeOverlay();
    const width = this.vw;
    const height = this.vh;
    const cover = Math.max(width / this.menuZoom, height / this.menuZoom) + 160;
    this.overlay = this.add.container(0, 0).setDepth(MENU_OVERLAY_DEPTH);
    const dim = this.add.rectangle(width / 2, height / 2, cover, cover, 0x0a0a12, 0.88);
    this.overlay.add(dim);
    // Блокировщик: меню под оверлеем не должно реагировать на клики
    const blocker = this.add.rectangle(width / 2, height / 2, cover, cover, 0x000000, 0.001)
      .setInteractive({ useHandCursor: false });
    this.addExtra(blocker);
  }

  private backButton(y?: number): void {
    const width = this.vw;
    const height = this.vh;
    const by = Math.min(y ?? height / 2 + Math.min(300, height * 0.36), height - 38);
    const b = makeButton(this, width / 2, by, 170, 54, t('common.back'), () => this.closeOverlay(), 'red', 16);
    this.addExtra(b.img);
    this.addExtra(b.txt);
    this.addExtra(b.hit);
  }

  /**
   * Высота шапки оверлея (лента + отступы) — теми же величинами, что рисует
   * `overlayTitle`. Нужна там, где панель обтягивается вокруг контента:
   * сначала меряем блоки, потом решаем, сколько пергамента нужно.
   */
  private overlayTitleHeight(): number {
    const font = Phaser.Math.Clamp(Math.round(this.vw * 0.036), 20, 28);
    return Math.round(font * 1.55) + 30;
  }

  /**
   * Заголовок оверлея на ленте из пака.
   *
   * Восемь окон меню подписывались голым текстом прямо на пергаменте, а
   * «Лавка», «Хроника», пауза, LevelUp и преемственность держались на ленте.
   * Из-за этого оверлеи меню читались как черновики, а не как готовая
   * игра. Здесь один общий помощник — и все окна выглядят одинаково.
   *
   * @param top верх пергаментной панели
   * @param variant цвет ленты: у нейтральных окон красный, у наград — жёлтый
   */
  private overlayTitle(
    top: number,
    label: string,
    variant: 'red' | 'yellow' | 'blue' = 'red',
  ): number {
    const width = this.vw;
    const font = Phaser.Math.Clamp(Math.round(this.vw * 0.036), 20, 28);
    const ribbonH = Math.round(font * 1.55);
    const y = top + ribbonH / 2 + 14;
    // Всё обязано попасть В контейнер оверлея: объекты, созданные через
    // this.add(), лежат на глубине 0 и оказываются под логотипом меню и под
    // затемнением — лента выцветала, а пергамент уезжал под логотип.
    const ribbon = makeRibbon(this, width / 2, y,
      Math.min(width - 40, label.length * font * 0.62 + 90),
      `ribbon-${variant}` as const, ribbonH);
    const title = this.add.text(width / 2, y, label, {
      fontFamily: FONT, fontSize: `${font}px`, color: '#ffe9c0',
      stroke: '#1b1008', strokeThickness: Math.max(4, Math.round(font / 5)),
    }).setOrigin(0.5);
    this.overlay?.add([ribbon, title]);
    // Нижняя граница шапки — от неё дальше раскладывается содержимое.
    return top + ribbonH + 30;
  }

  private closeOverlay(): void {
    this.overlay?.destroy(true);
    this.overlay = null;
    for (const o of this.overlayExtras) o.destroy();
    this.overlayExtras = [];
    for (const r of this.shopRowEls) r.destroy(true);
    this.shopRowEls = [];
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
    const innerW = paperW - 56;

    // ---------- Проход 1: измерение ----------
    // Высота пергамента считается ПОСЛЕ того, как известна высота текста.
    // Раньше панель бралась из `paperW * 1.24`, и на телефоне (виртуальное
    // полотно 460 px, а текст переносится в три-четыре строки) рецепты
    // эволюций вылезали за нижний край пергамента и подрезались кнопкой
    // «Назад». Теперь контент меряется первым, панель обтягивается вокруг
    // него, а лишние строки рецептов просто не рисуются.
    const lines = [
      t('howto.hero'),
      t('howto.move'),
      '',
      t('howto.auto'),
      t('howto.loot'),
    ];
    const body = this.add.text(width / 2, 0, lines.join('\n'), {
      fontFamily: FONT, fontSize: '14px', color: '#57431f', align: 'center', lineSpacing: 6,
      wordWrap: { width: innerW },
    }).setOrigin(0.5, 0);

    const footer = this.add.text(width / 2, 0, [
      t('howto.goal1'),
      t('howto.goal2'),
      t('howto.goal3'),
    ].join('\n'), {
      fontFamily: FONT, fontSize: '13px', color: '#57431f', align: 'center', lineSpacing: 6,
      wordWrap: { width: innerW },
    }).setOrigin(0.5, 0);

    const headH = this.overlayTitleHeight();
    const evoBlockH = 50;              // заголовок раздела + подпись под ним
    const recipeGap = 26;
    const evoTop = headH + body.height + 18;
    const recipeTop = evoTop + evoBlockH;
    const maxH = Math.max(240, height - 40);

    // Сколько строк рецептов влезает между началом списка и подвалом.
    const roomForRecipes = maxH - (recipeTop + 14 + footer.height + 24);
    const recipeCap = Math.max(0, Math.floor(roomForRecipes / recipeGap));
    const showEvo = recipeCap >= 2;
    const shownEvos = showEvo
      ? Object.values(EVOLUTIONS).slice(0, Math.min(recipeCap, Object.keys(EVOLUTIONS).length))
      : [];

    const usedH = (showEvo ? recipeTop + shownEvos.length * recipeGap + 14 : evoTop + 20)
      + footer.height + 24;
    const paperH = Math.min(maxH, Math.max(280, usedH));
    const top = (height - paperH) / 2;

    // ---------- Проход 2: отрисовка ----------
    const paper = makePanel(this, width / 2, height / 2, 'paper', paperW, paperH);
    // Пергамент уходит в контейнер оверлея ПЕРВЫМ: порядок добавления — это
    // порядок отрисовки. Если добавить панель после ленты, она накроет и
    // заголовок, и ленту.
    this.overlay?.add(paper);
    this.overlayTitle(top, t('howto.title'), 'blue');

    body.setY(top + headH);
    this.overlay?.add(body);

    if (showEvo) {
      const evoTitleY = top + evoTop;
      const evoTitle = this.add.text(width / 2, evoTitleY, t('howto.evoTitle'), {
        fontFamily: FONT, fontSize: '16px', color: '#9a6a08',
      }).setOrigin(0.5);
      const evoHint = this.add.text(width / 2, evoTitleY + 22, t('howto.evoRecipe'), {
        fontFamily: FONT, fontSize: '12px', color: '#8a5b12',
      }).setOrigin(0.5);
      this.overlay?.add([evoTitle, evoHint]);

      const recipeY0 = top + recipeTop;
      shownEvos.forEach((evo, i) => {
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
        fontFamily: FONT, fontSize: '12px', color: '#57431f',
      }).setOrigin(0, 0.5);
      fitTextWidth(wName, wColW, 11, 8);
      const plus = this.add.text(plusX, y, '+', {
        fontFamily: FONT, fontSize: '12px', color: '#8a5b12',
      }).setOrigin(0.5);
      const pIcon = this.add.image(pIconX + iconW / 2, y, PASSIVES[evo.partner].icon)
        .setDisplaySize(iconW, iconW);
      const pName = this.add.text(pTextX, y, PASSIVES[evo.partner].name, {
        fontFamily: FONT, fontSize: '12px', color: '#57431f',
      }).setOrigin(0, 0.5);
      fitTextWidth(pName, pColW, 11, 8);
      const arrow = this.add.text(arrowX, y, '→', {
        fontFamily: FONT, fontSize: '12px', color: '#9a6a08',
      }).setOrigin(0.5);
      const evoName = this.add.text(evoX, y, `★ ${evo.name}`, {
        fontFamily: FONT, fontSize: '12px', color: '#9a6a08',
        stroke: '#f7e7c3', strokeThickness: 2,
      }).setOrigin(0, 0.5);
      fitTextWidth(evoName, evoColW, 11, 8);
      this.overlay?.add([wIcon, wName, plus, pIcon, pName, arrow, evoName]);
      });
    }

    footer.setY(top + (showEvo ? recipeTop + shownEvos.length * recipeGap + 14 : evoTop + 20));
    this.overlay?.add(footer);
    // Кнопка — ПОД пергаментом, а не поверх него. Раньше её Y считался от
    // центра экрана, и на телефоне (где панель высокая) она ложилась прямо
    // на подвал с правилами, обрезая последнюю строку.
    this.backButton(Math.min(height - 38, top + paperH + 38));
  }

  // ================================================================
  // «Рекорды» — таблица из /api/scores
  // ================================================================

  private async showRecords(): Promise<void> {
    this.beginOverlay();
    const width = this.vw;
    const height = this.vh;
    const container = this.add.container(0, 0).setDepth(MENU_OVERLAY_DEPTH);
    // Переносим затемнение из каркасного контейнера в новый (для guard-проверки active)
    this.overlay?.destroy(true);
    this.overlay = container;
    const cover = Math.max(width / this.menuZoom, height / this.menuZoom) + 160;
    const dim = this.add.rectangle(width / 2, height / 2, cover, cover, 0x0a0a12, 0.88);
    container.add(dim);

    const paperW = Math.min(600, width - 50);
    const paperH = Math.min(470, height - 60);
    // Подвал: подсказка об источнике + формула подсчёта очков.
    // Строки таблицы не должны заезжать на него — считаем вместимость.
    const footerTop = top_ => top_ + paperH - 92;
    const rowsTop = top_ => top_ + this.overlayTitleHeight() + 34;
    const rowCapFor = (t: number): number =>
      Math.max(3, Math.floor((footerTop(t) - rowsTop(t) - 8) / 26));
    const cx = width / 2;
    const cy = height / 2;
    // Пергамент — тот же кремовый, что у остальных окон меню.
    //
    // Раньше здесь стоял «особый пергамент» — тёмно-синий лист с золотыми
    // уголками, единственное тёмное пятно во всём интерфейсе. Таблица
    // рекордов выглядела как вклеенная выписка из чужого документа, а
    // текст на ней приходилось писать светлым по тёмному — в остальных
    // окнах он тёмный по кремовому.
    const paper = makePanel(this, cx, cy, 'paper', paperW, paperH);
    container.add(paper);
    const top = cy - paperH / 2;
    const footerTopAbs = footerTop(top);
    const rowsTopAbs = rowsTop(top);
    const rowCap = rowCapFor(top);

    // Заголовок — на ленте, как у «Достижений» и «Хроники»
    const headerBottom = this.overlayTitle(top, t('records.title'), 'yellow');

    const loading = this.add.text(cx, headerBottom + 40, t('records.loading'), {
      fontFamily: FONT, fontSize: '15px', color: '#8a6d3b',
    }).setOrigin(0.5);
    container.add(loading);

    // Колонки таблицы
    const left = cx - paperW / 2 + 30;
    const right = cx + paperW / 2 - 30;
    const colName = left + 28;
    const colScore = right - 92;
    const colKills = right - 40;

    const headerStyle: Phaser.Types.GameObjects.Text.TextStyle = {
      fontFamily: FONT, fontSize: '12px', color: '#8a6d3b',
    };
    const headerY = headerBottom + 22;
    container.add(this.add.text(left, headerY, '#', { ...headerStyle }).setOrigin(0, 0.5));
    container.add(this.add.text(colName, headerY, t('records.colHero'), { ...headerStyle }).setOrigin(0, 0.5));
    container.add(this.add.text(colScore, headerY, t('records.colScore'), { ...headerStyle }).setOrigin(1, 0.5));
    container.add(this.add.text(colKills, headerY, t('records.colKills'), { ...headerStyle }).setOrigin(1, 0.5));
    container.add(this.add.text(right, headerY, t('records.colTime'), { ...headerStyle }).setOrigin(1, 0.5));
    const hr = this.add.graphics();
    hr.lineStyle(1, 0xc9a25e, 0.9).lineBetween(left, headerY + 14, right, headerY + 14);
    container.add(hr);

    // ---------- Фильтр: все заезды / только победы ----------
    // Чипы — из того же пергамента, что и остальные окна. Раньше это были
    // тёмные прямоугольники: единственное место, где материал интерфейса
    // менялся на глазах у игрока.
    const chipY = headerBottom - 4;
    const chipW = 110;
    const chipH = 28;
    const chips: Array<{ key: 'all' | 'win'; label: string }> = [
      { key: 'all', label: t('records.filterAll') },
      { key: 'win', label: t('records.filterWins') },
    ];
    const chipEls: Array<{ bg: Phaser.GameObjects.NineSlice; txt: Phaser.GameObjects.Text }> = [];
    chips.forEach((c, i) => {
      const x = cx + (i === 0 ? -chipW - 10 : 10) + chipW / 2;
      const active0 = this.recordsFilter === c.key;
      const bg = makePanel(this, x, chipY, 'paper', chipW, chipH);
      bg.setTint(active0 ? 0xffe9a0 : 0xffffff);
      const txt = this.add.text(x, chipY, c.label, {
        fontFamily: FONT, fontSize: '12px', color: active0 ? '#7a4e0e' : '#8a6d3b',
      }).setOrigin(0.5);
      const hit = this.add.zone(x, chipY, chipW + 8, 34).setInteractive({ useHandCursor: true });
      hit.on('pointerdown', () => {
        if (this.recordsFilter === c.key) return;
        audio.play('click');
        this.recordsFilter = c.key;
        this.renderRecords(container, left, right, colName, colScore, colKills, rowsTopAbs, rowCap);
        // Перекрасить чипы
        chipEls.forEach((els, j) => {
          const active = this.recordsFilter === chips[j].key;
          els.txt.setColor(active ? '#7a4e0e' : '#8a6d3b');
          els.bg.setTint(active ? 0xffe9a0 : 0xffffff);
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
      fontFamily: FONT, fontSize: '12px', color: '#8a6d3b', align: 'center',
      wordWrap: { width: paperW - 60 },
    }).setOrigin(0.5).setScrollFactor(0));

    container.add(this.add.text(cx, footerTopAbs + 34, [
      t('records.formula1'),
      t('records.formula2'),
    ].join('\n'), {
      fontFamily: FONT, fontSize: '12px', color: '#8a6d3b', align: 'center', lineSpacing: 6,
      wordWrap: { width: paperW - 60 },
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
        fontFamily: FONT, fontSize: '15px', color: '#8a6d3b', align: 'center', lineSpacing: 8,
      }).setOrigin(0.5);
      container.add(empty);
      this.recordsListEls.push(empty);
      return;
    }
    // Палитра строк — как на остальных пергаментах: тёмно-коричневый
    // текст, золото для первого места и очков.
    const style: Phaser.Types.GameObjects.Text.TextStyle = {
      fontFamily: FONT, fontSize: '13px', color: '#3b2410',
    };
    // Имя занимает всё свободное место до колонки «СЧЁТ»
    const nameMaxW = Math.max(60, colScore - colName - 30);
    // Если строк больше, чем помещается, показываем верхние и считаем остальные
    const shownRows = rows.slice(0, rowCap);
    shownRows.forEach((r, i) => {
      const y = rowsTop + i * 26;
      // Медали эмодзи в пиксельном шрифте не рисуются — вместо них номер
      // в рамке, и он одинаково читается в любой локали.
      const medal = `${i + 1}.`;
      // Длинные имена ужимаем под колонку, а не обрезаем по 13 символов
      const nameText = this.add.text(colName, y, `${r.name}${r.victory ? ' ★' : ''}`, {
        ...style, color: i === 0 ? '#9a6a08' : '#3b2410',
      }).setOrigin(0, 0.5);
      fitTextWidth(nameText, nameMaxW, 13);
      const els: Phaser.GameObjects.GameObject[] = [
        this.add.text(left, y, medal, {
          ...style, color: i < 3 ? '#9a6a08' : '#8a6d3b',
        }).setOrigin(0, 0.5),
        nameText,
        this.add.text(colScore, y, num(r.score), {
          ...style, color: '#9a6a08',
        }).setOrigin(1, 0.5),
        this.add.text(colKills, y, `${r.kills}`, { ...style }).setOrigin(1, 0.5),
      ];
      els.push(this.add.text(right, y, clock(r.timeSurvived), { ...style }).setOrigin(1, 0.5));
      container.add(els);
      this.recordsListEls.push(...els);
    });
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

    const head = this.overlayTitle(top, t('ach.title'), 'yellow');
    this.overlay?.add(this.add.text(cx, head, `${count} / ${total}`, {
      fontFamily: FONT, fontSize: '15px', color: '#8a5b12',
    }).setOrigin(0.5));

    // Полоса прогресса
    const barW = paperW - 130;
    const bar = this.add.graphics();
    bar.fillStyle(0x3b2a1a, 1).fillRoundedRect(cx - barW / 2, head + 18, barW, 12, 6);
    if (count > 0) {
      bar.fillStyle(0xd9a520, 1).fillRoundedRect(cx - barW / 2 + 2, head + 20, Math.max(8, (barW - 4) * (count / total)), 8, 4);
    }
    this.overlay?.add(bar);

    // Сетка: число колонок подбирается под ширину, высота ячейки — под
    // оставшуюся высоту пергамента. До правки сетка жёстко была 3×3 при
    // 12 достижениях, то есть 4 ряда, и нижний ряд ложился на подсказку.
    const cellGap = 12;
    const cols = paperW >= 560 ? 4 : 3;
    const rows = Math.ceil(ACHIEVEMENTS.length / cols);
    const gridTop = head + 48;
    const hintH = 30;
    const footerH = ACHIEVEMENTS.length > 0 && unlocked.size === ACHIEVEMENTS.length ? 30 : 0;
    const gridRoom = top + paperH - gridTop - hintH - footerH - 14;
    const cellH = Math.max(64, Math.min(104, (gridRoom - (rows - 1) * cellGap) / rows));
    const cellW = (paperW - 56 - (cols - 1) * cellGap) / cols;

    // Подсказка стоит ВНУТРИ пергамента: раньше она ставилась на самый
    // нижний край панели и на телефоне обрезалась краем.
    this.achDesc = this.add.text(cx, top + paperH - hintH / 2 - 4, t('ach.hint'), {
      fontFamily: FONT, fontSize: '12px', color: '#57431f', align: 'center',
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

      // Название достижения. Кегль не ниже FS.micro: на 9 px «Церем кровь»
      // и «Кузнец судьбы» читались как серые пятна, а не как названия.
      const achFont = FS.micro;
      const iconSize = Math.max(20, Math.min(30, cellH * 0.28));
      const icon = this.add.image(0, -cellH * 0.26, a.icon).setDisplaySize(iconSize, iconSize);
      if (!has) icon.setTint(0x8d8577);
      cell.add(icon);

      const achText = this.add.text(0, cellH * 0.06, a.name, {
        fontFamily: FONT, fontSize: `${achFont}px`,
        color: has ? '#3b2410' : '#8d8577', align: 'center',
        wordWrap: { width: cellW - 12 }, lineSpacing: 2,
      }).setOrigin(0.5);
      // Две строки максимум, дальше кегль ужимается до порога читаемости.
      shrinkToHeight(achText, cellH * 0.46, achFont, FONT_FLOOR);
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
      this.addExtra(cell);
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

    const head = this.overlayTitle(top, t('chron.title'), 'yellow');

    if (meta.matches === 0 && meta.kills === 0) {
      this.overlay?.add(this.add.text(cx, cy + 10, [
        t('chron.empty1'),
        t('chron.empty2'),
        t('chron.empty3'),
      ].join('\n'), {
        fontFamily: FONT, fontSize: '14px', color: '#57431f', align: 'center', lineSpacing: 10,
        wordWrap: { width: paperW - 60 },
      }).setOrigin(0.5));
    } else {
      const winRate = meta.matches > 0 ? Math.round((meta.victories / meta.matches) * 100) : 0;
      if (meta.matches > 0) {
        const chip = this.add.graphics();
        chip.fillStyle(0xdff0d8, 1).fillRoundedRect(cx - 74, head, 148, 26, 13);
        chip.lineStyle(2, 0x5b8a51, 1).strokeRoundedRect(cx - 74, head, 148, 26, 13);
        this.overlay?.add(chip);
        this.overlay?.add(this.add.text(cx, head + 13, t('chron.winRate', { v: winRate }), {
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
          fontFamily: FONT, fontSize: '12px', color: '#8a5b12',
        }).setOrigin(0.5));
        this.overlay?.add(this.add.text(x, y + 9, val, {
          fontFamily: FONT, fontSize: '17px', color: '#3b2410',
        }).setOrigin(0.5));
      });

      this.overlay?.add(this.add.text(cx, top + paperH - 26, t('chron.footer'), {
        fontFamily: FONT, fontSize: '12px', color: '#8a5b12',
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
    const chip = makeChip(this, x, y, 150, 40, t('bonus.title'), {
      fontSize: 12,
      subFontSize: 11,
      sub: t('bonus.streak', { v: streak }),
    });
    // Хит-зона 156×48 ≥ MIN_TOUCH: сама плашка 150×40 чуть меньше тач-гейта
    chip.container.setSize(156, 48);
    chip.container.setInteractive({ useHandCursor: true });
    chip.container.on('pointerdown', () => {
      audio.play('click');
      this.showBonusOverlay();
    });
    this.tweens.add({
      targets: chip.container, scale: { from: 1, to: 1.06 }, duration: 850, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    });
    this.bonusChip = chip.container;
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
    const chip = makeChip(this, x, y, 160, 40, t('chest.title'), {
      fontSize: 12,
      subFontSize: 11,
      sub: t('chest.left', { v: left }),
    });
    chip.container.setSize(166, 48); // ≥ MIN_TOUCH с учётом полей (§I.6)
    chip.container.setInteractive({ useHandCursor: true });
    chip.container.on('pointerdown', () => {
      audio.play('click');
      void this.openDailyChest();
    });
    this.tweens.add({
      targets: chip.container, scale: { from: 1, to: 1.05 }, duration: 1000, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    });
    this.chestChip = chip.container;
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

  /**
   * Ряд из четырёх чипов пре-рана под чипами сложности.
   *
   * На телефоне четыре чипа в один ряд не помещаются: подписи вроде
   * «Контракт: Без контракта» в 90 px превращались в кашу. Поэтому на
   * узком экране чипы раскладываются в два ряда по два, и подпись получает
   * вдвое больше места.
   *
   * ⚠️ `preTop` — это ВЕРХ блока, а не его середина: строки раскладываются
   * от него вниз. Раньше считалось от середины, и второй ряд уезжал под
   * кнопку «Играть» — на телефоне она закрывала половину плашек.
   */
  private createPreRow(width: number, preTop: number, mobile: boolean): number {
    const gap = 10;
    const perRow = mobile ? 2 : 4;
    const chipW = Math.min(mobile ? 200 : 190, (width - 24 - (perRow - 1) * gap) / perRow);
    this.preChipW = chipW;
    // Кегль подписи чипа: на телефоне строка должна оставаться читаемой,
    // поэтому 12 px, а не 8 — раньше подпись превращалась в кашу.
    this.preChipFont = 12;
    // Высота плашки держит ДВЕ строки подписи. Длинные подписи
    // («Откроется после 3 го матча») в одну строку не влезали и вылезали
    // за верхний край чипа.
    const chipH = mobile ? 42 : 42;
    const rowH = chipH + gap;

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
      const col = i % perRow;
      const row = Math.floor(i / perRow);
      const x = width / 2 - (perRow * chipW + (perRow - 1) * gap) / 2 + col * (chipW + gap) + chipW / 2;
      const y = preTop + row * rowH + chipH / 2;
      const chip = makeChip(this, x, y, chipW, chipH, c.label, {
        fontSize: this.preChipFont,
        disabled: !c.enabled,
      });
      chip.container.setSize(chipW + 8, chipH + 6);
      chip.container.setInteractive({ useHandCursor: c.enabled });
      chip.container.on('pointerdown', () => {
        if (!c.enabled) return;
        audio.play('click');
        c.action();
      });
      this.preChipTexts[i] = chip.container.list[1] as Phaser.GameObjects.Text;
    });

    return Math.ceil(chips.length / perRow) * rowH - gap;
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
      fitTextWidth(txt, this.preChipW - 14, this.preChipFont);
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

    const head = this.overlayTitle(top, t('contract.title'), 'red');

    const rowW = paperW - 48;
    const rowsTop = head - 12;

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
        fontFamily: FONT, fontSize: '12px', color: '#8a5b12',
      }).setOrigin(0, 0.5));
      this.overlay?.add(this.add.text(cx + rowW / 2 - 14, rowCy, mult, {
        fontFamily: FONT, fontSize: '12px', color: '#9a6a08',
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
      this.addExtra(zone);
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

    const head = this.overlayTitle(top, t('ukaz.title'), 'red');

    const id = loadText('tss-ukaz-pick');
    const order = ORDERS.find((o) => o.id === id);
    this.overlay?.add(this.add.text(cx, head + 18, t('ukaz.pick', {
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
        fontFamily: FONT, fontSize: '12px', color: '#8a5b12', align: 'center',
        wordWrap: { width: paperW - 60 },
      }).setOrigin(0.5));
    }

    const open = makeButton(this, cx, top + paperH - 74, 190, 44, t('meta.tab'), () => {
      this.closeOverlay();
      this.openOverlayScene('Meta');
    }, 'blue', 12);
    this.addExtra(open.img); this.addExtra(open.txt); this.addExtra(open.hit);

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
      fontFamily: FONT, fontSize: '12px', color: '#8a5b12',
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
        fontFamily: FONT, fontSize: '12px', color: '#8a5b12',
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

    const head = this.overlayTitle(top, t('challenge.title'), 'red');
    this.overlay?.add(this.add.text(cx, head, t('challenge.mods'), {
      fontFamily: FONT, fontSize: '12px', color: '#8a5b12',
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
        fontFamily: FONT, fontSize: '12px', color: '#57431f', align: 'center',
        wordWrap: { width: paperW - 70 },
      }).setOrigin(0.5));
    });

    this.overlay?.add(this.add.text(cx, top + 232, t('challenge.reward'), {
      fontFamily: FONT, fontSize: '12px', color: '#8a5b12', align: 'center',
    }).setOrigin(0.5));
    if (challengeVictoryToday()) {
      this.overlay?.add(this.add.text(cx, top + 252, t('challenge.done'), {
        fontFamily: FONT, fontSize: '12px', color: '#2e7d32',
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
      this.addExtra(reroll.img); this.addExtra(reroll.txt); this.addExtra(reroll.hit);
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
      track('challenge_start', { mods: ch.mods, rerolled: salt !== '' });
      this.scene.start('Game', { hero: this.selectedHero, diff: this.selectedDiff });
    }, 'blue', 12);
    this.addExtra(start.img); this.addExtra(start.txt); this.addExtra(start.hit);

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
      fontFamily: FONT, fontSize: '12px', color: '#8a5b12',
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
    this.addExtra(claim.img); this.addExtra(claim.txt); this.addExtra(claim.hit);
    if (placementAvailable('bonus-x2')) {
      const x2 = makeButton(this, cx + 90, btnY, 160, 48, t('bonus.claimX2'), () => {
        void this.claimBonusWithAd();
      }, 'red', 13);
      this.addExtra(x2.img); this.addExtra(x2.txt); this.addExtra(x2.hit);
    }

    this.backButton(top + paperH + 42);
  }

  private claimBonus(doubled: boolean): void {
    const res = claimDailyBonus(doubled);
    if (res.ok) {
      track('daily_claim', { day: res.day, doubled });
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
      fontFamily: FONT, fontSize: '12px', color: '#8a5b12',
    }).setOrigin(0.5));
    this.overlay?.add(this.add.text(cx, top + 82,
      t('meta.blessingTokens', { v: loadMetaState().blessingTokens }), {
      fontFamily: FONT, fontSize: '12px', color: '#9a6a08',
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
        fontFamily: FONT, fontSize: '12px', color: '#8a5b12',
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
      this.addExtra(zone);
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
      this.addExtra(adBtn.img); this.addExtra(adBtn.txt); this.addExtra(adBtn.hit);
    }
    const skip = makeButton(this, cx + 98, footY, 150, 44, t('common.back'), () => {
      this.closeOverlay();
      go();
    }, 'blue', 11);
    this.addExtra(skip.img); this.addExtra(skip.txt); this.addExtra(skip.hit);
  }
}
