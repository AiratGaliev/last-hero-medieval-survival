import Phaser from 'phaser';
import { Cursor } from '../systems/Cursor';
import { FONT } from '../constants';
import { makePanel, makeButton, fitTextWidth, type Button } from '../systems/Ui';
import { audio } from '../systems/Audio';
import { t, num, clock } from '../../i18n';
import { submitScore } from '../../platform/leaderboard';
import { isAuthorized, displayName } from '../../platform/player';
import { showInterstitial, showRewarded, rewardedAvailable } from '../../platform/ads';
import { gameplayStop } from '../../platform/lifecycle';
import { loadText, saveText } from '../storage';

// ============ Экран конца матча: статистика + рекорд + монетизация ============
// Всё внутри Phaser: гость вводит имя в нативный <input> (DOMElement),
// авторизованный игрок Яндекса получает имя из профиля. Рекорд уходит
// либо в общий зал Яндекс Игр, либо в локальную таблицу (см. platform/leaderboard).
//
// Вёрстка. Тело (статистика, урон по оружию, новые достижения) скроллится,
// низ (имя, воскрешение, сохранение, действия) закреплён у нижней границы.
// Раньше всё складывалось одной переменной `cursor` сверху вниз, и на
// 1280×720 с полным набором оружия кнопка «Сохранить» уезжала за экран —
// рекорд было физически не сохранить.

export interface GameOverStats {
  victory: boolean;
  time: number;
  kills: number;
  level: number;
  gold: number;
  score: number;
  hero?: string;
  difficulty?: string;
  difficultyId?: string;
  bestCombo?: number;
  weapons?: { id: string; icon: string; name: string; dmg: number; kills: number; evolved?: boolean }[];
  newAch?: { name: string; emoji: string }[];
}

interface GameOverData {
  stats: GameOverStats;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** Что удалось показать игрок�� после сохранения. */
type SaveTarget = 'none' | 'online' | 'local' | 'error';

/** Минимальный контракт GameScene, нужный сцене конца матча. */
interface GameOverReviveTarget {
  revive?(): boolean;
}

export class GameOverScene extends Phaser.Scene {
  private payload!: GameOverData;
  /** Состояние сохранения переживает рестарт сцены (ресайз) — но не новый матч */
  private saveState: SaveState = 'idle';
  private lastStatsRef: GameOverStats | null = null;
  private nameValue = '';
  private nameInput: Phaser.GameObjects.DOMElement | null = null;
  private saveBtn: Button | null = null;
  private saveMsg: Phaser.GameObjects.Text | null = null;
  private saveTarget: SaveTarget = 'none';
  private reviveBtn: (Button & { hint: Phaser.GameObjects.Text }) | null = null;
  /** Один раз за матч. Сбрасывается вместе с lastStatsRef. */
  private reviveUsed = false;
  /** Защита от двойного клика: два параллельных showRewarded — лишний вызов SDK. */
  private revivePending = false;
  private saveY = 0;

  constructor() {
    super('GameOver');
  }

  /** Курсор в стиле Tiny Swords: следит за наведением и переключает
   *  состояние. В CSS у курсора !important — он перебивает инлайновый
   *  cursor, который Phaser ставит через useHandCursor. */
  private cursor!: Cursor;

