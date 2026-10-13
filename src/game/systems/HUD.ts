import Phaser from 'phaser';
import { DEPTH, FONT, GAME_DURATION } from '../constants';
import type { AchievementDef } from '../achievements';
import { audio } from './Audio';
import { makePanel } from './Ui';

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

export class HUD {
  private scene: Phaser.Scene;
  private scoreMult = 1;
  /** Корневой контейнер HUD с компенсацией зума камеры */
  private root!: Phaser.GameObjects.Container;
  private xpBarBg!: Phaser.GameObjects.Rectangle;
  private xpBarFill!: Phaser.GameObjects.Rectangle;
  private xpLabel!: Phaser.GameObjects.Text;
  private timerText!: Phaser.GameObjects.Text;
  private statsText!: Phaser.GameObjects.Text;
  private goldIcon!: Phaser.GameObjects.Image;
  private goldText!: Phaser.GameObjects.Text;
  private scoreText!: Phaser.GameObjects.Text;
  private announceText!: Phaser.GameObjects.Text;
  // Кнопка паузы: три РОВНЯХ top-level sf=0-объекта (без контейнера!) —
  // баг Phaser 4.2.1: hit-тест вложенных в sf-контейнер объектов не учитывает
  // scrollFactor контейнера → кнопка в контейнере некликабельна при скролле.
  private pauseBg!: Phaser.GameObjects.Image;
  private pauseTxt!: Phaser.GameObjects.Text;
  private pauseHit!: Phaser.GameObjects.Zone;
  private weaponIcons = new Map<string, Phaser.GameObjects.Container>();
  private bossGroup!: Phaser.GameObjects.Container;
  private bossFill!: Phaser.GameObjects.Rectangle;
  private bossBg!: Phaser.GameObjects.Rectangle;
  private bossInner!: Phaser.GameObjects.Rectangle;
  private bossText!: Phaser.GameObjects.Text;
  /** Ширина полосы босса — не шире экрана (на мобильных 420px обрезалось) */
  private bossBarW = 420;

  // Виньетка низкого HP + тег сложности + тосты ачивок
  private vignetteRects: Phaser.GameObjects.Rectangle[] = [];
  private diffTag: Phaser.GameObjects.Text | null = null;
  private toastQueue: AchievementDef[] = [];
  private toastBusy = false;

  private resizeHandler = () => this.layout();

  constructor(scene: Phaser.Scene, onPause: () => void, opts: HudOpts = {}) {
    this.scene = scene;
    this.scoreMult = opts.scoreMult ?? 1;
    this.build(onPause, opts);
    scene.scale.on('resize', this.resizeHandler);
  }

