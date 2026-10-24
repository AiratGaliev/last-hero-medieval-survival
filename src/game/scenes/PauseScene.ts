import Phaser from 'phaser';
import { armIdleThrottle } from '../systems/IdleThrottle';
import { Cursor } from '../systems/Cursor';
import { DEPTH, FONT } from '../constants';
import { audio } from '../systems/Audio';
import { makeButton, makePanel, makeRibbon, OverlayLayer } from '../systems/Ui';
import { StatBar, FILL } from '../systems/Bar';
import { outlineFor } from '../systems/Text';
import { t } from '../../i18n';

// ============ Пауза: меню + панель снаряжения (оружия/бонусы) ============

interface LoadoutEntry {
  icon: string;
  name: string;
  level: number;
  /** Оружие прошло эволюцию (уровень 6) */
  evolved?: boolean;
}

interface LoadoutData {
  weapons: LoadoutEntry[];
  passives: LoadoutEntry[];
  hero: { name: string; hp: number; maxHp: number };
  stats: { kills: number; elapsed: number; gold: number; level: number };
}

interface PauseData {
  onResume: () => void;
  onToggleMute: () => boolean;
  hintsEnabled: boolean;
  onToggleHints: () => boolean;
  loadout?: LoadoutData;
  /**
   * Нижняя граница верхней полосы HUD (полоса босса) в экранных пикселях.
   * Окно открывается поверх живой сцены, и её верхняя полоса стоит ровно на
   * той же высоте, что и лента-заголовок.
   */
  topInset?: number;
}

export class PauseScene extends Phaser.Scene {
  private payload!: PauseData;
  /**
   * Звуковой переключатель — кнопка, а не строчка текста.
   *
   * Раньше это был голый Text с подписью «звук вкл»: выглядел как подпись,
   * а не как элемент управления, и на телефоне не давал ощущения, что его
   * можно нажать. Теперь это та же кнопка пака, что и остальные.
   */
  private muteBtn!: ReturnType<typeof makeButton>;
  private hintsBtn!: ReturnType<typeof makeButton>;
  /** Слой окна: всё содержимое выше HUD и его затемнения. */
  private ui!: OverlayLayer;

  constructor() {
    super('Pause');
  }

  /** Курсор в стиле Tiny Swords: следит за наведением и переключает
   *  состояние. В CSS у курсора !important — он перебивает инлайновый
   *  cursor, который Phaser ставит через useHandCursor. */
  private cursor!: Cursor;

