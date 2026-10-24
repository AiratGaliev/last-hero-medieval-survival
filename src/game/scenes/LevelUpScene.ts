import Phaser from 'phaser';
import { armIdleThrottle } from '../systems/IdleThrottle';
import { Cursor } from '../systems/Cursor';
import { DEPTH, FONT } from '../constants';
import { makeRibbon, OverlayLayer } from '../systems/Ui';
import { makeCornerFrame, type CornerFrame } from '../systems/Corners';
import type { UpgradeCard } from '../data';
import { audio } from '../systems/Audio';
import { makePanel } from '../systems/Ui';
import { outlineFor, shrinkToHeight, FONT_FLOOR } from '../systems/Text';
import { t } from '../../i18n';

// ============ Выбор улучшения при левел-апе ============

interface LevelUpData {
  getChoices: () => UpgradeCard[];
  onChoose: (card: UpgradeCard) => boolean; // true = выбран последний уровень наград
  /** Вызывается после визуального эффекта повышения уровня, перед возвратом в матч. */
  onFinished?: () => void;
  /** Нормализованная позиция героя в игровом viewport до паузы мира. */
  heroPoint?: { x: number; y: number };
  /**
   * Нижняя граница верхней полосы HUD (полоса босса) в экранных пикселях.
   *
   * Окно открывается поверх живой сцены, и её верхняя полоса стоит ровно на
   * той же высоте, что и заголовок окна. Без этого поля лента «НОВЫЙ
   * УРОВЕНЬ!» ложилась прямо на имя босса и на его полосу здоровья.
   */
  topInset?: number;
}

interface CardUi {
  container: Phaser.GameObjects.Container;
  paper: Phaser.GameObjects.NineSlice;
  icon: Phaser.GameObjects.Image | Phaser.GameObjects.Sprite;
  title: Phaser.GameObjects.Text;
  subtitle: Phaser.GameObjects.Text;
  desc: Phaser.GameObjects.Text;
  levelDots: Phaser.GameObjects.Text;
  card: UpgradeCard;
  /** Угловая рамка из ассетов: появляется на наведённой карточке */
  frame: CornerFrame;
}

export class LevelUpScene extends Phaser.Scene {
  private payload!: LevelUpData;
  private cards: CardUi[] = [];
  private panel!: Phaser.GameObjects.Container;
  /** Текущий набор карт — сохраняется при перезапуске сцены (ресайз окна) */
  private currentChoices: UpgradeCard[] | null = null;
  /** Метка сессии: новый payload = новый матч/левел-ап — сбрасываем кэш карт */
  private lastPayload: LevelUpData | null = null;
  /** Виртуальное полотно (мобильные): контент зумится камерой, ничего не обрезается */
  private vw = 0;
  private vh = 0;
  private overlayZoom = 1;
  /** Слой окна выше HUD (см. systems/Ui.ts OverlayLayer). */
  private ui!: OverlayLayer;
  /** Клавиатурная навигация: подсвеченная карточка (−1 = ничего) */
  private hoverIdx = -1;
  /** Защита от повторного выбора, пока карточки закрываются и играет эффект левел-апа. */
  private choosing = false;
  /** Центр ленты-заголовка и её высота: от них считается блок карточек. */
  private titleY = 0;
  private ribbonH = 0;

  constructor() {
    super('LevelUp');
  }

  /** Курсор в стиле Tiny Swords: следит за наведением и переключает
   *  состояние. В CSS у курсора !important — он перебивает инлайновый
   *  cursor, который Phaser ставит через useHandCursor. */
  private cursor!: Cursor;

