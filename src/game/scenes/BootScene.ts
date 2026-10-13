import Phaser from 'phaser';
import { FONT } from '../constants';
import { asset } from '../assets';
import { t } from '../../i18n';

// ============ Загрузчик ассетов + анимации ============

export class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  preload(): void {
    const { width, height } = this.scale;
    // Прогресс-бар
    const barW = Math.min(460, width - 80);
    const barH = 18;
    const bx = (width - barW) / 2;
    const by = height / 2 - barH / 2;
    this.add.rectangle(width / 2, by - 24, barW, 22, 0x3b2a1a).setStrokeStyle(2, 0x8a6d3b);
    this.add.text(width / 2, by - 56, 'Tiny Sword Survivors', {
      fontFamily: FONT, fontSize: '16px', color: '#ffe9b0',
    }).setOrigin(0.5);
    const bar = this.add.rectangle(bx + 2, by + 1, 10, barH - 4, 0xe8c170).setOrigin(0, 0.5);
    this.add.text(width / 2, by + 40, t('boot.loading'), {
      fontFamily: FONT, fontSize: '10px', color: '#cbb389',
    }).setOrigin(0.5);

    this.load.on('progress', (v: number) => {
      bar.width = Math.max(10, (barW - 4) * v);
    });

    // ---- Игрок (синий воин) ----
    this.load.spritesheet('player-idle', asset('tiny-swords', 'units/blue/warrior/warrior-idle.png'), { frameWidth: 192, frameHeight: 192 });
    this.load.spritesheet('player-run', asset('tiny-swords', 'units/blue/warrior/warrior-run.png'), { frameWidth: 192, frameHeight: 192 });
    this.load.spritesheet('player-atk1', asset('tiny-swords', 'units/blue/warrior/warrior-attack1.png'), { frameWidth: 192, frameHeight: 192 });
    this.load.spritesheet('player-atk2', asset('tiny-swords', 'units/blue/warrior/warrior-attack2.png'), { frameWidth: 192, frameHeight: 192 });

    // ---- Герои: лучница, копейщик и монах (синяя фракция) ----
    this.load.spritesheet('hero-archer-idle', asset('tiny-swords', 'units/blue/archer/archer-idle.png'), { frameWidth: 192, frameHeight: 192 });
    this.load.spritesheet('hero-archer-run', asset('tiny-swords', 'units/blue/archer/archer-run.png'), { frameWidth: 192, frameHeight: 192 });
    this.load.spritesheet('hero-archer-atk', asset('tiny-swords', 'units/blue/archer/archer-shoot.png'), { frameWidth: 192, frameHeight: 192 });
    this.load.spritesheet('hero-lancer-idle', asset('tiny-swords', 'units/blue/lancer/lancer-idle.png'), { frameWidth: 320, frameHeight: 320 });
    this.load.spritesheet('hero-lancer-run', asset('tiny-swords', 'units/blue/lancer/lancer-run.png'), { frameWidth: 320, frameHeight: 320 });
    this.load.spritesheet('hero-lancer-atk', asset('tiny-swords', 'units/blue/lancer/lancer-right-attack.png'), { frameWidth: 320, frameHeight: 320 });
    this.load.spritesheet('hero-monk-idle', asset('tiny-swords', 'units/blue/monk/idle.png'), { frameWidth: 192, frameHeight: 192 });
    this.load.spritesheet('hero-monk-run', asset('tiny-swords', 'units/blue/monk/run.png'), { frameWidth: 192, frameHeight: 192 });
    this.load.spritesheet('hero-monk-atk', asset('tiny-swords', 'units/blue/monk/heal.png'), { frameWidth: 192, frameHeight: 192 });

