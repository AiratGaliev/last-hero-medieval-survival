// ============ Угловая рамка из ассетов Tiny Swords ============
//
// ui/cursors/cursor-04 — четыре угла рамки, собранные в одной картинке
// 128×128. В таком виде рамка годится только под квадрат, поэтому из
// квадрантов 64×64 регистрируются кадры corner-tl/tr/br/bl (по 21×25 каждый,
// см. BootScene.registerFrames). Собрав их по углам прямоугольника,
// получаем рамку, которая тянется под любой размер элемента: углы
// остаются натуральными, растягивается только пустота между ними. Это
// заметно чище прямоугольной обводки и в духе Tiny Swords.
//
// Отдельных обрезанных копий corner-*.png в src/assets/game нет.
//
// Каждый угол — 21×25 px, толщина ломаной ~13 px (см. scripts/probe-cursors.mjs).

import Phaser from 'phaser';
import { FONT } from '../constants';

/** Ключи углов: порядок обхода по часовой стрелке от левого верхнего. */
const CORNERS = ['corner-tl', 'corner-tr', 'corner-br', 'corner-bl'] as const;

/** Текстура, в которой зарегистрированы кадры углов. */
const CORNER_TEXTURE = 'cursor-04';

export interface CornerFrame {
  container: Phaser.GameObjects.Container;
  setBox(w: number, h: number): void;
  setPosition(x: number, y: number): void;
  setVisible(v: boolean): void;
  setAlpha(a: number): void;
  destroy(): void;
}

/**
 * Собирает рамку из четырёх углов вокруг прямоугольника `w × h`,
 * размещённого по центру точки (x, y).
 */
export function makeCornerFrame(
  scene: Phaser.Scene,
  x: number,
  y: number,
  w: number,
  h: number,
  opts: { cornerScale?: number; alpha?: number; depth?: number } = {},
): CornerFrame {
  const scale = opts.cornerScale ?? 1;
  const container = scene.add.container(x, y);
  const corners = CORNERS.map((key) =>
    scene.add.image(0, 0, CORNER_TEXTURE, key).setScale(scale).setOrigin(0.5, 0.5),
  );
  container.add(corners);
  container.setDepth(opts.depth ?? 10);
  container.setAlpha(opts.alpha ?? 1);

  const box = { w, h };
  const apply = (): void => {
    const hw = box.w / 2;
    const hh = box.h / 2;
    // Углы стоят вплотную к краям; их собственная толщина (~13 px при
    // масштабе 1) съедена внутрь, поэтому сдвигаем на половину толщины,
    // чтобы рамка охватывала элемент, а не уходила за его пределы.
    const i = 13 * scale;
    corners[0].setPosition(-hw + i, -hh + i);
    corners[1].setPosition(hw - i, -hh + i);
    corners[2].setPosition(hw - i, hh - i);
    corners[3].setPosition(-hw + i, hh - i);
  };
  apply();

  return {
    container,
    setBox(nw, nh) { box.w = nw; box.h = nh; apply(); },
    setPosition(nx, ny) { container.setPosition(nx, ny); },
    setVisible(v) { container.setVisible(v); },
    setAlpha(a) { container.setAlpha(a); },
    destroy() { container.destroy(true); },
  };
}

/**
 * Подпись-подсказка в рамке: мелкий текст под рамкой не нужен,
 * но сам уголок крупный и требует аккуратного размещения.
 * Возвращает готовый размер угла в пикселях для данного масштаба.
 */
export function cornerInset(scale = 1): number {
  return 13 * scale;
}

/** Текст-водяной знак, используемый на заблокированных элементах. */
export function lockedMark(scene: Phaser.Scene, x: number, y: number, size = 22): Phaser.GameObjects.Text {
  return scene.add.text(x, y, '×', {
    fontFamily: FONT, fontSize: size + 'px', color: '#ff8a7a',
    stroke: '#5a0808', strokeThickness: 4,
  }).setOrigin(0.5).setDepth(11);
}
