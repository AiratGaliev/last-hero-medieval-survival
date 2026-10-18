import Phaser from 'phaser';
import { DEPTH, FONT, GAME_DURATION, COMBO, MAX_LEVEL } from '../constants';
import type { AchievementDef } from '../achievements';
import { audio } from './Audio';
import { hudBottomInset, safeInsets, resetSafeInsets } from '../safeArea';
import { makePanel } from './Ui';
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
 * Горизонтальный запас справа под кнопку паузы: половина кнопки плюс
 * поле до края экрана. Всё, что выравнивается вправо в HUD, смещается
 * на эту величину, чтобы не наезжать на кнопку.
 */
const PAUSE_RESERVE = 70;

export class HUD {
  private scene: Phaser.Scene;
  private scoreMult = 1;
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
  private bossFill!: Phaser.GameObjects.Rectangle;
  private bossBg!: Phaser.GameObjects.Rectangle;
  private bossInner!: Phaser.GameObjects.Rectangle;
  private bossText!: Phaser.GameObjects.Text;
  private bossHpText!: Phaser.GameObjects.Text;
  /** Ширина полосы босса — не шире экрана (на мобильных 420px обрезалось) */
  private bossBarW = 420;

  // Серия убийств (комбо): счётчик + полоса затухания окна
  private comboText!: Phaser.GameObjects.Text;
  private comboBarBg!: Phaser.GameObjects.Rectangle;
  private comboBar!: Phaser.GameObjects.Rectangle;
  private comboShown = -1;
  private comboBaseY = 78;

  // Индикаторы целей за экраном: сундук (золото) и босс/элита (красный)
  private indChest!: Phaser.GameObjects.Container;
  private indEnemy!: Phaser.GameObjects.Container;
  private indChestShown = false;
  private indEnemyShown = false;

  // Виньетка низкого HP + тег сложности + тосты ачивок
  private vignetteRects: Phaser.GameObjects.Rectangle[] = [];
  private diffTag: Phaser.GameObjects.Text | null = null;
  private toastQueue: AchievementDef[] = [];
  private toastBusy = false;

  // ---- Поселение (TZ §B.8, §E.11, §H.2) ----
  private resGroup!: Phaser.GameObjects.Container;
  private resTexts: Record<string, Phaser.GameObjects.Text> = {};
  private resVisible = false;
  private settleGroup!: Phaser.GameObjects.Container;
  private settleInfraBar!: Phaser.GameObjects.Rectangle;
  private settlePopBar!: Phaser.GameObjects.Rectangle;
  private garrisonText!: Phaser.GameObjects.Text;
  private feedItems: Array<Phaser.GameObjects.Container> = [];
  private speedupBtns: Record<string, Phaser.GameObjects.Container> = {};
  /** Фон кнопки ускорения — гасится, когда ускорять нечего (§G.8). */
  private speedupBg: Record<string, Phaser.GameObjects.Rectangle> = {};
  private speedupHandlers: { repair: () => void; heal: () => void } = { repair: () => {}, heal: () => {} };

  private resizeHandler = () => { resetSafeInsets(); this.layout(); };

  constructor(scene: Phaser.Scene, onPause: () => void, opts: HudOpts = {}) {
    this.scene = scene;
    this.scoreMult = opts.scoreMult ?? 1;
    this.build(onPause, opts);
    scene.scale.on('resize', this.resizeHandler);
    window.addEventListener('orientationchange', this.resizeHandler);
  }