  private showHeroLevelUpBeam(
    point: { x: number; y: number } | undefined,
    width: number,
    height: number,
  ): void {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    const x = Phaser.Math.Clamp(point.x, 0, 1) * width;
    const y = Phaser.Math.Clamp(point.y, 0.12, 0.9) * height;
    const beamHeight = Math.min(180, height * 0.28);

    // Луч и золотое кольцо рисуются в overlay-сцене, чьи часы продолжают идти,
    // пока GameScene заморожена. Поэтому эффект не зависает вместе с миром.
    const beam = this.add.graphics().setPosition(x, y).setAlpha(0)
      .setBlendMode(Phaser.BlendModes.ADD);
    beam.fillStyle(0xffe9a0, 0.28);
    beam.beginPath();
    beam.moveTo(-18, -beamHeight);
    beam.lineTo(18, -beamHeight);
    beam.lineTo(8, 4);
    beam.lineTo(-8, 4);
    beam.closePath();
    beam.fillPath();
    this.ui.add(beam);

    const ring = this.add.circle(x, y, 9)
      .setStrokeStyle(3, 0xffd76e, 0.9)
      .setAlpha(0);
    this.ui.add(ring);

    this.tweens.add({
      targets: beam,
      alpha: { from: 0, to: 0.95 },
      scaleX: { from: 0.6, to: 1.2 },
      duration: 220,
      yoyo: true,
      repeat: 1,
      ease: 'Sine.Out',
      onComplete: () => beam.destroy(),
    });
    this.tweens.add({
      targets: ring,
      alpha: { from: 0, to: 0.95 },
      scale: 3.2,
      duration: 420,
      ease: 'Cubic.easeOut',
      onComplete: () => ring.destroy(),
    });
  }

