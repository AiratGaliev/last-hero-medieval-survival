import Phaser from 'phaser';
import { FONT } from '../constants';
import { asset } from '../assets';
import { HEROES } from '../data';
import { t } from '../../i18n';

// ============ Загрузчик ассетов + анимации ============

/**
 * Таблица спрайт-листов существ (TZ §C.2). Порядок кадров проверен по
 * размерам листов; rate подобран под характер движения.
 * anim: idle/run/guard/windup — циклы состояния, atk/shoot/dead/recover —
 * однократные анимации действия.
 */
interface CreatureSheet {
  kind: string;   // = EnemyKind, префикс анимаций
  dir: string;    // папка внутри enemies/
  base: string;   // базовое имя файла
  frameW: number;
  sheets: Array<[anim: string, file: string, frames: number, rate: number]>;
}

export const CREATURE_SHEETS: CreatureSheet[] = [
  { kind: 'goblin', dir: 'goblin-raiders/torch-goblin', base: 'torch-goblin', frameW: 192, sheets: [
    ['idle', 'idle', 8, 8], ['run', 'run', 6, 10], ['atk', 'attack', 8, 12],
  ] },
  { kind: 'thief', dir: 'thief', base: 'thief', frameW: 192, sheets: [
    ['idle', 'idle', 6, 7], ['run', 'run', 6, 13], ['atk', 'attack', 6, 14],
  ] },
  { kind: 'gnoll', dir: 'gnoll', base: 'gnoll', frameW: 192, sheets: [
    ['idle', 'idle', 6, 7], ['run', 'walk', 8, 10], ['shoot', 'throw', 8, 12],
    // Брони нет, но ближний удар существо всё равно наносит (§A.5, выбор цели
    // №3), а общая ветка замаха играет `${kind}-atk`. Без алиаса Phaser
    // молча игнорирует play() и `lastAnim` навсегда залипает на ключе:
    // существо перестаёт переключать run/idle (ездит в бегущем цикле стоя).
    ['atk', 'throw', 8, 12],
  ] },
  { kind: 'skull', dir: 'skull', base: 'skull', frameW: 192, sheets: [
    ['idle', 'idle', 8, 7], ['run', 'run', 6, 11], ['atk', 'attack', 7, 12], ['guard', 'guard', 7, 10],
  ] },
  { kind: 'shaman', dir: 'goblin-raiders/hex-shaman', base: 'hex-shaman', frameW: 192, sheets: [
    ['idle', 'idle', 8, 7], ['run', 'run', 4, 10], ['shoot', 'attack', 10, 12],
    ['atk', 'attack', 10, 12],
  ] },
  { kind: 'pig-rider', dir: 'goblin-raiders/pig-rider-spear-goblin', base: 'pig-rider', frameW: 256, sheets: [
    ['idle', 'idle', 8, 7], ['run', 'run', 4, 12], ['atk', 'attack', 7, 12],
  ] },
  { kind: 'bomb-fish', dir: 'pirate-fish/bomb-fish', base: 'bomb-fish', frameW: 192, sheets: [
    ['idle', 'idle', 8, 7], ['run', 'run', 6, 12],
    // Подрыв «в упор» (§A.5): рыба подрывается рядом с пешкой. Штатных
    // idle/run мало — используем собственный bomb-fish-shoot (7 кадров).
    ['atk', 'shoot', 7, 10],
  ] },
  // Резервные кавернные/морские существа (фаза I): все пути проверены по паку.
  { kind: 'spider', dir: 'caveborn/spider', base: 'spider', frameW: 192, sheets: [
    ['idle', 'idle', 8, 7], ['run', 'run', 5, 10], ['atk', 'attack', 8, 12],
  ] },
  { kind: 'snake', dir: 'caveborn/snake', base: 'snake', frameW: 192, sheets: [
    ['idle', 'idle', 8, 7], ['run', 'run', 8, 11], ['atk', 'attack', 6, 12],
  ] },
  { kind: 'lizard', dir: 'caveborn/lizard', base: 'lizard', frameW: 192, sheets: [
    ['idle', 'idle', 7, 7], ['run', 'run', 6, 10], ['atk', 'attack', 9, 12], ['hit', 'hit', 2, 10],
  ] },
  { kind: 'turtle', dir: 'caveborn/turtle', base: 'turtle', frameW: 320, sheets: [
    ['idle', 'idle', 10, 7], ['run', 'walk', 7, 9], ['atk', 'attack', 10, 10],
    ['guardIn', 'guard-in', 6, 10], ['guardOut', 'guard-out', 3, 10],
  ] },
  { kind: 'gnome', dir: 'gnome', base: 'gnome', frameW: 192, sheets: [
    ['idle', 'idle', 8, 7], ['run', 'run', 6, 11], ['atk', 'attack', 7, 12],
  ] },
  { kind: 'panda', dir: 'panda', base: 'panda', frameW: 256, sheets: [
    ['idle', 'idle', 10, 7], ['run', 'run', 6, 10], ['atk', 'attack', 13, 12], ['guard', 'guard', 8, 9],
  ] },
  { kind: 'spear-goblin', dir: 'goblin-raiders/spear-goblin', base: 'spear-goblin', frameW: 256, sheets: [
    ['idle', 'idle', 8, 7], ['run', 'run', 6, 10], ['atk', 'attack-fast', 7, 12],
    ['atkStrong', 'attack-strong', 8, 11],
  ] },
  { kind: 'harpoon-shark', dir: 'pirate-fish/harpoon-shark', base: 'harpoon-shark', frameW: 192, sheets: [
    ['idle', 'idle', 8, 7], ['run', 'run', 6, 10], ['atk', 'throw', 8, 11],
  ] },
  { kind: 'paddle-shark', dir: 'pirate-fish/paddle-shark', base: 'paddle-shark', frameW: 192, sheets: [
    ['idle', 'idle', 8, 7], ['run', 'run', 6, 11], ['atk', 'attack', 6, 12],
  ] },
  { kind: 'bear', dir: 'caveborn/bear', base: 'bear', frameW: 256, sheets: [
    ['idle', 'idle', 8, 6], ['run', 'run', 5, 10], ['atk', 'attack', 9, 12],
  ] },
  { kind: 'minotaur', dir: 'minotaur', base: 'minotaur', frameW: 320, sheets: [
    ['idle', 'idle', 16, 8], ['run', 'walk', 8, 10], ['atk', 'attack', 12, 12], ['guard', 'guard', 11, 10],
  ] },
  { kind: 'boss', dir: 'ogre-boss', base: 'ogre-boss', frameW: 384, sheets: [
    ['idle', 'idle', 12, 7], ['run', 'walk', 10, 9], ['atk', 'attack', 6, 10],
    ['windup', 'windup', 5, 10], ['recover', 'recovery', 10, 10], ['dead', 'dead', 10, 8],
  ] },
];