  private build(onPause: () => void, opts: HudOpts): void {
    const W = this.scene.scale.width;
    // scrollFactor(0) обязателен: иначе контейнер «уезжает» вместе с миром при скролле камеры
    this.root = this.scene.add.container(0, 0).setScrollFactor(0).setDepth(DEPTH.HUD);

    this.xpBarBg = this.scene.add.rectangle(0, 0, W, 16, 0x1b1008)
      .setOrigin(0, 0.5);
    this.xpBarFill = this.scene.add.rectangle(2, 0, 10, 12, 0x54c2ff)
      .setOrigin(0, 0.5);
    this.xpLabel = this.scene.add.text(0, 0, 'УР. 1', {
      fontFamily: FONT, fontSize: '10px', color: '#ffffff',
      stroke: '#1b1008', strokeThickness: 3,
    }).setOrigin(0.5);

    this.timerText = this.scene.add.text(0, 0, '00:00', {
      fontFamily: FONT, fontSize: '18px', color: '#ffe9b0',
      stroke: '#1b1008', strokeThickness: 5,
    });

    this.statsText = this.scene.add.text(0, 0, '', {
      fontFamily: FONT, fontSize: '10px', color: '#d8c9a8',
      stroke: '#1b1008', strokeThickness: 3,
    });

    this.goldIcon = this.scene.add.image(0, 0, 'icon-coin').setDisplaySize(14, 14);
    this.goldText = this.scene.add.text(0, 0, '0', {
      fontFamily: FONT, fontSize: '12px', color: '#ffd76e',
      stroke: '#1b1008', strokeThickness: 3,
    }).setOrigin(0, 0.5);

    this.scoreText = this.scene.add.text(0, 0, 'СЧЁТ 0', {
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

    // Кнопка паузы (важно для мобильных) — плоская структура, см. комментарий выше
    this.pauseBg = this.scene.add.image(0, 0, 'btn-small-blue').setDisplaySize(42, 42)
      .setScrollFactor(0).setDepth(DEPTH.HUD + 9);
    this.pauseTxt = this.scene.add.text(0, 0, 'II', {
      fontFamily: FONT, fontSize: '16px', color: '#ffffff',
      stroke: '#2a1608', strokeThickness: 5,
    }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH.HUD + 10);
    this.pauseHit = this.scene.add.zone(0, 0, 56, 56).setScrollFactor(0)
      .setDepth(DEPTH.HUD + 8).setInteractive({ useHandCursor: true });
    this.pauseHit.on('pointerover', () => {
      this.scene.tweens.add({ targets: [this.pauseBg, this.pauseTxt], scale: (this.pauseHit.scaleX || 1) * 1.08, duration: 110 });
      this.pauseBg.setTint(0xfff2cc);
    });
    this.pauseHit.on('pointerout', () => {
      this.scene.tweens.add({ targets: [this.pauseBg, this.pauseTxt], scale: this.pauseHit.scaleX || 1, duration: 110 });
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
    this.bossText = this.scene.add.text(0, -16, 'ЧЁРНЫЙ КОПЕЙЩИК', {
      fontFamily: FONT, fontSize: '10px', color: '#ff9a8a',
      stroke: '#1b1008', strokeThickness: 4,
    }).setOrigin(0.5);
    this.bossGroup.add([this.bossBg, this.bossInner, this.bossFill, this.bossText]);

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

    // Порядок добавления = порядок отрисовки (снизу вверх):
    // полосы/тексты → босс-бар → виньетка → анонс → тосты достижений
    // (добавляются динамически). Пауза — отдельным top-level объектом.
    const base: Phaser.GameObjects.GameObject[] = [
      this.xpBarBg, this.xpBarFill, this.xpLabel,
      this.timerText, this.statsText, this.goldIcon, this.goldText,
      this.scoreText,
    ];
    if (this.diffTag) base.push(this.diffTag);
    base.push(this.bossGroup, ...this.vignetteRects, this.announceText);
    this.root.add(base);

    this.layout();
  }

  private camZoom(): number {
    return this.scene.cameras.main.zoom || 1;
  }

  layout(): void {
    const W = this.scene.scale.width;
    const H = this.scene.scale.height;
    this.xpBarBg.setPosition(0, 8).setSize(W, 16);
    this.xpBarFill.setPosition(2, 8);
    this.xpLabel.setPosition(W / 2, 8);
    this.timerText.setPosition(12, 34);
    this.statsText.setPosition(12, 62);
    this.goldIcon.setPosition(12, 82);
    this.goldText.setPosition(30, 82);
    this.scoreText.setPosition(W - 12, 34);
    this.diffTag?.setPosition(W - 12, 54);
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
    let iy = H - 16;
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
    // Кнопка паузы — плоские sf=0-объекты с той же компенсацией
    const bx = W / 2 + (W - 46 - W / 2) / z;
    const by = H / 2 + (96 - H / 2) / z;
    const inv = 1 / z;
    this.pauseBg.setPosition(bx, by).setScale(inv);
    this.pauseTxt.setPosition(bx, by).setScale(inv);
    this.pauseHit.setPosition(bx, by).setScale(inv);
  }

  update(s: HudState): void {
    const frac = Phaser.Math.Clamp(s.xp / Math.max(1, s.xpNext), 0, 1);
    const W = this.scene.scale.width;
    this.xpBarFill.setSize(Math.max(6, (W - 4) * frac), 12);
    this.xpLabel.setText(`УР. ${s.level}`);

    const remain = Math.max(0, GAME_DURATION - s.elapsed);
    if (remain <= 0) {
      // Время вышло — на арене финальный босс: честная индикация вместо «00:00»
      this.timerText.setText('⚔ БОСС!');
      this.timerText.setColor('#ff6b5e');
    } else {
      const mm = Math.floor(remain / 60);
      const ss = Math.floor(remain % 60);
      this.timerText.setText(`${mm.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}`);
      this.timerText.setColor('#ffe9b0');
    }

    this.statsText.setText(`УБИЙСТВ: ${s.kills}`);
    this.goldText.setText(`${s.gold}`);
    this.scoreText.setText(`СЧЁТ ${s.score.toLocaleString('ru-RU')}`);

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
    this.bossFill.setSize(Math.max(0, (this.bossBarW - 6) * Phaser.Math.Clamp(frac, 0, 1)), 12);
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
    const c = this.scene.add.container(W + 150, 132);
    const paper = makePanel(this.scene, 0, 0, 'paper', 250, 58);
    const icon = this.scene.add.image(-95, 0, a.icon).setDisplaySize(38, 38);
    const label = this.scene.add.text(-68, -14, 'ДОСТИЖЕНИЕ!', {
      fontFamily: FONT, fontSize: '9px', color: '#8a5b12',
    }).setOrigin(0, 0.5);
    const name = this.scene.add.text(-68, 7, a.name, {
      fontFamily: FONT, fontSize: '13px', color: '#3b2410',
      stroke: '#ffe9c0', strokeThickness: 3,
    }).setOrigin(0, 0.5);
    c.add([paper, icon, label, name]);
    this.root.add(c); // поверх остального HUD
    this.scene.tweens.add({ targets: c, x: W - 140, duration: 320, ease: 'Back.easeOut' });
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
      c = this.scene.add.container(12 + this.weaponIcons.size * 40, H - 16);
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
    lvlText.setText(level > 0 ? `${level}` : '');
    // Подсветка максимума
    const bg = c.list[0] as Phaser.GameObjects.Rectangle;
    bg.setFillStyle(level >= 5 ? 0x6b4d12 : 0x1b1008, 0.8);
  }

  destroy(): void {
    this.scene.scale.off('resize', this.resizeHandler);
    this.root.destroy();
    this.pauseBg.destroy();
    this.pauseTxt.destroy();
    this.pauseHit.destroy();
  }
}
