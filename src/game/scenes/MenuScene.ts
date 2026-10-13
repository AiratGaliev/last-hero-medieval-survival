import Phaser from 'phaser';
import { FONT } from '../constants';
import { HEROES, WEAPONS, DIFFICULTIES, type HeroId, type DifficultyId } from '../data';
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

interface DiffChip {
  container: Phaser.GameObjects.Container;
  frame: Phaser.GameObjects.Graphics;
  diffId: DifficultyId;
}

const HERO_ORDER: HeroId[] = ['warrior', 'archer', 'lancer', 'monk'];
const DIFF_ORDER: DifficultyId[] = ['normal', 'nightmare'];

export class MenuScene extends Phaser.Scene {
  private overlay: Phaser.GameObjects.Container | null = null;
  private logo!: Phaser.GameObjects.Text;
  private logo2!: Phaser.GameObjects.Text;
  private heroCards: HeroCard[] = [];
  private diffChips: DiffChip[] = [];
  private selectedHero: HeroId = 'warrior';
  private selectedDiff: DifficultyId = 'normal';
  /** Виртуальное полотно (на мобильных меньше реального экрана — камера зумит) */
  private vw = 0;
  private vh = 0;
  private menuZoom = 1;

  constructor() {
    super('Menu');
  }

  create(): void {
    const realW = this.scale.width;
    const realH = this.scale.height;
    this.heroCards = [];
    this.diffChips = [];

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

    // Сохранённый герой + сложность
    const saved = window.localStorage.getItem('tss-hero');
    if (saved === 'warrior' || saved === 'archer' || saved === 'lancer' || saved === 'monk') {
      this.selectedHero = saved;
    }
    const savedDiff = window.localStorage.getItem('tss-diff');
    if (savedDiff === 'normal' || savedDiff === 'nightmare') {
      this.selectedDiff = savedDiff;
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

    // Замок на фоне
    this.add.image(width * 0.5, height * 0.28, 'castle').setScale(0.8).setAlpha(0.55);
    const sheep = this.add.sprite(width * 0.1, height * 0.9, 'sheep').setScale(0.65).setAlpha(0.9);
    sheep.play('sheep-idle');
    const pawn = this.add.sprite(width * 0.9, height * 0.92, 'grunt-idle').setScale(0.45).setAlpha(0.9);
    pawn.play('grunt-idle');
    void sheep; void pawn;

    // Логотип
    const titleY = Math.max(52, height * 0.075);
    this.logo = this.add.text(width / 2, titleY, 'TINY SWORD', {
      fontFamily: FONT, fontSize: mobile ? '42px' : '52px', color: '#ffd76e',
      stroke: '#5a2d05', strokeThickness: 12,
    }).setOrigin(0.5);
    this.logo2 = this.add.text(width / 2, titleY + (mobile ? 48 : 54), 'SURVIVORS', {
      fontFamily: FONT, fontSize: mobile ? '36px' : '44px', color: '#ffffff',
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
    // Сетка карточек: 4 в ряд на десктопе, 2×2 на мобильном (виртуальное полотно)
    const cols = width < 760 ? 2 : 4;
    const rows = Math.ceil(HERO_ORDER.length / cols);
    const gap = 14;
    const cardW = Math.min(width < 760 ? 205 : 225, (width - 36 - (cols - 1) * gap) / cols);
    const cardH = width < 760 ? 178 : 214;
    const cardsY = height * (width < 760 ? 0.44 : 0.47);
    const blockH = rows * cardH + (rows - 1) * gap;
    const heroTop = cardsY - blockH / 2;
    const heroBottom = cardsY + blockH / 2;

    const label = this.add.text(width / 2, heroTop - 26, '— ВЫБЕРИ ГЕРОЯ —', {
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
    makeButton(this, width / 2, btnY, Math.min(320, width - 80), 58, 'ИГРАТЬ', () => {
      audio.unlock();
      window.localStorage.setItem('tss-hero', this.selectedHero);
      window.localStorage.setItem('tss-diff', this.selectedDiff);
      this.scene.start('Game', { hero: this.selectedHero, diff: this.selectedDiff });
    }, 'blue', mobile ? 20 : 24);

    const smallW = Math.min(185, (width - 100) / 2);
    const smallY = btnY + 60;
    makeButton(this, width / 2 - smallW / 2 - 10, smallY, smallW, 44, 'КАК ИГРАТЬ', () => this.showHowTo(), 'red', 14);
    makeButton(this, width / 2 + smallW / 2 + 10, smallY, smallW, 44, 'РЕКОРДЫ', () => this.showRecords(), 'red', 14);

    this.add.text(width / 2, height - 12, 'Phaser 4 • ассеты Pixel Frog «Tiny Swords»', {
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

    const frame = this.add.graphics();
    container.add(frame);

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
      c.frame.clear();
      if (selected) {
        c.frame.lineStyle(4, 0xd9a520, 1).strokeRect(-c.container.width / 2 + 4, -c.container.height / 2 + 4, c.container.width - 8, c.container.height - 8);
        c.container.setScale(1.07);
      } else {
        c.container.setScale(1);
      }
    }
    for (const d of this.diffChips) {
      const selected = d.diffId === this.selectedDiff;
      d.frame.clear();
      d.container.setAlpha(selected ? 1 : 0.72);
      if (selected) {
        const w = d.container.width, h = d.container.height;
        d.frame.lineStyle(3, d.diffId === 'nightmare' ? 0xc03028 : 0xd9a520, 1)
          .strokeRect(-w / 2 + 3, -h / 2 + 3, w - 6, h - 6);
        d.container.setScale(1.05);
      } else {
        d.container.setScale(1);
      }
    }
  }

  private layout(): void {
    this.scene.restart();
  }

  // ---------- Как играть ----------
  private showHowTo(): void {
    this.closeOverlay();
    const width = this.vw;
    const height = this.vh;
    this.overlay = this.add.container(0, 0);
    const dim = this.add.rectangle(width / 2, height / 2, width / this.menuZoom + 80, height / this.menuZoom + 80, 0x0a0a12, 0.72);
    const paperW = Math.min(560, width - 50);
    const paper = makePanel(this, width / 2, height / 2, 'paper', paperW, paperW * 1.05);
    const header = this.add.text(width / 2, height / 2 - paperW * 0.5, 'КАК ИГРАТЬ', {
      fontFamily: FONT, fontSize: '26px', color: '#3b2410',
    }).setOrigin(0.5);
    const lines = [
      'Выбери героя: воин, лучница, копейщик или монах.',
      'Затем сложность: Поход или Кошмар (×1.6 очков).',
      'WASD / стрелки — движение',
      'на телефоне — виртуальный джойстик',
      '',
      'Оружие атакует автоматически.',
      'Собирай кристаллы опыта и золото,',
      'открывай сокровища и выбирай улучшения.',
      'Золото матча — валюта «Лавки торговца».',
      'Осторожно: бочки-камикадзе взрываются!',
      '',
      'Выживи 15 минут и убей',
      'ЧЁРНОГО КОПЕЙЩИКА!',
      '',
      'На «Кошмаре» на 10-й минуте ждёт',
      'ТЁМНЫЙ МОНАХ...',
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
    const width = this.vw;
    const height = this.vh;
    const container = this.add.container(0, 0);
    this.overlay = container;
    const dim = this.add.rectangle(width / 2, height / 2, width / this.menuZoom + 80, height / this.menuZoom + 80, 0x0a0a12, 0.72);
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
    const width = this.vw;
    const height = this.vh;
    const y = height / 2 + Math.min(300, height * 0.36);
    makeButton(this, width / 2, y, 170, 56, 'НАЗАД', () => this.closeOverlay(), 'red', 17);
  }

  private closeOverlay(): void {
    this.overlay?.destroy(true);
    this.overlay = null;
  }

  update(): void {
    if (this.logo && this.logo.active) {
      const base = Math.max(52, this.vh * 0.075);
      this.logo.y = base + Math.sin(this.time.now / 700) * 5;
      this.logo2.y = base + (this.vw < 760 ? 48 : 54) + Math.sin(this.time.now / 700) * 5;
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
