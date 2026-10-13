import Phaser from 'phaser';
import { FONT } from '../constants';
import type { UpgradeCard } from '../data';
import { audio } from '../systems/Audio';
import { makePanel } from '../systems/Ui';

// ============ Выбор улучшения при левел-апе ============

interface LevelUpData {
  getChoices: () => UpgradeCard[];
  onChoose: (card: UpgradeCard) => boolean; // true = готово
}

interface CardUi {
  container: Phaser.GameObjects.Container;
  paper: Phaser.GameObjects.NineSlice;
  icon: Phaser.GameObjects.Image;
  title: Phaser.GameObjects.Text;
  subtitle: Phaser.GameObjects.Text;
  desc: Phaser.GameObjects.Text;
  levelDots: Phaser.GameObjects.Text;
  card: UpgradeCard;
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

  constructor() {
    super('LevelUp');
  }

  create(payload: LevelUpData): void {
    if (this.lastPayload !== payload) {
      // Новая сессия (новый матч или новый вызов openLevelUp) — свежие карты
      this.currentChoices = null;
      this.lastPayload = payload;
    }
    this.payload = payload;

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

    // Затемнение — на весь видимый экран
    this.add.rectangle(width / 2, height / 2, width / this.overlayZoom + 80, height / this.overlayZoom + 80, 0x0a0a12, 0.72);

    // Заголовок
    const title = this.add.text(width / 2, height * 0.1, 'НОВЫЙ УРОВЕНЬ!', {
      fontFamily: FONT, fontSize: '34px', color: '#ffd76e',
      stroke: '#5a2d05', strokeThickness: 8,
    }).setOrigin(0.5);
    this.tweens.add({
      targets: title,
      scale: { from: 0.6, to: 1 },
      duration: 320,
      ease: 'Back.easeOut',
    });

    this.panel = this.add.container(0, 0);
    this.renderCards();

    this.add.text(width / 2, height - 18, 'выбери улучшение', {
      fontFamily: FONT, fontSize: '13px', color: '#cbb389',
    }).setOrigin(0.5);

    // При изменении размера окна — перерисовать карты на новых координатах (те же карты!)
    this.scale.on('resize', this.rebuild, this);
    this.events.once('shutdown', () => {
      this.scale.off('resize', this.rebuild, this);
    });
  }

  private rebuild = (): void => {
    this.scene.restart(this.payload as any);
  };

  private renderCards(): void {
    for (const c of this.cards) c.container.destroy();
    this.cards = [];
    // Кэшируем набор карт: при перезапуске сцены (ресайз) показываем те же карты,
    // при переходе к следующему левел-апу — генерируем новые.
    if (!this.currentChoices) this.currentChoices = this.payload.getChoices();
    const choices = this.currentChoices;
    const width = this.vw || this.scale.width;
    const height = this.vh || this.scale.height;
    const vertical = width < 720;

    const cardW = vertical ? Math.min(300, width - 48) : Math.min(280, (width - 80) / 3);
    const gap = vertical ? 20 : 24;
    const cardH = vertical ? cardW * 0.66 : cardW * 0.82;
    const totalH = vertical ? choices.length * (cardH + gap) : cardH;
    // Сдвиг вниз, чтобы карточки не наезжали на заголовок
    const vShift = vertical ? 34 : 0;

    choices.forEach((card, i) => {
      const x = vertical
        ? width / 2
        : width / 2 - (choices.length * (cardW + gap) - gap) / 2 + i * (cardW + gap) + cardW / 2;
      const y = vertical
        ? height * 0.5 - totalH / 2 + vShift + i * (cardH + gap) + cardH / 2
        : height * 0.52;

      const container = this.add.container(x, y);
      const paper = makePanel(this, 0, 0, card.kind === 'weapon-new' || card.kind === 'passive' ? 'paper' : 'paperSpecial', cardW, cardH);
      container.add(paper);

      const icon = this.add.image(0, -cardH * 0.32, card.icon)
        .setDisplaySize(58, 58);
      container.add(icon);

      const title = this.add.text(0, -cardH * 0.08, card.title, {
        fontFamily: FONT, fontSize: '15px', color: '#3b2410',
        align: 'center', wordWrap: { width: cardW - 50 },
      }).setOrigin(0.5, 0.5);
      container.add(title);

      const subtitle = this.add.text(0, cardH * 0.08, card.subtitle, {
        fontFamily: FONT, fontSize: '12px', color: card.kind === 'weapon-new' ? '#8a5b12' : '#8a5b12',
        align: 'center',
      }).setOrigin(0.5, 0.5);
      container.add(subtitle);

      const desc = this.add.text(0, cardH * 0.24, card.desc, {
        fontFamily: FONT, fontSize: '11px', color: '#57431f',
        align: 'center', wordWrap: { width: cardW - 56 },
      }).setOrigin(0.5, 0);
      container.add(desc);

      // Точки уровня
      const dots = card.levelTo !== undefined && card.levelTo <= 5 && card.kind !== 'heal' && card.kind !== 'gold'
        ? '●'.repeat(card.levelTo) + '○'.repeat(Math.max(0, 5 - card.levelTo))
        : '';
      const levelDots = this.add.text(0, cardH * 0.42, dots, {
        fontFamily: FONT, fontSize: '12px', color: '#b0803a',
      }).setOrigin(0.5);
      container.add(levelDots);

      container.setSize(cardW, cardH);
      container.setInteractive({ useHandCursor: true });

      container.on('pointerover', () => {
        this.tweens.add({ targets: container, scale: 1.05, duration: 120 });
        paper.setTint(0xfff2cc);
      });
      container.on('pointerout', () => {
        this.tweens.add({ targets: container, scale: 1, duration: 120 });
        paper.clearTint();
      });
      container.on('pointerdown', () => {
        audio.play('click');
        this.chooseCard(card);
      });

      // Появление
      container.setScale(0.4);
      container.setAlpha(0);
      this.tweens.add({
        targets: container,
        scale: 1, alpha: 1,
        delay: 90 * i,
        duration: 260,
        ease: 'Back.easeOut',
      });

      this.cards.push({ container, paper, icon, title, subtitle, desc, levelDots, card });
    });
  }

  private chooseCard(card: UpgradeCard): void {
    const done = this.payload.onChoose(card);
    if (done) {
      // Матч продолжается — следующий левел-ап сгенерирует новые карты
      this.currentChoices = null;
      this.scene.stop();
    } else {
      // Следующий выбор — новый набор карт
      this.currentChoices = null;
      for (const c of this.cards) {
        this.tweens.add({
          targets: c.container,
          alpha: 0, y: c.container.y - 30,
          duration: 180,
          onComplete: () => c.container.destroy(),
        });
      }
      this.cards = [];
      this.time.delayedCall(190, () => this.renderCards());
    }
  }
}
