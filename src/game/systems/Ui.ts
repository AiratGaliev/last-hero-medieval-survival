import Phaser from 'phaser';
import { FONT } from '../constants';
import { audio } from './Audio';

// ============ Фабрика UI-элементов на NineSlice ============
// Ассеты Tiny Swords — 9-тайловые гриды, склеенные в бесшовные текстуры.

export const NINE_SLICE = {
  paper: { key: 'paper9', left: 52, right: 52, top: 44, bottom: 44 },
  paperSpecial: { key: 'paper-special9', left: 55, right: 55, top: 44, bottom: 43 },
  btnBlue: { key: 'btn-blue9', left: 45, right: 45, top: 47, bottom: 47 },
  btnRed: { key: 'btn-red9', left: 45, right: 45, top: 47, bottom: 47 },
  banner: { key: 'banner9', left: 100, right: 84, top: 68, bottom: 111 },
} as const;

export type NineKey = keyof typeof NINE_SLICE;

/** Панель (бумага/баннер) на NineSlice */
export function makePanel(
  scene: Phaser.Scene, x: number, y: number, kind: NineKey, w: number, h: number,
): Phaser.GameObjects.NineSlice {
  const cfg = NINE_SLICE[kind];
  const ns = scene.add.nineslice(
    x, y, cfg.key, undefined, w, h, cfg.left, cfg.right, cfg.top, cfg.bottom,
    true, true,
  );
  return ns;
}

/**
 * Подгоняет текст под ширину кнопки. Иначе длинный текст вылезает за
 * девятислайс: русское «СОХРАНИТЬ РЕКОРД» шире английского «SAVE SCORE»
 * и в кнопку 260 px не влезало. Уменьшаем кегль, а не масштаб — так
 * сохраняется читаемая пиксельная сетка.
 */
function fitWidth(
  txt: Phaser.GameObjects.Text,
  maxW: number,
  fontSize: number,
  minSize = 9,
): void {
  if (txt.width <= maxW || txt.width === 0) return;
  const fitted = Math.max(minSize, Math.floor(fontSize * (maxW / txt.width)));
  if (fitted < fontSize) {
    txt.setStyle({ fontSize: `${fitted}px`, strokeThickness: Math.max(3, fitted / 4) });
  }
  // Крайний случай: даже минимальный кегль не влезает — сжимаем по ширине
  if (txt.width > maxW) txt.setScale(maxW / txt.width);
}

/**
 * Подгоняет готовый Phaser-текст под ширину: уменьшает кегль, а если не
 * помогло — сжимает по ширине. Нужен там, где подпись нельзя обрезать
 * (имена в таблице рекордов, названия достижений), но и не влезает.
 */
export function fitTextWidth(
  txt: Phaser.GameObjects.Text,
  maxW: number,
  fontSize: number,
  minSize = 8,
): void {
  fitWidth(txt, maxW, fontSize, minSize);
}

/** Кнопка на NineSlice с текстом и хит-зоной */
export function makeButton(
  scene: Phaser.Scene,
  x: number, y: number,
  w: number, h: number,
  label: string,
  onClick: () => void,
  variant: 'blue' | 'red' = 'blue',
  fontSize = 20,
): { img: Phaser.GameObjects.NineSlice; txt: Phaser.GameObjects.Text; hit: Phaser.GameObjects.Zone } {
  const cfg = variant === 'blue' ? NINE_SLICE.btnBlue : NINE_SLICE.btnRed;
  const img = scene.add.nineslice(
    x, y, cfg.key, undefined, w, h, cfg.left, cfg.right, cfg.top, cfg.bottom,
  );
  const txt = scene.add.text(x, y, label, {
    fontFamily: FONT,
    fontSize: `${fontSize}px`,
    color: '#ffffff',
    stroke: '#2a1608',
    strokeThickness: Math.max(4, fontSize / 4),
  }).setOrigin(0.5);

  /**
   * Подгоняем подпись под ширину кнопки — иначе длинный текст вылезает за
   * девятислайс (русское «СОХРАНИТЬ РЕКОРД» не влезало в 260 px).
   */
  fitWidth(txt, w - 28, fontSize);

  const hit = scene.add.zone(x, y, w + 36, h + 30).setInteractive({ useHandCursor: true });
  hit.on('pointerover', () => {
    scene.tweens.add({ targets: [img, txt], scale: 1.06, duration: 110 });
    img.setTint(0xfff2cc);
  });
  hit.on('pointerout', () => {
    scene.tweens.add({ targets: [img, txt], scale: 1, duration: 110 });
    img.clearTint();
  });
  hit.on('pointerdown', () => {
    audio.play('click');
    onClick();
  });
  return { img, txt, hit };
}
