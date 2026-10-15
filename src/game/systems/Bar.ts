import Phaser from 'phaser';
import { FONT } from '../constants';

// ============ Полоса из настоящих ассетов ============
// Раньше HP и XP рисовались плоскими прямоугольниками кодом. В наборе
// Tiny Swords есть готовые полосы: ui/bars состоит из трёх деталей в ряд —
// левый торец, середина (она и растягивается по длине) и правый торец.
// Середина непрозрачна целиком и уже содержит тёмное «корыто», поэтому
// под заливкой ничего досоздавать не нужно.
//
// Заливку НЕ тонируем: setTint в Phaser умножает цвет текстуры на тон,
// а исходная bar-big-fill красная — синий тон дал бы тёмно-красный.
// Вместо этого prepare-assets.mjs перекрашивает её в нужные цвета
// (см. FILL ниже), и здесь мы просто переключаем текстуру.

/** Геометрия деталей, зафиксированная при нарезке (см. prepare-assets.mjs). */
export const BAR_GEOM = {
  /** Компактная полоса HUD: 19 px по высоте, торцы по 15 px. */
  small: { cap: 15, height: 19, inset: 4 },
  /** Полоса босса: 51 px по высоте, торцы по 24 px. */
  big: { cap: 24, height: 51, inset: 10 },
} as const;

export type BarSize = keyof typeof BAR_GEOM;

/** Заливки, подготовленные перекраской исходной полосы. */
export const FILL = {
  blue: 'bar-fill-blue',
  green: 'bar-fill-green',
  yellow: 'bar-fill-yellow',
  red: 'bar-fill-red',
  ghost: 'bar-fill-ghost',
  white: 'bar-fill-white',
} as const;

export interface BarOpts {
  /** Задержанный «призрак» урона — медленно догоняет реальное значение. */
  ghost?: boolean;
  /** Текстуры заливки: норма / низко / критически. */
  fill?: string;
  fillLow?: string;
  fillCritical?: string;
  /** Подпись над полосой. */
  label?: string;
  labelColor?: string;
  fontSize?: number;
}

export class StatBar {
  readonly root: Phaser.GameObjects.Container;

  private frame: Phaser.GameObjects.Image[] = [];
  private fill: Phaser.GameObjects.Image;
  private shine: Phaser.GameObjects.Image | null = null;
  private ghost: Phaser.GameObjects.Image | null = null;
  private label: Phaser.GameObjects.Text | null = null;

  private width: number;
  private ghostFrac = 1;

  constructor(
    private scene: Phaser.Scene,
    x: number,
    y: number,
    w: number,
    private size: BarSize = 'small',
    private opts: BarOpts = {},
  ) {
    this.width = Math.max(BAR_GEOM[size].cap * 2 + 16, w);
    this.root = scene.add.container(x, y);

    const geom = BAR_GEOM[size];
    const innerW = this.innerWidth;
    const innerH = this.innerHeight;

    // Рамка: торцы плюс растянутая середина
    this.frame = [
      scene.add.image(-this.width / 2 + geom.cap / 2, 0, 'bar-' + size + '-cap-l')
        .setDisplaySize(geom.cap, geom.height),
      scene.add.image(0, 0, 'bar-' + size + '-mid')
        .setDisplaySize(this.width - geom.cap * 2, geom.height),
      scene.add.image(this.width / 2 - geom.cap / 2, 0, 'bar-' + size + '-cap-r')
        .setDisplaySize(geom.cap, geom.height),
    ];

    // Порядок важен: середина рамки непрозрачна и закрывает всё, что под
    // ней, поэтому рамка идёт ПЕРВОЙ, а заливка с бликом ложится поверх.
    this.root.add(this.frame);

    // Призрак урона под основной заливкой
    if (opts.ghost) {
      this.ghost = scene.add
        .image(0, 0, FILL.ghost)
        .setOrigin(0, 0.5)
        .setDisplaySize(innerW, innerH);
      this.root.add(this.ghost);
    }

    this.fill = scene.add
      .image(0, 0, opts.fill ?? FILL.blue)
      .setOrigin(0, 0.5)
      .setDisplaySize(innerW, innerH);
    this.root.add(this.fill);

    // Глянец: светлая полоска по верхнему краю заливки
    this.shine = scene.add
      .image(0, 0, FILL.white)
      .setOrigin(0, 0.5)
      .setDisplaySize(innerW, 3)
      .setAlpha(0.4);
    this.root.add(this.shine);

    if (opts.label) {
      this.label = scene.add.text(0, 0, opts.label, {
        fontFamily: FONT,
        fontSize: (opts.fontSize ?? 10) + 'px',
        color: opts.labelColor ?? '#ffffff',
        stroke: '#1b1008',
        strokeThickness: 3,
      }).setOrigin(0.5);
      this.label.setY(-BAR_GEOM[size].height / 2 - 9);
      this.root.add(this.label);
    }

    this.setFraction(1);
  }

