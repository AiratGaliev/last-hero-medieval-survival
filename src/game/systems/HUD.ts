import Phaser from 'phaser';
import { DEPTH, FONT, GAME_DURATION, COMBO, MAX_LEVEL, SPEEDUP_COST } from '../constants';
import type { AchievementDef } from '../achievements';
import { audio } from './Audio';
import { hudBottomInset, safeInsets, resetSafeInsets } from '../safeArea';
import { makePanel, makeButton, type Button } from './Ui';
import { FS, outlineFor } from './Text';
import { num, t } from '../../i18n';
import { StatBar, FILL } from './Bar';

/**
 * Контейнер иконки оружия или пассивки в HUD.
 *
 * Расширение Phaser-контейнера полем пометки: когда ствол дозрел до
 * эволюции, иконка пульсирует золотом, пока игрок не возьмёт карточку.
 */
interface WeaponIcon extends Phaser.GameObjects.Container {
  evoReady?: boolean;
}

// ============ HUD: XP-бар, таймер, счётчики, иконки, бар босса ============
//
// ВАЖНО: игровая камера умеет зумить (resizeZoom), а зум применяется вокруг
// центра вьюпорта — элементы с scrollFactor(0) при зуме ≠ 1 «уплывают»
// (на десктопе >1152×700 уезжают за экран, на мобильных сжимаются к центру).
// Решение: весь HUD живёт в корневом контейнере с инверсной трансформацией
// (scale 1/zoom + позиция center*(1−1/zoom)) — дети задаются в ЭКРАННЫХ
// координатах и отображаются ровно там, где задумано, при любом зуме.

export interface HudState {
  hp: number;
  maxHp: number;
  level: number;
  xp: number;
  xpNext: number;
  kills: number;
  score: number;
  elapsed: number;
  gold: number;
}

export interface HudOpts {
  scoreMult?: number;
  diffName?: string;
}

/** Сторона кнопки паузы в экранных пикселях. */
const PAUSE_SIZE = 42;
/**
 * Сторона слота иконки оружия/пассивки в экранных пикселях.
 *
 * Слот и кнопка паузы — соседи в одном ряду, поэтому держат одну величину.
 */
const SLOT_SIZE = 34;
/**
 * Шаг между слотами иконок: зазор плюс сторона слота. Должен совпадать с
 * величиной, которой `setIcon` ставит первый слот, иначе ряд «разъезжается».
 */
const SLOT_STEP = 40;
/**
 * Горизонтальный запас справа под кнопку паузы: половина кнопки плюс
 * поле до края экрана. Всё, что выравнивается вправо в HUD, смещается
 * на эту величину, чтобы не наезжать на кнопку.
 */
const PAUSE_RESERVE = 70;

/**
 * Высота кнопок ускорения в экранных пикселях.
 *
 * Держится в одном месте с `bottomStack()`: раньше высота задавалась прямо
 * в вызове, а столбец считался от неё — кнопки наезжали на ленту событий.
 */
const SPEEDUP_H = 30;

export class HUD {
  private scene: Phaser.Scene;
  private scoreMult = 1;
  /**
   * Масштаб HUD под размер экрана.
   *
   * Интерфейс задуман под 1280×720. На 1920×1080 он превращался в пыль:
   * таймер 18 px на полутораметровом мониторе не читается, а полоса HP
   * выглядит ниточкой. Ниже единицы HUD не уменьшается — на телефоне он
   * и так упирается в края экрана.
   */
  private s = 1;
  /** Тексты HUD: базовый кегль и толщина обводки для пересчёта при ресайзе. */
  private textSizes = new Map<Phaser.GameObjects.Text, { base: number; stroke: number }>();
  /** Корневой контейнер HUD с компенсацией зума камеры */
  private root!: Phaser.GameObjects.Container;
  /** Полосы собраны из настоящих ассетов ui/bars (см. systems/Bar.ts) */
  private xpBar!: StatBar;
  private xpLabel!: Phaser.GameObjects.Text;
  private timerText!: Phaser.GameObjects.Text;
  private statsText!: Phaser.GameObjects.Text;
  private goldIcon!: Phaser.GameObjects.Image;
  private goldText!: Phaser.GameObjects.Text;
  private scoreText!: Phaser.GameObjects.Text;
  private announceText!: Phaser.GameObjects.Text;
  private announcementTypewriterEvent: Phaser.Time.TimerEvent | null = null;
  // HP-бар: мгновенная полоса + «призрак» урона (медленно догоняет)
  private hpIcon!: Phaser.GameObjects.Image;
  private hpBar!: StatBar;
  private hpText!: Phaser.GameObjects.Text;
  // Кнопка паузы: три РОВНЯХ top-level sf=0-объекта (без контейнера!) —
  // баг Phaser 4.2.1: hit-тест вложенных в sf-контейнер объектов не учитывает
  // scrollFactor контейнера → кнопка в контейнере некликабельна при скролле.
  private pauseBg!: Phaser.GameObjects.Image;
  private pauseTxt!: Phaser.GameObjects.Text;
  private pauseHit!: Phaser.GameObjects.Zone;
  /** Масштаб кнопки паузы после setDisplaySize — база для подсветки. */
  private pauseBaseScale = 1;
  private weaponIcons = new Map<string, WeaponIcon>();
  private bossGroup!: Phaser.GameObjects.Container;
  /** Полоса босса собрана из ассета ui/bars (крупная деталь) */
  private bossBar!: StatBar;
  private bossText!: Phaser.GameObjects.Text;
  private bossHpText!: Phaser.GameObjects.Text;
  /** Ширина полосы босса — не шире экрана (на мобильных 420px обрезалось) */
  private bossBarW = 420;

  // Серия убийств (комбо): счётчик + полоса затухания окна
  private comboText!: Phaser.GameObjects.Text;
  private comboBarBg!: Phaser.GameObjects.Rectangle;
  private comboBar!: Phaser.GameObjects.Image;
  private comboShown = -1;
  private comboBaseY = 78;

  // Индикаторы целей за экраном: сундук (золото) и босс/элита (красный)
  private indChest!: Phaser.GameObjects.Container;
  private indEnemy!: Phaser.GameObjects.Container;
  private indChestShown = false;
  private indEnemyShown = false;

  // Виньетка низкого HP + тег сложности + тосты ачивок
  private vignetteRects: Phaser.GameObjects.Rectangle[] = [];
  private siegeVignetteUntil = 0;
  private diffTag: Phaser.GameObjects.Text | null = null;
  private toastQueue: AchievementDef[] = [];
  private toastBusy = false;

  // ---- Поселение (TZ §B.8, §E.11, §H.2) ----
  private resGroup!: Phaser.GameObjects.Container;
  private resLabels: Record<string, Phaser.GameObjects.Text> = {};
  private resTexts: Record<string, Phaser.GameObjects.Text> = {};
  private resVisible = false;
  private settleGroup!: Phaser.GameObjects.Container;
  /** HP замка — отдельная полоса, чтобы не прятать состояние ядра в общем HP поселения. */
  private settleCastleBar!: Phaser.GameObjects.Image;
  private settleInfraBar!: Phaser.GameObjects.Image;
  private settlePopBar!: Phaser.GameObjects.Image;
  private garrisonText!: Phaser.GameObjects.Text;
  private feedItems: Array<Phaser.GameObjects.Container> = [];
  /** Кнопки оплаты ускорений. Hit-зоны остаются верхнеуровневыми объектами из-за особенностей Phaser 4. */
  private speedupButtons: Record<string, Button> = {};
  private speedupHandlers: {
    repairCurrency: () => void;
    repairAd: () => void;
    healCurrency: () => void;
    healAd: () => void;
  } = {
    repairCurrency: () => {}, repairAd: () => {}, healCurrency: () => {}, healAd: () => {},
  };