  create(payload: LevelUpData): void {
    this.cursor = new Cursor(this);
    if (this.lastPayload !== payload) {
      // Новая сессия (новый матч или новый вызов openLevelUp) — свежие карты
      this.currentChoices = null;
      this.lastPayload = payload;
    }
    this.payload = payload;
    this.choosing = false;

    // Мобильные экраны: виртуальное полотно 460×780 + зум камеры
    const realW = this.scale.width;
    const realH = this.scale.height;
    const mobile = realW < 720;
    this.overlayZoom = mobile ? Math.min(realW / 460, realH / 780) : 1;
    this.vw = mobile ? 460 : realW;
    this.vh = mobile ? 780 : realH;
    // centerOn центрирует виртуальное полотно (с учётом origin 0.5 камеры)
    this.cameras.main.setZoom(this.overlayZoom);
    this.cameras.main.centerOn(this.vw / 2, this.vh / 2);
    const width = this.vw;
    const height = this.vh;

    // Затемнение — на весь видимый экран.
    //
    // Слой лежит ВЫШЕ HUD (DEPTH.HUD): окно левел-апа запускается поверх
    // игровой сцены, и раньше затемнение ложилось под счётчики, полосу
    // опыта и иконки оружия — они светились сквозь «выбор карты».
    this.ui = new OverlayLayer(this, DEPTH.OVERLAY + 2);
    this.ui.rectangle(width / 2, height / 2, width / this.overlayZoom + 80, height / this.overlayZoom + 80, 0x0a0a12, 0.72);
    // Заголовок на ленте. Лента не даёт заголовку висеть в пустом
    // тёмном поле и повторяет стиль остальных экранов.
    //
    // Высота ленты считается от кегля заголовка: лента из пака — это
    // баннер с изгибами по краям, и надпись должна помещаться в её
    // «живую» часть, а не наезжать на изгибы.
    const titleFont = Math.round(Math.min(30, Math.max(20, height * 0.046)));
    const ribbonH = Math.round(titleFont * 2.3);
    // Заголовок не наезжает на верхнюю полосу HUD: полоса босса с именем
    // стоит на той же высоте, и лента ложилась прямо на неё. Сцена передаёт
    // её нижнюю границу; если полосы нет — заголовок идёт по обычной
    // десятой части высоты.
    const titleY = Math.max(height * 0.1, (payload.topInset ?? 0) + ribbonH / 2 + 12);
    this.titleY = titleY;
    this.ribbonH = ribbonH;
    // ВАЖНО: порядок добавления. В контейнере слоя `setDepth` не сортирует
    // детей — Phaser рисует их в порядке добавления. Лента идёт ПЕРВОЙ,
    // иначе она ложится поверх заголовка и закрывает его целиком.
    const probe = this.ui.text(width / 2, 0, t('levelup.title'), {
      fontFamily: FONT, fontSize: `${titleFont}px`, color: '#5a2d05',
      stroke: '#ffe9b0', strokeThickness: outlineFor(titleFont),
    }).setOrigin(0.5).setVisible(false);
    const ribbonW = Math.min(width - 40, Math.max(220, probe.width + 90));
    probe.destroy();
    const ribbon = this.ui.add(
      makeRibbon(this, width / 2, titleY, ribbonW, 'ribbon-yellow', ribbonH),
    );
    const title = this.ui.text(width / 2, titleY, t('levelup.title'), {
      fontFamily: FONT, fontSize: `${titleFont}px`, color: '#5a2d05',
      stroke: '#ffe9b0', strokeThickness: outlineFor(titleFont),
    }).setOrigin(0.5);
    this.tweens.add({
      targets: title,
      scale: { from: 0.6, to: 1 },
      duration: 320,
      ease: 'Back.easeOut',
    });
    // Лента «разворачивается» вместе с заголовком
    ribbon.setScale(0.4, 1);
    this.tweens.add({
      targets: ribbon,
      scaleX: 1,
      duration: 340,
      ease: 'Back.easeOut',
    });
    this.tweens.add({
      targets: ribbon,
      scaleY: { from: 0.2, to: 1 },
      duration: 260,
      ease: 'Back.easeOut',
    });

    this.panel = this.ui.group(0, 0);
    this.renderCards();

    this.ui.text(width / 2, height - 18, t('levelup.hint'), {
      fontFamily: FONT, fontSize: '13px', color: '#cbb389',
      stroke: '#1b1008', strokeThickness: 3,
    }).setOrigin(0.5);

    // Клавиатурная навигация: 1/2/3 — мгновенный выбор, стрелки — подсветка,
    // Enter/Space — выбор подсвеченной карточки
    const kb = this.input.keyboard;
    if (kb) {
      kb.on('keydown-ONE', () => this.chooseByIndex(0));
      kb.on('keydown-NUMPAD_ONE', () => this.chooseByIndex(0));
      kb.on('keydown-TWO', () => this.chooseByIndex(1));
      kb.on('keydown-NUMPAD_TWO', () => this.chooseByIndex(1));
      kb.on('keydown-THREE', () => this.chooseByIndex(2));
      kb.on('keydown-NUMPAD_THREE', () => this.chooseByIndex(2));
      kb.on('keydown-RIGHT', () => this.moveHover(1));
      kb.on('keydown-LEFT', () => this.moveHover(-1));
      kb.on('keydown-UP', () => this.moveHover(-1));
      kb.on('keydown-DOWN', () => this.moveHover(1));
      kb.on('keydown-ENTER', () => this.chooseHovered());
      kb.on('keydown-SPACE', () => this.chooseHovered());
    }

    // При изменении размера окна — перерисовать карты на новых координатах (те же карты!)
    this.scale.on('resize', this.rebuild, this);
    this.events.once('shutdown', () => {
      this.scale.off('resize', this.rebuild, this);
      this.hoverIdx = -1;
    });

    // Карточки статичны: без ввода рендерим 15 fps (матч под ними рисуется)
    armIdleThrottle(this);
  }

  private rebuild = (): void => {
    this.scene.restart(this.payload as any);
  };