  create(payload: PauseData): void {
    this.cursor = new Cursor(this);
    this.payload = payload;
    const { width, height } = this.scale;
    const compact = height < 560 || width < 560;
    this.ui = new OverlayLayer(this, DEPTH.OVERLAY + 2);

    this.ui.rectangle(width / 2, height / 2, width + 40, height + 40, 0x0a0a12, 0.7);

    // Заголовок — на ленте из пака, как в «Лавке», «Хронике», LevelUp и
    // окне преемственности. Раньше он висел голым обведённым текстом на
    // тёмном поле и выглядел как чужеродная вставка.
    const titleFont = compact ? 30 : 40;
    const ribbonH = Math.round(titleFont * 1.55);
    // Лента не наезжает на верхнюю полосу HUD: полоса босса с именем стоит
    // на той же высоте, и «ПАУЗА» ложилась прямо на неё.
    const requestedTitleY = Math.max(
      compact ? height * 0.1 : height * 0.11,
      (payload.topInset ?? 0) + ribbonH / 2 + 12,
    );
    // На низком/узком viewport оставляем физическое место под оба переключателя
    // и три действия. Если полоса босса съела почти всю высоту, слегка сжимаем
    // безопасный отступ вместо того, чтобы сделать меню неуправляемым.
    const maxTitleY = height - ribbonH / 2 - 177;
    const titleY = compact ? Math.min(requestedTitleY, maxTitleY) : requestedTitleY;
    const ribbonW = Math.min(width - 40, Math.max(260, width * 0.34));
    this.ui.add(makeRibbon(this, width / 2, titleY, ribbonW, 'ribbon-blue', ribbonH));

    const title = this.ui.text(width / 2, titleY, t('pause.title'), {
      fontFamily: FONT, fontSize: `${titleFont}px`, color: '#ffe9c0',
      stroke: '#1b1008', strokeThickness: outlineFor(titleFont),
    }).setOrigin(0.5);
    this.tweens.add({ targets: title, scale: { from: 0.7, to: 1 }, duration: 260, ease: 'Back.easeOut' });
    // Переключатели идут в одной адаптивной строке: второй ряд съедал место
    // на телефоне и наезжал на кнопки управления при видимой полосе босса.
    const soundY = titleY + ribbonH / 2 + 30;
    const controlsW = Math.max(120, Math.min(420, width - 32));
    const controlsGap = 10;
    const controlW = (controlsW - controlsGap) / 2;
    const controlsOffset = controlW / 2 + controlsGap / 2;
    this.buildSoundToggle(width / 2 - controlsOffset, soundY, controlW);
    this.buildHintsToggle(width / 2 + controlsOffset, soundY, controlW);
    const headerBottom = soundY + 38 / 2 + 8;

    // ---------- Панель снаряжения ----------
    const lo = payload.loadout;
    if (lo && !compact) {
      const panelW = Math.min(470, width - 60);
      const rows = Math.max(lo.weapons.length, lo.passives.length, 1);
      const panelH = Math.min(430, 128 + rows * 28 + 44);
      // На широком экране панель стоит по центру сверху, а кнопки — в ряд под
      // ней. Раньше панель и кнопки стояли рядом, и между ними зияла пустота.
      const by = height - (compact ? 120 : 96);
      // Панель центрируется между шапкой и кнопками, но не наезжает на шапку:
      // после сдвига ленты вниз (полоса босса) высокая панель могла залезть
      // под заголовок.
      const panelY = Math.max(headerBottom + panelH / 2 + 12, (headerBottom + (by - 40)) / 2);
      this.buildLoadoutPanel(width / 2, panelY, panelW, panelH, lo);
      const bw = Math.min(240, (width - 80) / 3 - 16);
      this.menuBtn(width / 2 - (bw + 16), by, t('pause.resume'), 'blue', bw, 58, () => this.resume());
      this.menuBtn(width / 2, by, t('pause.restart'), 'red', bw, 58, () => this.restart());
      this.menuBtn(width / 2 + (bw + 16), by, t('pause.toMenu'), 'blue', bw, 58, () => this.toMenu());
    } else {
      // На narrow/landscape viewport действия раскладываются в свободной зоне
      // после заголовка и настроек, а не по фиксированным долям высоты.
      const actionsTop = headerBottom + 10;
      const actionsBottom = height - 12;
      const available = Math.max(0, actionsBottom - actionsTop);
      const gap = Math.max(4, Math.min(10, Math.floor(available * 0.04)));
      const buttonH = Math.max(30, Math.min(58, Math.floor((available - gap * 2) / 3)));
      const total = buttonH * 3 + gap * 2;
      const startY = actionsTop + Math.max(0, (available - total) / 2) + buttonH / 2;
      const buttonW = Math.min(300, width - 40);
      this.menuBtn(width / 2, startY, t('pause.resume'), 'blue', buttonW, buttonH, () => this.resume());
      this.menuBtn(width / 2, startY + buttonH + gap, t('pause.restart'), 'red', buttonW, buttonH, () => this.restart());
      this.menuBtn(width / 2, startY + 2 * (buttonH + gap), t('pause.toMenu'), 'blue', Math.min(260, width - 40), buttonH, () => this.toMenu());
    }

    // Esc — продолжить
    const kb = this.input.keyboard;
    if (kb) {
      kb.on('keydown-ESC', () => this.resume());
      kb.on('keydown-P', () => this.resume());
    }

    // При изменении размера окна (поворот телефона) — перерисовать меню на новых координатах
    this.scale.on('resize', this.rebuild, this);
    this.events.once('shutdown', () => this.scale.off('resize', this.rebuild, this));

    // Пауза статична: без ввода рендерим 15 fps (матч под ней продолжает рисоваться)
    armIdleThrottle(this);
  }