  private resizeHandler = () => { resetSafeInsets(); this.layout(); };

  /**
   * Масштаб HUD для экрана.
   *
   * Ориентир — 1280×720. Снизу ограничение единицей (на телефоне HUD уже
   * упирается в края), сверху — полутора: на 4K-мониторе увеличивать
   * интерфейс бессмысленно.
   */
  private static scaleFor(w: number, h: number): number {
    return Phaser.Math.Clamp(Math.min(w / 1280, h / 720), 1, 1.5);
  }

  /** Число в экранных пикселях с учётом масштаба HUD. */
  private sc(v: number): number {
    return Math.round(v * this.s);
  }

  /**
   * Создаёт текст HUD и запоминает его базовый кегль: при смене размера
   * экрана масштаб меняется, и кегли пересчитываются.
   */
  private mkText(
    content: string,
    base: number,
    style: Phaser.Types.GameObjects.Text.TextStyle,
  ): Phaser.GameObjects.Text {
    const stroke = style.strokeThickness ?? 0;
    const txt = this.scene.add.text(0, 0, content, {
      ...style,
      fontSize: `${this.sc(base)}px`,
    });
    this.textSizes.set(txt, { base, stroke });
    return txt;
  }

  /**
   * Пересчитывает кегли всех текстов HUD под текущий масштаб.
   *
   * Обводка растёт вместе с кеглем, но не должна превышать треть глифа:
   * иначе на большом мониторе «×14» превращалось в сплошное тёмное пятно.
   */
  private applyTextSizes(): void {
    for (const [txt, info] of this.textSizes) {
      const size = this.sc(info.base);
      const scaled = Math.round((info.stroke * size) / Math.max(1, info.base));
      const stroke = Math.min(Math.max(2, scaled), Math.max(2, Math.round(size / 3)));
      if (txt.style.fontSize !== `${size}px` || txt.style.strokeThickness !== stroke) {
        txt.setStyle({ fontSize: `${size}px`, strokeThickness: stroke });
      }
    }
  }

  constructor(scene: Phaser.Scene, onPause: () => void, opts: HudOpts = {}) {
    this.scene = scene;
    this.scoreMult = opts.scoreMult ?? 1;
    this.build(onPause, opts);
    scene.scale.on('resize', this.resizeHandler);
    window.addEventListener('orientationchange', this.resizeHandler);
  }