  private renderCards(): void {
    for (const c of this.cards) c.container.destroy();
    this.cards = [];
    this.hoverIdx = -1;
    // Кэшируем набор карт: при перезапуске сцены (ресайз) показываем те же карты,
    // при переходе к следующему левел-апу — генерируем новые.
    if (!this.currentChoices) this.currentChoices = this.payload.getChoices();
    const choices = this.currentChoices;
    const width = this.vw || this.scale.width;
    const height = this.vh || this.scale.height;
    const vertical = width < 720;

    const cardW = vertical ? Math.min(300, width - 48) : Math.min(280, (width - 80) / 3);
    const gap = vertical ? 20 : 24;
    // Блок карточек начинается ПОД лентой-заголовком: лента опускается ниже
    // полосы босса, и на телефоне старая привязка к середине экрана уводила
    // первую карточку прямо под ленту.
    const blockTop = this.titleY + this.ribbonH / 2 + 24;
    const blockRoom = height - blockTop - 20;
    const wantedH = vertical ? cardW * 0.66 : cardW * 0.82;
    const cardH = Math.round(Math.min(
      wantedH,
      Math.max(120, (blockRoom - (choices.length - 1) * gap) / choices.length),
    ));
    const totalH = choices.length * cardH + (choices.length - 1) * gap;

    choices.forEach((card, i) => {
      const x = vertical
        ? width / 2
        : width / 2 - (choices.length * (cardW + gap) - gap) / 2 + i * (cardW + gap) + cardW / 2;
      const y = vertical
        ? blockTop + totalH / 2 - (totalH - cardH) / 2 + i * (cardH + gap)
        : height * 0.52;

      const container = this.ui.group(x, y);
      const isEvo = card.kind === 'weapon-evolve';
      // ВСЕ карточки — кремовый пергамент, как строки «Лавки».
      //
      // Раньше карточки лечения и золота брали `paperSpecial` — тёмно-синий
      // лист, и в одном ряду оказывались две разные фактуры. На скриншоте
      // это читалось как чужеродная тёмная плита, а её тёмная кромка
      // вылезала из-под соседней карточки отдельной тёмной полосой.
      // Отличие карточек теперь держит тонировка эволюции и угловая рамка,
      // а не смена материала.
      const paper = makePanel(this, 0, 0, 'paper', cardW, cardH);
      container.add(paper);

      // Эволюция: пульсирующее золотое сияние за карточкой + искры
      if (isEvo) {
        paper.setTint(0xffd76e);
        const glow = this.add.rectangle(0, 0, cardW + 18, cardH + 18)
          .setStrokeStyle(3, 0xffd76e, 0.9).setFillStyle(0xffd76e, 0.06);
        container.addAt(glow, 0);
        this.tweens.add({
          targets: glow,
          alpha: { from: 1, to: 0.45 },
          scale: { from: 1, to: 1.04 },
          duration: 800,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut',
        });
        // Мерцающие звёздочки вокруг карточки
        for (let s = 0; s < 5; s++) {
          const star = this.add.text(
            Phaser.Math.Between(-cardW / 2 + 8, cardW / 2 - 8),
            Phaser.Math.Between(-cardH / 2 + 6, cardH / 2 - 6),
            '✦',
            { fontFamily: FONT, fontSize: '13px', color: '#ffd76e' },
          ).setOrigin(0.5).setAlpha(0);
          container.add(star);
          this.tweens.add({
            targets: star,
            alpha: { from: 0, to: 1 },
            scale: { from: 0.4, to: 1 },
            duration: 500,
            delay: s * 220 + Phaser.Math.Between(0, 160),
            yoyo: true,
            repeat: -1,
            repeatDelay: 700 + Phaser.Math.Between(0, 400),
            ease: 'Sine.easeInOut',
          });
        }
      }

      // У пороховой бочки есть отдельный спрайт-лист с горящим фитилём.
      // В карточке показываем именно этот ассет и его анимацию, а не условную UI-иконку.
      const iconSize = Math.min(72, cardH * 0.32);
      const isBombWeapon = card.id === 'bomb'
        && (card.kind === 'weapon-new' || card.kind === 'weapon-up' || card.kind === 'weapon-evolve');
      const icon = isBombWeapon
        ? this.add.sprite(0, -cardH * 0.30, 'barrel').play('barrel-burn')
        : this.add.image(0, -cardH * 0.30, card.icon);
      icon.setDisplaySize(iconSize, iconSize);
      if (isEvo) icon.setTint(0xffe9a0);
      container.add(icon);
      // Эволюция: иконка «дышит» золотом
      if (isEvo) {
        this.tweens.add({
          targets: icon,
          scale: { from: 1, to: 1.12 },
          duration: 700,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut',
        });
      }

      // Раскладка карточки — по полосам, а не «как получится»: полосы
      // считаются от высоты карточки, поэтому одинаково работают и на
      // узкой карточке телефона, и на широкой десктопной.
      const nameY = -cardH * 0.05;
      const subY = cardH * 0.10;
      const descTop = cardH * 0.18;
      const innerBottom = cardH / 2 - 8;
      const dotsMinY = cardH * 0.40;

      const title = this.add.text(0, nameY, card.title, {
        fontFamily: FONT, fontSize: '16px', color: '#3b2410',
        align: 'center', wordWrap: { width: cardW - 50 },
      }).setOrigin(0.5, 0.5);
      container.add(title);

      const subtitle = this.add.text(0, subY, card.subtitle, {
        fontFamily: FONT, fontSize: isEvo ? '13px' : '12px',
        color: isEvo ? '#9a6a08' : '#8a5b12',
        align: 'center',
      }).setOrigin(0.5, 0.5);
      container.add(subtitle);

      const desc = this.add.text(0, descTop, card.desc, {
        fontFamily: FONT, fontSize: '12px', color: '#57431f',
        align: 'center', wordWrap: { width: cardW - 56 },
      }).setOrigin(0.5, 0);
      container.add(desc);

      // Точки уровня (эволюция — пять точек + звезда)
      const dots = card.kind === 'weapon-evolve'
        ? '●●●●●★'
        : card.levelTo !== undefined && card.levelTo <= 5 && card.kind !== 'heal' && card.kind !== 'gold'
          ? '●'.repeat(card.levelTo) + '○'.repeat(Math.max(0, 5 - card.levelTo))
          : '';

      // Описание и точки уровня делят нижнюю часть карточки.
      //
      // Точки стоят на своей высоте, описание занимает всё, что осталось
      // до них, и ужимается до порога читаемости. Раньше описание получало
      // фиксированный запас и на невысокой карточке («Бросок сокола по
      // направлению атаки») наезжало на точки.
      let dotsY = Math.min(Math.max(dotsMinY, innerBottom - 12), innerBottom);
      if (dots) shrinkToHeight(desc, Math.max(18, dotsY - descTop - 8), 12, FONT_FLOOR);
      dotsY = Math.min(
        Math.max(dotsY, descTop + desc.height + 8),
        Math.max(dotsMinY, innerBottom - 12),
      );
      const levelDots = this.add.text(0, dotsY, dots, {
        fontFamily: FONT, fontSize: '12px', color: isEvo ? '#9a6a08' : '#b0803a',
      }).setOrigin(0.5);
      container.add(levelDots);

      // Рамка из четырёх углов: подсвечивает выбранную карточку
      const frame = makeCornerFrame(this, 0, 0, cardW + 10, cardH + 10, {
        cornerScale: 1.15, depth: 20,
      });
      container.add(frame.container);
      frame.setVisible(false);

      container.setSize(cardW, cardH);
      container.setInteractive({ useHandCursor: true });

      container.on('pointerover', () => {
        this.setHover(i);
      });
      container.on('pointerout', () => {
        this.clearHover(i);
      });
      container.on('pointerdown', () => {
        audio.play('click');
        this.chooseCard(card);
      });

      // Появление (эволюция — крупнее и с «взрывом»)
      container.setScale(isEvo ? 0.3 : 0.4);
      container.setAlpha(0);
      this.tweens.add({
        targets: container,
        scale: 1, alpha: 1,
        delay: 90 * i,
        duration: isEvo ? 380 : 260,
        ease: 'Back.easeOut',
      });

      this.cards.push({ container, paper, icon, title, subtitle, desc, levelDots, card, frame });
    });
  }

