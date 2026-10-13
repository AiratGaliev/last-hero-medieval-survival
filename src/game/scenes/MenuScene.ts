import Phaser from 'phaser';
import { FONT } from '../constants';
import { audio } from '../systems/Audio';
import { makePanel, makeButton } from '../systems/Ui';

// ============ Главное меню ============

interface ScoreRow {
  id: number;
  name: string;
  score: number;
  kills: number;
  level: number;
  victory: boolean;
}

export class MenuScene extends Phaser.Scene {
  private ui: Phaser.GameObjects.Container = {} as Phaser.GameObjects.Container;
  private overlay: Phaser.GameObjects.Container | null = null;
  private logo!: Phaser.GameObjects.Text;
  private logo2!: Phaser.GameObjects.Text;
  private clouds: Phaser.GameObjects.Image[] = [];

  constructor() {
    super('Menu');
  }

  create(): void {
    const { width, height } = this.scale;
    // Фон: травка
    this.add.tileSprite(width / 2, height / 2, width + 120, height + 120, 'grass-tile');
    // Водная рамка
    const t = 26;
    this.add.tileSprite(width / 2, -60, width + 400, 200, 'water-tile');
    this.add.tileSprite(width / 2, height + 60, width + 400, 200, 'water-tile');
    this.add.tileSprite(-80, height / 2, 200, height + 400, 'water-tile');
    this.add.tileSprite(width + 80, height / 2, 200, height + 400, 'water-tile');
    void t;

    // Облака
    for (let i = 0; i < 6; i++) {
      const c = this.add.image(
        Phaser.Math.Between(0, width),
        Phaser.Math.Between(30, height * 0.5),
        `cloud${Phaser.Math.Between(1, 3)}`,
      ).setAlpha(0.65);
      this.clouds.push(c);
      this.tweens.add({
        targets: c,
        x: '+=500',
        duration: Phaser.Math.Between(50, 90) * 1000,
        repeat: -1,
        onRepeat: () => { c.x = -200; },
      });
    }

    // Декор: замок и юниты
    this.add.image(width * 0.5, height * 0.32, 'castle').setScale(0.85).setAlpha(0.96);
    const warrior = this.add.sprite(width * 0.36, height * 0.42, 'player-idle').setScale(0.5);
    warrior.play('player-idle');
    const pawn = this.add.sprite(width * 0.62, height * 0.43, 'grunt-idle').setScale(0.5);
    pawn.play('grunt-idle');
    const archer = this.add.sprite(width * 0.44, height * 0.47, 'archer-idle').setScale(0.45);
    archer.play('archer-idle');
    const sheep = this.add.sprite(width * 0.58, height * 0.5, 'sheep').setScale(0.7);
    sheep.play('sheep-idle');
    void warrior; void pawn; void archer; void sheep;

    // Логотип
    this.logo = this.add.text(width / 2, height * 0.1, 'TINY SWORD', {
      fontFamily: FONT, fontSize: '52px', color: '#ffd76e',
      stroke: '#5a2d05', strokeThickness: 12,
    }).setOrigin(0.5);
    this.logo2 = this.add.text(width / 2, height * 0.1 + 54, 'SURVIVORS', {
      fontFamily: FONT, fontSize: '44px', color: '#ffffff',
      stroke: '#7a1010', strokeThickness: 11,
    }).setOrigin(0.5);
    this.tweens.add({
      targets: [this.logo, this.logo2],
      scale: { from: 0.7, to: 1 },
      duration: 480,
      ease: 'Back.easeOut',
    });
    // Мечи-декорации
    this.add.image(width / 2 - 320, height * 0.13, 'swords').setDisplaySize(120, 172).setAlpha(0.9);
    this.add.image(width / 2 + 320, height * 0.13, 'swords').setDisplaySize(120, 172).setFlipX(true).setAlpha(0.9);

    // Кнопки
    this.menuButton(width / 2, height * 0.62, 'ИГРАТЬ', 'blue', 320, 66, () => {
      audio.unlock();
      this.scene.start('Game');
    });
    this.menuButton(width / 2, height * 0.62 + 84, 'КАК ИГРАТЬ', 'red', 260, 60, () => this.showHowTo());
    this.menuButton(width / 2, height * 0.62 + 158, 'РЕКОРДЫ', 'blue', 220, 54, () => this.showRecords());

    this.add.text(width / 2, height - 22, 'Phaser 4 • ассеты Pixel Frog «Tiny Swords»', {
      fontFamily: FONT, fontSize: '12px', color: '#3b2410',
    }).setOrigin(0.5).setAlpha(0.8);

    this.scale.on('resize', this.layout, this);
    this.events.once('shutdown', () => this.scale.off('resize', this.layout, this));
  }

  private layout(): void {
    this.scene.restart();
  }

  private menuButton(x: number, y: number, label: string, variant: 'blue' | 'red', w: number, h: number, onClick: () => void): void {
    makeButton(this, x, y, w, h, label, onClick, variant, w > 300 ? 24 : w > 240 ? 19 : 16);
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
      'WASD / стрелки — движение',
      'на телефоне — виртуальный джойстик',
      '',
      'Оружие атакует автоматически.',
      'Собирай кристаллы опыта и получай',
      'улучшения на каждом уровне.',
      '',
      'Выживи 15 минут и убей',
      'ЧЁРНОГО КОПЕЙЩИКА!',
      '',
      'ESC / P — пауза, M — звук',
    ];
    const body = this.add.text(width / 2, height / 2 - paperW * 0.34, lines.join('\n'), {
      fontFamily: FONT, fontSize: '15px', color: '#57431f', align: 'center', lineSpacing: 9,
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
    // лёгкое покачивание логотипа
    if (this.logo && this.logo.active) {
      this.logo.y = this.scale.height * 0.1 + Math.sin(this.time.now / 700) * 5;
      this.logo2.y = this.scale.height * 0.1 + 54 + Math.sin(this.time.now / 700) * 5;
    }
  }
}