    // ---- Враги ----
    this.load.spritesheet('grunt-idle', asset('tiny-swords', 'units/red/pawn/pawn-idle.png'), { frameWidth: 192, frameHeight: 192 });
    this.load.spritesheet('grunt-run', asset('tiny-swords', 'units/red/pawn/pawn-run.png'), { frameWidth: 192, frameHeight: 192 });
    this.load.spritesheet('swarm-idle', asset('tiny-swords', 'units/purple/pawn/pawn-idle.png'), { frameWidth: 192, frameHeight: 192 });
    this.load.spritesheet('swarm-run', asset('tiny-swords', 'units/purple/pawn/pawn-run.png'), { frameWidth: 192, frameHeight: 192 });
    this.load.spritesheet('brute-idle', asset('tiny-swords', 'units/yellow/warrior/warrior-idle.png'), { frameWidth: 192, frameHeight: 192 });
    this.load.spritesheet('brute-run', asset('tiny-swords', 'units/yellow/warrior/warrior-run.png'), { frameWidth: 192, frameHeight: 192 });
    this.load.spritesheet('archer-idle', asset('tiny-swords', 'units/red/archer/archer-idle.png'), { frameWidth: 192, frameHeight: 192 });
    this.load.spritesheet('archer-run', asset('tiny-swords', 'units/red/archer/archer-run.png'), { frameWidth: 192, frameHeight: 192 });
    this.load.spritesheet('archer-shoot', asset('tiny-swords', 'units/red/archer/archer-shoot.png'), { frameWidth: 192, frameHeight: 192 });
    this.load.spritesheet('lancer-idle', asset('tiny-swords', 'units/purple/lancer/lancer-idle.png'), { frameWidth: 320, frameHeight: 320 });
    this.load.spritesheet('lancer-run', asset('tiny-swords', 'units/purple/lancer/lancer-run.png'), { frameWidth: 320, frameHeight: 320 });
    // --- Новые враги v1.8 ---
    this.load.spritesheet('guard-idle', asset('tiny-swords', 'units/red/warrior/warrior-guard.png'), { frameWidth: 192, frameHeight: 192 });
    this.load.spritesheet('guard-run', asset('tiny-swords', 'units/red/warrior/warrior-run.png'), { frameWidth: 192, frameHeight: 192 });
    this.load.spritesheet('taskmaster-idle', asset('tiny-swords', 'units/red/pawn/pawn-idle-hammer.png'), { frameWidth: 192, frameHeight: 192 });
    this.load.spritesheet('taskmaster-run', asset('tiny-swords', 'units/red/pawn/pawn-run-hammer.png'), { frameWidth: 192, frameHeight: 192 });
    this.load.spritesheet('merc-idle', asset('tiny-swords', 'units/red/lancer/lancer-idle.png'), { frameWidth: 320, frameHeight: 320 });
    this.load.spritesheet('merc-run', asset('tiny-swords', 'units/red/lancer/lancer-run.png'), { frameWidth: 320, frameHeight: 320 });
    this.load.spritesheet('monk-idle', asset('tiny-swords', 'units/black/monk/idle.png'), { frameWidth: 192, frameHeight: 192 });
    this.load.spritesheet('monk-run', asset('tiny-swords', 'units/black/monk/run.png'), { frameWidth: 192, frameHeight: 192 });
    this.load.spritesheet('monk-heal', asset('tiny-swords', 'units/black/monk/heal.png'), { frameWidth: 192, frameHeight: 192 });
    this.load.spritesheet('fx-heal', asset('tiny-swords', 'units/black/monk/heal-effect.png'), { frameWidth: 192, frameHeight: 192 });
    this.load.spritesheet('boss-idle', asset('tiny-swords', 'units/black/lancer/lancer-idle.png'), { frameWidth: 320, frameHeight: 320 });
    this.load.spritesheet('boss-run', asset('tiny-swords', 'units/black/lancer/lancer-run.png'), { frameWidth: 320, frameHeight: 320 });

    // ---- Эффекты ----
    this.load.spritesheet('fx-explosion1', asset('tiny-swords', 'particle-fx/explosion-01.png'), { frameWidth: 192, frameHeight: 192 });
    this.load.spritesheet('fx-explosion2', asset('tiny-swords', 'particle-fx/explosion-02.png'), { frameWidth: 192, frameHeight: 192 });
    this.load.spritesheet('fx-dust', asset('tiny-swords', 'particle-fx/dust-01.png'), { frameWidth: 64, frameHeight: 64 });
    this.load.spritesheet('fx-fire', asset('tiny-swords', 'particle-fx/fire-01.png'), { frameWidth: 64, frameHeight: 64 });
    this.load.spritesheet('fx-foam', asset('tiny-swords', 'terrain/tileset/water-foam.png'), { frameWidth: 192, frameHeight: 192 });