  // ================================================================
  // Клавиатурная навигация
  // ================================================================

  /** Подсветить карточку (без выбора) */
  private setHover(idx: number): void {
    if (idx < 0 || idx >= this.cards.length) return;
    if (this.hoverIdx === idx) return;
    this.clearHoverVisual();
    this.hoverIdx = idx;
    const c = this.cards[idx];
    if (!c) return;
    this.tweens.add({ targets: c.container, scale: 1.05, duration: 120 });
    c.paper.setTint(0xfff2cc);
    c.frame.setVisible(true);
    // Лёгкое дыхание рамки: приглашение выбрать именно эту карточку
    this.tweens.killTweensOf(c.frame.container);
    this.tweens.add({
      targets: c.frame.container,
      alpha: { from: 0.72, to: 1 },
      duration: 620, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    });
  }

  private clearHoverVisual(): void {
    if (this.hoverIdx < 0) return;
    const c = this.cards[this.hoverIdx];
    if (c && c.container.active) {
      this.tweens.add({ targets: c.container, scale: 1, duration: 120 });
      c.paper.clearTint();
      this.tweens.killTweensOf(c.frame.container);
      c.frame.setVisible(false);
    }
    this.hoverIdx = -1;
  }

  private clearHover(idx: number): void {
    if (this.hoverIdx !== idx) return;
    this.clearHoverVisual();
  }

