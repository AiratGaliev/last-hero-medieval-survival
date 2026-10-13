import Phaser from 'phaser';
import { FONT } from '../constants';
import { HEROES, WEAPONS, type HeroId } from '../data';
import { audio } from '../systems/Audio';
import { makePanel, makeButton } from '../systems/Ui';

// ============ Главное меню с выбором героя ============

interface ScoreRow {
  id: number;
  name: string;
  score: number;
  kills: number;
  level: number;
  victory: boolean;
}

interface HeroCard {
  container: Phaser.GameObjects.Container;
  sprite: Phaser.GameObjects.Sprite;
  frame: Phaser.GameObjects.Graphics;
  heroId: HeroId;
}

const HERO_ORDER: HeroId[] = ['warrior', 'archer', 'lancer'];

export class MenuScene extends Phaser.Scene {
  private overlay: Phaser.GameObjects.Container | null = null;
  private logo!: Phaser.GameObjects.Text;
  private logo2!: Phaser.GameObjects.Text;
  private heroCards: HeroCard[] = [];
  private selectedHero: HeroId = 'warrior';

  constructor() {
    super('Menu');
  }

  create(): void {
    const { width, height } = this.scale;
    this.heroCards = [];

    // Сохранённый герой
    const saved = window.localStorage.getItem('tss-hero');
    if (saved === 'warrior' || saved === 'archer' || saved === 'lancer') {
      this.selectedHero = saved;
    }

    // Фон: травка + вода
    this.add.tileSprite(width / 2, height / 2, width + 120, height + 120, 'grass-tile');
    this.add.tileSprite(width / 2, -60, width + 400, 200, 'water-tile');
    this.add.tileSprite(width / 2, height + 60, width + 400, 200, 'water-tile');
    this.add.tileSprite(-80, height / 2, 200, height + 400, 'water-tile');
    this.add.tileSprite(width + 80, height / 2, 200, height + 400, 'water-tile');

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

    // Замок на фоне
    this.add.image(width * 0.5, height * 0.30, 'castle').setScale(0.8).setAlpha(0.55);
    const sheep = this.add.sprite(width * 0.12, height * 0.88, 'sheep').setScale(0.65).setAlpha(0.9);
    sheep.play('sheep-idle');
    const pawn = this.add.sprite(width * 0.88, height * 0.9, 'grunt-idle').setScale(0.45).setAlpha(0.9);
    pawn.play('grunt-idle');
    void sheep; void pawn;

    // Логотип
    const titleY = Math.max(52, height * 0.085);
    this.logo = this.add.text(width / 2, titleY, 'TINY SWORD', {
      fontFamily: FONT, fontSize: width < 700 ? '38px' : '52px', color: '#ffd76e',
      stroke: '#5a2d05', strokeThickness: 12,
    }).setOrigin(0.5);
    this.logo2 = this.add.text(width / 2, titleY + (width < 700 ? 44 : 54), 'SURVIVORS', {
      fontFamily: FONT, fontSize: width < 700 ? '32px' : '44px', color: '#ffffff',
      stroke: '#7a1010', strokeThickness: 11,
    }).setOrigin(0.5);
    this.tweens.add({
      targets: [this.logo, this.logo2],
      scale: { from: 0.7, to: 1 },
      duration: 480,
      ease: 'Back.easeOut',
    });
    if (width >= 760) {
      this.add.image(width / 2 - 330, titleY + 20, 'swords').setDisplaySize(110, 158).setAlpha(0.85);
      this.add.image(width / 2 + 330, titleY + 20, 'swords').setDisplaySize(110, 158).setFlipX(true).setAlpha(0.85);
    }

    // ---------- Выбор героя ----------
    const label = this.add.text(width / 2, titleY + (width < 700 ? 96 : 108), '— ВЫБЕРИ ГЕРОЯ —', {
      fontFamily: FONT, fontSize: '14px', color: '#3b2410',
      stroke: '#ffe9c0', strokeThickness: 4,
    }).setOrigin(0.5).setAlpha(0.9);
    void label;

    const cardW = Math.min(250, (width - 56) / 3);
    const cardH = 216;
    const gap = 16;
    const cardsY = height * 0.46;
    HERO_ORDER.forEach((id, i) => {
      const x = width / 2 - (3 * cardW + 2 * gap - gap) / 2 + i * (cardW + gap) + cardW / 2;
      this.createHeroCard(x, cardsY, id, cardW, cardH);
    });

    // ---------- Кнопки ----------
    const btnY = Math.min(height * 0.84, cardsY + cardH / 2 + 58);
    makeButton(this, width / 2, btnY, Math.min(320, width - 80), 60, 'ИГРАТЬ', () => {
      audio.unlock();
      window.localStorage.setItem('tss-hero', this.selectedHero);
      this.scene.start('Game', { hero: this.selectedHero });
    }, 'blue', width < 700 ? 20 : 24);

    const smallW = Math.min(190, (width - 100) / 2);
    const smallY = btnY + 62;
    makeButton(this, width / 2 - smallW / 2 - 10, smallY, smallW, 46, 'КАК ИГРАТЬ', () => this.showHowTo(), 'red', 14);
    makeButton(this, width / 2 + smallW / 2 + 10, smallY, smallW, 46, 'РЕКОРДЫ', () => this.showRecords(), 'red', 14);

    this.add.text(width / 2, height - 14, 'Phaser 4 • ассеты Pixel Frog «Tiny Swords»', {
      fontFamily: FONT, fontSize: '11px', color: '#3b2410',
    }).setOrigin(0.5).setAlpha(0.8);

    this.refreshSelection();
    this.scale.on('resize', this.layout, this);
    this.events.once('shutdown', () => this.scale.off('resize', this.layout, this));
  }