  private get innerLeft(): number {
    const geom = BAR_GEOM[this.size];
    return -this.width / 2 + geom.cap + geom.inset;
  }

  private get innerWidth(): number {
    const geom = BAR_GEOM[this.size];
    return this.width - geom.cap * 2 - geom.inset * 2;
  }

  private get innerHeight(): number {
    return BAR_GEOM[this.size].height - BAR_GEOM[this.size].inset * 2;
  }

  /** Доля заполнения 0…1. Цвет и призрак пересчитываются автоматически. */
  setFraction(frac: number): void {
    const next = Phaser.Math.Clamp(frac, 0, 1);
    const w = this.innerWidth * next;

    this.fill.x = this.innerLeft;
    this.fill.setDisplaySize(w, this.innerHeight);

    if (this.shine) {
      this.shine.x = this.innerLeft;
      this.shine.setDisplaySize(w, 3);
      this.shine.setVisible(w > 2);
    }

    // Зелёный → жёлтый → красный по мере убывания здоровья.
    // Пороги работают только когда заданы обе текстуры: у полосы опыта их
    // нет, иначе она перекрашивалась бы в жёлтый уже на середине опыта.
    if (this.opts.fillLow && this.opts.fillCritical) {
      let key = this.opts.fill ?? FILL.green;
      if (next <= 0.25) key = this.opts.fillCritical;
      else if (next <= 0.5) key = this.opts.fillLow;
      if (this.fill.texture.key !== key) this.fill.setTexture(key);
    }

    if (this.ghost) {
      // Призрак догоняет: при уроне тает, при лечении подтягивается сразу
      this.ghostFrac = next >= this.ghostFrac ? next : Math.max(next, this.ghostFrac - 0.015);
      this.ghost.x = this.innerLeft;
      this.ghost.setDisplaySize(this.innerWidth * this.ghostFrac, this.innerHeight);
      this.ghost.setVisible(this.ghostFrac > next + 0.005);
    }
  }

  /** Меняет ширину полосы (например, при повороте экрана). */
  setWidth(w: number): void {
    const geom = BAR_GEOM[this.size];
    const next = Math.max(geom.cap * 2 + 16, w);
    if (next === this.width) return;
    const frac = this.innerWidth > 0 ? this.fill.displayWidth / this.innerWidth : 1;
    this.width = next;

    this.frame[0].setPosition(-next / 2 + geom.cap / 2, 0);
    this.frame[1].setDisplaySize(next - geom.cap * 2, geom.height);
    this.frame[2].setPosition(next / 2 - geom.cap / 2, 0);
    this.setFraction(frac);
  }

  setPosition(x: number, y: number): void {
    this.root.setPosition(x, y);
  }

  setLabel(text: string): void {
    this.label?.setText(text);
  }

  setScrollFactor(v: number): void {
    this.root.setScrollFactor(v);
  }

  setDepth(d: number): void {
    this.root.setDepth(d);
  }

  setVisible(v: boolean): void {
    this.root.setVisible(v);
  }

  destroy(): void {
    this.root.destroy(true);
  }
}