  private build(onPause: () => void, opts: HudOpts): void {
    const W = this.scene.scale.width;
    const H = this.scene.scale.height;
    // scrollFactor(0) обязателен: иначе контейнер «уезжает» вместе с миром при скролле камеры
    this.root = this.scene.add.container(0, 0).setScrollFactor(0).setDepth(DEPTH.HUD);
    this.s = HUD.scaleFor(W, H);

    // Полоса опыта на всю ширину экрана: рамка из ui/bars + синяя заливка
    this.xpBar = new StatBar(this.scene, W / 2, 9, W, 'small', { fill: FILL.blue });
    this.root.add(this.xpBar.root);
    this.xpLabel = this.mkText(t('hud.level', { v: 1 }), 12, {
      fontFamily: FONT, color: '#ffffff',
      stroke: '#1b1008', strokeThickness: 3,
    }).setOrigin(0.5);

    this.timerText = this.mkText('00:00', 18, {
      fontFamily: FONT, color: '#ffe9b0',
      stroke: '#1b1008', strokeThickness: 5,
    }).setOrigin(0, 0.5);

    this.statsText = this.mkText('', 12, {
      fontFamily: FONT, color: '#d8c9a8',
      stroke: '#1b1008', strokeThickness: 3,
    });

    // HP-бар игрока: сердце + деревянная полоса с «призраком» урона
    this.hpIcon = this.scene.add.image(0, 0, 'icon-heart').setDisplaySize(15, 15);
    this.hpBar = new StatBar(this.scene, 30 + 154 / 2, 55, 154, 'small', {
      ghost: true,
      fill: FILL.green,
      fillLow: FILL.yellow,
      fillCritical: FILL.red,
    });
    this.root.add(this.hpBar.root);
    this.hpText = this.mkText('', 12, {
      fontFamily: FONT, color: '#ffffff',
      stroke: '#1b1008', strokeThickness: 3,
    }).setOrigin(0, 0.5);

    this.goldIcon = this.scene.add.image(0, 0, 'icon-coin').setDisplaySize(14, 14);
    this.goldText = this.mkText('0', 12, {
      fontFamily: FONT, color: '#ffd76e',
      stroke: '#1b1008', strokeThickness: 3,
    }).setOrigin(0, 0.5);

    this.scoreText = this.mkText(t('hud.score', { v: 0 }), 12, {
      fontFamily: FONT, color: '#ffd76e',
      stroke: '#1b1008', strokeThickness: 3,
    }).setOrigin(1, 0);

    // Тег сложности («Кошмар ×1.6»)
    if ((opts.scoreMult ?? 1) > 1) {
      this.diffTag = this.mkText(`${opts.diffName ?? ''} ×${opts.scoreMult}`, 12, {
        fontFamily: FONT, color: '#ff8866',
        stroke: '#1b1008', strokeThickness: 3,
      }).setOrigin(1, 0);
    }

    // Кнопка паузы (важно для мобильных). Живёт внутри root: контейнер уже
    // компенсирует зум камеры, поэтому кнопка всегда ровно PAUSE_SIZE
    // экранных пикселей. Отдельным объектом со своим setScale(1/zoom)
    // она выходила в натуральный размер текстуры — на 390 px это был
    // квадрат в четверть экрана.
    this.pauseBg = this.scene.add.image(0, 0, 'btn-small-blue').setDisplaySize(PAUSE_SIZE, PAUSE_SIZE);
    this.pauseTxt = this.mkText('II', 16, {
      fontFamily: FONT, color: '#ffffff',
      stroke: '#2a1608', strokeThickness: 5,
    }).setOrigin(0.5);
    this.pauseHit = this.scene.add.zone(0, 0, PAUSE_SIZE + 16, PAUSE_SIZE + 16)
      .setInteractive({ useHandCursor: true });
    this.pauseBaseScale = this.pauseBg.scaleX;
    this.root.add([this.pauseBg, this.pauseTxt, this.pauseHit]);
    this.pauseHit.on('pointerover', () => {
      this.scene.tweens.add({
        targets: [this.pauseBg, this.pauseTxt],
        scale: this.pauseBaseScale * 1.08, duration: 110,
      });
      this.pauseBg.setTint(0xfff2cc);
    });
    this.pauseHit.on('pointerout', () => {
      this.scene.tweens.add({
        targets: [this.pauseBg, this.pauseTxt],
        scale: this.pauseBaseScale, duration: 110,
      });
      this.pauseBg.clearTint();
    });
    this.pauseHit.on('pointerdown', () => {
      audio.play('click');
      onPause();
    });

    // Босс-бар: собран из настоящей полосы ui/bars (крупная деталь),
    // а не из плоских прямоугольников. Ширина подгоняется под экран в layout().
    this.bossGroup = this.scene.add.container(0, 0).setVisible(false);
    this.bossBar = new StatBar(this.scene, 0, 0, 420, 'big', { fill: FILL.red });
    this.bossGroup.add(this.bossBar.root);
    this.bossHpText = this.mkText('', 12, {
      fontFamily: FONT, color: '#ffd9c0',
      stroke: '#1b1008', strokeThickness: 4,
    }).setOrigin(0.5);
    this.bossText = this.mkText(t('hud.bossName'), 12, {
      fontFamily: FONT, color: '#ff9a8a',
      stroke: '#1b1008', strokeThickness: 4,
    }).setOrigin(0.5);
    this.bossGroup.add([this.bossText, this.bossHpText]);

    // Виньетка низкого HP (пульсирующие красные края экрана)
    for (let i = 0; i < 4; i++) {
      const r = this.scene.add.rectangle(0, 0, 10, 10, 0xd03028, 0.3)
        .setOrigin(0, 0).setVisible(false);
      this.vignetteRects.push(r);
    }

    this.announceText = this.mkText('', 20, {
      fontFamily: FONT, color: '#ffffff',
      stroke: '#7a1010', strokeThickness: outlineFor(20),
    }).setOrigin(0.5).setAlpha(0);

    // Комбо-счётчик серии убийств (топ-справа, под счётом)
    this.comboText = this.mkText('', 20, {
      fontFamily: FONT, color: '#ffd76e',
      stroke: '#7a1010', strokeThickness: outlineFor(20),
    }).setOrigin(1, 0.5).setVisible(false);
    this.comboBarBg = this.scene.add.rectangle(0, 0, 68, 6, 0x1b1008, 0.85).setOrigin(1, 0.5).setVisible(false);
    this.comboBar = this.scene.add.image(0, 0, FILL.yellow).setOrigin(1, 0.5).setVisible(false);

    // Стрелки-индикаторы за экраном (сундук/босс)
    // Сундук оставляем золотым (родной цвет спрайта), врага красим
    // в красный — так стрелки различаются с одного взгляда
    this.indChest = this.makeIndicator(0xffe9b0);
    this.indEnemy = this.makeIndicator(0xff5040);

    // ---- Блок РЕСУРСЫ (дерево/мясо/руда) — скрыт, пока всё по нулям (§B.8) ----
    //
    // Число стоит СПРАВА от значка. Раньше текст создавался в той же точке,
    // что и иконка, и цифра рисовалась поверх картинки — количество ресурсов
    // было не прочитать вовсе.
    this.resGroup = this.scene.add.container(0, 0).setVisible(false);
    const RES_ICON = 15;
    const RES_GAP = 5;
    const RES_COUNT_X = 76;
    const resDefs: Array<[string, string, number, string]> = [
      ['wood', 'res-wood', 0xffffff, t('resource.wood')],
      ['meat', 'res-meat', 0xffffff, t('resource.meat')],
      ['ore', 'res-ore', 0xfff0b0, t('resource.ore')],
    ];
    resDefs.forEach(([key, tex, tint, labelText], i) => {
      const rowY = i * 20;
      const ic = this.scene.add.image(0, rowY, tex).setDisplaySize(RES_ICON, RES_ICON).setOrigin(0, 0.5);
      if (tint !== 0xffffff) ic.setTint(tint);
      // Вся группа масштабируется в layout(), поэтому детям задаются базовые размеры.
      const label = this.scene.add.text(RES_ICON + RES_GAP, rowY, labelText, {
        fontFamily: FONT, fontSize: '10px', color: '#d8c9a8',
        stroke: '#1b1008', strokeThickness: 2,
      }).setOrigin(0, 0.5);
      const txt = this.scene.add.text(RES_COUNT_X, rowY, '0', {
        fontFamily: FONT, fontSize: '12px', color: '#ffe9b0',
        stroke: '#1b1008', strokeThickness: 3,
      }).setOrigin(0, 0.5);
      this.resLabels[key] = label;
      this.resTexts[key] = txt;
      this.resGroup.add([ic, label, txt]);
    });

    // ---- Индикатор поселения: две мини-полосы (§E.11 — обязателен) ----
    //
    // Подпись гарнизона уходит вправо от полос, а не в ту же точку: раньше
    // «Гарнизон 2/4» рисовалось поверх обеих мини-полос.
    this.settleGroup = this.scene.add.container(0, 0);
    const SETTLE_BAR_W = 100;
    const SETTLE_GAP = 20;
    const castleIc = this.scene.add.image(0, 0, 'castle').setDisplaySize(16, 13).setOrigin(0, 0.5);
    const barBgC = this.scene.add.rectangle(SETTLE_GAP, -8, SETTLE_BAR_W, 5, 0x1b1008, 0.85).setOrigin(0, 0.5);
    const barBgI = this.scene.add.rectangle(SETTLE_GAP, 0, SETTLE_BAR_W, 5, 0x1b1008, 0.85).setOrigin(0, 0.5);
    const barBgP = this.scene.add.rectangle(SETTLE_GAP, 8, SETTLE_BAR_W, 5, 0x1b1008, 0.85).setOrigin(0, 0.5);
    this.settleCastleBar = this.scene.add.image(SETTLE_GAP, -8, FILL.green).setOrigin(0, 0.5);
    this.settleInfraBar = this.scene.add.image(SETTLE_GAP, 0, FILL.yellow).setOrigin(0, 0.5);
    this.settlePopBar = this.scene.add.image(SETTLE_GAP, 8, FILL.green).setOrigin(0, 0.5);
    this.garrisonText = this.mkText('', 12, {
      fontFamily: FONT, color: '#d8c9a8',
      stroke: '#1b1008', strokeThickness: 3,
    }).setOrigin(0, 0.5).setPosition(this.sc(SETTLE_GAP + SETTLE_BAR_W + 6), 0);
    this.settleGroup.add([castleIc, barBgC, barBgI, barBgP, this.settleCastleBar, this.settleInfraBar, this.settlePopBar, this.garrisonText]);

    // Порядок добавления = порядок отрисовки (снизу вверх):
    // полосы/тексты → босс-бар → виньетка → анонс → тосты достижений
    // (добавляются динамически). Пауза — отдельным top-level объектом.
    const base: Phaser.GameObjects.GameObject[] = [
      this.xpBar.root, this.xpLabel,
      this.timerText, this.statsText, this.goldIcon, this.goldText,
      this.hpIcon, this.hpBar.root, this.hpText,
      this.scoreText,
    ];
    if (this.diffTag) base.push(this.diffTag);
    base.push(
      this.bossGroup, ...this.vignetteRects, this.announceText,
      this.comboBarBg, this.comboBar, this.comboText,
      this.indChest, this.indEnemy,
      this.resGroup, this.settleGroup,
    );
    this.root.add(base);

    this.layout();
    void H;
  }

  private camZoom(): number {
    return this.scene.cameras.main.zoom || 1;
  }