  private resume(): void {
    this.payload.onResume();
    this.scene.stop();
  }

  private restart(): void {
    this.scene.stop('Game');
    this.scene.start('Game');
  }

  private toMenu(): void {
    this.scene.stop('Game');
    this.scene.start('Menu');
  }

  // ================================================================
  // Панель снаряжения: герой + колонки оружия/бонусов + статистика
  // ================================================================

  private buildLoadoutPanel(cx: number, cy: number, w: number, h: number, lo: LoadoutData): void {
    this.ui.add(makePanel(this, cx, cy, 'paper', w, h));
    const top = cy - h / 2;

    // Герой + HP
    this.ui.text(cx, top + 26, `${lo.hero.name.toUpperCase()}  ·  ${t('hud.level', { v: lo.stats.level })}`, {
      fontFamily: FONT, fontSize: '15px', color: '#3b2410',
    }).setOrigin(0.5);
    const hpFrac = Phaser.Math.Clamp(lo.hero.hp / Math.max(1, lo.hero.maxHp), 0, 1);
    const barW = Math.min(200, w - 80);
    // Полоса HP — из набора ui/bars, как в бою, а не зелёный прямоугольник.
    const hpBar = new StatBar(this, cx, top + 48, barW, 'small', {
      fill: FILL.green,
      fillLow: FILL.yellow,
      fillCritical: FILL.red,
    });
    hpBar.setFraction(hpFrac);
    this.ui.add(hpBar.root);
    this.ui.text(cx, top + 48, `${lo.hero.hp}/${lo.hero.maxHp}`, {
      fontFamily: FONT, fontSize: '12px', color: '#ffffff', stroke: '#3b2410', strokeThickness: 3,
    }).setOrigin(0.5);

    // Колонки
    const colW = (w - 60) / 2;
    const colL = cx - colW / 2 - 8;
    const colR = cx + colW / 2 + 8;
    this.ui.text(colL, top + 78, t('pause.weapons'), {
      fontFamily: FONT, fontSize: '12px', color: '#8a5b12',
    }).setOrigin(0.5);
    this.ui.text(colR, top + 78, t('pause.bonuses'), {
      fontFamily: FONT, fontSize: '12px', color: '#8a5b12',
    }).setOrigin(0.5);

    const entry = (x: number, y: number, e: LoadoutEntry, maxed: boolean) => {
      const ic = this.ui.image(x - colW / 2 + 14, y, e.icon).setDisplaySize(22, 22);
      const nameTxt = this.ui.text(x - colW / 2 + 32, y, e.name, {
        fontFamily: FONT, fontSize: '12px', color: e.evolved ? '#9a6a08' : '#3b2410',
      }).setOrigin(0, 0.5);
      if (e.evolved) {
        ic.setTint(0xffe9a0);
        nameTxt.setText(`★ ${e.name}`);
      }
      this.ui.text(x + colW / 2 - 10, y, e.evolved ? '★' : `${e.level}/5`, {
        fontFamily: FONT, fontSize: e.evolved ? 12 : 11,
        color: e.evolved ? '#b8860b' : maxed ? '#2e7d32' : '#b0803a',
        stroke: e.evolved ? '#ffe9b0' : maxed ? '#dcecc9' : '#f7e7c3', strokeThickness: 3,
      }).setOrigin(1, 0.5);
    };
    lo.weapons.slice(0, 7).forEach((e, i) => entry(colL, top + 100 + i * 28, e, e.level >= 5));
    lo.passives.slice(0, 8).forEach((e, i) => entry(colR, top + 100 + i * 28, e, e.level >= 5));

    // Статистика матча внизу панели.
    // Значки — из набора, а не эмодзи: в пиксельном шрифте нет глифов
    // ⏱/🪙, и на экране оставался пустой квадрат вместо часов и монеты.
    // Часов в наборе нет, поэтому время идёт текстом, а убийствам и золоту
    // достаются настоящие иконки.
    const mm = Math.floor(lo.stats.elapsed / 60);
    const ss = Math.floor(lo.stats.elapsed % 60).toString().padStart(2, '0');
    const statY = top + h - 24;
    const ICON = 13;
    const GAP = 14;
    const probe = this.ui.text(0, 0, '0000000', {
      fontFamily: FONT, fontSize: '12px', color: '#7a4e0e',
    }).setVisible(false);
    const digits = probe.width;
    probe.destroy();
    // Часы без значка: время и так читается, лишний глиф только шумит.
    const rows: Array<[string | null, string]> = [
      [null, `${mm}:${ss}`],
      ['icon-knives', `${lo.stats.kills}`],
      ['icon-coin', `${lo.stats.gold}`],
    ];
    let sx = cx - (rows.length * (ICON + 5 + digits) + GAP + digits) / 2 + digits / 2;
    for (const [icon, value] of rows) {
      if (icon) {
        this.ui.image(sx - digits / 2 - 5 - ICON / 2, statY, icon).setDisplaySize(ICON, ICON);
      }
      this.ui.text(sx, statY, value, {
        fontFamily: FONT, fontSize: '12px', color: '#7a4e0e',
      }).setOrigin(0.5);
      sx += digits + GAP + (icon ? ICON + 5 : 0);
    }
  }

