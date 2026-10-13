import Phaser from 'phaser';
import { FONT } from '../constants';
import { makePanel, makeButton } from '../systems/Ui';

// ============ Экран конца матча (React-диалог поверх для ввода имени) ============

export interface GameOverStats {
  victory: boolean;
  time: number;
  kills: number;
  level: number;
  gold: number;
  score: number;
}

interface GameOverData {
  stats: GameOverStats;
}

export class GameOverScene extends Phaser.Scene {
  private payload!: GameOverData;

  constructor() {
    super('GameOver');
  }

  create(payload: GameOverData): void {
    this.payload = payload;
    const { width, height } = this.scale;
    const s = this.payload.stats;

    this.add.rectangle(width / 2, height / 2, width + 40, height + 40, 0x0a0a12, 0.78)
      .setScrollFactor(0);

    // Баннер
    const banner = makePanel(this, width / 2, height * 0.2, 'banner', Math.min(420, width - 60), Math.min(300, height * 0.34));
    banner.setScrollFactor(0);
    this.tweens.add({ targets: banner, scale: { from: 0.6, to: 1 }, duration: 320, ease: 'Back.easeOut' });

    const title = this.add.text(width / 2, height * 0.17, s.victory ? 'ПОБЕДА!' : 'ПОРАЖЕНИЕ', {
      fontFamily: FONT, fontSize: '34px', color: s.victory ? '#ffd700' : '#ff6b5e',
      stroke: '#5a0808', strokeThickness: 9,
    }).setOrigin(0.5).setScrollFactor(0);

    const mm = Math.floor(s.time / 60).toString().padStart(2, '0');
    const ss = Math.floor(s.time % 60).toString().padStart(2, '0');
    const lines = [
      `ВРЕМЯ: ${mm}:${ss}`,
      `УБИЙСТВ: ${s.kills}`,
      `УРОВЕНЬ: ${s.level}`,
      `ЗОЛОТО: ${s.gold}`,
      `СЧЁТ: ${s.score.toLocaleString('ru-RU')}`,
    ];
    const statsText = this.add.text(width / 2, height * 0.44, lines.join('\n'), {
      fontFamily: FONT, fontSize: '16px', color: '#ffe9b0',
      align: 'center', lineSpacing: 10,
      stroke: '#1b1008', strokeThickness: 5,
    }).setOrigin(0.5).setScrollFactor(0);

    this.add.text(width / 2, height * 0.63, 'сохрани рекорд в диалоге справа', {
      fontFamily: FONT, fontSize: '12px', color: '#cbb389',
    }).setOrigin(0.5).setScrollFactor(0);

    this.btn(width / 2, height * 0.74, 'ИГРАТЬ СНОВА', 'blue', 300, 66, () => this.restart());
    this.btn(width / 2, height * 0.88, 'В МЕНЮ', 'blue', 220, 54, () => this.toMenu());

    void title;
    void statsText;

    // Слушаем команды от React-диалога
    window.addEventListener('tss-restart', this.restart);
    window.addEventListener('tss-menu', this.toMenu);
    this.events.once('shutdown', () => {
      window.removeEventListener('tss-restart', this.restart);
      window.removeEventListener('tss-menu', this.toMenu);
    });
  }

  private restart = (): void => {
    this.scene.stop('Game');
    this.scene.start('Game');
  };

  private toMenu = (): void => {
    this.scene.stop('Game');
    this.scene.start('Menu');
  };

  private btn(x: number, y: number, label: string, variant: 'blue' | 'red', w: number, h: number, onClick: () => void): void {
    const b = makeButton(this, x, y, w, h, label, onClick, variant, w > 250 ? 20 : 15);
    b.img.setScrollFactor(0);
    b.txt.setScrollFactor(0);
    b.hit.setScrollFactor(0);
  }
}