  layout(): void {
    const W = this.scene.scale.width;
    const H = this.scene.scale.height;
    // Масштаб HUD пересчитывается при ресайзе: окно могло развернуться
    // с телефона на десктоп, и интерфейс обязан вырасти вместе с ним.
    this.s = HUD.scaleFor(W, H);
    this.applyTextSizes();
    const sa = safeInsets();
    const S = this.s;

    // Полоса опыта — во всю ширину экрана, остальные элементы — в углах.
    this.xpBar.setFactor(S);
    this.xpBar.setWidth(W);
    this.xpBar.setPosition(W / 2, this.sc(9) + sa.top);
    this.xpLabel.setPosition(W / 2, this.sc(9) + sa.top);

    this.timerText.setPosition(this.sc(12) + sa.left, this.sc(32) + sa.top);
    // HP-бар: под таймером; полоса 154 px + сердце + текст
    const hpW = this.sc(154);
    this.hpIcon.setDisplaySize(this.sc(15), this.sc(15));
    this.hpIcon.setPosition(this.sc(19) + sa.left, this.sc(55) + sa.top);
    this.hpBar.setFactor(S);
    this.hpBar.setPosition(this.sc(30) + hpW / 2 + sa.left, this.sc(55) + sa.top);
    this.hpText.setPosition(this.sc(30) + hpW + this.sc(6) + sa.left, this.sc(55) + sa.top);
    this.statsText.setPosition(this.sc(12) + sa.left, this.sc(78) + sa.top);
    this.goldIcon.setDisplaySize(this.sc(14), this.sc(14));
    this.goldIcon.setPosition(this.sc(12) + sa.left, this.sc(98) + sa.top);
    this.goldText.setPosition(this.sc(30) + sa.left, this.sc(98) + sa.top);
    // Блок РЕСУРСЫ: под золотом матча (левый столбец, §B.8).
    // Группа масштабируется целиком: значки и цифры растут вместе с HUD.
    this.resGroup.setScale(S).setPosition(this.sc(12) + sa.left, this.sc(120) + sa.top);
    // Индикатор поселения: под ресурсами, а без них — сразу под золотом.
    // Тот же ряд нужен босс-бару на узком экране, поэтому он считается здесь.
    const settleY = this.resVisible ? this.sc(192) : this.sc(130);
    this.settleGroup.setScale(S).setPosition(this.sc(12) + sa.left, settleY + sa.top);
    // Правый верхний угол занят кнопкой паузы: весь блок (счёт, метка
    // сложности, серия) заканчивается левее неё, иначе цифры ложились
    // прямо на кнопку.
    const rEdge = W - this.sc(PAUSE_RESERVE);
    this.scoreText.setPosition(rEdge - sa.right, this.sc(34) + sa.top);
    this.diffTag?.setPosition(rEdge - sa.right, this.sc(54) + sa.top);
    // Комбо: под счётом, выравнивание вправо
    this.comboBaseY = this.sc(78) + sa.top;
    this.comboText.setPosition(rEdge - sa.right, this.comboBaseY);
    this.comboBarBg.setPosition(rEdge - sa.right, this.comboBaseY + this.sc(16));
    this.comboBar.setPosition(rEdge - sa.right - this.sc(2), this.comboBaseY + this.sc(16));
    // Анонс: на низких экранах опускаем ниже, чтобы не наезжать на босс-бар
    this.announceText.setPosition(W / 2, H < 600 ? Math.max(this.sc(126), H * 0.3) : H * 0.22);
    // Босс-бар. На узком экране он не влезает рядом с левой колонкой и
    // накрывал счётчик убийств, золото и индикатор поселения, поэтому
    // уводится ПОД всю колонку (ниже индикатора поселения).
    this.bossGroup.setPosition(W / 2, W < 700 ? settleY + sa.top + this.sc(34) : this.sc(64));
    // Полоса босса не шире экрана: на мобильных (<430px) фиксированные 420px
    // обрезались краями экрана
    this.bossBarW = Math.min(this.sc(420), W - 24);
    this.bossBar.setFactor(S * 0.62);
    this.bossBar.setWidth(this.bossBarW);
    this.bossBar.setPosition(0, 0);
    this.bossText.setPosition(0, -this.sc(22));
    // Виньетка: красные полосы по краям
    const e = this.sc(26);
    const [top, bottom, left, right] = this.vignetteRects;
    top?.setPosition(0, 0).setSize(W, e);
    bottom?.setPosition(0, H - e).setSize(W, e);
    left?.setPosition(0, 0).setSize(e, H);
    right?.setPosition(W - e, 0).setSize(e, H);
    // Иконки оружия: слева направо снизу, с переносом на новый ряд —
    // на мобильных 16 иконок (7 оружий + 9 пассивок) не помещаются в один ряд
    const step = this.sc(SLOT_STEP);
    const perRow = Math.max(1, Math.floor((W - this.sc(24)) / step));
    const slot = this.sc(SLOT_SIZE);
    const icoSize = this.sc(26);
    let ix = this.sc(12);
    let iconsY = this.bottomStack().iconsY;
    let inRow = 0;
    for (const c of this.weaponIcons.values()) {
      c.setPosition(ix, iconsY);
      // Слот и иконка тоже должны расти вместе с HUD, иначе на большом
      // экране ряд из шестнадцати значков вырождается в горсть точек.
      const bg = c.list[0] as Phaser.GameObjects.Image | undefined;
      if (bg) bg.setDisplaySize(slot, slot);
      const ic = c.list[1] as Phaser.GameObjects.Image | undefined;
      if (ic) ic.setDisplaySize(icoSize, icoSize);
      const lvl = c.list[2] as Phaser.GameObjects.Text | undefined;
      if (lvl) lvl.setPosition(slot - 3, slot / 2 - 2);
      inRow++;
      if (inRow >= perRow) {
        inRow = 0;
        ix = this.sc(12);
        iconsY -= this.sc(SLOT_STEP + 4);
      } else {
        ix += step;
      }
    }
    // Компенсация зума игровой камеры: инверсная трансформация корня,
    // чтобы дети (в экранных координатах) рисовались ровно на своих местах.
    const z = this.camZoom();
    this.root.setScale(1 / z);
    this.root.setPosition((W / 2) * (1 - 1 / z), (H / 2) * (1 - 1 / z));
    // Кнопка паузы: экранные координаты, компенсацию зума делает root.
    // Масштаб фона не трогаем — он задан через setDisplaySize при создании,
    // и любой setScale здесь вернул бы натуральный размер текстуры.
    const pauseSize = this.sc(PAUSE_SIZE);
    this.pauseBg.setDisplaySize(pauseSize, pauseSize);
    this.pauseBaseScale = this.pauseBg.scaleX;
    const bx = W - this.sc(46);
    const by = this.sc(96);
    this.pauseBg.setPosition(bx, by);
    this.pauseTxt.setPosition(bx, by).setScale(1);
    this.pauseHit.setPosition(bx, by).setScale(1);
    this.pauseHit.setSize(pauseSize + 16, pauseSize + 16);
  }

  update(s: HudState): void {
    const atMax = s.level >= MAX_LEVEL;
    // На потолке уровней полоса заполнена целиком и показывает пометку,
    // а не растущие числа, которых больше не станет.
    const frac = atMax ? 1 : Phaser.Math.Clamp(s.xp / Math.max(1, s.xpNext), 0, 1);
    this.xpBar.setFraction(frac);
    const label = atMax
      ? t('hud.levelMax', { v: s.level })
      : t('hud.levelProgress', { a: num(s.xp), b: num(s.xpNext), v: s.level });
    if (this.xpLabel.text !== label) this.xpLabel.setText(label);

    const remain = Math.max(0, GAME_DURATION - s.elapsed);
    if (remain <= 0) {
      // Время вышло — на арене финальный босс: честная индикация вместо «00:00»
      this.timerText.setText(t('hud.bossIncoming'));
      this.timerText.setColor('#ff6b5e');
    } else {
      const mm = Math.floor(remain / 60);
      const ss = Math.floor(remain % 60);
      this.timerText.setText(`${mm.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}`);
      this.timerText.setColor('#ffe9b0');
    }

    this.statsText.setText(t('hud.kills', { v: num(s.kills) }));
    this.goldText.setText(`${s.gold}`);
    this.scoreText.setText(t('hud.score', { v: num(s.score) }));

    // HP-бар: полоса + «призрак» урона (медленно догоняет после удара)
    this.updateHpBar(s.hp, s.maxHp);

    // Виньетка включается как низким HP, так и объявлением осады.
    // Два триггера объединены, поэтому восстановление HP не гасит срочное
    // предупреждение об осаде, а окончание предупреждения не гасит low-HP edge.
    const now = this.scene.time.now;
    const hpFrac = s.hp / Math.max(1, s.maxHp);
    const hpPulse = hpFrac < 0.3 ? 0.18 + Math.abs(Math.sin(now / 260)) * 0.16 : 0;
    const siegePulse = now < this.siegeVignetteUntil
      ? 0.16 + Math.abs(Math.sin(now / 95)) * 0.2
      : 0;
    const vignetteAlpha = Math.max(hpPulse, siegePulse);
    for (const r of this.vignetteRects) {
      r.setVisible(vignetteAlpha > 0).setAlpha(vignetteAlpha);
    }
  }