  /**
   * Переключатель звука — кнопка пака с подписью состояния.
   *
   * Значок динамика (🔇) в пиксельном шрифте не рисовался — в наборе
   * нет эмодзи, и на экране оставался пустой квадрат. Поэтому состояние
   * передаётся словами, а сам переключатель сделан той же кнопкой, что и
   * остальные: раньше это была строчка текста, и в неё нельзя было
   * целиться на телефоне.
   */
  private buildSoundToggle(x: number, y: number, width = 190): void {
    const b = makeButton(this, x, y, width, 38, '', () => {
      this.payload.onToggleMute();
      this.updateMuteLabel();
    }, 'blue', 13, { hitW: width + 10, hitH: 46 });
    this.ui.addAll([b.img, b.txt, b.hit]);
    this.muteBtn = b;
    this.updateMuteLabel();
  }

  private buildHintsToggle(x: number, y: number, width: number): void {
    const b = makeButton(this, x, y, width, 38, '', () => {
      const enabled = this.payload.onToggleHints();
      this.updateHintsLabel(enabled);
    }, 'blue', 12, { hitW: width + 10, hitH: 46 });
    this.ui.addAll([b.img, b.txt, b.hit]);
    this.hintsBtn = b;
    this.updateHintsLabel(this.payload.hintsEnabled);
  }

  private updateHintsLabel(enabled: boolean): void {
    // Состояние payload переживает сцену при resize/orientationchange.
    this.payload.hintsEnabled = enabled;
    this.hintsBtn?.setLabel(enabled ? t('pause.trainingOn') : t('pause.trainingOff'));
  }

  private rebuild = (): void => {
    // Перезапуск с теми же данными — кнопки встанут по новым размерам экрана
    this.scene.restart(this.payload as PauseData);
  };

  private updateMuteLabel(): void {
    this.muteBtn?.setLabel(audio.muted ? t('hud.soundOff') : t('hud.soundOn'));
  }

  private menuBtn(x: number, y: number, label: string, variant: 'blue' | 'red', w: number, h: number, onClick: () => void): void {
    const b = makeButton(this, x, y, w, h, label, onClick, variant, w > 250 ? 20 : 16);
    this.ui.addAll([b.img, b.txt, b.hit]);
  }
}
