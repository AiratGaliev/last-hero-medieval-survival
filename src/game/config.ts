import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene';
import { MenuScene } from './scenes/MenuScene';
import { GameScene } from './scenes/GameScene';
import { LevelUpScene } from './scenes/LevelUpScene';
import { PauseScene } from './scenes/PauseScene';
import { GameOverScene } from './scenes/GameOverScene';
import { SuccessionScene } from './scenes/SuccessionScene';
import { MetaScene } from './scenes/MetaScene';
import { ShopScene } from './scenes/ShopScene';

// ============ Конфигурация Phaser-игры ============

export function createGame(parent: HTMLElement): Phaser.Game {
  return new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    backgroundColor: '#3f8ed0',
    // DOM-контейнер нужен для нативного <input> ввода имени на экране рекорда
    dom: { createContainer: true },
    scale: {
      mode: Phaser.Scale.RESIZE,
      width: '100%',
      height: '100%',
    },
    physics: {
      default: 'arcade',
      arcade: {
        gravity: { x: 0, y: 0 },
        debug: false,
      },
    },
    pixelArt: true,
    roundPixels: true,
    // MetaScene/ShopScene — оверлеи поверх меню (фазы Q/S, ROADMAP)
    scene: [BootScene, MenuScene, GameScene, LevelUpScene, PauseScene, GameOverScene, SuccessionScene, MetaScene, ShopScene],
  });
}