    // ---- Тайлы, декорации ----
    this.load.image('grass-tile', asset('game', 'grass-tile.png'));
    this.load.image('water-tile', asset('tiny-swords', 'terrain/tileset/water-background-color.png'));
    this.load.spritesheet('tree1', asset('tiny-swords', 'terrain/resources/trees/tree1.png'), { frameWidth: 192, frameHeight: 256 });
    this.load.spritesheet('tree3', asset('tiny-swords', 'terrain/resources/trees/tree3.png'), { frameWidth: 192, frameHeight: 192 });
    this.load.spritesheet('bushe1', asset('tiny-swords', 'terrain/decorations/bushes/bushe1.png'), { frameWidth: 128, frameHeight: 128 });
    this.load.spritesheet('sheep', asset('tiny-swords', 'terrain/resources/sheep/sheep-idle.png'), { frameWidth: 128, frameHeight: 128 });
    this.load.image('rock1', asset('tiny-swords', 'terrain/decorations/rocks/rock1.png'));
    this.load.image('rock2', asset('tiny-swords', 'terrain/decorations/rocks/rock2.png'));
    this.load.image('rock3', asset('tiny-swords', 'terrain/decorations/rocks/rock3.png'));
    this.load.image('cloud1', asset('tiny-swords', 'terrain/decorations/clouds/clouds-02.png'));
    this.load.image('cloud2', asset('tiny-swords', 'terrain/decorations/clouds/clouds-04.png'));
    this.load.image('cloud3', asset('tiny-swords', 'terrain/decorations/clouds/clouds-06.png'));
    this.load.image('castle', asset('tiny-swords', 'buildings/blue/castle.png'));
    this.load.image('house1', asset('tiny-swords', 'buildings/blue/house1.png'));
    this.load.image('house2', asset('tiny-swords', 'buildings/blue/house2.png'));
    this.load.image('house3', asset('tiny-swords', 'buildings/blue/house3.png'));
    this.load.image('tower', asset('tiny-swords', 'buildings/blue/tower.png'));
    this.load.image('monastery', asset('tiny-swords', 'buildings/blue/monastery.png'));

    // ---- Игровые объекты ----
    this.load.image('gem-blue', asset('game', 'gem-blue.png'));
    this.load.image('gem-green', asset('game', 'gem-green.png'));
    this.load.image('gem-red', asset('game', 'gem-red.png'));
    this.load.image('gem-purple', asset('game', 'gem-purple.png'));
    this.load.image('gem-gold', asset('game', 'gem-gold.png'));
    this.load.image('meat', asset('game', 'meat.png'));
    this.load.image('arrow', asset('game', 'arrow.png'));
    this.load.image('spear', asset('game', 'spear.png'));
    this.load.image('barrel', asset('game', 'barrel.png'));
    this.load.image('slash', asset('game', 'slash.png'));
    this.load.image('aoe-ring', asset('game', 'aoe-ring.png'));
    this.load.image('shadow', asset('game', 'shadow.png'));
    this.load.image('knife', asset('game', 'knife.png'));
    this.load.image('treasure', asset('tiny-swords', 'terrain/resources/gold-stones/gold-stone-6.png'));
    this.load.spritesheet('fx-treasure', asset('tiny-swords', 'terrain/resources/gold-stones/gold-stone-6-highlight.png'), { frameWidth: 128, frameHeight: 128 });

    // ---- Иконки ----
    for (const ic of ['icon-sword', 'icon-bow', 'icon-spear', 'icon-hammer', 'icon-bomb', 'icon-aura',
      'icon-boots', 'icon-shield', 'icon-magnet', 'icon-heart', 'icon-might', 'icon-haste', 'icon-meat', 'icon-coin',
      'icon-knives', 'icon-gem']) {
      this.load.image(ic, asset('game', `${ic}.png`));
    }