  /** Красные края экрана при объявлении осады (TZ §H.13 №2). */
  showSiegeVignette(durationMs = 2_000): void {
    if (!Number.isFinite(durationMs) || durationMs <= 0) return;
    this.siegeVignetteUntil = Math.max(
      this.siegeVignetteUntil,
      this.scene.time.now + durationMs,
    );
    const alpha = 0.2 + Math.abs(Math.sin(this.scene.time.now / 95)) * 0.2;
    for (const rect of this.vignetteRects) rect.setVisible(true).setAlpha(alpha);
  }

  /** Полоса HP: быстрая заливка + медленный «призрак» (классика файтингов) */
  private updateHpBar(hp: number, maxHp: number): void {
    const frac = Phaser.Math.Clamp(hp / Math.max(1, maxHp), 0, 1);
    this.hpBar.setFraction(frac);
    this.hpText.setText(`${Math.ceil(hp)}/${maxHp}`);
    this.hpText.setColor(frac > 0.25 ? '#ffffff' : '#ff9a8a');
  }

  // ================= ПОСЕЛЕНИЕ: HUD (TZ §B.8, §E.11) =================

  /** Экранная координата ресурса дерева для обучающей стрелки (§I.2). */
  resourceHintPoint(): { x: number; y: number } {
    // resGroup и HUD root используют одну и ту же inverse-zoom систему
    // экранных координат, поэтому подсказке передаётся логическая точка до zoom.
    return {
      x: this.resGroup.x + 86 * this.resGroup.scaleX,
      y: this.resGroup.y,
    };
  }

  /** Блок РЕСУРСЫ: обновление по событию economy 'change', не каждый кадр. */
  updateResources(res: { wood: number; ore: number; meat: number }): void {
    const any = res.wood > 0 || res.ore > 0 || res.meat > 0;
    this.resGroup.setVisible(any);
    // Положение блока — дело layout(): он учитывает масштаб HUD и безопасные
    // зоны. Раньше updateResources переставлял его «сырыми» координатами
    // поверх расчёта, и на большом мониторе блок уезжал с левой колонки.
    if (!any && !this.resVisible) return;
    this.resVisible = any;
    this.resTexts.wood.setText(`${res.wood}`);
    this.resTexts.meat.setText(`${res.meat}`);
    this.resTexts.ore.setText(`${res.ore}`);
  }

  /** HP замка, инфраструктура, население и численность гарнизона (§E.11). */
  updateSettlement(castleFrac: number, infraFrac: number, popFrac: number, garrison: string): void {
    const w = this.sc(100);
    const h = this.sc(5);
    const castle = Phaser.Math.Clamp(castleFrac, 0, 1);
    const infra = Phaser.Math.Clamp(infraFrac, 0, 1);
    const population = Phaser.Math.Clamp(popFrac, 0, 1);
    this.settleCastleBar.setDisplaySize(Math.max(2, w * castle), h);
    this.settleInfraBar.setDisplaySize(Math.max(2, w * infra), h);
    this.settlePopBar.setDisplaySize(Math.max(2, w * population), h);
    this.settleCastleBar.setTexture(castle > 0.5 ? FILL.green : castle > 0.25 ? FILL.yellow : FILL.red);
    this.settleInfraBar.setTexture(infra > 0.5 ? FILL.yellow : infra > 0.25 ? 'bar-fill-yellow' : FILL.red);
    this.settlePopBar.setTexture(population > 0.5 ? FILL.green : population > 0.25 ? FILL.yellow : FILL.red);
    if (this.garrisonText.text !== garrison) this.garrisonText.setText(garrison);
  }

  /**
 * Нижний ряд HUD: иконки оружия, кнопки ускорений и лента событий.
 *
 * Раньше все трое жили в одной полосе у нижней кромки и накладывались друг
 * на друга: лента событий пересекала кнопки ускорений, а те — ряд иконок.
 * Теперь это столбец, который считается снизу вверх от одного края:
 * ряд иконок лежит на экране, над ним кнопки, над ними — лента.
 */
private bottomStack(): { iconsY: number; speedupY: number; feedY: number } {
    const H = this.scene.scale.height;
    const slot = this.sc(SLOT_SIZE);
    const btnH = this.sc(SPEEDUP_H);
    const iconsY = H - hudBottomInset(this.sc(4)) - slot / 2;
    const speedupY = iconsY - slot / 2 - this.sc(8) - btnH / 2;
    const feedY = speedupY - btnH / 2 - this.sc(20);
    return { iconsY, speedupY, feedY };
  }

  /** Лента поселения: именные события, 3 последних по 6 сек (§H.2). */
  feed(text: string, color = '#ffe9b0'): void {
    const W = this.scene.scale.width;
    const w = Math.min(this.sc(300), W - this.sc(24));
    const feedY = this.bottomStack().feedY;
    const rowHeight = this.sc(28);
    // Лента — это стек, а не три сообщения в одной точке.
    for (const item of this.feedItems) {
      this.scene.tweens.killTweensOf(item);
      this.scene.tweens.add({
        targets: item, y: item.y - rowHeight, duration: 160, ease: 'Sine.Out',
      });
    }
    const c = this.scene.add.container(this.sc(14), feedY);
    // Подложка ленты — пергамент из набора, а не чёрный прямоугольник:
    // события поселения читаются поверх живой сцены, и тёмная плашка
    // выбивалась из общей стилистики. Цвет события переносит полоска
    // слева: подпись остаётся тёмной и читаемой на пергаменте.
    const bg = makePanel(this.scene, w / 2, 0, 'paper', w, this.sc(24));
    bg.setAlpha(0.94);
    const accent = this.scene.add.rectangle(
      this.sc(6), 0, this.sc(4), this.sc(12), Phaser.Display.Color.HexStringToColor(color).color,
      1,
    ).setOrigin(0.5);
    const label = this.scene.add.text(this.sc(12), 0, text, {
      fontFamily: FONT, fontSize: `${this.sc(12)}px`, color: '#3b2410',
      wordWrap: { width: w - this.sc(20) },
    }).setOrigin(0, 0.5);
    c.add([bg, accent, label]);
    this.root.add(c);
    this.feedItems.push(c);
    // Старые записи выталкиваются вверх и гаснут
    while (this.feedItems.length > 3) {
      const old = this.feedItems.shift()!;
      this.scene.tweens.add({ targets: old, alpha: 0, duration: 300, onComplete: () => old.destroy() });
    }
    this.scene.time.delayedCall(6000, () => {
      const i = this.feedItems.indexOf(c);
      if (i >= 0) this.feedItems.splice(i, 1);
      this.scene.tweens.add({ targets: c, alpha: 0, duration: 400, onComplete: () => c.destroy() });
    });
  }