  create(payload: GameOverData): void {
    this.cursor = new Cursor(this);
    this.payload = payload;
    if (this.lastStatsRef !== payload.stats) {
      // Новый матч — сбрасываем прогресс сохранения и право на воскрешение.
      // Раньше reviveUsed жил на экземпляре сцены, а Phaser переиспользует
      // сцену между матчами: воскрешение работало один раз за загрузку
      // страницы, а не один раз за матч.
      this.saveState = 'idle';
      this.lastStatsRef = payload.stats;
      this.reviveUsed = false;
      this.saveTarget = 'none';
      this.nameValue = loadText('tss-name') ?? '';
    }
    this.nameInput = null;
    this.saveBtn = null;
    this.saveMsg = null;
    this.reviveBtn = null;

    // Бой окончен — площадка не должна считать это активным геймплеем
    gameplayStop();

    const s = this.payload.stats;
    const { width, height } = this.scale;
    const compact = height < 520;

    this.add.rectangle(width / 2, height / 2, width + 40, height + 40, 0x0a0a12, 0.78)
      .setScrollFactor(0);

    // ---------- Бюджет высоты ----------
    // Шапка и низ получают фиксированную долю экрана, тело — остаток.
    // Каждый блок тела умещается в отведённую высоту и ничего не выходит
    // за нижнюю границу, поэтому кнопки всегда доступны на любом размере.
    const showRevive = this.canRevive();
    const actH = compact ? 40 : 50;
    const saveH = compact ? 38 : 44;
    const inputH = compact ? 34 : 44;
    const reviveH = compact ? 36 : 42;

    // Низ: считаем снизу вверх — так он гарантированно на экране
    let fy = height - actH / 2 - 8;
    const actionsY = fy;
    fy -= actH / 2 + 10;

    this.saveY = fy - saveH / 2;
    fy = this.saveY - saveH / 2 - 8;

    let reviveY = 0;
    if (showRevive) {
      reviveY = fy - reviveH / 2;
      fy -= reviveH / 2 + (compact ? 16 : 22); // + пояснение под кнопкой
    }

    const inputY = fy - inputH / 2;
    const bodyBottom = Math.max(40, inputY - inputH / 2 - 12);

    // Шапка. Баннер рисуем только там, где он помещается в натуральную
    // величину: слайсы banner9 — 68 px сверху и 111 px снизу, всего 179.
    // На меньшей высоте торцы сжимаются, и завитки превращаются в рваную
    // бумагу. В компактном ландшафте (высота < 520) баннера нет вовсе:
    // 200 px там — это половина экрана.
    const BANNER_MIN_H = 179;
    const bannerH = compact || height < BANNER_MIN_H + 60 ? 0 : 200;
    const titleSize = compact ? 22 : Phaser.Math.Clamp(height * 0.045, 28, 38);

    let headerBottom = 6;
    if (bannerH > 0) {
      const banner = makePanel(this, width / 2, 8 + bannerH / 2, 'banner', Math.min(400, width - 60), bannerH);
      banner.setScrollFactor(0);
      this.tweens.add({ targets: banner, scale: { from: 0.6, to: 1 }, duration: 320, ease: 'Back.easeOut' });
      headerBottom = 8 + bannerH;
    }

    const title = this.add.text(width / 2, headerBottom + 8, s.victory ? t('over.win') : t('over.lose'), {
      fontFamily: FONT, fontSize: `${titleSize}px`,
      color: s.victory ? '#ffd700' : '#ff6b5e',
      stroke: '#5a0808', strokeThickness: 9,
    }).setOrigin(0.5, 0).setScrollFactor(0);
    headerBottom = title.y + title.height + (compact ? 6 : 8);

    // ---------- Тело ----------
    // Если шапка съела слишком много, тело начинается ниже: итоги важнее
    // расстояния между блоками.
    const bodyTop = Math.min(headerBottom, Math.max(40, bodyBottom - 40));
    this.buildBody(s, width, bodyTop, bodyBottom, compact);

    // ---------- Низ ----------
    this.createNameInput(inputY, inputH);
    if (showRevive) this.createReviveUi(reviveY, reviveH);
    this.createSaveUi(saveH);
    this.createActions(actionsY, actH, width);

    // При изменении размера окна (поворот телефона) — перерисовать на новых координатах
    this.scale.on('resize', this.rebuild, this);
    this.events.once('shutdown', () => {
      // Нативный input мог остаться в DOM-слое — убираем вручную
      try {
        (this.nameInput?.node as HTMLElement | undefined)?.remove();
      } catch {
        // элемент уже удалён
      }
      this.nameInput = null;
      this.scale.off('resize', this.rebuild, this);
    });
  }

  // ================================================================
  // Тело экрана
  // ================================================================

