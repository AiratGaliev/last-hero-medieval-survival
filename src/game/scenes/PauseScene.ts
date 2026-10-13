import Phaser from 'phaser';
import { FONT } from '../constants';
import { audio } from '../systems/Audio';
import { makeButton } from '../systems/Ui';

// ============ Пауза ============

interface PauseData {
  onResume: () => void;
  onToggleMute: () => boolean;
}

export class PauseScene extends Phaser.Scene {
  private payload!: PauseData;
  private muteLabel!: Phaser.GameObjects.Text;

  constructor() {
    super('Pause');
  }

  create(payload: PauseData): void {
    this.payload = payload;
    const { width, height } = this.scale;

    this.add.rectangle(width / 2, height / 2, width + 40, height + 40, 0x0a0a12, 0.7)
      .setScrollFactor(0);

    const title = this.add.text(width / 2, height * 0.2, 'ПАУЗА', {
      fontFamily: FONT, fontSize: '40px', color: '#ffe9b0',
      stroke: '#5a2d05', strokeThickness: 9,
    }).setOrigin(0.5).setScrollFactor(0);
    this.tweens.add({ targets: title, scale: { from: 0.7, to: 1 }, duration: 260, ease: 'Back.easeOut' });

    this.menuBtn(width / 2, height * 0.42, 'ПРОДОЛЖИТЬ', 'blue', 300, 66, () => {
      this.payload.onResume();
      this.scene.stop();
    });
    this.menuBtn(width / 2, height * 0.58, 'ЗАНОВО', 'red', 300, 66, () => {
      this.scene.stop('Game');
      this.scene.start('Game');
    });
    this.menuBtn(width / 2, height * 0.74, 'В МЕНЮ', 'blue', 220, 54, () => {
      this.scene.stop('Game');
      this.scene.start('Menu');
    });

    // Звук
    this.muteLabel = this.add.text(width / 2, height * 0.87, '', {
      fontFamily: FONT, fontSize: '13px', color: '#cbb389',
    }).setOrigin(0.5).setScrollFactor(0);
    this.updateMuteLabel();
    const soundBtn = this.add.text(width / 2, height * 0.87, '  🔇', {
      fontFamily: FONT, fontSize: '18px', color: '#cbb389',
    }).setOrigin(0.5).setScrollFactor(0).setInteractive({ useHandCursor: true });
    soundBtn.on('pointerdown', () => {
      this.payload.onToggleMute();
      this.updateMuteLabel();
    });
    this.muteLabel.setX(width / 2 - 16);

    // Esc — продолжить
    const kb = this.input.keyboard;
    if (kb) {
      kb.on('keydown-ESC', () => {
        this.payload.onResume();
        this.scene.stop();
      });
      kb.on('keydown-P', () => {
        this.payload.onResume();
        this.scene.stop();
      });
    }
  }

  private updateMuteLabel(): void {
    this.muteLabel.setText(audio.muted ? 'ЗВУК ВЫКЛ' : 'ЗВУК ВКЛ');
  }

  private menuBtn(x: number, y: number, label: string, variant: 'blue' | 'red', w: number, h: number, onClick: () => void): void {
    makeButton(this, x, y, w, h, label, onClick, variant, w > 250 ? 20 : 16);
  }
}