  /** Обработчики выбора оплаты: валюта/жетон и rewarded — разные явные действия. */
  setSpeedupHandlers(h: {
    repairCurrency: () => void;
    repairAd: () => void;
    healCurrency: () => void;
    healAd: () => void;
  }): void {
    this.speedupHandlers = h;
  }

/**
 * Кнопки ускорений (§G.8).
 *
 * §G.8 и гейт §G.11 п.21 требуют: «кнопки появляются только когда есть
 * активный ремонт / есть раненые в радиусе, иначе СЕРЫЕ с подсказкой почему».
 * Раньше при отсутствии цели кнопка просто УДАЛЯЛАСЬ — игрок не понимал, что
 * механика есть и почему она не работает. Теперь кнопка всегда на месте и
 * меняет подпись на причину отказа.
 */
  updateSpeedups(
    repairTarget: boolean,
    healTarget: boolean,
    walletBalance: number,
    hasSpeedupToken: boolean,
    repairAdAvailable: boolean,
    healAdAvailable: boolean,
  ): void {
    const W = this.scene.scale.width;
    const groupW = this.sc(148);
    const currencyW = this.sc(90);
    const gap = this.sc(4);
    const adW = groupW - currencyW - gap;
    const bh = this.sc(SPEEDUP_H);
    const rowY = this.bottomStack().speedupY;

    const currencyLabel = (kind: 'repair' | 'heal', target: boolean): string => {
      if (!target) return t('speedup.noTarget');
      if (hasSpeedupToken) return t('speedup.tokenButton');
      const cost = SPEEDUP_COST[kind];
      return walletBalance >= cost
        ? t(kind === 'repair' ? 'speedup.repairGoldLabel' : 'speedup.healGoldLabel', { v: cost })
        : t('speedup.needGold', { v: cost });
    };

    const defs = [
      {
        key: 'repairCurrency', kind: 'currency', group: 0,
        label: currencyLabel('repair', repairTarget),
        enabled: repairTarget && (hasSpeedupToken || walletBalance >= SPEEDUP_COST.repair),
        // Кнопки создаются один раз и захватывают onClick из def навсегда,
        // поэтому обработчик должен читаться из таблицы В момент клика:
        // setSpeedupHandlers после создания кнопок иначе игнорируется.
        click: (): void => this.speedupHandlers.repairCurrency(),
      },
      {
        key: 'repairAd', kind: 'ad', group: 0,
        label: !repairTarget ? t('speedup.noTargetShort')
          : repairAdAvailable ? t('speedup.adButton') : t('speedup.adUnavailableShort'),
        enabled: repairTarget && repairAdAvailable,
        click: (): void => this.speedupHandlers.repairAd(),
      },
      {
        key: 'healCurrency', kind: 'currency', group: 1,
        label: currencyLabel('heal', healTarget),
        enabled: healTarget && (hasSpeedupToken || walletBalance >= SPEEDUP_COST.heal),
        click: (): void => this.speedupHandlers.healCurrency(),
      },
      {
        key: 'healAd', kind: 'ad', group: 1,
        label: !healTarget ? t('speedup.noTargetShort')
          : healAdAvailable ? t('speedup.adButton') : t('speedup.adUnavailableShort'),
        enabled: healTarget && healAdAvailable,
        click: (): void => this.speedupHandlers.healAd(),
      },
    ] as const;

    for (const def of defs) {
      const width = def.kind === 'currency' ? currencyW : adW;
      const groupCenter = W - this.sc(14) - groupW / 2 - def.group * (groupW + this.sc(8));
      const groupLeft = groupCenter - groupW / 2;
      const x = def.kind === 'currency'
        ? groupLeft + currencyW / 2
        : groupLeft + currencyW + gap + adW / 2;
      const fontSize = this.sc(def.kind === 'currency' ? 10 : 9);
      let btn = this.speedupButtons[def.key];
      if (!btn) {
        btn = makeButton(
          this.scene, x, rowY, width, bh, def.label,
          def.click, 'blue', fontSize,
          { hitW: width, hitH: bh },
        );
        // Текст и графика компенсируют зум через root. В Phaser 4 nested
        // hit-зоны не получают ту же коррекцию; оставляем hit top-level и
        // перемещаем его через Button.setPosition вместе с визуалом.
        this.root.add([btn.img, btn.txt]);
        btn.hit.setScrollFactor(0).setDepth(DEPTH.HUD + 1);
        this.speedupButtons[def.key] = btn;
      }
      btn.setLabel(def.label);
      btn.setEnabled(def.enabled);
      btn.txt.setColor('#ffffff');
      btn.setPosition(x, rowY, {
        originX: this.root.x,
        originY: this.root.y,
        scaleX: this.root.scaleX,
        scaleY: this.root.scaleY,
      });
    }
  }

  /** Обновление серии убийств: счётчик ×N + полоса окна */
  /**
   * Помечает иконку ствола как готового к эволюции: золотая рамка и
   * мягкая пульсация. Метку нужно снять, когда эволюция взята.
   */
  markEvolutionReady(weaponId: string): void {
    const icon = this.weaponIcons.get(weaponId);
    if (!icon || icon.evoReady) return;
    icon.evoReady = true;
    // Подложка слота — Image из ассета, а не Graphics: «золотая рамка» на
    // ней делается тонировкой. Пульс по прозрачности контейнера остаётся.
    const bg = icon.list[0] as Phaser.GameObjects.Image | undefined;
    if (bg && bg.type === 'Image') bg.setTint(0xffd700);
    this.scene.tweens.add({
      targets: icon, alpha: { from: 1, to: 0.65 },
      duration: 850, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    });
  }

  /** Снимает пометку «готово к эволюции». */
  clearEvolutionReady(weaponId: string): void {
    const icon = this.weaponIcons.get(weaponId);
    if (!icon || !icon.evoReady) return;
    icon.evoReady = false;
    this.scene.tweens.killTweensOf(icon);
    icon.setAlpha(1);
    const bg = icon.list[0] as Phaser.GameObjects.Image | undefined;
    // Возвращаем обычный цвет слота, а не снимаем тонировку: setIcon
    // красит подложку по уровню (5+ — золотая).
    const lvl = icon.list[2] as Phaser.GameObjects.Text | undefined;
    const evolved = lvl?.text === '★';
    if (bg && bg.type === 'Image') bg.setTint(evolved ? 0xffd76e : 0x9aa7b8);
  }

  updateCombo(combo: number, windowFrac: number): void {
    const show = combo >= COMBO.MIN_DISPLAY;
    this.comboText.setVisible(show);
    this.comboBarBg.setVisible(show);
    this.comboBar.setVisible(show);
    if (!show) {
      this.comboShown = -1;
      return;
    }
    if (combo !== this.comboShown) {
      // Поп-анимация при росте серии (y мог остаться от вспышки сброса)
      this.comboText.setText(`×${combo}`);
      this.comboText.y = this.comboBaseY;
      this.comboText.setScale(1.3);
      this.scene.tweens.killTweensOf(this.comboText);
      this.scene.tweens.add({ targets: this.comboText, scale: 1, duration: 140, ease: 'Back.easeOut' });
      this.comboShown = combo;
    }
    // Полоса окна серии: заливка из набора полос (bar-fill-*), а не
    // прямоугольник — так индикатор выглядит частью интерфейса.
    const frac = Phaser.Math.Clamp(windowFrac, 0, 1);
    this.comboBar.setDisplaySize(
      Math.max(0, this.sc(64) * frac),
      this.sc(3),
    );
    // Цвет: чем ближе к сбросу — тем краснее
    this.comboBar.setTexture(frac > 0.4 ? FILL.yellow : frac > 0.18 ? 'bar-fill-yellow' : FILL.red);
  }

  /** Серия сброшена: короткая красная вспышка ×N */
  breakCombo(combo: number): void {
    if (combo < COMBO.MIN_DISPLAY) return;
    this.comboText.setText(`×${combo}`).setColor('#ff6b5e');
    this.scene.tweens.killTweensOf(this.comboText);
    this.scene.tweens.add({
      targets: this.comboText, alpha: 0, y: this.comboBaseY - 18,
      duration: 420, ease: 'Quad.easeIn',
      onComplete: () => {
        this.comboText.setColor('#ffd76e').setAlpha(1).setVisible(false);
        this.comboText.y = this.comboBaseY;
      },
    });
    this.comboShown = -1;
  }