  private build(onPause: () => void, opts: HudOpts): void {
    const W = this.scene.scale.width;
    // scrollFactor(0) обязателен: иначе контейнер «уезжает» вместе с миром при скролле камеры
    this.root = this.scene.add.container(0, 0).setScrollFactor(0).setDepth(DEPTH.HUD);

    // Полоса опыта на всю ширину экрана: рамка из ui/bars + синяя заливка
    this.xpBar = new StatBar(this.scene, W / 2, 9, W, 'small', { fill: FILL.blue });
    this.root.add(this.xpBar.root);
    this.xpLabel = this.scene.add.text(0, 0, t('hud.level', { v: 1 }), {
      fontFamily: FONT, fontSize: '10px', color: '#ffffff',
      stroke: '#1b1008', strokeThickness: 3,
    }).setOrigin(0.5);

    this.timerText = this.scene.add.text(0, 0, '00:00', {
      fontFamily: FONT, fontSize: '18px', color: '#ffe9b0',
      stroke: '#1b1008', strokeThickness: 5,
    }).setOrigin(0, 0.5);

    this.statsText = this.scene.add.text(0, 0, '', {
      fontFamily: FONT, fontSize: '10px', color: '#d8c9a8',
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
    this.hpText = this.scene.add.text(0, 0, '', {
      fontFamily: FONT, fontSize: '10px', color: '#ffffff',
      stroke: '#1b1008', strokeThickness: 3,
    }).setOrigin(0, 0.5);

    this.goldIcon = this.scene.add.image(0, 0, 'icon-coin').setDisplaySize(14, 14);
    this.goldText = this.scene.add.text(0, 0, '0', {
      fontFamily: FONT, fontSize: '12px', color: '#ffd76e',
      stroke: '#1b1008', strokeThickness: 3,
    }).setOrigin(0, 0.5);

    this.scoreText = this.scene.add.text(0, 0, t('hud.score', { v: 0 }), {
      fontFamily: FONT, fontSize: '11px', color: '#ffd76e',
      stroke: '#1b1008', strokeThickness: 3,
    }).setOrigin(1, 0);

    // Тег сложности («Кошмар ×1.6»)
    if ((opts.scoreMult ?? 1) > 1) {
      this.diffTag = this.scene.add.text(0, 0, `${opts.diffName ?? ''} ×${opts.scoreMult}`, {
        fontFamily: FONT, fontSize: '10px', color: '#ff8866',
        stroke: '#1b1008', strokeThickness: 3,
      }).setOrigin(1, 0);
    }

    // Кнопка паузы (важно для мобильных). Живёт внутри root: контейнер уже
    // компенсирует зум камеры, поэтому кнопка всегда ровно PAUSE_SIZE
    // экранных пикселей. Отдельным объектом со своим setScale(1/zoom)
    // она выходила в натуральный размер текстуры — на 390 px это был
    // квадрат в четверть экрана.
    this.pauseBg = this.scene.add.image(0, 0, 'btn-small-blue').setDisplaySize(PAUSE_SIZE, PAUSE_SIZE);
    this.pauseTxt = this.scene.add.text(0, 0, 'II', {
      fontFamily: FONT, fontSize: '16px', color: '#ffffff',
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

    // Босс-бар (ширина подгоняется под экран в layout())
    this.bossGroup = this.scene.add.container(0, 0).setVisible(false);
    const barW = 420;
    this.bossBg = this.scene.add.rectangle(0, 0, barW, 18, 0x1b1008, 0.92).setOrigin(0.5);
    this.bossInner = this.scene.add.rectangle(0, 0, barW - 6, 12, 0x50120f).setOrigin(0.5);
    this.bossFill = this.scene.add.rectangle(-(barW - 6) / 2, 0, barW - 6, 12, 0xd03028).setOrigin(0, 0.5);
    this.bossHpText = this.scene.add.text(0, 0, '', {
      fontFamily: FONT, fontSize: '10px', color: '#ffd9c0',
      stroke: '#1b1008', strokeThickness: 4,
    }).setOrigin(0.5);
    this.bossText = this.scene.add.text(0, -16, t('hud.bossName'), {
      fontFamily: FONT, fontSize: '10px', color: '#ff9a8a',
      stroke: '#1b1008', strokeThickness: 4,
    }).setOrigin(0.5);
    this.bossGroup.add([this.bossBg, this.bossInner, this.bossFill, this.bossText, this.bossHpText]);

    // Виньетка низкого HP (пульсирующие красные края экрана)
    for (let i = 0; i < 4; i++) {
      const r = this.scene.add.rectangle(0, 0, 10, 10, 0xd03028, 0.3)
        .setOrigin(0, 0).setVisible(false);
      this.vignetteRects.push(r);
    }

    this.announceText = this.scene.add.text(0, 0, '', {
      fontFamily: FONT, fontSize: '20px', color: '#ffffff',
      stroke: '#7a1010', strokeThickness: 7,
    }).setOrigin(0.5).setAlpha(0);

    // Комбо-счётчик серии убийств (топ-справа, под счётом)
    this.comboText = this.scene.add.text(0, 0, '', {
      fontFamily: FONT, fontSize: '20px', color: '#ffd76e',
      stroke: '#7a1010', strokeThickness: 6,
    }).setOrigin(1, 0.5).setVisible(false);
    this.comboBarBg = this.scene.add.rectangle(0, 0, 68, 6, 0x1b1008, 0.85).setOrigin(1, 0.5).setVisible(false);
    this.comboBar = this.scene.add.rectangle(0, 0, 64, 3, 0xffd76e).setOrigin(1, 0.5).setVisible(false);

    // Стрелки-индикаторы за экраном (сундук/босс)
    // Сундук оставляем золотым (родной цвет спрайта), врага красим
    // в красный — так стрелки различаются с одного взгляда
    this.indChest = this.makeIndicator(0xffe9b0);
    this.indEnemy = this.makeIndicator(0xff5040);

    // ---- Блок РЕСУРСЫ (дерево/мясо/руда) — скрыт, пока всё по нулям (§B.8) ----
    this.resGroup = this.scene.add.container(0, 0).setVisible(false);
    const resDefs: Array<[string, string, number]> = [
      ['wood', 'res-wood', 0xffffff], ['meat', 'res-meat', 0xffffff], ['ore', 'res-ore', 0xfff0b0],
    ];
    resDefs.forEach(([key, tex, tint], i) => {
      const ic = this.scene.add.image(0, i * 20, tex).setDisplaySize(15, 15).setOrigin(0, 0.5);
      if (tint !== 0xffffff) ic.setTint(tint);
      const txt = this.scene.add.text(20, i * 20, '0', {
        fontFamily: FONT, fontSize: '11px', color: '#ffe9b0',
        stroke: '#1b1008', strokeThickness: 3,
      }).setOrigin(0, 0.5);
      this.resTexts[key] = txt;
      this.resGroup.add([ic, txt]);
    });

    // ---- Индикатор поселения: две мини-полосы (§E.11 — обязателен) ----
    this.settleGroup = this.scene.add.container(0, 0);
    const castleIc = this.scene.add.image(0, 0, 'castle').setDisplaySize(16, 13).setOrigin(0, 0.5);
    const barBgI = this.scene.add.rectangle(20, -4, 100, 5, 0x1b1008, 0.85).setOrigin(0, 0.5);
    const barBgP = this.scene.add.rectangle(20, 4, 100, 5, 0x1b1008, 0.85).setOrigin(0, 0.5);
    this.settleInfraBar = this.scene.add.rectangle(20, -4, 100, 5, 0xd0a050).setOrigin(0, 0.5);
    this.settlePopBar = this.scene.add.rectangle(20, 4, 100, 5, 0x6db44a).setOrigin(0, 0.5);
    this.garrisonText = this.scene.add.text(0, 14, '', {
      fontFamily: FONT, fontSize: '9px', color: '#d8c9a8',
      stroke: '#1b1008', strokeThickness: 3,
    }).setOrigin(0, 0.5);
    this.settleGroup.add([castleIc, barBgI, barBgP, this.settleInfraBar, this.settlePopBar, this.garrisonText]);

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
  }

  private camZoom(): number {
    return this.scene.cameras.main.zoom || 1;
  }

  layout(): void {
    const W = this.scene.scale.width;
    const H = this.scene.scale.height;
    this.xpBar.setWidth(W);
    const sa = safeInsets();
    this.xpBar.setPosition(W / 2, 9 + sa.top);
    this.xpLabel.setPosition(W / 2, 9 + sa.top);
    this.timerText.setPosition(12 + sa.left, 32 + sa.top);
    // HP-бар: под таймером; полоса 150px + сердце + текст
    this.hpIcon.setPosition(19 + sa.left, 55 + sa.top);
    this.hpBar.setPosition(30 + 154 / 2 + sa.left, 55 + sa.top);
    this.hpText.setPosition(30 + 154 + 6 + sa.left, 55 + sa.top);
    this.statsText.setPosition(12 + sa.left, 78 + sa.top);
    this.goldIcon.setPosition(12 + sa.left, 98 + sa.top);
    this.goldText.setPosition(30 + sa.left, 98 + sa.top);
    // Блок РЕСУРСЫ: под золотом матча (левый столбец, §B.8)
    this.resGroup.setPosition(12 + sa.left, 120 + sa.top);
    // Индикатор поселения: под ресурсами
    this.settleGroup.setPosition(12 + sa.left, 184 + sa.top);
    // Правый верхний угол занят кнопкой паузы: весь блок (счёт, метка
    // сложности, серия) заканчивается левее неё, иначе цифры ложились
    // прямо на кнопку.
    const rEdge = W - PAUSE_RESERVE;
    this.scoreText.setPosition(rEdge - sa.right, 34 + sa.top);
    this.diffTag?.setPosition(rEdge - sa.right, 54 + sa.top);
    // Комбо: под счётом, выравнивание вправо
    this.comboBaseY = 78 + sa.top;
    this.comboText.setPosition(rEdge - sa.right, this.comboBaseY);
    this.comboBarBg.setPosition(rEdge - sa.right, this.comboBaseY + 16);
    this.comboBar.setPosition(rEdge - sa.right - 2, this.comboBaseY + 16);
    // Анонс: на низких экранах опускаем ниже, чтобы не наезжать на босс-бар
    this.announceText.setPosition(W / 2, H < 600 ? Math.max(126, H * 0.3) : H * 0.22);
    // Босс-бар: на узких экранах опускаем под строку золота — иначе
    // перекрывает счётчик убийств (x=12, y=62)
    this.bossGroup.setPosition(W / 2, W < 620 ? 112 : 64);
    // Полоса босса не шире экрана: на мобильных (<430px) фиксированные 420px
    // обрезались краями экрана
    this.bossBarW = Math.min(420, W - 24);
    this.bossBg.setSize(this.bossBarW, 18);
    this.bossInner.setSize(this.bossBarW - 6, 12);
    this.bossFill.setPosition(-(this.bossBarW - 6) / 2, 0);
    // Виньетка: красные полосы по краям
    const e = 26;
    const [top, bottom, left, right] = this.vignetteRects;
    top?.setPosition(0, 0).setSize(W, e);
    bottom?.setPosition(0, H - e).setSize(W, e);
    left?.setPosition(0, 0).setSize(e, H);
    right?.setPosition(W - e, 0).setSize(e, H);
    // Иконки оружия: слева направо снизу, с переносом на новый ряд —
    // на мобильных 16 иконок (7 оружий + 9 пассивок) не помещаются в один ряд
    const perRow = Math.max(1, Math.floor((W - 24) / 40));
    let ix = 12;
    let iy = H - hudBottomInset();
    let inRow = 0;
    for (const c of this.weaponIcons.values()) {
      c.setPosition(ix, iy);
      inRow++;
      if (inRow >= perRow) {
        inRow = 0;
        ix = 12;
        iy -= 44;
      } else {
        ix += 40;
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
    const bx = W - 46;
    const by = 96;
    this.pauseBg.setPosition(bx, by);
    this.pauseTxt.setPosition(bx, by).setScale(1);
    this.pauseHit.setPosition(bx, by).setScale(1);
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

    // Виньетка низкого HP
    const hpFrac = s.hp / Math.max(1, s.maxHp);
    if (hpFrac < 0.3) {
      const pulse = 0.18 + Math.abs(Math.sin(this.scene.time.now / 260)) * 0.16;
      for (const r of this.vignetteRects) {
        r.setVisible(true).setAlpha(pulse);
      }
    } else {
      for (const r of this.vignetteRects) r.setVisible(false);
    }
  }

  /** Полоса HP: быстрая заливка + медленный «призрак» (классика файтингов) */
  private updateHpBar(hp: number, maxHp: number): void {
    const frac = Phaser.Math.Clamp(hp / Math.max(1, maxHp), 0, 1);
    this.hpBar.setFraction(frac);
    this.hpText.setText(`${Math.ceil(hp)}/${maxHp}`);
    this.hpText.setColor(frac > 0.25 ? '#ffffff' : '#ff9a8a');
  }

  // ================= ПОСЕЛЕНИЕ: HUD (TZ §B.8, §E.11) =================

  /** Блок РЕСУРСЫ: обновление по событию economy 'change', не каждый кадр. */
  updateResources(res: { wood: number; ore: number; meat: number }): void {
    const any = res.wood > 0 || res.ore > 0 || res.meat > 0;
    this.resGroup.setVisible(any);
    this.settleGroup.setPosition(12 + safeInsets().left, (any ? 184 : 122) + safeInsets().top);
    if (!any && !this.resVisible) return;
    this.resVisible = any;
    this.resTexts.wood.setText(`${res.wood}`);
    this.resTexts.meat.setText(`${res.meat}`);
    this.resTexts.ore.setText(`${res.ore}`);
  }

  /** Две полосы поселения + счётчик гарнизона (§E.11). */
  updateSettlement(infraFrac: number, popFrac: number, garrison: string): void {
    this.settleInfraBar.width = Math.max(2, 100 * Phaser.Math.Clamp(infraFrac, 0, 1));
    this.settlePopBar.width = Math.max(2, 100 * Phaser.Math.Clamp(popFrac, 0, 1));
    this.settleInfraBar.setFillStyle(infraFrac > 0.5 ? 0xd0a050 : infraFrac > 0.25 ? 0xe0a030 : 0xd03028);
    this.settlePopBar.setFillStyle(popFrac > 0.5 ? 0x6db44a : popFrac > 0.25 ? 0xe0a030 : 0xd03028);
    if (this.garrisonText.text !== garrison) this.garrisonText.setText(garrison);
  }

  /** Лента поселения: именные события, 3 последних по 6 сек (§H.2). */
  feed(text: string, color = '#ffe9b0'): void {
    const W = this.scene.scale.width;
    const H = this.scene.scale.height;
    const c = this.scene.add.container(14, H - 120);
    const bg = this.scene.add.rectangle(0, 0, Math.min(300, W - 28), 22, 0x1b1008, 0.78).setOrigin(0, 0.5);
    const label = this.scene.add.text(8, 0, text, {
      fontFamily: FONT, fontSize: '10px', color,
      stroke: '#1b1008', strokeThickness: 3,
      wordWrap: { width: Math.min(284, W - 44) },
    }).setOrigin(0, 0.5);
    c.add([bg, label]);
    this.root.add(c);
    this.feedItems.push(c);
    // Старые записи выталкиваются вверх и гаснут
    while (this.feedItems.length > 3) {
      const old = this.feedItems.shift()!;
      this.scene.tweens.add({ targets: old, alpha: 0, duration: 300, onComplete: () => old.destroy() });
    }
    this.scene.tweens.add({ targets: c, y: c.y - this.feedItems.length * 0, duration: 1 });
    this.scene.time.delayedCall(6000, () => {
      const i = this.feedItems.indexOf(c);
      if (i >= 0) this.feedItems.splice(i, 1);
      this.scene.tweens.add({ targets: c, alpha: 0, duration: 400, onComplete: () => c.destroy() });
    });
  }

  /** Кнопки ускорений (§G.8): callback’и GameScene. */
  setSpeedupHandlers(h: { repair: () => void; heal: () => void }): void {
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
  updateSpeedups(repairTarget: boolean, healTarget: boolean): void {
    const H = this.scene.scale.height;
    const defs: Array<[string, string, boolean, number, string]> = [
      ['repair', t('speedup.repair'), repairTarget, 0, t('speedup.noTarget')],
      ['heal', t('speedup.heal'), healTarget, 46, t('speedup.noTarget')],
    ];
    for (const [key, label, enabled, dy, why] of defs) {
      let c = this.speedupBtns[key];
      if (!c) {
        c = this.scene.add.container(0, 0);
        const bg = this.scene.add.rectangle(0, 0, 148, 30, 0x1b1008, 0.9).setOrigin(1, 0.5)
          .setStrokeStyle(1, 0x8a6d3b).setInteractive({ useHandCursor: true });
        const txt = this.scene.add.text(-8, 0, label, {
          fontFamily: FONT, fontSize: '10px', color: '#ffe9b0',
        }).setOrigin(1, 0.5);
        c.add([bg, txt]);
        this.speedupBg[key] = bg;
        bg.on('pointerdown', () => this.speedupHandlers[key as 'repair' | 'heal']());
        c.setSize(148, 30);
        this.speedupBtns[key] = c;
        this.root.add(c);
      }
      const list = c.list as Phaser.GameObjects.GameObject[];
      const txt = list[1] as Phaser.GameObjects.Text;
      const bgs = this.speedupBg[key];
      if (bgs) {
        bgs.setStrokeStyle(1, enabled ? 0x8a6d3b : 0x4a4038);
        bgs.setFillStyle(enabled ? 0x1b1008 : 0x14100b, 0.75);
        txt.setColor(enabled ? '#ffe9b0' : '#6f6558');
        txt.setText(enabled ? label : why);
        bgs.input!.enabled = enabled;
        bgs.input!.cursor = enabled ? 'pointer' : 'default';
      }
      c.setPosition(this.scene.scale.width - 14, H - hudBottomInset() - 60 - dy);
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
    const bg = icon.list[0] as Phaser.GameObjects.Rectangle | undefined;
    if (bg && bg.type === 'Rectangle') bg.setStrokeStyle(3, 0xffd700, 1);
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
    const bg = icon.list[0] as Phaser.GameObjects.Rectangle | undefined;
    if (bg && bg.type === 'Rectangle') bg.setStrokeStyle(0);
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
    this.comboBar.width = Math.max(0, 64 * Phaser.Math.Clamp(windowFrac, 0, 1));
    // Цвет: чем ближе к сбросу — тем краснее
    const frac = Phaser.Math.Clamp(windowFrac, 0, 1);
    this.comboBar.setFillStyle(frac > 0.4 ? 0xffd76e : frac > 0.18 ? 0xe0a030 : 0xd03028);
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

  announce(text: string, color = '#ffffff'): void {
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

  showBossBar(name: string): void {
    this.bossText.setText(name);
    this.bossGroup.setVisible(true);
  }

  updateBossBar(frac: number, hp?: number, maxHp?: number): void {
    const f = Phaser.Math.Clamp(frac, 0, 1);
    this.bossFill.setSize(Math.max(0, (this.bossBarW - 6) * f), 12);
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
      fontFamily: FONT, fontSize: '9px', color: '#8a5b12',
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

  setIcon(id: string, iconKey: string, level: number, isPassive: boolean): void {
    let c = this.weaponIcons.get(id);
    const H = this.scene.scale.height;
    if (!c) {
      c = this.scene.add.container(
        12 + this.weaponIcons.size * 40,
        H - hudBottomInset(),
      );
      const bg = this.scene.add.rectangle(0, 0, 34, 34, 0x1b1008, 0.75).setOrigin(0, 0.5);
      const ic = this.scene.add.image(4, -3, iconKey).setOrigin(0, 0).setDisplaySize(26, 26);
      const lvl = this.scene.add.text(30, 10, '1', {
        fontFamily: FONT, fontSize: '8px', color: '#ffd76e',
        stroke: '#1b1008', strokeThickness: 3,
      }).setOrigin(1, 1);
      c.add([bg, ic, lvl]);
      this.root.add(c);
      this.weaponIcons.set(id, c);
      void isPassive;
      // Новая иконка могла выйти за экран (мобильный) — пересчитать раскладку
      this.layout();
    }
    const lvlText = c.list[2] as Phaser.GameObjects.Text;
    const ic = c.list[1] as Phaser.GameObjects.Image;
    if (level >= 6) {
      // Эволюция: звезда вместо цифры, золотая рамка и свечение иконки
      lvlText.setText('★').setFontSize(11);
      ic.setTint(0xffe9a0);
      const bg = c.list[0] as Phaser.GameObjects.Rectangle;
      bg.setFillStyle(0x8a6a18, 0.92);
      bg.setStrokeStyle(2, 0xffd76e, 0.9);
      // Появление: пульс золотой вспышки
      this.scene.tweens.add({
        targets: c, scale: { from: 1.6, to: 1 }, duration: 340, ease: 'Back.easeOut',
      });
    } else {
      lvlText.setText(level > 0 ? `${level}` : '').setFontSize(8);
      // Подсветка максимума
      const bg = c.list[0] as Phaser.GameObjects.Rectangle;
      bg.setStrokeStyle(0, 0xffffff, 0);
      bg.setFillStyle(level >= 5 ? 0x6b4d12 : 0x1b1008, 0.8);
    }
  }

  destroy(): void {
    this.scene.scale.off('resize', this.resizeHandler);
    window.removeEventListener('orientationchange', this.resizeHandler);
    this.root.destroy();
    this.pauseBg.destroy();
    this.pauseTxt.destroy();
    this.pauseHit.destroy();
  }
}
