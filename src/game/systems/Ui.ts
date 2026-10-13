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