    // ---- UI ----
    // 9-slice версии (склеены из тайлов ассета) — все панели/кнопки строятся
    // из них; сырые крупные текстуры (paper/banner/bigbutton) не грузим.
    this.load.image('btn-small-blue', asset('tiny-swords', 'ui/buttons/smallbluesquarebutton-regular.png'));
    this.load.image('swords', asset('tiny-swords', 'ui/swords/swords.png'));
    this.load.image('paper9', asset('game', 'paper9.png'));
    this.load.image('paper-special9', asset('game', 'paper-special9.png'));
    this.load.image('btn-blue9', asset('game', 'btn-blue9.png'));
    this.load.image('btn-red9', asset('game', 'btn-red9.png'));
    this.load.image('banner9', asset('game', 'banner9.png'));
  }

  create(): void {
    this.createAnims();
    this.scene.start('Menu');
  }

  private sheet(animKey: string, textureKey: string, count: number, rate = 10): void {
    this.anims.create({
      key: animKey,
      frames: this.anims.generateFrameNumbers(textureKey, { start: 0, end: count - 1 }),
      frameRate: rate,
      repeat: -1,
    });
  }

  private once(animKey: string, textureKey: string, count: number, rate = 14): void {
    this.anims.create({
      key: animKey,
      frames: this.anims.generateFrameNumbers(textureKey, { start: 0, end: count - 1 }),
      frameRate: rate,
      repeat: 0,
    });
  }

  private createAnims(): void {
    // Игрок
    this.sheet('player-idle', 'player-idle', 8, 8);
    this.sheet('player-run', 'player-run', 6, 10);
    this.once('player-atk1', 'player-atk1', 4, 16);
    this.once('player-atk2', 'player-atk2', 4, 16);
    // Враги
    this.sheet('grunt-idle', 'grunt-idle', 8, 7);
    this.sheet('grunt-run', 'grunt-run', 6, 10);
    this.sheet('swarm-idle', 'swarm-idle', 8, 8);
    this.sheet('swarm-run', 'swarm-run', 6, 13);
    this.sheet('brute-idle', 'brute-idle', 8, 6);
    this.sheet('brute-run', 'brute-run', 6, 8);
    this.sheet('archer-idle', 'archer-idle', 6, 7);
    this.sheet('archer-run', 'archer-run', 4, 10);
    this.once('archer-shoot', 'archer-shoot', 8, 14);
    this.sheet('lancer-idle', 'lancer-idle', 12, 8);
    this.sheet('lancer-run', 'lancer-run', 6, 10);
    // Новые враги v1.8
    this.sheet('guard-idle', 'guard-idle', 6, 7);
    this.sheet('guard-run', 'guard-run', 6, 11);
    this.sheet('taskmaster-idle', 'taskmaster-idle', 8, 7);
    this.sheet('taskmaster-run', 'taskmaster-run', 6, 10);
    this.sheet('merc-idle', 'merc-idle', 12, 8);
    this.sheet('merc-run', 'merc-run', 6, 10);
    this.sheet('monk-idle', 'monk-idle', 6, 7);
    this.sheet('monk-run', 'monk-run', 4, 10);
    this.once('monk-heal', 'monk-heal', 11, 12);
    this.sheet('boss-idle', 'boss-idle', 12, 8);
    this.sheet('boss-run', 'boss-run', 6, 10);
    // Эффекты
    this.once('fx-explosion1', 'fx-explosion1', 8, 16);
    this.once('fx-explosion2', 'fx-explosion2', 10, 16);
    this.once('fx-dust', 'fx-dust', 8, 14);
    this.once('fx-fire', 'fx-fire', 8, 12);
    this.once('fx-heal', 'fx-heal', 11, 12);
    this.sheet('fx-foam', 'fx-foam', 16, 8);
    this.sheet('fx-treasure', 'fx-treasure', 6, 10);
    // Герои
    this.sheet('hero-archer-idle', 'hero-archer-idle', 6, 7);
    this.sheet('hero-archer-run', 'hero-archer-run', 4, 10);
    this.once('hero-archer-atk', 'hero-archer-atk', 8, 14);
    this.sheet('hero-lancer-idle', 'hero-lancer-idle', 12, 8);
    this.sheet('hero-lancer-run', 'hero-lancer-run', 6, 10);
    this.once('hero-lancer-atk', 'hero-lancer-atk', 3, 12);
    this.sheet('hero-monk-idle', 'hero-monk-idle', 6, 7);
    this.sheet('hero-monk-run', 'hero-monk-run', 4, 10);
    this.once('hero-monk-atk', 'hero-monk-atk', 11, 12);
    // Декор
    this.sheet('tree1-sway', 'tree1', 8, 3);
    this.sheet('tree3-sway', 'tree3', 8, 3);
    this.sheet('bushe1-sway', 'bushe1', 8, 4);
    this.sheet('sheep-idle', 'sheep', 6, 4);
  }
}