  /**
   * Итоги матча, урон по оружию и новые достижения.
   *
   * Содержимое подгоняется под доступную высоту: список оружия показывает
   * столько строк, сколько помещается (и не показывает ни одной, если
   * места нет), достижения при нехватке места сворачиваются в одну строку.
   * Итоги матча видны всегда — они важнее деталей.
   *
   * Маски в Phaser 4 работают только в Canvas-рендерере, а игра идёт в WebGL,
   * поэтому вариант «отрезать контейнер по высоте» физически не работает.
   */
  private buildBody(
    s: GameOverStats, width: number, top: number, bottom: number, compact: boolean,
  ): void {
    const body = this.add.container(0, 0).setScrollFactor(0);
    const pad = compact ? 8 : 14;
    const cx = width / 2;
    // Строим от нуля, в конце сдвигаем контейнер: при свободном месте
    // (например, на 1920×1080) блок не прилипал к шапке, а стоял по центру.
    let y = 0;

    // --- Итоги матча ---
    // На широких экранах идём в две колонки: одна колонка из семи строк
    // занимала ~190 px и съедала место, где уместен разбор урона оружием.
    const heroLine = s.hero ? t('over.hero', { v: s.hero.toUpperCase() }) : '';
    const pairs: Array<[string, string]> = [
      [t('over.time', { v: clock(s.time) }), t('over.kills', { v: num(s.kills) })],
      [t('over.level', { v: num(s.level) }), (s.bestCombo ?? 0) >= 5 ? t('over.combo', { v: s.bestCombo ?? 0 }) : ''],
      [t('over.gold', { v: num(s.gold) }), t('over.score', { v: num(s.score) })],
    ].filter(([a, b]) => a.length > 0 || b.length > 0) as Array<[string, string]>;

    const avail = Math.max(60, bottom - top - pad);
    const statFont = compact ? 12 : avail < 220 ? 13 : 15;
    const statSpacing = compact ? 4 : 6;
    const twoCol = width >= 470 && !compact;

    const statStyle: Phaser.Types.GameObjects.Text.TextStyle = {
      fontFamily: FONT, fontSize: `${statFont}px`, color: '#ffe9b0',
      align: 'center', lineSpacing: statSpacing,
      stroke: '#1b1008', strokeThickness: 5,
    };

    if (twoCol) {
      if (heroLine) {
        body.add(this.add.text(cx, y, heroLine, { ...statStyle, color: '#ffd76e' }).setOrigin(0.5, 0));
        y += statFont + 10;
      }
      const colW = Math.min(240, width * 0.42);
      const probe = this.add.text(0, 0, 'x', { ...statStyle }).setOrigin(0.5, 0);
      const rowH = probe.height + 2;
      probe.destroy();
      pairs.forEach((pair, i) => {
        const ry = y + i * rowH;
        body.add(this.add.text(cx - colW / 2, ry, pair[0], statStyle).setOrigin(0.5, 0));
        body.add(this.add.text(cx + colW / 2, ry, pair[1], { ...statStyle, color: '#ffd76e' }).setOrigin(0.5, 0));
      });
      y += pairs.length * rowH + 10;
    } else {
      const lines = [
        heroLine,
        ...pairs.map(([a, b]) => [a, b].filter(Boolean).join('   ')),
      ].filter((l) => l.trim().length > 0);
      const statsText = this.add.text(cx, y, lines.join('\n'), statStyle).setOrigin(0.5, 0);
      body.add(statsText);
      y += statsText.height + (compact ? 8 : 12);
    }

    // --- Сложность ---
    if (s.difficulty && top + y + 20 <= bottom) {
      // Знак ☠ ставится по id сложности, а не по переведённому названию:
      // сравнение со строкой «КОШМАР» не срабатывало в английской сборке.
      const mark = s.difficultyId === 'nightmare' ? ' ☠' : '';
      body.add(this.add.text(cx, y, `${t('over.difficulty', { v: s.difficulty.toUpperCase() })}${mark}`, {
        fontFamily: FONT, fontSize: compact ? '11px' : '13px', color: '#cbb389',
        stroke: '#1b1008', strokeThickness: 4,
      }).setOrigin(0.5, 0));
      y += compact ? 18 : 22;
    }

    // --- Урон по оружию ---
    y = this.renderWeaponStats(body, s, y, width, compact, bottom - top - y - pad);

    // --- Новые достижения ---
    const ach = s.newAch ?? [];
    if (ach.length > 0 && top + y + 24 <= bottom) {
      const wrap = Math.min(480, width - 60);
      const items = ach.map((a) => `${a.emoji} ${a.name}`).join('  •  ');
      // Полный вариант меряем заранее и рисуем только если он влезает
      const probe = this.add.text(cx, 0, items, {
        fontFamily: FONT, fontSize: '12px', wordWrap: { width: wrap },
      }).setOrigin(0.5, 0);
      const needFull = 16 + probe.height + 6;
      probe.destroy();

      if (bottom - top - y >= needFull) {
        body.add(this.add.text(cx, y, t('over.newAch'), {
          fontFamily: FONT, fontSize: '11px', color: '#ffd76e',
          stroke: '#1b1008', strokeThickness: 4,
        }).setOrigin(0.5, 0));
        body.add(this.add.text(cx, y + 16, items, {
          fontFamily: FONT, fontSize: '12px', color: '#ffe9b0',
          align: 'center', wordWrap: { width: wrap },
          stroke: '#1b1008', strokeThickness: 4,
        }).setOrigin(0.5, 0));
      } else {
        // Не влезает — одна строка с числом и первыми названиями
        const names = ach.slice(0, 2).map((a) => a.name).join(', ');
        const more = ach.length > 2 ? ` +${ach.length - 2}` : '';
        body.add(this.add.text(cx, y + 2, `${t('over.newAch')} ${ach.length} · ${names}${more}`, {
          fontFamily: FONT, fontSize: '11px', color: '#ffd76e',
          stroke: '#1b1008', strokeThickness: 4,
          wordWrap: { width: wrap },
          align: 'center',
        }).setOrigin(0.5, 0));
      }
    }

    // Ставим блок в доступную область: при нехватке места — сверху,
    // при запасе — по центру.
    const regionH = Math.max(40, bottom - top - pad);
    body.y = top + pad + Math.max(0, (regionH - y) / 2);
  }

