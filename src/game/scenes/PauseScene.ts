import Phaser from 'phaser';
import { FONT } from '../constants';
import { audio } from '../systems/Audio';
import { makeButton, makePanel } from '../systems/Ui';

// ============ Пауза: меню + панель снаряжения (оружия/бонусы) ============

interface LoadoutEntry {
  icon: string;
  name: string;
  level: number;
}

interface LoadoutData {
  weapons: LoadoutEntry[];
  passives: LoadoutEntry[];
  hero: { name: string; hp: number; maxHp: number };
  stats: { kills: number; elapsed: number; gold: number; level: number };
}

interface PauseData {
  onResume: () => void;
  onToggleMute: () => boolean;
  loadout?: LoadoutData;
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
    const compact = height < 560;

    this.add.rectangle(width / 2, height / 2, width + 40, height + 40, 0x0a0a12, 0.7)
      .setScrollFactor(0);

    const title = this.add.text(width / 2, compact ? height * 0.1 : height * 0.11, 'ПАУЗА', {
      fontFamily: FONT, fontSize: compact ? '32px' : '40px', color: '#ffe9b0',
      stroke: '#5a2d05', strokeThickness: 9,
    }).setOrigin(0.5).setScrollFactor(0);
    this.tweens.add({ targets: title, scale: { from: 0.7, to: 1 }, duration: 260, ease: 'Back.easeOut' });

    // ---------- Панель снаряжения ----------
    const lo = payload.loadout;
    const wide = width >= 980;
    if (lo && !compact) {
      const panelW = Math.min(470, width - 60);
      const rows = Math.max(lo.weapons.length, lo.passives.length, 1);
      const panelH = Math.min(430, 128 + rows * 28 + 44);
      const panelY = compact ? height * 0.5 : height * 0.47;
      const panelX = wide ? width / 2 - 130 : width / 2;
      this.buildLoadoutPanel(panelX, panelY, panelW, panelH, lo);
      // Кнопки справа от панели на широких экранах, иначе под панелью
      if (wide) {
        const bx = width / 2 + panelW / 2 + 90;
        this.menuBtn(bx, height * 0.34, 'ПРОДОЛЖИТЬ', 'blue', 250, 58, () => this.resume());
        this.menuBtn(bx, height * 0.50, 'ЗАНОВО', 'red', 250, 58, () => this.restart());
        this.menuBtn(bx, height * 0.66, 'В МЕНЮ', 'blue', 250, 50, () => this.toMenu());
        this.buildSoundToggle(bx, height * 0.80);
      } else {
        this.menuBtn(width / 2, height * 0.78, 'ПРОДОЛЖИТЬ', 'blue', 300, 56, () => this.resume());
        this.menuBtn(width / 2, height * 0.875, 'ЗАНОВО', 'red', 240, 46, () => this.restart());
        this.menuBtn(width / 2 + 96, height - 32, 'В МЕНЮ', 'blue', 180, 40, () => this.toMenu());
        this.buildSoundToggle(width / 2 - 118, height - 32);
      }
    } else {
      // Компактный ландшафт / без данных — прежняя вертикальная раскладка
      this.menuBtn(width / 2, height * 0.42, 'ПРОДОЛЖИТЬ', 'blue', 300, 66, () => this.resume());
      this.menuBtn(width / 2, height * 0.58, 'ЗАНОВО', 'red', 300, 66, () => this.restart());
      this.menuBtn(width / 2, height * 0.74, 'В МЕНЮ', 'blue', 220, 54, () => this.toMenu());
      this.buildSoundToggle(width / 2, height * 0.87);
    }

    // Esc — продолжить
    const kb = this.input.keyboard;
    if (kb) {
      kb.on('keydown-ESC', () => this.resume());
      kb.on('keydown-P', () => this.resume());
    }

