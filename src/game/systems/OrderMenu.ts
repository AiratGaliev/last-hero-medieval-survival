import Phaser from 'phaser';
import { FONT } from '../constants';
import { t } from '../../i18n';
import type { Pawn } from '../entities/Pawn';

// ============ Радиальное меню приказов (TZ §B.6) ============
//
// Десктоп: Shift+ЛКМ; тач: лонг-пресс 500 мс (кольцо заполнения под пальцем,
// отпускание раньше/свайп = отмена). У гражданских 2 активных + 2 серых
// заготовки; у гарнизона свой набор (СЛЕДОВАТЬ/НА ПОСТ/ДЕРЖАТЬ [+В ОБИТЕЛЬ]).
// Приказ гарнизону держится до отмены, гражданскому — сбрасывается после задачи.

export interface OrderMenuEntry {
  key: string;
  label: string;
  disabled?: boolean;
}

export class OrderMenu {
  private scene: Phaser.Scene;
  private container: Phaser.GameObjects.Container | null = null;
  private pawn: Pawn | null = null;
  private ring: Phaser.GameObjects.Graphics | null = null;
  private ringStart = 0;
  private ringOrigin: { x: number; y: number } | null = null;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  /** Кольцо заполнения лонг-пресса (в мировых координатах у камеры). */
  showRing(x: number, y: number, now: number): void {
    if (!this.ring) {
      this.ring = this.scene.add.graphics().setDepth(9400);
    }
    this.ringOrigin = { x, y };
    if (this.ringStart === 0) this.ringStart = now;
  }

  updateRing(now: number, durationMs: number): number {
    if (!this.ring || !this.ringOrigin) return 0;
    const k = Math.min(1, (now - this.ringStart) / durationMs);
    this.ring.clear();
    this.ring.lineStyle(5, 0xffe9b0, 0.95);
    this.ring.beginPath();
    this.ring.arc(this.ringOrigin.x, this.ringOrigin.y, 34, -Math.PI / 2, -Math.PI / 2 + k * Math.PI * 2);
    this.ring.strokePath();
    return k;
  }

  hideRing(): void {
    this.ring?.destroy();
    this.ring = null;
    this.ringStart = 0;
    this.ringOrigin = null;
  }

  get ringing(): boolean {
    return this.ring !== null;
  }

  /** Открыть меню по пешке в мировых координатах (сцена продолжает рендер). */
  open(pawn: Pawn, wx: number, wy: number, onPick: (key: string) => void, onClose?: () => void): void {
    this.close();
    this.pawn = pawn;
    const entries = this.entriesFor(pawn);
    const R = 74;
    const container = this.scene.add.container(0, 0).setDepth(9450);

    // Затемнение-ловушка: клик мимо пунктов закрывает меню
    const veil = this.scene.add.rectangle(0, 0, this.scene.scale.width * 2, this.scene.scale.height * 2, 0x000000, 0.25)
      .setInteractive();
    veil.on('pointerdown', () => { this.close(); onClose?.(); });
    container.add(veil);

    const items: Array<Phaser.GameObjects.Container> = [];
    entries.forEach((e, i) => {
      const a = -Math.PI / 2 + (i / entries.length) * Math.PI * 2;
      const ix = wx + Math.cos(a) * R;
      const iy = wy + Math.sin(a) * R;
      const c = this.scene.add.container(ix, iy);
      const color = e.disabled ? 0x6b5a3f : 0x3b6ea5;
      const bg = this.scene.add.circle(0, 0, 34, color, e.disabled ? 0.7 : 0.95)
        .setStrokeStyle(2, e.disabled ? 0x4a4136 : 0x9fc1e8);
      const label = this.scene.add.text(0, 0, e.label, {
        fontFamily: FONT, fontSize: '10px', color: e.disabled ? '#a99a80' : '#ffffff',
        align: 'center', wordWrap: { width: 60 },
      }).setOrigin(0.5);
      c.add([bg, label]);
      if (!e.disabled) {
        bg.setInteractive({ useHandCursor: true });
        bg.on('pointerdown', () => {
          onPick(e.key);
          this.close();
        });
        this.scene.tweens.add({ targets: c, scale: { from: 0.4, to: 1 }, duration: 130, ease: 'Back.easeOut' });
      }
      items.push(c);
      container.add(c);
    });

    // Центральный крестик «закрыть»
    const close = this.scene.add.circle(wx, wy, 18, 0x1a0f08, 0.9).setStrokeStyle(2, 0x8a6d3b).setInteractive({ useHandCursor: true });
    const cross = this.scene.add.text(wx, wy, '✕', { fontFamily: FONT, fontSize: '14px', color: '#ffe9b0' }).setOrigin(0.5);
    close.on('pointerdown', () => { this.close(); onClose?.(); });
    container.add([close, cross]);

    this.container = container;
    void items;
  }

