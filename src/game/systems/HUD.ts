import Phaser from 'phaser';
import { DEPTH, FONT, GAME_DURATION } from '../constants';
import { WEAPONS, PASSIVES, type WeaponId, type PassiveId } from '../data';

// ============ HUD: XP-бар, таймер, счётчики, иконки, бар босса ============

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

export class HUD {
  private scene: Phaser.Scene;
  private xpBarBg!: Phaser.GameObjects.Rectangle;
  private xpBarFill!: Phaser.GameObjects.Rectangle;
  private xpLabel!: Phaser.GameObjects.Text;
  private timerText!: Phaser.GameObjects.Text;
  private statsText!: Phaser.GameObjects.Text;
  private scoreText!: Phaser.GameObjects.Text;
  private announceText!: Phaser.GameObjects.Text;
  private weaponIcons = new Map<string, Phaser.GameObjects.Container>();
  private bossGroup!: Phaser.GameObjects.Container;
  private bossFill!: Phaser.GameObjects.Rectangle;
  private bossText!: Phaser.GameObjects.Text;

  private resizeHandler = () => this.layout();

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.build();
    scene.scale.on('resize', this.resizeHandler);
  }

  private build(): void {
    const W = this.scene.scale.width;
    this.xpBarBg = this.scene.add.rectangle(0, 0, W, 16, 0x1b1008)
      .setOrigin(0, 0.5).setScrollFactor(0).setDepth(DEPTH.HUD + 5);
    this.xpBarFill = this.scene.add.rectangle(2, 0, 10, 12, 0x54c2ff)
      .setOrigin(0, 0.5).setScrollFactor(0).setDepth(DEPTH.HUD + 6);
    this.xpLabel = this.scene.add.text(0, 0, 'УР. 1', {
      fontFamily: FONT, fontSize: '9px', color: '#ffffff',
      stroke: '#1b1008', strokeThickness: 3,
    }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH.HUD + 7);

    this.timerText = this.scene.add.text(0, 0, '00:00', {
      fontFamily: FONT, fontSize: '18px', color: '#ffe9b0',
      stroke: '#1b1008', strokeThickness: 5,
    }).setScrollFactor(0).setDepth(DEPTH.HUD + 7);

    this.statsText = this.scene.add.text(0, 0, '', {
      fontFamily: FONT, fontSize: '9px', color: '#d8c9a8',
      stroke: '#1b1008', strokeThickness: 3,
    }).setScrollFactor(0).setDepth(DEPTH.HUD + 7);

    this.scoreText = this.scene.add.text(0, 0, 'СЧЁТ 0', {
      fontFamily: FONT, fontSize: '10px', color: '#ffd76e',
      stroke: '#1b1008', strokeThickness: 3,
    }).setOrigin(1, 0).setScrollFactor(0).setDepth(DEPTH.HUD + 7);

    this.announceText = this.scene.add.text(0, 0, '', {
      fontFamily: FONT, fontSize: '20px', color: '#ffffff',
      stroke: '#7a1010', strokeThickness: 7,
    }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH.HUD + 20).setAlpha(0);

    // Босс-бар
    this.bossGroup = this.scene.add.container(0, 0).setScrollFactor(0).setDepth(DEPTH.HUD + 10).setVisible(false);
    const barW = 420;
    const bg = this.scene.add.rectangle(0, 0, barW, 18, 0x1b1008, 0.92).setOrigin(0.5);
    const inner = this.scene.add.rectangle(0, 0, barW - 6, 12, 0x50120f).setOrigin(0.5);
    this.bossFill = this.scene.add.rectangle(-(barW - 6) / 2, 0, barW - 6, 12, 0xd03028).setOrigin(0, 0.5);
    this.bossText = this.scene.add.text(0, -16, 'ЧЁРНЫЙ КОПЕЙЩИК', {
      fontFamily: FONT, fontSize: '10px', color: '#ff9a8a',
      stroke: '#1b1008', strokeThickness: 4,
    }).setOrigin(0.5);
    this.bossGroup.add([bg, inner, this.bossFill, this.bossText]);

    this.layout();
  }

  layout(): void {
    const W = this.scene.scale.width;
    const H = this.scene.scale.height;
    this.xpBarBg.setPosition(0, 8).setSize(W, 16);
    this.xpBarFill.setPosition(2, 8);
    this.xpLabel.setPosition(W / 2, 8);
    this.timerText.setPosition(12, 34);
    this.statsText.setPosition(12, 62);
    this.scoreText.setPosition(W - 12, 34);
    this.announceText.setPosition(W / 2, H * 0.22);
    this.bossGroup.setPosition(W / 2, 64);
    // Иконки оружия
    let x = 12;
    for (const c of this.weaponIcons.values()) {
      c.setPosition(x, H - 16);
      x += 40;
    }
  }

  update(s: HudState): void {
    const frac = Phaser.Math.Clamp(s.xp / Math.max(1, s.xpNext), 0, 1);
    const W = this.scene.scale.width;
    this.xpBarFill.setSize(Math.max(6, (W - 4) * frac), 12);
    this.xpLabel.setText(`УР. ${s.level}`);

    const remain = Math.max(0, GAME_DURATION - s.elapsed);
    const mm = Math.floor(remain / 60);
    const ss = Math.floor(remain % 60);
    this.timerText.setText(`${mm.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}`);

    this.statsText.setText(`УБИЙСТВ: ${s.kills}   ЗОЛОТО: ${s.gold}`);
    this.scoreText.setText(`СЧЁТ ${s.score.toLocaleString('ru-RU')}`);
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

  updateBossBar(frac: number): void {
    const barW = 414;
    this.bossFill.setSize(Math.max(0, barW * Phaser.Math.Clamp(frac, 0, 1)), 12);
  }

  hideBossBar(): void {
    this.bossGroup.setVisible(false);
  }

  setIcon(id: string, iconKey: string, level: number, isPassive: boolean): void {
    let c = this.weaponIcons.get(id);
    const H = this.scene.scale.height;
    if (!c) {
      c = this.scene.add.container(12 + this.weaponIcons.size * 40, H - 16).setScrollFactor(0).setDepth(DEPTH.HUD + 8);
      const bg = this.scene.add.rectangle(0, 0, 34, 34, 0x1b1008, 0.75).setOrigin(0, 0.5);
      const ic = this.scene.add.image(4, -3, iconKey).setOrigin(0, 0).setDisplaySize(26, 26);
      const lvl = this.scene.add.text(30, 10, '1', {
        fontFamily: FONT, fontSize: '8px', color: '#ffd76e',
        stroke: '#1b1008', strokeThickness: 3,
      }).setOrigin(1, 1);
      c.add([bg, ic, lvl]);
      this.weaponIcons.set(id, c);
      void isPassive;
    }
    const lvlText = c.list[2] as Phaser.GameObjects.Text;
    lvlText.setText(level > 0 ? `${level}` : '');
    // Подсветка максимума
    const bg = c.list[0] as Phaser.GameObjects.Rectangle;
    bg.setFillStyle(level >= 5 ? 0x6b4d12 : 0x1b1008, 0.8);
  }

  destroy(): void {
    this.scene.scale.off('resize', this.resizeHandler);
  }
}
