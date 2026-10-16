import Phaser from 'phaser';
import { FONT } from '../constants';
import { asset } from '../assets';
import { HEROES } from '../data';
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
    this.add.text(width / 2, by - 56, t('common.gameTitle'), {
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

    // ---- Жители: синяя и жёлтая фракции, чтобы толпа не была одного цвета ----
    for (const [prefix, faction] of [['pawn', 'blue'], ['pawny', 'yellow']] as const) {
      this.load.spritesheet(
        prefix + '-idle', asset('tiny-swords', `units/${faction}/pawn/pawn-idle.png`),
        { frameWidth: 192, frameHeight: 192 },
      );
      this.load.spritesheet(
        prefix + '-work-axe', asset('tiny-swords', `units/${faction}/pawn/pawn-interact-axe.png`),
        { frameWidth: 192, frameHeight: 192 },
      );
      this.load.spritesheet(
        prefix + '-work-hammer', asset('tiny-swords', `units/${faction}/pawn/pawn-interact-hammer.png`),
        { frameWidth: 192, frameHeight: 192 },
      );
      this.load.spritesheet(
        prefix + '-work-knife', asset('tiny-swords', `units/${faction}/pawn/pawn-interact-knife.png`),
        { frameWidth: 192, frameHeight: 192 },
      );
      this.load.spritesheet(
        prefix + '-work-pickaxe', asset('tiny-swords', `units/${faction}/pawn/pawn-interact-pickaxe.png`),
        { frameWidth: 192, frameHeight: 192 },
      );
    }
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
    // Раньше арена была пустой: никого, кроме овец. Крестьяне работают
    // у ресурсов, поэтому карта выглядит обжитой, а не пустошей.
    // Число кадров у листов разное: топор и кирка — по 6, нож — 4,
    // молот — 3. Задавать всем одно значение нельзя: Phaser начинает
    // писать «Frame not found» на каждом кадре анимации.
    const WORK_FRAMES: Array<[string, number, number]> = [
      ['axe', 6, 8],
      ['hammer', 3, 9],
      ['knife', 4, 8],
      ['pickaxe', 6, 8],
    ];
    for (const p of ['pawn', 'pawny']) {
      this.sheet(p + '-idle', p + '-idle', 8, 7);
      for (const [tool, n, rate] of WORK_FRAMES) {
        this.sheet(p + '-work-' + tool, p + '-work-' + tool, n, rate);
      }
    }
    this.sheet('sheep-idle', 'sheep', 6, 4);
  }
}