  // ================================================================
  // Панель статистики оружия: урон/убийства каждого ствола матча
  // ================================================================

  private renderWeaponStats(
    body: Phaser.GameObjects.Container, s: GameOverStats, cursor: number,
    width: number, compact: boolean, avail: number,
  ): number {
    const list = (s.weapons ?? []).filter((w) => w.dmg > 0);
    if (list.length === 0) return cursor;
    const cx = width / 2;
    const ROW = 22;
    const HEAD = 18;

    if (compact) {
      // Компактный ландшафт: одна строка с топ-3 оружием
      const top = list.slice(0, 3)
        .map((w) => `${w.name} ${this.fmtDmg(w.dmg)}⚡${w.kills}`)
        .join(' • ');
      body.add(this.add.text(cx, cursor, top, {
        fontFamily: FONT, fontSize: '10px', color: '#ffd76e',
        stroke: '#1b1008', strokeThickness: 3,
      }).setOrigin(0.5, 0)
        .setWordWrapWidth(Math.min(460, width - 40)));
      return cursor + 28;
    }

    // Полный режим: заголовок + строки с полосами урона
    body.add(this.add.text(cx, cursor, t('over.damageTitle'), {
      fontFamily: FONT, fontSize: '11px', color: '#cbb389',
      stroke: '#1b1008', strokeThickness: 4,
    }).setOrigin(0.5, 0));
    cursor += HEAD;

    const maxDmg = Math.max(...list.map((w) => w.dmg), 1);
    const rowW = Math.min(380, width - 90);
    const barMax = Math.max(20, rowW - 150);
    // Сколько строк реально помещается — по высоте. Если не помещается
    // ни одна, раздел не рисуется вовсе: важнее показать итоги матча,
    // чем накрыть собой поле ввода имени.
    const limit = Math.min(7, width < 420 ? 5 : 7);
    const cap = Math.max(0, Math.min(list.length, limit, Math.floor((avail - HEAD) / ROW)));
    if (cap <= 0) return cursor;
    const shown = list.slice(0, cap);

    shown.forEach((w, i) => {
      const y = cursor + HEAD + i * ROW + 8;
      const icon = this.add.image(cx - rowW / 2 + 10, y, w.icon).setDisplaySize(20, 20);
      if (w.evolved) icon.setTint(0xffe9a0);
      body.add(icon);
      const nameW = barMax - 16;
      const nameText = this.add.text(cx - rowW / 2 + 26, y, w.name, {
        fontFamily: FONT, fontSize: '10px', color: w.evolved ? '#ffd76e' : '#ffe9b0',
        stroke: '#1b1008', strokeThickness: 3,
      }).setOrigin(0, 0.5);
      // Название не должно наезжать на полосу урона и числа
      fitTextWidth(nameText, nameW, 10, 7);
      body.add(nameText);
      // Полоса урона (относительно лучшего оружия; эволюция — золотая)
      body.add(this.add.rectangle(cx - rowW / 2 + 128, y, barMax, 8, 0x2a1c10, 0.9)
        .setOrigin(0, 0.5));
      const bar = body.add(this.add.rectangle(
        cx - rowW / 2 + 128, y, 4, 6,
        w.evolved || i === 0 ? 0xffd76e : 0xd0883a,
      ).setOrigin(0, 0.5));
      this.tweens.add({ targets: bar, width: Math.max(4, Math.round(barMax * (w.dmg / maxDmg))), duration: 500, delay: 150 + i * 70, ease: 'Cubic.easeOut' });
      body.add(this.add.text(cx + rowW / 2, y, `${this.fmtDmg(w.dmg)}  ⚔${w.kills}`, {
        fontFamily: FONT, fontSize: '10px', color: '#ffd76e',
        stroke: '#1b1008', strokeThickness: 3,
      }).setOrigin(1, 0.5));
    });
    return cursor + HEAD + shown.length * ROW + 10;
  }