    // При изменении размера окна (поворот телефона) — перерисовать меню на новых координатах
    this.scale.on('resize', this.rebuild, this);
    this.events.once('shutdown', () => this.scale.off('resize', this.rebuild, this));
  }

  private resume(): void {
    this.payload.onResume();
    this.scene.stop();
  }

  private restart(): void {
    this.scene.stop('Game');
    this.scene.start('Game');
  }

  private toMenu(): void {
    this.scene.stop('Game');
    this.scene.start('Menu');
  }

  // ================================================================
  // Панель снаряжения: герой + колонки оружия/бонусов + статистика
  // ================================================================

  private buildLoadoutPanel(cx: number, cy: number, w: number, h: number, lo: LoadoutData): void {
    const paper = makePanel(this, cx, cy, 'paper', w, h);
    paper.setScrollFactor(0);
    const top = cy - h / 2;

    // Герой + HP
    this.add.text(cx, top + 26, `${lo.hero.name.toUpperCase()}  ·  УР. ${lo.stats.level}`, {
      fontFamily: FONT, fontSize: '15px', color: '#3b2410',
    }).setOrigin(0.5).setScrollFactor(0);
    const hpFrac = Phaser.Math.Clamp(lo.hero.hp / Math.max(1, lo.hero.maxHp), 0, 1);
    const barW = Math.min(200, w - 80);
    this.add.rectangle(cx, top + 46, barW, 12, 0xc9a25e, 1).setOrigin(0.5).setScrollFactor(0);
    this.add.rectangle(cx - (barW - 4) / 2, top + 46, (barW - 4) * hpFrac, 8, hpFrac > 0.5 ? 0x53b44a : hpFrac > 0.25 ? 0xe0a030 : 0xd03028)
      .setOrigin(0, 0.5).setScrollFactor(0);
    this.add.text(cx, top + 46, `${lo.hero.hp}/${lo.hero.maxHp}`, {
      fontFamily: FONT, fontSize: '9px', color: '#ffffff', stroke: '#3b2410', strokeThickness: 3,
    }).setOrigin(0.5).setScrollFactor(0);

    // Колонки
    const colW = (w - 60) / 2;
    const colL = cx - colW / 2 - 8;
    const colR = cx + colW / 2 + 8;
    this.add.text(colL, top + 78, 'ОРУЖИЯ', {
      fontFamily: FONT, fontSize: '11px', color: '#8a5b12',
    }).setOrigin(0.5).setScrollFactor(0);
    this.add.text(colR, top + 78, 'БОНУСЫ', {
      fontFamily: FONT, fontSize: '11px', color: '#8a5b12',
    }).setOrigin(0.5).setScrollFactor(0);

    const entry = (x: number, y: number, e: LoadoutEntry, maxed: boolean) => {
      this.add.image(x - colW / 2 + 14, y, e.icon).setDisplaySize(22, 22).setScrollFactor(0);
      this.add.text(x - colW / 2 + 32, y, e.name, {
        fontFamily: FONT, fontSize: '10px', color: '#3b2410',
      }).setOrigin(0, 0.5).setScrollFactor(0);
      this.add.text(x + colW / 2 - 10, y, `${e.level}/5`, {
        fontFamily: FONT, fontSize: '10px', color: maxed ? '#2e7d32' : '#b0803a',
        stroke: maxed ? '#dcecc9' : '#f7e7c3', strokeThickness: 3,
      }).setOrigin(1, 0.5).setScrollFactor(0);
    };
    lo.weapons.slice(0, 7).forEach((e, i) => entry(colL, top + 100 + i * 28, e, e.level >= 5));
    lo.passives.slice(0, 8).forEach((e, i) => entry(colR, top + 100 + i * 28, e, e.level >= 5));

    // Статистика матча внизу панели
    const mm = Math.floor(lo.stats.elapsed / 60);
    const ss = Math.floor(lo.stats.elapsed % 60).toString().padStart(2, '0');
    this.add.text(cx, top + h - 24, `⏱ ${mm}:${ss}   ⚔ ${lo.stats.kills}   🪙 ${lo.stats.gold}`, {
      fontFamily: FONT, fontSize: '12px', color: '#7a4e0e',
    }).setOrigin(0.5).setScrollFactor(0);
  }

  private buildSoundToggle(x: number, y: number): void {
    this.muteLabel = this.add.text(x, y, '', {
      fontFamily: FONT, fontSize: '13px', color: '#cbb389',
    }).setOrigin(1, 0.5).setScrollFactor(0).setInteractive({ useHandCursor: true });
    this.muteLabel.on('pointerdown', () => {
      this.payload.onToggleMute();
      this.updateMuteLabel();
    });
    const icon = this.add.text(x + 6, y, '🔇', {
      fontFamily: FONT, fontSize: '16px', color: '#cbb389',
    }).setOrigin(0.5).setScrollFactor(0).setInteractive({ useHandCursor: true });
    icon.on('pointerdown', () => {
      this.payload.onToggleMute();
      this.updateMuteLabel();
    });
    this.updateMuteLabel();
  }

  private rebuild = (): void => {
    // Перезапуск с теми же данными — кнопки встанут по новым размерам экрана
    this.scene.restart(this.payload as PauseData);
  };

  private updateMuteLabel(): void {
    this.muteLabel.setText(audio.muted ? 'ЗВУК ВЫКЛ' : 'ЗВУК ВКЛ');
  }

  private menuBtn(x: number, y: number, label: string, variant: 'blue' | 'red', w: number, h: number, onClick: () => void): void {
    makeButton(this, x, y, w, h, label, onClick, variant, w > 250 ? 20 : 16);
  }
}