  private moveHover(dir: number): void {
    if (this.cards.length === 0) return;
    const base = this.hoverIdx < 0 ? (dir > 0 ? -1 : 0) : this.hoverIdx;
    const next = (base + dir + this.cards.length) % this.cards.length;
    this.setHover(next);
    audio.play('click');
  }

  private chooseByIndex(idx: number): void {
    if (idx < 0 || idx >= this.cards.length) return;
    audio.play('click');
    this.chooseCard(this.cards[idx].card);
  }

  private chooseHovered(): void {
    if (this.hoverIdx >= 0 && this.hoverIdx < this.cards.length) {
      this.chooseByIndex(this.hoverIdx);
    } else if (this.cards.length > 0) {
      // Ничего не подсвечено — выбираем среднюю карточку (как «Enter по умолчанию»)
      this.chooseByIndex(Math.floor(this.cards.length / 2));
    }
  }

  private chooseCard(card: UpgradeCard): void {
    if (this.choosing) return;
    this.choosing = true;

    const done = this.payload.onChoose(card);
    this.currentChoices = null;
    for (const c of this.cards) {
      // Бесконечные твиды сияния/звёзд эволюции — убить до уничтожения.
      this.tweens.killTweensOf(c.container);
      c.container.list.forEach((child) => this.tweens.killTweensOf(child));
      c.container.disableInteractive();
      this.tweens.add({
        targets: c.container,
        alpha: 0,
        scale: 0.86,
        y: c.container.y - 24,
        duration: 180,
        ease: 'Cubic.easeIn',
        onComplete: () => c.container.destroy(),
      });
    }
    this.cards = [];

    if (done) {
      // Карточки исчезают ПЕРЕД вспышкой: эффект не должен теряться за UI.
      // Match оставляем на паузе, пока игрок видит результат повышения уровня.
      this.scale.off('resize', this.rebuild, this);
      this.time.delayedCall(200, () => {
        this.showHeroLevelUpBeam(
          this.payload.heroPoint,
          this.vw || this.scale.width,
          this.vh || this.scale.height,
        );
        this.time.delayedCall(480, () => {
          this.payload.onFinished?.();
          this.scene.stop();
        });
      });
    } else {
      // Несколько уровней подряд: следующий набор показываем после выхода старого.
      this.time.delayedCall(190, () => {
        this.choosing = false;
        this.renderCards();
      });
    }
  }
}