  private fmtDmg(v: number): string {
    if (v >= 10000) return `${(v / 1000).toFixed(1)}k`;
    if (v >= 1000) return `${(v / 1000).toFixed(2)}k`;
    return `${Math.round(v)}`;
  }

  // ================================================================
  // Имя игрока
  // ================================================================

  /**
   * Авторизованному игроку Яндекса показываем имя из профиля — вводить своё
   * незачем (требование 1.2: лишние поля без пользы только раздражают).
   * Гость по-прежнему вводит имя в нативный <input>.
   */
  private createNameInput(y: number, h = 44): void {
    const width = this.scale.width;

    if (isAuthorized()) {
      const name = displayName(this.nameValue);
      this.add.text(width / 2, y, name, {
        fontFamily: FONT, fontSize: '17px', color: '#ffe9b0',
        stroke: '#1b1008', strokeThickness: 5,
      }).setOrigin(0.5).setScrollFactor(0);
      this.nameValue = name;
      return;
    }

    const el = document.createElement('input');
    el.type = 'text';
    el.maxLength = 24;
    el.autocomplete = 'off';
    el.spellcheck = false;
    el.placeholder = t('over.namePlaceholder');
    el.value = this.nameValue;
    el.setAttribute('aria-label', t('over.nameAria'));
    el.style.width = `${Math.min(340, width - 80)}px`;
    el.style.height = `${h - 6}px`;
    el.style.boxSizing = 'border-box';
    el.style.background = '#fff8e7';
    el.style.border = '3px solid #8a5b12';
    el.style.borderRadius = '10px';
    el.style.color = '#3b2410';
    el.style.fontFamily = FONT;
    el.style.fontSize = '16px';
    el.style.textAlign = 'center';
    el.style.outline = 'none';
    el.style.padding = '0 10px';
    el.style.pointerEvents = 'auto';
    el.addEventListener('input', () => {
      this.nameValue = el.value;
    });
    // Enter — сохранить
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void this.saveScore();
      }
    });
    this.nameInput = this.add.dom(width / 2, y, el);
    this.nameInput.setOrigin(0.5);
  }

  private getName(): string {
    const node = this.nameInput?.node as HTMLInputElement | undefined;
    if (node && typeof node.value === 'string') return node.value;
    return this.nameValue;
  }

  // ================================================================
  // Сохранение рекорда
  // ================================================================

  private savedLabel(): string {
    if (this.saveTarget === 'online') return t('over.savedOnline');
    if (this.saveTarget === 'error') return t('over.savedLocalOffline');
    return t('over.savedLocal');
  }

  private createSaveUi(h = 44): void {
    const width = this.scale.width;

    // Сообщение о результате — всегда на одном месте, кнопка исчезает
    const showMsg = (text: string, color: string): void => {
      this.saveBtn?.destroy();
      this.saveBtn = null;
      this.saveMsg?.destroy();
      this.saveMsg = this.add.text(width / 2, this.saveY, text, {
        fontFamily: FONT, fontSize: '14px', color,
        stroke: '#1b1008', strokeThickness: 5,
        align: 'center', wordWrap: { width: width - 60 },
      }).setOrigin(0.5).setScrollFactor(0);
    };

    if (this.saveState === 'saved') {
      showMsg(this.savedLabel(), this.saveTarget === 'error' ? '#ffd76e' : '#7dc95e');
      return;
    }

    const label = this.saveState === 'error' ? t('over.retry') : t('over.save');
    const b = makeButton(this, width / 2, this.saveY, Math.min(280, width - 70), h, label, () => {
      void this.saveScore();
    }, 'blue', 15);
    b.img.setScrollFactor(0);
    b.txt.setScrollFactor(0);
    b.hit.setScrollFactor(0);
    this.saveBtn = b;

    if (this.saveState === 'error') {
      this.saveMsg = this.add.text(width / 2, this.saveY - 32, t('over.saveFailed'), {
        fontFamily: FONT, fontSize: '10px', color: '#ff8a7a',
        stroke: '#1b1008', strokeThickness: 3,
        align: 'center', wordWrap: { width: width - 60 },
      }).setOrigin(0.5).setScrollFactor(0);
    }
  }

  /**
   * Сохраняет результат: локально всегда, в общий зал Яндекса — авторизованным.
   *
   * Разница между «сохранилось» и «сохранилось в общий зал» игроку показывается
   * явно: раньше submitScore никогда не бросал исключение, catch был недостижим,
   * и неудачная отправка в общий зал выглядела как обычный успех.
   */
  private saveScore = async (): Promise<void> => {
    if (this.saveState === 'saving' || this.saveState === 'saved') return;
    this.saveState = 'saving';
    this.saveBtn?.txt.setText(t('over.saving'));

    const s = this.payload.stats;
    const raw = this.getName().trim();
    const name = displayName(raw || t('over.defaultName'));

    try {
      const result = await submitScore({
        name,
        score: s.score,
        kills: s.kills,
        level: s.level,
        timeSurvived: s.time,
        victory: s.victory,
      });
      this.saveState = 'saved';
      this.saveTarget = result.online ? 'online' : result.reason === 'error' ? 'error' : 'local';

      if (!isAuthorized()) saveText('tss-name', name);

      audio.play('ach');
      // Перерисовываем нижний блок: кнопка сменяется сообщением о результате
      this.createSaveUi();

      // Показ рекламы не должен ломать экран — ошибки внутри ads.ts глотаются
      void showInterstitial({ pause: () => audio.silence(), resume: () => audio.unsilence() });
    } catch (err) {
      console.warn('[gameover] сохранение не удалось:', err);
      this.saveState = 'error';
      this.saveBtn?.setLabel(t('over.retry'));
      this.saveMsg?.destroy();
      this.saveMsg = this.add.text(this.scale.width / 2, this.saveY - 32, t('over.saveFailed'), {
        fontFamily: FONT, fontSize: '10px', color: '#ff8a7a',
        stroke: '#1b1008', strokeThickness: 3,
        align: 'center', wordWrap: { width: this.scale.width - 60 },
      }).setOrigin(0.5).setScrollFactor(0);
    }
  };

  // ================================================================
  // Воскрешение за rewarded-ролик
  // ================================================================

  private canRevive(): boolean {
    if (this.reviveUsed || this.revivePending) return false;
    if (this.payload.stats.victory) return false;
    return rewardedAvailable();
  }

  private createReviveUi(y: number, h = 42): void {
    const width = this.scale.width;
    const w = Math.min(300, width - 70);

    // Текст кнопки прямо называет награду — требование 4.5.1.
    const b = makeButton(this, width / 2, y, w, h, t('over.revive'), () => {
      void this.revive();
    }, 'blue', 15);
    b.img.setScrollFactor(0);
    b.txt.setScrollFactor(0);
    b.hit.setScrollFactor(0);

    const hint = this.add.text(width / 2, y + h / 2 + 13, t('over.reviveHint'), {
      fontFamily: FONT, fontSize: '10px', color: '#cbb389',
      stroke: '#1b1008', strokeThickness: 3,
    }).setOrigin(0.5).setScrollFactor(0);

    this.reviveBtn = { ...b, hint };
  }

  private revive = async (): Promise<void> => {
    // Без этой защиты два быстрых клика давали два параллельных
    // showRewardedVideo — лишний вызов SDK и лишняя реклама у игрока.
    if (!this.canRevive()) return;
    this.revivePending = true;
    this.reviveBtn?.setEnabled(false);

    try {
      const res = await showRewarded({ pause: () => audio.silence(), resume: () => audio.unsilence() });

      if (!res.rewarded) {
        // Ролик не досмотрен или недоступен — честно говорим об этом
        this.reviveBtn?.hint.setText(t('over.reviveUnavailable'));
        this.reviveBtn?.hint.setColor('#ff8a7a');
        return;
      }

      const game = this.scene.get('Game') as GameOverReviveTarget;
      if (!game || typeof game.revive !== 'function' || !game.revive()) {
        this.reviveBtn?.hint.setText(t('over.reviveUnavailable'));
        return;
      }

      this.reviveUsed = true;
      this.reviveBtn?.destroy();
      this.reviveBtn = null;

      // Порядок важен: сначала снимаем экран смерти, потом возвращаем бой
      this.scene.stop('GameOver');
      this.scene.resume('Game');
    } finally {
      this.revivePending = false;
    }
  };

  // ================================================================
  // Навигация
  // ================================================================

  private rebuild = (): void => {
    // Рестарт с той же статистикой — элементы встанут по новым размерам экрана
    this.scene.restart({ stats: this.payload.stats });
  };

  private createActions(y: number, actH: number, width: number): void {
    const w1 = Math.min(240, width * 0.55);
    const w2 = Math.min(150, width * 0.30);
    const gapB = 12;
    if (w1 + w2 + gapB <= width - 30) {
      this.btn(width / 2 - (w1 + w2 + gapB) / 2 + w1 / 2, y, t('over.playAgain'), 'blue', w1, actH, () => this.restart(), 16);
      this.btn(width / 2 + (w1 + w2 + gapB) / 2 - w2 / 2, y, t('over.toMenu'), 'red', w2, actH, () => this.toMenu(), 15);
    } else {
      this.btn(width / 2, y - actH * 0.55, t('over.playAgain'), 'blue', w1, actH, () => this.restart(), 15);
      this.btn(width / 2, y + actH * 0.55, t('over.toMenu'), 'red', w2, Math.max(30, actH - 6), () => this.toMenu(), 14);
    }
  }

  private restart = (): void => {
    // Гасим возможные зависшие оверлеи (левел-ап/пауза)
    this.scene.stop('LevelUp');
    this.scene.stop('Pause');
    this.scene.stop('Game');
    this.scene.start('Game');
  };

  private toMenu = (): void => {
    this.scene.stop('LevelUp');
    this.scene.stop('Pause');
    this.scene.stop('Game');
    this.scene.start('Menu');
  };

  private btn(x: number, y: number, label: string, variant: 'blue' | 'red', w: number, h: number, onClick: () => void, fontSize: number): void {
    const b = makeButton(this, x, y, w, h, label, onClick, variant, fontSize);
    b.img.setScrollFactor(0);
    b.txt.setScrollFactor(0);
    b.hit.setScrollFactor(0);
  }
}