  /** Открыть меню с произвольными пунктами (меню найма на здании). */
  openCustom(entries: OrderMenuEntry[], wx: number, wy: number, onPick: (key: string) => void): void {
    this.close();
    this.pawn = null;
    const R = 74;
    const container = this.scene.add.container(0, 0).setDepth(9450);
    const veil = this.scene.add.rectangle(0, 0, this.scene.scale.width * 2, this.scene.scale.height * 2, 0x000000, 0.25)
      .setInteractive();
    veil.on('pointerdown', () => this.close());
    container.add(veil);
    entries.forEach((e, i) => {
      const a = -Math.PI / 2 + (i / entries.length) * Math.PI * 2;
      const ix = wx + Math.cos(a) * R;
      const iy = wy + Math.sin(a) * R;
      const c = this.scene.add.container(ix, iy);
      const color = e.disabled ? 0x6b5a3f : 0x3b6ea5;
      const bg = this.scene.add.circle(0, 0, 34, color, e.disabled ? 0.7 : 0.95)
        .setStrokeStyle(2, e.disabled ? 0x4a4136 : 0x9fc1e8);
      const label = this.scene.add.text(0, 0, e.label, {
        fontFamily: FONT, fontSize: '10px', color: e.disabled ? '#a99a80' : '#ffffff',
        align: 'center', wordWrap: { width: 60 },
      }).setOrigin(0.5);
      c.add([bg, label]);
      if (!e.disabled) {
        bg.setInteractive({ useHandCursor: true });
        bg.on('pointerdown', () => {
          onPick(e.key);
          this.close();
        });
        this.scene.tweens.add({ targets: c, scale: { from: 0.4, to: 1 }, duration: 130, ease: 'Back.easeOut' });
      }
      container.add(c);
    });
    // §B.6: приказ гарнизону ДЕРЖИТСЯ ДО ОТМЕНЫ («пост ставится один раз:
    // стой здесь и держи — и забыл»), поэтому у приказа обязателен явный
    // «сброс» в радиальном меню. Без него перевести воина обратно на
    // автоповедение было невозможно в принципе.
    const reset = this.scene.add.container(wx, wy - 54);
    const rbg = this.scene.add.rectangle(0, 0, 96, 26, 0x5a4327, 0.95)
      .setStrokeStyle(2, 0xd8c9a8).setInteractive({ useHandCursor: true });
    const rtxt = this.scene.add.text(0, 0, t('order.reset'), {
      fontFamily: FONT, fontSize: '10px', color: '#ffe9b0',
    }).setOrigin(0.5);
    rbg.on('pointerdown', () => {
      if (this.pawn) { this.pawn.order = null; this.pawn.orderTarget = null; }
      this.close();
    });
    reset.add([rbg, rtxt]);
    container.add(reset);

    const close = this.scene.add.circle(wx, wy, 18, 0x1a0f08, 0.9).setStrokeStyle(2, 0x8a6d3b).setInteractive({ useHandCursor: true });
    const cross = this.scene.add.text(wx, wy, '✕', { fontFamily: FONT, fontSize: '14px', color: '#ffe9b0' }).setOrigin(0.5);
    close.on('pointerdown', () => this.close());
    container.add([close, cross]);
    this.container = container;
  }

  close(): void {
    this.container?.destroy();
    this.container = null;
    this.pawn = null;
  }

  get openPawn(): Pawn | null {
    return this.pawn;
  }

  get isOpen(): boolean {
    return this.container !== null;
  }

  private entriesFor(pawn: Pawn): OrderMenuEntry[] {
    if (pawn.cls === 'garrison') {
      const list: OrderMenuEntry[] = [
        { key: 'follow', label: t('order.follow') },
        { key: 'post', label: t('order.post') },
        { key: 'hold', label: t('order.hold') },
      ];
      if (pawn.kind === 'healer') list.push({ key: 'monastery', label: t('order.monastery') });
      return list;
    }
    return [
      { key: 'collect', label: t('order.collect') },
      { key: 'build', label: t('order.build') },
      // Заготовки фазы R (§B.6): рисуются серыми, клик игнорируется
      { key: 'repair', label: t('order.repair'), disabled: true },
      { key: 'rest', label: t('order.rest'), disabled: true },
    ];
  }
}