/** Аватары существ (enemies/avatars) для заставок элит и босса. */
const CREATURE_FACES: Array<[kind: string, file: string]> = [
  ['goblin', 'torch-goblin'], ['thief', 'thief'], ['gnoll', 'gnoll'],
  ['skull', 'skull'], ['shaman', 'hex-shaman'], ['bomb-fish', 'bomb-fish'],
  ['spider', 'spider'], ['snake', 'snake'], ['lizard', 'lizard'], ['turtle', 'turtle'],
  ['gnome', 'gnome'], ['panda', 'panda'], ['spear-goblin', 'spear-goblin'],
  ['harpoon-shark', 'harpoon-shark'], ['paddle-shark', 'paddle-shark'],
  ['bear', 'bear'], ['minotaur', 'minotaur'], ['boss', 'ogre-boss'],
];

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
    this.add.text(width / 2, by - 56, t('common.gameTitle'), {
      fontFamily: FONT, fontSize: '16px', color: '#ffe9b0',
    }).setOrigin(0.5);
    const bar = this.add.rectangle(bx + 2, by + 1, 10, barH - 4, 0xe8c170).setOrigin(0, 0.5);
    this.add.text(width / 2, by + 40, t('boot.loading'), {
      fontFamily: FONT, fontSize: '12px', color: '#cbb389',
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

    // ---- Враги — существа из пака enemies/ (TZ §A.2, §C.2) ----
    // Листы грузятся циклом по CREATURE_SHEETS; анимации создаются в
    // createAnims() по тем же таблицам. Ключи: `${kind}-${anim}`.
    for (const c of CREATURE_SHEETS) {
      for (const [anim, file] of c.sheets) {
        this.load.spritesheet(
          `${c.kind}-${anim}`,
          asset('tiny-swords', `enemies/${c.dir}/${c.base}-${file}.png`),
          { frameWidth: c.frameW, frameHeight: c.frameW },
        );
      }
    }
    // FX лечения остаётся: используется Effects.heal (сейчас — герой-монак
    // и будущие механики монастыря, TZ §G). hero-monk-* не трогаем.
    this.load.spritesheet('fx-heal', asset('tiny-swords', 'units/black/monk/heal-effect.png'), { frameWidth: 192, frameHeight: 192 });
    // Снаряды врагов: вращающаяся кость гнолла и магический шар шамана,
    // плюс FX взрыва шара (все — из того же пака enemies/)
    this.load.spritesheet('proj-bone', asset('tiny-swords', 'enemies/gnoll/gnoll-bone.png'), { frameWidth: 64, frameHeight: 64 });
    this.load.spritesheet('proj-hex', asset('tiny-swords', 'enemies/goblin-raiders/hex-shaman/hex-shaman-projectile.png'), { frameWidth: 128, frameHeight: 128 });
    this.load.image('proj-harpoon', asset('tiny-swords', 'enemies/pirate-fish/harpoon-shark/harpoon.png'));
    this.load.spritesheet('fx-hex', asset('tiny-swords', 'enemies/goblin-raiders/hex-shaman/hex-shaman-explosion.png'), { frameWidth: 128, frameHeight: 128 });
    // Аватары существ для кино-заставок элит и босса (HUD.bossIntro)
    for (const [kind, file] of CREATURE_FACES) {
      this.load.image(`face-${kind}`, asset('tiny-swords', `enemies/avatars/${file}.png`));
    }

    // ---- Эффекты ----
    this.load.spritesheet('fx-explosion1', asset('tiny-swords', 'particle-fx/explosion-01.png'), { frameWidth: 192, frameHeight: 192 });
    this.load.spritesheet('fx-explosion2', asset('tiny-swords', 'particle-fx/explosion-02.png'), { frameWidth: 192, frameHeight: 192 });
    this.load.spritesheet('fx-dust', asset('tiny-swords', 'particle-fx/dust-01.png'), { frameWidth: 64, frameHeight: 64 });
    this.load.spritesheet('fx-fire', asset('tiny-swords', 'particle-fx/fire-01.png'), { frameWidth: 64, frameHeight: 64 });
    this.load.spritesheet('fx-foam', asset('tiny-swords', 'terrain/tileset/water-foam.png'), { frameWidth: 192, frameHeight: 192 });

    // ---- Тайлы, декорации ----
    // Тайл травы берём кадром из тайлсета (второй тайл верхней строки) —
    // отдельного grass-tile.png больше нет.
    this.load.spritesheet('grass-source', asset('tiny-swords', 'terrain/tileset/tilemap-color3.png'), {
      frameWidth: 64, frameHeight: 64,
    });
    // Автотайлы арены: трава с кустистым краем и каменный обрыв.
    // Используются для кромки — вместо голого прямоугольника травы.
    this.load.spritesheet('arena-tiles', asset('tiny-swords', 'terrain/tileset/tilemap-color1.png'), {
      frameWidth: 64, frameHeight: 64,
    });
    this.load.image('water-tile', asset('tiny-swords', 'terrain/tileset/water-background-color.png'));
    // ---- Деревья: четыре породы вместо двух ----
    this.load.spritesheet('tree1', asset('tiny-swords', 'terrain/resources/trees/tree1.png'), { frameWidth: 192, frameHeight: 256 });
    this.load.spritesheet('tree2', asset('tiny-swords', 'terrain/resources/trees/tree2.png'), { frameWidth: 192, frameHeight: 256 });
    this.load.spritesheet('tree3', asset('tiny-swords', 'terrain/resources/trees/tree3.png'), { frameWidth: 192, frameHeight: 192 });
    this.load.spritesheet('tree4', asset('tiny-swords', 'terrain/resources/trees/tree4.png'), { frameWidth: 192, frameHeight: 192 });
    // Пни: рубленые стволы. Статичные, но хорошо закрывают пустоты
    // у опушек, где дерево уже не помещается.
    this.load.image('stump1', asset('tiny-swords', 'terrain/resources/trees/stump-1.png'));
    this.load.image('stump2', asset('tiny-swords', 'terrain/resources/trees/stump-2.png'));
    this.load.image('stump3', asset('tiny-swords', 'terrain/resources/trees/stump-3.png'));
    this.load.image('stump4', asset('tiny-swords', 'terrain/resources/trees/stump-4.png'));
    // ---- Кусты: четыре вида с покачиванием ----
    this.load.spritesheet('bushe1', asset('tiny-swords', 'terrain/decorations/bushes/bushe1.png'), { frameWidth: 128, frameHeight: 128 });
    this.load.spritesheet('bushe2', asset('tiny-swords', 'terrain/decorations/bushes/bushe2.png'), { frameWidth: 128, frameHeight: 128 });
    this.load.spritesheet('bushe3', asset('tiny-swords', 'terrain/decorations/bushes/bushe3.png'), { frameWidth: 128, frameHeight: 128 });
    this.load.spritesheet('bushe4', asset('tiny-swords', 'terrain/decorations/bushes/bushe4.png'), { frameWidth: 128, frameHeight: 128 });
    this.load.spritesheet('sheep', asset('tiny-swords', 'terrain/resources/sheep/sheep-idle.png'), { frameWidth: 128, frameHeight: 128 });
    // ---- Камни ----
    this.load.image('rock1', asset('tiny-swords', 'terrain/decorations/rocks/rock1.png'));
    this.load.image('rock2', asset('tiny-swords', 'terrain/decorations/rocks/rock2.png'));
    this.load.image('rock3', asset('tiny-swords', 'terrain/decorations/rocks/rock3.png'));
    this.load.image('rock4', asset('tiny-swords', 'terrain/decorations/rocks/rock4.png'));
    // ---- Камни в воде: кромка арены перестаёт быть пустой полосой ----
    this.load.spritesheet('waterrock1', asset('tiny-swords', 'terrain/decorations/water-rocks/water-rocks-01.png'), { frameWidth: 128, frameHeight: 64 });
    this.load.spritesheet('waterrock2', asset('tiny-swords', 'terrain/decorations/water-rocks/water-rocks-02.png'), { frameWidth: 128, frameHeight: 64 });
    this.load.spritesheet('waterrock3', asset('tiny-swords', 'terrain/decorations/water-rocks/water-rocks-03.png'), { frameWidth: 128, frameHeight: 64 });
    this.load.spritesheet('waterrock4', asset('tiny-swords', 'terrain/decorations/water-rocks/water-rocks-04.png'), { frameWidth: 128, frameHeight: 64 });
    // ---- Облака: восемь форм вместо трёх ----
    this.load.image('cloud1', asset('tiny-swords', 'terrain/decorations/clouds/clouds-01.png'));
    this.load.image('cloud2', asset('tiny-swords', 'terrain/decorations/clouds/clouds-02.png'));
    this.load.image('cloud3', asset('tiny-swords', 'terrain/decorations/clouds/clouds-03.png'));
    this.load.image('cloud4', asset('tiny-swords', 'terrain/decorations/clouds/clouds-04.png'));
    this.load.image('cloud5', asset('tiny-swords', 'terrain/decorations/clouds/clouds-05.png'));
    this.load.image('cloud6', asset('tiny-swords', 'terrain/decorations/clouds/clouds-06.png'));
    this.load.image('cloud7', asset('tiny-swords', 'terrain/decorations/clouds/clouds-07.png'));
    this.load.image('cloud8', asset('tiny-swords', 'terrain/decorations/clouds/clouds-08.png'));
    // Пасхалка: уточка плавает в канаве у берега
    this.load.image('duck', asset('tiny-swords', 'terrain/decorations/rubber-duck/rubber-duck.png'));

    // ---- Стрелка и рамки: только ui/cursors ----
    // cursor-01 — стрелка: и курсор мыши, и указатель на цель за экраном
    // (не 'arrow' — под тем ключом уже лежит стрела-снаряд game/arrow.png)
    this.load.image('cursor-arrow', asset('tiny-swords', 'ui/cursors/cursor-01.png'));
    // cursor-04 — четыре угла рамки в одной картинке 128×128. Отдельных
    // corner-*.png больше нет: углы регистрируются кадрами этой текстуры в
    // create() (см. addFrame ниже), а systems/Corners.ts рисует рамку
    // из них под любой размер.
    this.load.image('cursor-04', asset('tiny-swords', 'ui/cursors/cursor-04.png'));

    // Ленты для заголовков: торцы + растягиваемая середина
    this.load.image('ribbon-blue', asset('game', 'ribbon-blue.png'));
    this.load.image('ribbon-yellow', asset('game', 'ribbon-yellow.png'));
    this.load.image('ribbon-purple', asset('game', 'ribbon-purple.png'));
    this.load.image('ribbon-red', asset('game', 'ribbon-red.png'));

    // ---- Жители: синяя и жёлтая фракции ----
    // Синий collector использует axe/pickaxe/knife (молот — только у жёлтых
    // builder/repairer, TZ §B.10): ключ pawn-work-hammer не регистрируется.
    for (const [prefix, faction] of [['pawn', 'blue'], ['pawny', 'yellow']] as const) {
      this.load.spritesheet(
        prefix + '-idle', asset('tiny-swords', `units/${faction}/pawn/pawn-idle.png`),
        { frameWidth: 192, frameHeight: 192 },
      );
      // Ходьба без груза: раньше лист не грузился, и Pawn.playMove падал
      // в фолбэк «Missing animation: pawn-run» — пешки шли статичной картинкой
      this.load.spritesheet(
        prefix + '-run', asset('tiny-swords', `units/${faction}/pawn/pawn-run.png`),
        { frameWidth: 192, frameHeight: 192 },
      );
      for (const tool of ['axe', 'knife', 'pickaxe'] as const) {
        this.load.spritesheet(
          prefix + '-work-' + tool, asset('tiny-swords', `units/${faction}/pawn/pawn-interact-${tool}.png`),
          { frameWidth: 192, frameHeight: 192 },
        );
      }
    }
    // Молот нужен только жёлтой фракции (стройка/ремонт, §B.2)
    this.load.spritesheet('pawny-work-hammer', asset('tiny-swords', 'units/yellow/pawn/pawn-interact-hammer.png'), { frameWidth: 192, frameHeight: 192 });
    // Carry-анимации пешек: ресурс виден на руках (§B.2)
    for (const [prefix, faction] of [['pawn', 'blue'], ['pawny', 'yellow']] as const) {
      for (const res of ['wood', 'meat', 'gold'] as const) {
        this.load.spritesheet(
          `${prefix}-carry-${res}`, asset('tiny-swords', `units/${faction}/pawn/pawn-run-${res}.png`),
          { frameWidth: 192, frameHeight: 192 },
        );
        this.load.spritesheet(
          `${prefix}-carry-idle-${res}`, asset('tiny-swords', `units/${faction}/pawn/pawn-idle-${res}.png`),
          { frameWidth: 192, frameHeight: 192 },
        );
      }
    }
    // ---- Гарнизон (§B.2): воины казарм/тирa/обители — префикс pawn-*
    // обязателен, иначе столкнётся с hero-* (§A.6)
    this.load.spritesheet('pawn-warrior-idle', asset('tiny-swords', 'units/blue/warrior/warrior-idle.png'), { frameWidth: 192, frameHeight: 192 });
    this.load.spritesheet('pawn-warrior-run', asset('tiny-swords', 'units/blue/warrior/warrior-run.png'), { frameWidth: 192, frameHeight: 192 });
    this.load.spritesheet('pawn-warrior-attack1', asset('tiny-swords', 'units/blue/warrior/warrior-attack1.png'), { frameWidth: 192, frameHeight: 192 });
    this.load.spritesheet('pawn-warrior-attack2', asset('tiny-swords', 'units/blue/warrior/warrior-attack2.png'), { frameWidth: 192, frameHeight: 192 });
    this.load.spritesheet('pawn-lancer-idle', asset('tiny-swords', 'units/blue/lancer/lancer-idle.png'), { frameWidth: 320, frameHeight: 320 });
    this.load.spritesheet('pawn-lancer-run', asset('tiny-swords', 'units/blue/lancer/lancer-run.png'), { frameWidth: 320, frameHeight: 320 });
    this.load.spritesheet('pawn-lancer-atk', asset('tiny-swords', 'units/blue/lancer/lancer-right-attack.png'), { frameWidth: 320, frameHeight: 320 });
    this.load.spritesheet('pawn-archer-idle', asset('tiny-swords', 'units/blue/archer/archer-idle.png'), { frameWidth: 192, frameHeight: 192 });
    this.load.spritesheet('pawn-archer-run', asset('tiny-swords', 'units/blue/archer/archer-run.png'), { frameWidth: 192, frameHeight: 192 });
    this.load.spritesheet('pawn-archer-atk', asset('tiny-swords', 'units/blue/archer/archer-shoot.png'), { frameWidth: 192, frameHeight: 192 });
    this.load.spritesheet('pawn-monk-idle', asset('tiny-swords', 'units/blue/monk/idle.png'), { frameWidth: 192, frameHeight: 192 });
    this.load.spritesheet('pawn-monk-run', asset('tiny-swords', 'units/blue/monk/run.png'), { frameWidth: 192, frameHeight: 192 });
    this.load.spritesheet('pawn-monk-atk', asset('tiny-swords', 'units/blue/monk/heal.png'), { frameWidth: 192, frameHeight: 192 });

    // ---- Золотые жилы (§B.3): 5 вариантов + пульс (6 кадров 128×128)
    for (let i = 1; i <= 5; i++) {
      this.load.image(`gold-vein-${i}`, asset('tiny-swords', `terrain/resources/gold-stones/gold-stone-${i}.png`));
      this.load.spritesheet(
        `gold-vein-pulse-${i}`, asset('tiny-swords', `terrain/resources/gold-stones/gold-stone-${i}-highlight.png`),
        { frameWidth: 128, frameHeight: 128 },
      );
    }
    // ---- Иконки ресурсов для HUD (§B.8): дерево/мясо/руда
    this.load.image('res-wood', asset('tiny-swords', 'terrain/resources/wood-resource/wood-resource.png'));
    this.load.image('res-meat', asset('tiny-swords', 'terrain/resources/meat-resource/meat-resource.png'));
    this.load.image('res-ore', asset('tiny-swords', 'terrain/resources/gold-resource/gold-resource.png'));

    this.load.image('castle', asset('tiny-swords', 'buildings/blue/castle.png'));
    this.load.image('house1', asset('tiny-swords', 'buildings/blue/house1.png'));
    this.load.image('house2', asset('tiny-swords', 'buildings/blue/house2.png'));
    this.load.image('house3', asset('tiny-swords', 'buildings/blue/house3.png'));
    this.load.image('tower', asset('tiny-swords', 'buildings/blue/tower.png'));
    this.load.image('monastery', asset('tiny-swords', 'buildings/blue/monastery.png'));
    // Казармы вошли в первый раунд ради преемственности (§F.3), тир — фаза M
    this.load.image('barracks', asset('tiny-swords', 'buildings/blue/barracks.png'));
    this.load.image('archery', asset('tiny-swords', 'buildings/blue/archery.png'));

    // ---- Игровые объекты ----
    this.load.image('gem-blue', asset('game', 'gem-blue.png'));
    this.load.image('gem-green', asset('game', 'gem-green.png'));
    this.load.image('gem-red', asset('game', 'gem-red.png'));
    this.load.image('gem-purple', asset('game', 'gem-purple.png'));
    this.load.image('gem-gold', asset('game', 'gem-gold.png'));
    // ---- Стрела-снаряд, мясо, иконки: берём прямо из tiny-swords ----
    // Раньше эти файлы лежали копиями в src/assets/game. Копии удалены —
    // здесь ссылка на оригинал, второй источник правды не нужен.
    this.load.image('meat', asset('tiny-swords', 'terrain/resources/meat-resource/meat-resource.png'));
    this.load.image('arrow', asset('tiny-swords', 'units/black/archer/arrow.png'));
    this.load.image('icon-sword', asset('tiny-swords', 'ui/icons/icon-05.png'));
    this.load.image('icon-hammer', asset('tiny-swords', 'ui/icons/icon-01.png'));
    this.load.image('icon-meat', asset('tiny-swords', 'ui/icons/icon-04.png'));
    this.load.image('icon-coin', asset('tiny-swords', 'ui/icons/icon-03.png'));
    this.load.image('icon-gem', asset('tiny-swords', 'ui/icons/icon-07.png'));
    this.load.image('icon-shield', asset('tiny-swords', 'ui/icons/icon-06.png'));
    // Иконка лука — тот же рисунок стрелы, отдельного файла в ассете нет
    this.load.image('icon-bow', asset('tiny-swords', 'units/black/archer/arrow.png'));
    this.load.image('spear', asset('game', 'spear.png'));
    // Динамит: спрайт-лист 384×64 (6 кадров по 64×64, горит фитиль).
    // Ключ 'barrel' сохранён — его используют враг-камикадзе (data.ts) и
    // снаряд бомбы (Projectiles.throwBomb).
    this.load.spritesheet('barrel', asset('tiny-swords', 'units/extra/dynamite/dynamite.png'), {
      frameWidth: 64, frameHeight: 64,
    });
    this.load.image('slash', asset('game', 'slash.png'));
    this.load.image('aoe-ring', asset('game', 'aoe-ring.png'));
    // Тень: исходный Shadow.png 192×192 (содержимое 79×80 @ 57,56). Пустые
    // поля компенсируются при отрисовке (origin + масштаб), отдельной обрезки
    // не нужно — см. SHADOW_BOX в constants.ts.
    this.load.image('shadow', asset('tiny-swords', 'terrain/tileset/shadow.png'));

    // ---- Полосы: три детали в ряд в каждом листе ----
    // Отдельных bar-*-cap/mid.png больше нет: детали регистрируются кадрами
    // этих текстур в create(), а systems/Bar.ts собирает из них полосу.
    this.load.image('bar-base-big', asset('tiny-swords', 'ui/bars/bigbar-base.png'));
    this.load.image('bar-base-small', asset('tiny-swords', 'ui/bars/smallbar-base.png'));
    this.load.image('knife', asset('game', 'knife.png'));
    this.load.image('treasure', asset('tiny-swords', 'terrain/resources/gold-stones/gold-stone-6.png'));
    this.load.spritesheet('fx-treasure', asset('tiny-swords', 'terrain/resources/gold-stones/gold-stone-6-highlight.png'), { frameWidth: 128, frameHeight: 128 });

    // ---- Иконки ----
    // Эти девять есть только в src/assets/game — в tiny-swords нет ни одного
    // пиксельно совпадающего файла. Остальные иконки грузятся из ui/icons
    // (см. блок выше) — дублей копий больше нет.
    for (const ic of ['icon-spear', 'icon-bomb', 'icon-aura',
      'icon-boots', 'icon-magnet', 'icon-heart', 'icon-might', 'icon-haste', 'icon-knives']) {
      this.load.image(ic, asset('game', `${ic}.png`));
    }

    // ---- UI ----
    // 9-slice версии (склеены из тайлов ассета) — все панели/кнопки строятся
    // из них; сырые крупные текстуры (paper/banner/bigbutton) не грузим.
    this.load.image('btn-small-blue', asset('tiny-swords', 'ui/buttons/smallbluesquarebutton-regular.png'));
    // Круглые кнопки — для радиального меню приказов (systems/OrderMenu.ts)
    this.load.image('btn-small-blue-round', asset('tiny-swords', 'ui/buttons/smallblueroundbutton-regular.png'));
    this.load.image('btn-small-red-round', asset('tiny-swords', 'ui/buttons/smallredroundbutton-regular.png'));
    // Мечи логотипа: два ряда из сетки 3×5 в ui/swords, вырезаны скриптом
    // scripts/prepare-assets.mjs. Сама сетка не грузится — она в три раза
    // тяжелее и нужна только на этапе подготовки ассетов.
    this.load.image('sword-blue', asset('game', 'sword-blue.png'));
    this.load.image('sword-red', asset('game', 'sword-red.png'));
    this.load.image('paper9', asset('game', 'paper9.png'));
    this.load.image('paper-special9', asset('game', 'paper-special9.png'));
    this.load.image('btn-blue9', asset('game', 'btn-blue9.png'));
    this.load.image('btn-red9', asset('game', 'btn-red9.png'));
    // Состояние «утопленной» кнопки — раньше нажатия не было вовсе
    this.load.image('btn-blue9-pressed', asset('game', 'btn-blue9-pressed.png'));
    this.load.image('btn-red9-pressed', asset('game', 'btn-red9-pressed.png'));
    this.load.image('banner9', asset('game', 'banner9.png'));
    // Деревянный торговый стол для «Лавки торговца»
    this.load.image('table9', asset('game', 'table9.png'));

    // ---- Полосы HP/XP: собраны из трёх деталей, см. systems/Bar.ts ----
    // Детали — кадры текстур bar-base-{small,big} (загружены выше), отдельных
    // bar-*-cap/mid.png больше нет. Заливки: исходная bar-big-fill перекрашена
    // под цвета gameplay, потому что setTint умножает, а не заменяет цвет.
    for (const c of ['blue', 'green', 'yellow', 'red', 'ghost', 'white']) {
      this.load.image(`bar-fill-${c}`, asset('game', `bar-fill-${c}.png`));
    }

    // ---- Портреты героев: прямо из исходников ui/avatars пака ----
    // Обрезанных копий в src/assets/game больше нет: картинка 256×256 грузится
    // целиком, а рамка персонажа (HeroDef.portrait.box) применяется при отрисовке.
    for (const hero of Object.values(HEROES)) {
      this.load.image(`avatar-${hero.id}`, asset('tiny-swords', hero.portrait.file));
    }


  }

  create(): void {
    this.registerFrames();
    this.createAnims();
    this.scene.start('Menu');
  }

  /**
   * Кадры из сырых текстур пака. Отдельные обрезанные копии в src/assets/game
   * больше не генерируются (scripts/prepare-assets.mjs): нужные прямоугольники
   * регистрируются как кадры тех же самых текстур, что грузит игра. Так в
   * репозитории нет дубликатов картинок пака.
   */
  private registerFrames(): void {
    // Тайл травы 64×64 из tilemap-color3 (сетка 9×6 тайлов): второй тайл
    // верхней строки.
    this.textures.get('grass-source').add('grass-tile', 0, 64, 64, 64, 64);

    // Углы рамки: по 21×25 в квадрантах 64×64 картинки 128×128.
    const cursor = this.textures.get('cursor-04');
    cursor.add('corner-tl', 0, 3, 3, 21, 25);
    cursor.add('corner-tr', 0, 104, 3, 21, 25);
    cursor.add('corner-br', 0, 104, 100, 21, 25);
    cursor.add('corner-bl', 0, 3, 100, 21, 25);

    // Полосы: три детали в ряд в каждом листе (торец, середина, торец).
    const bigBar = this.textures.get('bar-base-big');
    bigBar.add('bar-big-cap-l', 0, 40, 9, 24, 51);
    bigBar.add('bar-big-mid', 0, 128, 9, 64, 51);
    bigBar.add('bar-big-cap-r', 0, 256, 9, 24, 51);
    const smallBar = this.textures.get('bar-base-small');
    smallBar.add('bar-small-cap-l', 0, 49, 22, 15, 19);
    smallBar.add('bar-small-mid', 0, 128, 22, 64, 19);
    smallBar.add('bar-small-cap-r', 0, 256, 22, 15, 19);

    // Ленты: три детали в ряд (левый хвост, растягиваемая середина, правый
    // хвост). Нine-slice тут не годится: хвосты ленты содержат изгибы, и
    // Phaser рисует углы девятислайса в натуральную величину — лента
    // «разъезжалась» и выглядела смятой. Собираем ленту из трёх картинок,
    // как полосу в systems/Bar.ts.
    //
    // Границы деталей заданы scripts/make-ribbons.mjs: 98 | 48 | 97.
    for (const key of ['ribbon-blue', 'ribbon-yellow', 'ribbon-purple', 'ribbon-red']) {
      const tex = this.textures.get(key);
      if (!tex) continue;
      tex.add('ribbon-l', 0, 0, 0, 98, 128);
      tex.add('ribbon-m', 0, 98, 0, 48, 128);
      tex.add('ribbon-r', 0, 146, 0, 97, 128);
    }
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
    // Динамит: горящий фитиль (6 кадров спрайт-листа 384×64)
    this.anims.create({
      key: 'barrel-burn',
      frames: this.anims.generateFrameNumbers('barrel', { start: 0, end: 5 }),
      frameRate: 8,
      repeat: -1,
    });
    // Игрок
    this.sheet('player-idle', 'player-idle', 8, 8);
    this.sheet('player-run', 'player-run', 6, 10);
    this.once('player-atk1', 'player-atk1', 4, 16);
    this.once('player-atk2', 'player-atk2', 4, 16);
    // Враги — существа: циклы и однократные анимации по таблице CREATURE_SHEETS
    for (const c of CREATURE_SHEETS) {
      for (const [anim, , frames, rate] of c.sheets) {
        const key = `${c.kind}-${anim}`;
        if (['atk', 'atkStrong', 'shoot', 'dead', 'recover', 'hit', 'guardIn', 'guardOut'].includes(anim)) {
          this.once(key, key, frames, rate);
        } else {
          this.sheet(key, key, frames, rate);
        }
      }
    }
    // Снаряды врагов и FX взрыва шара
    this.sheet('proj-bone-spin', 'proj-bone', 4, 10);
    this.sheet('proj-hex-orb', 'proj-hex', 3, 8);
    this.once('fx-hex', 'fx-hex', 9, 14);
    // Эффекты
    this.once('fx-explosion1', 'fx-explosion1', 8, 16);
    this.once('fx-explosion2', 'fx-explosion2', 10, 16);
    this.once('fx-dust', 'fx-dust', 8, 14);
    this.once('fx-fire', 'fx-fire', 8, 12);
    // Отдельный цикл для длительного горения построек; hit-FX выше остаётся одноразовым.
    this.anims.create({
      key: 'building-fire-loop',
      frames: this.anims.generateFrameNumbers('fx-fire', { start: 0, end: 7 }),
      frameRate: 10,
      repeat: -1,
    });
    this.anims.create({
      key: 'fire-arrow-trail',
      frames: this.anims.generateFrameNumbers('fx-fire', { start: 0, end: 7 }),
      frameRate: 14,
      repeat: -1,
    });
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
    // Покачивание декора: деревья, кусты, камни в воде
    this.sheet('tree1-sway', 'tree1', 8, 3);
    this.sheet('tree2-sway', 'tree2', 8, 3);
    this.sheet('tree3-sway', 'tree3', 8, 3);
    this.sheet('tree4-sway', 'tree4', 8, 3);
    this.sheet('bushe1-sway', 'bushe1', 8, 4);
    this.sheet('bushe2-sway', 'bushe2', 8, 4);
    this.sheet('bushe3-sway', 'bushe3', 8, 4);
    this.sheet('bushe4-sway', 'bushe4', 8, 4);
    this.sheet('waterrock1-sway', 'waterrock1', 8, 6);
    this.sheet('waterrock2-sway', 'waterrock2', 8, 6);
    this.sheet('waterrock3-sway', 'waterrock3', 8, 6);
    this.sheet('waterrock4-sway', 'waterrock4', 8, 6);

    // ---- Жители: пешки базово-рабочего вида ----
    // Число кадров у листов разное: топор и кирка — по 6, нож — 4.
    // Задавать всем одно значение нельзя: Phaser начинает писать
    // «Frame not found» на каждом кадре анимации.
    const WORK_FRAMES: Array<[string, number, number]> = [
      ['axe', 6, 8],
      ['knife', 4, 8],
      ['pickaxe', 6, 8],
    ];
    for (const p of ['pawn', 'pawny']) {
      this.sheet(p + '-idle', p + '-idle', 8, 7);
      this.sheet(p + '-run', p + '-run', 6, 10);
      for (const [tool, n, rate] of WORK_FRAMES) {
        this.sheet(p + '-work-' + tool, p + '-work-' + tool, n, rate);
      }
      // Carry: ресурс в руках — run 6 кадров / idle 8 кадров (§B.2)
      for (const res of ['wood', 'meat', 'gold'] as const) {
        this.sheet(`${p}-carry-${res}`, `${p}-carry-${res}`, 6, 10);
        this.sheet(`${p}-carry-idle-${res}`, `${p}-carry-idle-${res}`, 8, 7);
      }
    }
    // Молот — только жёлтая фракция (стройка/ремонт, 3 кадра)
    this.sheet('pawny-work-hammer', 'pawny-work-hammer', 3, 9);

    // ---- Гарнизон: анимации воинов (§B.2). Кадры проверены по ширине листов.
    this.sheet('pawn-warrior-idle', 'pawn-warrior-idle', 8, 7);
    this.sheet('pawn-warrior-run', 'pawn-warrior-run', 6, 10);
    this.once('pawn-warrior-attack1', 'pawn-warrior-attack1', 4, 14);
    this.once('pawn-warrior-attack2', 'pawn-warrior-attack2', 4, 14);
    this.sheet('pawn-lancer-idle', 'pawn-lancer-idle', 12, 8);
    this.sheet('pawn-lancer-run', 'pawn-lancer-run', 6, 10);
    this.once('pawn-lancer-atk', 'pawn-lancer-atk', 3, 12);
    this.sheet('pawn-archer-idle', 'pawn-archer-idle', 6, 7);
    this.sheet('pawn-archer-run', 'pawn-archer-run', 4, 10);
    this.once('pawn-archer-atk', 'pawn-archer-atk', 8, 14);
    this.sheet('pawn-monk-idle', 'pawn-monk-idle', 6, 7);
    this.sheet('pawn-monk-run', 'pawn-monk-run', 4, 10);
    this.once('pawn-monk-atk', 'pawn-monk-atk', 11, 12);

    // ---- Золотые жилы: пульс (6 кадров 128×128 на вариант)
    for (let i = 1; i <= 5; i++) {
      this.sheet(`gold-vein-pulse-${i}`, `gold-vein-pulse-${i}`, 6, 6);
    }
    this.sheet('sheep-idle', 'sheep', 6, 4);
  }
}