  /**
   * Стрелка-индикатор: указывает на цель за пределами экрана.
   *
   * Раньше треугольник рисовался в Graphics: он был резким, не в духе
   * остальной графики, и не масштабировался вместе с камерой. Теперь это
   * спрайт ui/cursors/cursor-01.png — тот же, что курсор мыши.
   *
   * Геометрия спрайта измерена по непрозрачным пикселям
   * (scripts/probe-cursors.mjs, scripts/probe-arrow.mjs): в кадре 64×64
   * стрелка занимает x 22…43, y 17…46, остриё в точке (22, 17), а
   * основание — между (34, 46) и (43, 36). Отсюда два числа:
   *
   *   • origin — в острии, иначе стрелка рисуется со сдвигом на 11 px
   *     вверх-влево от точки на краю экрана и уезжает за кадр;
   *   • направление оси — −125°, а не «ровно 45° наверх-влево», поэтому
   *     к углу между экраном и целью прибавляется 125°.
   */
  private makeIndicator(tint: number): Phaser.GameObjects.Container {
    const box = this.scene.add.container(0, 0);
    const arrow = this.scene.add
      .image(0, 0, 'cursor-arrow')
      .setOrigin(HUD.ARROW_TIP_X, HUD.ARROW_TIP_Y)
      .setScale(1)
      .setTint(tint);
    box.add(arrow);
    box.setVisible(false);
    return box;
  }

  /** Остриё стрелки в координатах кадра 64×64: (22, 17). */
  private static readonly ARROW_TIP_X = 22 / 64;
  private static readonly ARROW_TIP_Y = 17 / 64;

  /** Поворот от нарисованного наклона стрелки к нужному направлению: 125°. */
  private static readonly ARROW_OFFSET = (125 * Math.PI) / 180;

  /** Индикаторы целей за экраном: позиции в экранных координатах */
  updateIndicators(
    targets: Array<{ x: number; y: number; kind: 'chest' | 'boss' | 'elite' }>,
    toScreen: (wx: number, wy: number) => { x: number; y: number },
  ): void {
    const W = this.scene.scale.width;
    const H = this.scene.scale.height;
    const cx = W / 2, cy = H / 2;
    const m = 30;
    const place = (g: Phaser.GameObjects.Container, t: { x: number; y: number } | undefined, pulse: boolean): boolean => {
      if (!t) return false;
      const s = toScreen(t.x, t.y);
      // Цель видима на экране — стрелка не нужна
      if (s.x > m && s.x < W - m && s.y > m && s.y < H - m) return false;
      const dx = s.x - cx || 0.001;
      const dy = s.y - cy || 0.001;
      const adx = Math.abs(dx), ady = Math.abs(dy);
      // Луч от центра до рамки margin — пересечение с прямоугольником экрана
      const kx = adx > 0.001 ? (W / 2 - m) / adx : Infinity;
      const ky = ady > 0.001 ? (H / 2 - m) / ady : Infinity;
      const k = Math.min(kx, ky);
      g.setPosition(cx + dx * k, cy + dy * k);
      g.setRotation(Math.atan2(dy, dx) + HUD.ARROW_OFFSET);
      const a = pulse ? 0.55 + Math.abs(Math.sin(this.scene.time.now / 260)) * 0.45 : 1;
      g.setAlpha(a);
      return true;
    };
    const chest = targets.find((t) => t.kind === 'chest');
    const enemy = targets.find((t) => t.kind === 'boss') ?? targets.find((t) => t.kind === 'elite');
    this.indChestShown = place(this.indChest, chest, true);
    this.indEnemyShown = place(this.indEnemy, enemy, true);
    this.indChest.setVisible(this.indChestShown);
    this.indEnemy.setVisible(this.indEnemyShown);
  }

  /** Кино-заставка босса/элиты: чёрные полосы + аватар + имя (не блокирует игру) */
  bossIntro(name: string, subtitle = t('hud.bossSubtitleFinal'), face?: string): void {
    const W = this.scene.scale.width;
    const H = this.scene.scale.height;
    const barH = Math.max(38, H * 0.085);
    const c = this.scene.add.container(0, 0);
    const topBar = this.scene.add.rectangle(W / 2, -barH / 2 - 2, W + 8, barH, 0x07070d, 0.94).setOrigin(0.5);
    const botBar = this.scene.add.rectangle(W / 2, H + barH / 2 + 2, W + 8, barH, 0x07070d, 0.94).setOrigin(0.5);
    const sub = this.scene.add.text(W / 2, H / 2 - 34, subtitle, {
      fontFamily: FONT, fontSize: '13px', color: '#ff8a7a',
      stroke: '#1b1008', strokeThickness: 5,
    }).setOrigin(0.5).setAlpha(0);
    const title = this.scene.add.text(W / 2, H / 2, name, {
      fontFamily: FONT, fontSize: H < 600 ? '22px' : '30px', color: '#ffd700',
      stroke: '#5a0808', strokeThickness: 8,
    }).setOrigin(0.5).setAlpha(0).setScale(0.7);
    c.add([topBar, botBar, sub, title]);
    // Аватар существа из enemies/avatars — крупно над именем
    let avatar: Phaser.GameObjects.Image | null = null;
    if (face && this.scene.textures.exists(face)) {
      avatar = this.scene.add.image(W / 2, H / 2 - 110, face)
        .setOrigin(0.5).setAlpha(0).setScale(0.4);
      c.add(avatar);
    }
    this.root.add(c);
    // Полосы въезжают
    this.scene.tweens.add({ targets: topBar, y: barH / 2 + 1, duration: 240, ease: 'Cubic.easeOut' });
    this.scene.tweens.add({ targets: botBar, y: H - barH / 2 - 1, duration: 240, ease: 'Cubic.easeOut' });
    // Имя вспыхивает
    this.scene.tweens.add({ targets: [sub, title], alpha: 1, duration: 200, delay: 160 });
    this.scene.tweens.add({ targets: title, scale: 1, duration: 340, delay: 160, ease: 'Back.easeOut' });
    if (avatar) {
      this.scene.tweens.add({ targets: avatar, alpha: 1, scale: 1, duration: 320, delay: 120, ease: 'Back.easeOut' });
    }
    // ...и всё уезжает
    const fadeTargets: Phaser.GameObjects.GameObject[] = avatar ? [sub, title, avatar] : [sub, title];
    this.scene.tweens.add({
      targets: fadeTargets, alpha: 0, duration: 260, delay: 1750,
      onComplete: () => {
        this.scene.tweens.add({
          targets: topBar, y: -barH / 2 - 2, duration: 260, ease: 'Cubic.easeIn',
        });
        this.scene.tweens.add({
          targets: botBar, y: H + barH / 2 + 2, duration: 260, ease: 'Cubic.easeIn',
          onComplete: () => c.destroy(),
        });
      },
    });
  }

  /** Кинематографичное представление преемника крупным именем у врат (§H.13 #12). */
  successorIntro(name: string, heroTitle: string): void {
    this.bossIntro(name, heroTitle);
  }

  announce(text: string, color = '#ffffff'): void {
    if (this.announcementTypewriterEvent) {
      this.scene.time.removeEvent(this.announcementTypewriterEvent);
      this.announcementTypewriterEvent = null;
    }
    this.announceText.setText(text).setColor(color).setAlpha(1).setScale(1.25);
    this.scene.tweens.killTweensOf(this.announceText);
    this.scene.tweens.add({
      targets: this.announceText,
      scale: 1,
      duration: 220,
      ease: 'Back.easeOut',
    });
    this.scene.tweens.add({
      targets: this.announceText,
      alpha: 0,
      delay: 1700,
      duration: 520,
    });
  }