  private createHeroCard(x: number, y: number, heroId: HeroId, cardW: number, cardH: number): void {
    const hero = HEROES[heroId];
    const container = this.add.container(x, y);
    const paper = makePanel(this, 0, 0, 'paper', cardW, cardH);
    container.add(paper);

    // Живой спрайт героя
    const sprite = this.add.sprite(0, -cardH * 0.27, hero.anims.idle);
    sprite.setScale(hero.scale * 1.05);
    sprite.play(hero.anims.idle);
    container.add(sprite);

    const name = this.add.text(0, cardH * 0.08, hero.name, {
      fontFamily: FONT, fontSize: '17px', color: '#3b2410',
    }).setOrigin(0.5);
    container.add(name);

    const title = this.add.text(0, cardH * 0.21, hero.title, {
      fontFamily: FONT, fontSize: '11px', color: '#8a5b12',
    }).setOrigin(0.5);
    container.add(title);

    const traits = hero.traits.map((t) => `• ${t}`).join('\n');
    const body = this.add.text(0, cardH * 0.30, traits, {
      fontFamily: FONT, fontSize: '10px', color: '#57431f',
      align: 'center', lineSpacing: 5, wordWrap: { width: cardW - 30 },
    }).setOrigin(0.5, 0);
    container.add(body);

    // Иконка стартового оружия
    const wIcon = this.add.image(0, cardH * 0.44, WEAPONS[hero.startWeapon].icon).setDisplaySize(30, 30);
    container.add(wIcon);

    // Рамка выделения
    const frame = this.add.graphics();
    container.add(frame);

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

    this.heroCards.push({ container, sprite, frame, heroId });
  }

  private selectHero(heroId: HeroId): void {
    if (this.selectedHero === heroId) return;
    this.selectedHero = heroId;
    this.refreshSelection();
  }

  private refreshSelection(): void {
    for (const c of this.heroCards) {
      const selected = c.heroId === this.selectedHero;
      c.frame.clear();
      if (selected) {
        c.frame.lineStyle(4, 0xd9a520, 1).strokeRect(-c.container.width / 2 + 4, -c.container.height / 2 + 4, c.container.width - 8, c.container.height - 8);
        c.container.setScale(1.07);
      } else {
        c.container.setScale(1);
      }
    }
  }

  private layout(): void {
    this.scene.restart();
  }

