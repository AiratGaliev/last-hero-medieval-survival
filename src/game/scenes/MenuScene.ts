import Phaser from 'phaser';
import { Cursor } from '../systems/Cursor';
import { makeCornerFrame, type CornerFrame } from '../systems/Corners';
import { FONT } from '../constants';
import { HEROES, WEAPONS, PASSIVES, DIFFICULTIES, EVOLUTIONS, type HeroId, type DifficultyId } from '../data';
import { audio } from '../systems/Audio';
import { makePanel, makeButton, fitTextWidth } from '../systems/Ui';
import { loadShop, buyUpgrade, SHOP_UPGRADES } from '../shop';
import { ACHIEVEMENTS, loadUnlocked, loadMeta } from '../achievements';
import { t, num, clock } from '../../i18n';
import { topScores } from '../../platform/leaderboard';
import { notifyReady } from '../../platform/lifecycle';
import { loadText, saveText } from '../storage';
import { isAuthorized, offerAuth, displayName } from '../../platform/player';
import { isOnYandex } from '../../platform/sdk';

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
    this.add.tileSprite(width / 2, height / 2, coverW, coverH, 'grass-tile');
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
    const pawn = this.add.sprite(width * 0.9, height * 0.92, 'grunt-idle').setScale(0.45).setAlpha(0.9);
    pawn.play('grunt-idle');
    void sheep; void pawn;

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
    const cardH = width < 760 ? 160 : 214;
    const blockH = rows * cardH + (rows - 1) * gap;
    // От низа карточек до низа экрана: 34 до чипов сложности, 34 + 58 до
    // кнопки «Играть», дальше навигация (на мобильных она в два ряда).
    const navStack = mobile ? 34 + 58 + 90 : 34 + 58 + 44;
    const maxCardsY = height - 18 - navStack - 64 - blockH / 2;
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
    const chipsY = heroBottom + 34;
    const chipW = Math.min(200, (width - 90) / 2);
    DIFF_ORDER.forEach((id, i) => {
      const x = width / 2 + (i === 0 ? -chipW / 2 - 8 : chipW / 2 + 8);
      this.createDiffChip(x, chipsY, chipW, 40, id);
    });

    // ---------- Кнопки ----------
    const btnY = Math.min(height * 0.85, chipsY + 34 + 30);
    makeButton(this, width / 2, btnY, Math.min(320, width - 80), 58, t('menu.play'), () => {
      audio.unlock();
      saveText('tss-hero', this.selectedHero);
      saveText('tss-diff', this.selectedDiff);
      this.scene.start('Game', { hero: this.selectedHero, diff: this.selectedDiff });
    }, 'blue', mobile ? 20 : 24);

    // Навигация по мета-экранам — всё внутри Phaser
    const navItems: Array<[string, () => void]> = [
      [t('menu.howTo'), () => this.showHowTo()],
      [t('menu.records'), () => { void this.showRecords(); }],
      [t('menu.shop'), () => this.showShop()],
      [t('menu.achievements'), () => this.showAchievements()],
      [t('menu.chronicle'), () => this.showChronicle()],
    ];
    const navY = btnY + 58;
    if (mobile) {
      const w1 = Math.min(190, (width - 60 - 12) / 2);
      navItems.slice(0, 2).forEach(([lbl, action], i) => {
        makeButton(this, width / 2 + (i === 0 ? -1 : 1) * (w1 / 2 + 6), navY, w1, 42, lbl, action, 'red', 12);
      });
      const w2 = Math.min(150, (width - 60 - 24) / 3);
      navItems.slice(2).forEach(([lbl, action], i) => {
        const x = width / 2 - (3 * w2 + 24) / 2 + i * (w2 + 12) + w2 / 2;
        makeButton(this, x, navY + 48, w2, 42, lbl, action, 'red', 11);
      });
    } else {
      const gapN = 10;
      const bw = Math.min(185, (width - 80 - 4 * gapN) / 5);
      navItems.forEach(([lbl, action], i) => {
        const x = width / 2 - (5 * bw + 4 * gapN) / 2 + i * (bw + gapN) + bw / 2;
        makeButton(this, x, navY, bw, 44, lbl, action, 'red', 12);
      });
    }

    // ---------- Вход в аккаунт ----------
    // Общий зал рекордов доступен только авторизованным: setScore требует
    // входа. Площадка запрещает показывать окно входа без повода, поэтому
    // это явная кнопка — и заодно видно, под каким именем игрок записан.
    this.addAccountChip(width, height);

    this.add.text(width / 2, height - 12, t('menu.version'), {
      fontFamily: FONT, fontSize: '11px', color: '#3b2410',
    }).setOrigin(0.5).setAlpha(0.8);

    this.refreshSelection();
    this.scale.on('resize', this.layout, this);
    this.events.once('shutdown', () => this.scale.off('resize', this.layout, this));

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
}