  /** Финальный анонс постепенно выводит буквы, используя ту же анимацию HUD. */
  announceTypewriter(text: string, color = '#ffffff', intervalMs = 65): void {
    this.announce(text, color);
    const characters = Array.from(text);
    this.announceText.setText('');
    if (characters.length === 0) return;
    let visible = 0;
    this.announcementTypewriterEvent = this.scene.time.addEvent({
      delay: Math.max(20, intervalMs),
      repeat: characters.length - 1,
      callback: () => {
        visible++;
        this.announceText.setText(characters.slice(0, visible).join(''));
        if (visible >= characters.length) this.announcementTypewriterEvent = null;
      },
    });
  }

  showBossBar(name: string): void {
    this.bossText.setText(name);
    this.bossGroup.setVisible(true);
  }

  updateBossBar(frac: number, hp?: number, maxHp?: number): void {
    const f = Phaser.Math.Clamp(frac, 0, 1);
    this.bossBar.setFraction(f);
    if (hp !== undefined && maxHp !== undefined) {
      const text = num(Math.max(0, Math.ceil(hp))) + ' / ' + num(Math.round(maxHp));
      if (this.bossHpText.text !== text) this.bossHpText.setText(text);
      // Подпись светлеет по мере падения здоровья, чтобы финальная фаза
      // читалась без вглядывания в цифры.
      this.bossHpText.setColor(f > 0.5 ? '#ffd9c0' : f > 0.2 ? '#ffb08a' : '#ff7a5e');
    }
  }

  /** Прячет весь HUD (экран результата) и возвращает его при воскрешении. */
  setVisible(v: boolean): void {
    this.root.setVisible(v);
    // Кнопка паузы — отдельные top-level объекты, контейнер их не покрывает
    this.pauseBg.setVisible(v);
    this.pauseTxt.setVisible(v);
    this.pauseHit.setVisible(v);
    if (v) this.pauseBg.setInteractive();
    else this.pauseHit.disableInteractive();
  }

  hideBossBar(): void {
    this.bossGroup.setVisible(false);
  }

  /**
   * Нижняя граница верхней полосы HUD в экранных пикселях.
   *
   * Окна (левел-ап, пауза) запускаются поверх сцены и гасят её затемнением,
   * но полоса босса с именем стоит ровно там, где у окна заголовок: лента
   * «НОВЫЙ УРОВЕНЬ!» ложилась прямо на имя босса и на его полосу. Сцена
   * спрашивает HUD, где кончается верхняя полоса, и опускает заголовок ниже.
   */
  overlayTopInset(): number {
    if (!this.bossGroup.visible) return this.sc(46);
    return this.bossGroup.y + this.sc(34);
  }

  /** Тост-уведомление о достижении (очередь, выезжает справа) */
  achievementToast(a: AchievementDef): void {
    audio.play('ach');
    this.toastQueue.push(a);
    this.pumpToast();
  }

  private pumpToast(): void {
    if (this.toastBusy || this.toastQueue.length === 0) return;
    this.toastBusy = true;
    const a = this.toastQueue.shift()!;
    const W = this.scene.scale.width;
    // Ниже кнопки паузы (она занимает верхние ~117 px) и с запасом
    // от правого края: раньше панель накрывала кнопку.
    const c = this.scene.add.container(W + 170, 152);
    const paper = makePanel(this.scene, 0, 0, 'paper', 250, 58);
    const icon = this.scene.add.image(-95, 0, a.icon).setDisplaySize(38, 38);
    const label = this.scene.add.text(-68, -14, t('ach.toast'), {
      fontFamily: FONT, fontSize: '12px', color: '#8a5b12',
    }).setOrigin(0, 0.5);
    const name = this.scene.add.text(-68, 7, a.name, {
      fontFamily: FONT, fontSize: '13px', color: '#3b2410',
      stroke: '#ffe9c0', strokeThickness: 3,
    }).setOrigin(0, 0.5);
    c.add([paper, icon, label, name]);
    this.root.add(c); // поверх остального HUD
    this.scene.tweens.add({ targets: c, x: W - 152, duration: 320, ease: 'Back.easeOut' });
    this.scene.time.delayedCall(2600, () => {
      this.scene.tweens.add({
        targets: c, x: W + 170, alpha: 0, duration: 280,
        onComplete: () => {
          c.destroy();
          this.toastBusy = false;
          this.pumpToast();
        },
      });
    });
  }

  /** Удаляет иконки прошлого героя, чтобы старый билд не оставался в HUD преемника. */
  resetBuildoutIcons(): void {
    for (const icon of this.weaponIcons.values()) {
      this.scene.tweens.killTweensOf(icon);
      icon.destroy();
    }
    this.weaponIcons.clear();
  }

  setIcon(id: string, iconKey: string, level: number, isPassive: boolean): void {
    let c = this.weaponIcons.get(id);
    const H = this.scene.scale.height;
    const slot = this.sc(SLOT_SIZE);
    if (!c) {
      c = this.scene.add.container(
        12 + this.weaponIcons.size * 40,
        H - hudBottomInset(),
      );
      // Подложка слота — настоящий ассет ui/buttons (маленькая квадратная
      // кнопка пака), а не залитый прямоугольник: иконки оружия и пассивок
      // стоят в одном ряду с кнопкой паузы и должны быть из того же
      // набора графики, что и она.
      const bg = this.scene.add.image(0, 0, 'btn-small-blue')
        .setDisplaySize(slot, slot).setOrigin(0, 0.5).setTint(0x9aa7b8);
      const ic = this.scene.add.image(4, -3, iconKey).setOrigin(0, 0)
        .setDisplaySize(this.sc(26), this.sc(26));
      const lvl = this.mkText('1', FS.small, {
        fontFamily: FONT, color: '#ffd76e',
        stroke: '#1b1008', strokeThickness: 3,
      }).setOrigin(1, 1);
      lvl.setPosition(slot - 3, slot / 2 - 2);
      c.add([bg, ic, lvl]);
      this.root.add(c);
      this.weaponIcons.set(id, c);
      void isPassive;
      // Новая иконка могла выйти за экран (мобильный) — пересчитать раскладку
      this.layout();
    }
    const lvlText = c.list[2] as Phaser.GameObjects.Text;
    const ic = c.list[1] as Phaser.GameObjects.Image;
    const bg = c.list[0] as Phaser.GameObjects.Image;
    if (level >= 6) {
      // Эволюция: звезда вместо цифры, золотая подложка и свечение иконки.
      // Кегль не трогаем — mkText уже задал FS.small и пересчитает его сам
      // при ресайзе; ручной setFontSize здесь ломал бы размер при смене окна.
      lvlText.setText('★');
      ic.setTint(0xffe9a0);
      bg.clearTint().setTint(0xffd76e);
      // Появление: пульс золотой вспышки
      this.scene.tweens.add({
        targets: c, scale: { from: 1.6, to: 1 }, duration: 340, ease: 'Back.easeOut',
      });
    } else {
      // Уровень 1..5 — цифра. Раньше она ставилась кеглем 8 px, минуя общий
      // минимум кириллицы: цифра превращалась в пиксельную кашу и не
      // читалась. Теперь это FS.small, масштабируется вместе с HUD.
      lvlText.setText(level > 0 ? `${level}` : '');
      ic.clearTint();
      bg.clearTint().setTint(level >= 5 ? 0xffd76e : 0x9aa7b8);
    }
  }

  destroy(): void {
    if (this.announcementTypewriterEvent) {
      this.scene.time.removeEvent(this.announcementTypewriterEvent);
      this.announcementTypewriterEvent = null;
    }
    this.scene.scale.off('resize', this.resizeHandler);
    window.removeEventListener('orientationchange', this.resizeHandler);
    for (const button of Object.values(this.speedupButtons)) button.destroy();
    this.speedupButtons = {};
    this.root.destroy();
    this.pauseBg.destroy();
    this.pauseTxt.destroy();
    this.pauseHit.destroy();
  }
}