  // ---------- Как играть ----------
  private showHowTo(): void {
    this.closeOverlay();
    const { width, height } = this.scale;
    this.overlay = this.add.container(0, 0);
    const dim = this.add.rectangle(width / 2, height / 2, width + 40, height + 40, 0x0a0a12, 0.72);
    const paperW = Math.min(560, width - 50);
    const paper = makePanel(this, width / 2, height / 2, 'paper', paperW, paperW * 1.05);
    const header = this.add.text(width / 2, height / 2 - paperW * 0.5, 'КАК ИГРАТЬ', {
      fontFamily: FONT, fontSize: '26px', color: '#3b2410',
    }).setOrigin(0.5);
    const lines = [
      'Выбери героя: воин, лучница или копейщик.',
      'WASD / стрелки — движение',
      'на телефоне — виртуальный джойстик',
      '',
      'Оружие атакует автоматически.',
      'Собирай кристаллы опыта, открывай',
      'сокровища и выбирай улучшения.',
      '',
      'Выживи 15 минут и убей',
      'ЧЁРНОГО КОПЕЙЩИКА!',
      '',
      'ESC / P — пауза, M — звук',
    ];
    const body = this.add.text(width / 2, height / 2 - paperW * 0.34, lines.join('\n'), {
      fontFamily: FONT, fontSize: '15px', color: '#57431f', align: 'center', lineSpacing: 8,
    }).setOrigin(0.5, 0);
    this.overlay.add([dim, paper, header, body]);
    this.backButton();
  }

  // ---------- Рекорды ----------
  private async showRecords(): Promise<void> {
    this.closeOverlay();
    const { width, height } = this.scale;
    const container = this.add.container(0, 0);
    this.overlay = container;
    const dim = this.add.rectangle(width / 2, height / 2, width + 40, height + 40, 0x0a0a12, 0.72);
    const paperW = Math.min(560, width - 50);
    const paper = makePanel(this, width / 2, height / 2, 'paperSpecial', paperW, paperW * 1.05);
    const header = this.add.text(width / 2, height / 2 - paperW * 0.5, 'ТАБЛИЦА РЕКОРДОВ', {
      fontFamily: FONT, fontSize: '22px', color: '#ffe9c0',
    }).setOrigin(0.5);
    const loading = this.add.text(width / 2, height / 2, 'загрузка...', {
      fontFamily: FONT, fontSize: '15px', color: '#cbb389',
    }).setOrigin(0.5);
    container.add([dim, paper, header, loading]);

    try {
      const res = await fetch('/api/scores?limit=10');
      const rows: ScoreRow[] = await res.json();
      loading.destroy();
      if (rows.length === 0) {
        container.add(this.add.text(width / 2, height / 2, 'пока никто не выживал', {
          fontFamily: FONT, fontSize: '15px', color: '#cbb389',
        }).setOrigin(0.5));
      } else {
        const lines = rows.map((r, i) =>
          `${i + 1}. ${r.name.slice(0, 14).padEnd(14, ' ')} ${String(r.score).padStart(7, ' ')}  ур.${r.level}${r.victory ? ' ★' : ''}`,
        );
        const body = this.add.text(width / 2, height / 2 - paperW * 0.36, lines.join('\n'), {
          fontFamily: FONT, fontSize: '13px', color: '#ffe9c0', lineSpacing: 12,
        }).setOrigin(0.5, 0);
        container.add(body);
      }
    } catch {
      loading.destroy();
      container.add(this.add.text(width / 2, height / 2, 'не удалось загрузить', {
        fontFamily: FONT, fontSize: '15px', color: '#ff8a7a',
      }).setOrigin(0.5));
    }
    this.backButton();
  }

  private backButton(): void {
    const { width, height } = this.scale;
    const y = height / 2 + Math.min(300, height * 0.36);
    makeButton(this, width / 2, y, 170, 56, 'НАЗАД', () => this.closeOverlay(), 'red', 17);
  }

  private closeOverlay(): void {
    this.overlay?.destroy(true);
    this.overlay = null;
  }

  update(): void {
    if (this.logo && this.logo.active) {
      const base = Math.max(52, this.scale.height * 0.085);
      this.logo.y = base + Math.sin(this.time.now / 700) * 5;
      this.logo2.y = base + (this.scale.width < 700 ? 44 : 54) + Math.sin(this.time.now / 700) * 5;
    }
    // Выбранный герой «дышит»
    for (const c of this.heroCards) {
      if (c.sprite.active && c.heroId === this.selectedHero) {
        const target = HEROES[c.heroId].scale * (1.05 + Math.sin(this.time.now / 600 + 1) * 0.03);
        c.sprite.setScale(target);
      }
    }
  }
}
