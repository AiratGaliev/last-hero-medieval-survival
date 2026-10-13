import Phaser from 'phaser';
import { FONT } from '../constants';
import { makePanel, makeButton } from '../systems/Ui';
import { audio } from '../systems/Audio';
import { t, num, clock } from '../../i18n';
import { submitScore } from '../../platform/leaderboard';
import { isAuthorized, displayName } from '../../platform/player';
import { showInterstitial, showRewarded, rewardedAvailable } from '../../platform/ads';
import { gameplayStop } from '../../platform/lifecycle';

// ============ Экран конца матча: статистика + рекорд + монетизация ============
// Всё внутри Phaser: гость вводит имя в нативный <input> (DOMElement),
// авторизованный игрок Яндекса получает имя из профиля. Рекорд уходит
// либо в общий зал Яндекс Игр, либо в локальную таблицу (см. platform/leaderboard).

export interface GameOverStats {
  victory: boolean;
  time: number;
  kills: number;
  level: number;
  gold: number;
  score: number;
  hero?: string;
  difficulty?: string;
  bestCombo?: number;
  weapons?: { id: string; icon: string; name: string; dmg: number; kills: number; evolved?: boolean }[];
  newAch?: { name: string; emoji: string }[];
}

interface GameOverData {
  stats: GameOverStats;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** Что удалось показать игроку после сохранения. */
type SaveTarget = 'none' | 'online' | 'local';

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
  private saveBtn: { img: Phaser.GameObjects.NineSlice; txt: Phaser.GameObjects.Text; hit: Phaser.GameObjects.Zone } | null = null;
  private saveMsg: Phaser.GameObjects.Text | null = null;
  private saveTarget: SaveTarget = 'none';
  private reviveBtn: { img: Phaser.GameObjects.NineSlice; txt: Phaser.GameObjects.Text; hint: Phaser.GameObjects.Text; hit: Phaser.GameObjects.Zone } | null = null;
  private reviveUsed = false;
  private saveY = 0;

  constructor() {
    super('GameOver');
  }

  create(payload: GameOverData): void {
    this.payload = payload;
    if (this.lastStatsRef !== payload.stats) {
      // Новый матч — сбрасываем прогресс сохранения
      this.saveState = 'idle';
      this.lastStatsRef = payload.stats;
      this.nameValue = '';
      try {
        this.nameValue = window.localStorage.getItem('tss-name') ?? '';
      } catch {
        // приватный режим — просто пустое имя
      }
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
    /**
     * Плотный режим для невысоких, но не совсем компактных экранов
     * (типичный десктоп 1280×720, планшет в портрете). На них статистика,
     * ввод имени, сохранение и кнопки действий не помещались: нижние элементы
     * наезжали друг на друга, и кнопку сохранения было не нажать.
     */
    const tight = height < 840;

    this.add.rectangle(width / 2, height / 2, width + 40, height + 40, 0x0a0a12, 0.78)
      .setScrollFactor(0);

    // Баннер (в компактном ландшафтном режиме не помещается — пропускаем)
    if (!compact) {
      const bannerH = tight ? Math.min(170, height * 0.22) : Math.min(240, height * 0.30);
      const bannerY = tight ? height * 0.14 : height * 0.19;
      const banner = makePanel(this, width / 2, bannerY, 'banner', Math.min(430, width - 60), bannerH);
      banner.setScrollFactor(0);
      this.tweens.add({ targets: banner, scale: { from: 0.6, to: 1 }, duration: 320, ease: 'Back.easeOut' });
    }

    const title = this.add.text(width / 2, compact ? 36 : height * 0.155, s.victory ? t('over.win') : t('over.lose'), {
      fontFamily: FONT, fontSize: compact ? '28px' : '34px',
      color: s.victory ? '#ffd700' : '#ff6b5e',
      stroke: '#5a0808', strokeThickness: 9,
    }).setOrigin(0.5).setScrollFactor(0);
    void title;

    // ---------- Статистика ----------
    const lines = [
      s.hero ? t('over.hero', { v: s.hero.toUpperCase() }) : '',
      t('over.time', { v: clock(s.time) }),
      t('over.kills', { v: num(s.kills) }),
      t('over.level', { v: num(s.level) }),
      (s.bestCombo ?? 0) >= 5 ? t('over.combo', { v: s.bestCombo ?? 0 }) : '',
      t('over.gold', { v: num(s.gold) }),
      t('over.score', { v: num(s.score) }),
    ].filter((l) => l.length > 0);

    const statsTop = compact ? 62 : tight
      ? height * 0.14 + (Math.min(170, height * 0.22)) / 2 + 10
      : height * 0.19 + Math.min(240, height * 0.30) / 2 + 14;
    const statsText = this.add.text(width / 2, statsTop, lines.join('\n'), {
      fontFamily: FONT, fontSize: compact ? '13px' : '16px', color: '#ffe9b0',
      align: 'center', lineSpacing: compact ? 5 : 10,
      stroke: '#1b1008', strokeThickness: 5,
    }).setOrigin(0.5, 0).setScrollFactor(0);
    // Реальная высота текста (метрики шрифта > кегля) — чтобы строка
    // сложности не наезжала на последнюю строку статистики
    let cursor = statsTop + statsText.height + (compact ? 12 : 18);

    // ---------- Сложность ----------
    if (s.difficulty) {
      this.add.text(width / 2, cursor, `${t('over.difficulty', { v: s.difficulty.toUpperCase() })}${s.difficulty.toUpperCase() === 'КОШМАР' ? ' ☠' : ''}`, {
        fontFamily: FONT, fontSize: compact ? '11px' : '13px', color: '#cbb389',
        stroke: '#1b1008', strokeThickness: 4,
      }).setOrigin(0.5).setScrollFactor(0);
      cursor += compact ? 20 : 24;
    }

    // ---------- Статистика оружия (v1.8) ----------
    cursor = this.renderWeaponStats(s, cursor, compact, width);

    // ---------- Новые достижения (не в компактном режиме) ----------
    if (!compact && s.newAch && s.newAch.length > 0) {
      this.add.text(width / 2, cursor, t('over.newAch'), {
        fontFamily: FONT, fontSize: '11px', color: '#ffd76e',
        stroke: '#1b1008', strokeThickness: 4,
      }).setOrigin(0.5).setScrollFactor(0);
      const items = s.newAch.map((a) => `${a.emoji} ${a.name}`).join('  •  ');
      this.add.text(width / 2, cursor + 16, items, {
        fontFamily: FONT, fontSize: '12px', color: '#ffe9b0',
        align: 'center', wordWrap: { width: Math.min(480, width - 60) },
        stroke: '#1b1008', strokeThickness: 4,
      }).setOrigin(0.5).setScrollFactor(0);
      cursor += 44;
    }

    // ---------- Нижний блок: имя → воскрешение → сохранение → действия ----------
    // Отступы и высоты считаются от одного набора чисел, иначе на невысоких
    // экранах блоки наезжают друг на друга (кнопка сохранения была
    // перекрыта кнопками действий на 1280×720).
    const gapInput = tight ? 10 : 26;
    const inputH = compact ? 38 : 46;
    const reviveH = tight ? 40 : 44;   // высота самой кнопки
    const reviveBlockH = reviveH + 26; // кнопка + пояснение под ней
    const gapSave = tight ? 4 : 14;
    const saveH = tight ? 40 : 46;
    const gapActions = tight ? 6 : 58;
    const actH = tight ? 46 : 54;

    const inputY = cursor + gapInput;
    this.createNameInput(inputY);
    cursor = inputY + inputH;

    // Воскрешение за rewarded-ролик: только на Яндекс Играх, один раз за матч
    // и не после победы (победителю «жизнь» не нужна).
    if (this.canRevive()) {
      this.createReviveUi(cursor, reviveH);
      cursor += reviveBlockH;
    }

    this.saveY = cursor + gapSave;
    this.createSaveUi(saveH);

    // Кнопки действий — строго ниже нижнего края кнопки сохранения
    // (без saveH/2 кнопки снова наезжали друг на друга), но не за экран.
    const btnsY = Math.min(
      this.saveY + saveH / 2 + gapActions + actH / 2,
      height - actH / 2 - 6,
    );
    const w1 = Math.min(240, width * 0.55);
    const w2 = Math.min(150, width * 0.30);
    const gapB = 12;
    if (w1 + w2 + gapB <= width - 30) {
      this.btn(width / 2 - (w1 + w2 + gapB) / 2 + w1 / 2, btnsY, t('over.playAgain'), 'blue', w1, actH, () => this.restart(), 16);
      this.btn(width / 2 + (w1 + w2 + gapB) / 2 - w2 / 2, btnsY, t('over.toMenu'), 'red', w2, actH, () => this.toMenu(), 15);
    } else {
      this.btn(width / 2, btnsY - actH * 0.55, t('over.playAgain'), 'blue', w1, actH, () => this.restart(), 15);
      this.btn(width / 2, btnsY + actH * 0.55, t('over.toMenu'), 'red', w2, actH - 6, () => this.toMenu(), 14);
    }

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
  // Панель статистики оружия: урон/убийства каждого ствола матча
  // ================================================================

  private renderWeaponStats(s: GameOverStats, cursor: number, compact: boolean, width: number): number {
    const list = (s.weapons ?? []).filter((w) => w.dmg > 0);
    if (list.length === 0) return cursor;
    const cx = width / 2;

    if (compact) {
      // Компактный ландшафт: одна строка с топ-3 оружием
      const top = list.slice(0, 3)
        .map((w) => `${w.name} ${this.fmtDmg(w.dmg)}⚡${w.kills}`)
        .join(' • ');
      this.add.text(cx, cursor, top, {
        fontFamily: FONT, fontSize: '10px', color: '#ffd76e',
        stroke: '#1b1008', strokeThickness: 3,
      }).setOrigin(0.5).setScrollFactor(0)
        .setWordWrapWidth(Math.min(460, width - 40));
      return cursor + 26;
    }

    // Полный режим: заголовок + строки с полосами урона
    this.add.text(cx, cursor, t('over.damageTitle'), {
      fontFamily: FONT, fontSize: '11px', color: '#cbb389',
      stroke: '#1b1008', strokeThickness: 4,
    }).setOrigin(0.5).setScrollFactor(0);
    cursor += 18;

    const maxDmg = Math.max(...list.map((w) => w.dmg), 1);
    const rowW = Math.min(380, width - 90);
    const barMax = rowW - 150;
    list.slice(0, 7).forEach((w, i) => {
      const y = cursor + i * 22;
      // Иконка + имя (эволюция — золотое имя и подсветка)
      const icon = this.add.image(cx - rowW / 2 + 10, y - 2, w.icon).setDisplaySize(20, 20).setScrollFactor(0);
      if (w.evolved) icon.setTint(0xffe9a0);
      this.add.text(cx - rowW / 2 + 26, y - 2, w.name, {
        fontFamily: FONT, fontSize: '10px', color: w.evolved ? '#ffd76e' : '#ffe9b0',
        stroke: '#1b1008', strokeThickness: 3,
      }).setOrigin(0, 0.5).setScrollFactor(0);
      // Полоса урона (относительно лучшего оружия; эволюция — золотая)
      const barW = Math.max(4, Math.round(barMax * (w.dmg / maxDmg)));
      this.add.rectangle(cx - rowW / 2 + 128, y - 2, barMax, 8, 0x2a1c10, 0.9)
        .setOrigin(0, 0.5).setScrollFactor(0);
      const bar = this.add.rectangle(
        cx - rowW / 2 + 128, y - 2, 4, 6,
        w.evolved ? 0xffd76e : i === 0 ? 0xffd76e : 0xd0883a,
      )
        .setOrigin(0, 0.5).setScrollFactor(0);
      this.tweens.add({ targets: bar, width: barW, duration: 500, delay: 150 + i * 70, ease: 'Cubic.easeOut' });
      // Числа: урон и убийства
      this.add.text(cx + rowW / 2, y - 2, `${this.fmtDmg(w.dmg)}  ⚔${w.kills}`, {
        fontFamily: FONT, fontSize: '10px', color: '#ffd76e',
        stroke: '#1b1008', strokeThickness: 3,
      }).setOrigin(1, 0.5).setScrollFactor(0);
    });
    return cursor + Math.min(list.length, 7) * 22 + 10;
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
  private createNameInput(y: number): void {
    const width = this.scale.width;

    if (isAuthorized()) {
      this.add.text(width / 2, y + 14, displayName(this.nameValue), {
        fontFamily: FONT, fontSize: '17px', color: '#ffe9b0',
        stroke: '#1b1008', strokeThickness: 5,
      }).setOrigin(0.5).setScrollFactor(0);
      this.nameValue = displayName(this.nameValue);
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
    const w = Math.min(340, width - 80);
    el.style.width = `${w}px`;
    el.style.height = '40px';
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
    return this.saveTarget === 'online' ? t('over.savedOnline') : t('over.savedLocal');
  }

  private createSaveUi(h = 46): void {
    const width = this.scale.width;
    if (this.saveState === 'saved') {
      this.saveMsg = this.add.text(width / 2, this.saveY, this.savedLabel(), {
        fontFamily: FONT, fontSize: '15px', color: '#7dc95e',
        stroke: '#1b1008', strokeThickness: 5,
      }).setOrigin(0.5).setScrollFactor(0);
      return;
    }
    const label = this.saveState === 'error' ? t('over.retry') : t('over.save');
    const b = makeButton(this, width / 2, this.saveY, Math.min(260, width - 70), h, label, () => {
      void this.saveScore();
    }, 'blue', 15);
    b.img.setScrollFactor(0);
    b.txt.setScrollFactor(0);
    b.hit.setScrollFactor(0);
    this.saveBtn = b;
    if (this.saveState === 'error') {
      this.saveMsg = this.add.text(width / 2, this.saveY - 34, t('over.saveFailed'), {
        fontFamily: FONT, fontSize: '10px', color: '#ff8a7a',
        stroke: '#1b1008', strokeThickness: 3,
      }).setOrigin(0.5).setScrollFactor(0);
    }
  }

  /**
   * Сохраняет результат: локально всегда, в общий зал Яндекса — авторизованным.
   * После успеха показываем межстраничную рекламу (с кулдауном внутри ads.ts),
   * но только один раз за экран: игрок может жать «сохранить» повторно.
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
      this.saveTarget = result.online ? 'online' : 'local';

      if (!isAuthorized()) {
        try {
          window.localStorage.setItem('tss-name', name);
        } catch {
          // приватный режим
        }
      }

      audio.play('ach');
      this.saveBtn?.img.destroy();
      this.saveBtn?.txt.destroy();
      this.saveBtn?.hit.destroy();
      this.saveBtn = null;
      this.saveMsg?.destroy();
      this.saveMsg = this.add.text(this.scale.width / 2, this.saveY, this.savedLabel(), {
        fontFamily: FONT, fontSize: '15px', color: '#7dc95e',
        stroke: '#1b1008', strokeThickness: 5,
      }).setOrigin(0.5).setScrollFactor(0);
    } catch (err) {
      console.warn('[gameover] сохранение не удалось:', err);
      this.saveState = 'error';
      this.saveBtn?.txt.setText(t('over.retry'));
      this.saveMsg?.destroy();
      this.saveMsg = this.add.text(this.scale.width / 2, this.saveY - 34, t('over.saveFailed'), {
        fontFamily: FONT, fontSize: '10px', color: '#ff8a7a',
        stroke: '#1b1008', strokeThickness: 3,
      }).setOrigin(0.5).setScrollFactor(0);
      return;
    }

    // Показ рекламы не должен ломать экран — ошибки внутри ads.ts глотаются
    void showInterstitial({ pause: () => audio.silence(), resume: () => audio.unsilence() });
  };

  // ================================================================
  // Воскрешение за rewarded-ролик
  // ================================================================

  private canRevive(): boolean {
    if (this.reviveUsed) return false;
    if (this.payload.stats.victory) return false;
    return rewardedAvailable();
  }

  private createReviveUi(y: number, h = 44): void {
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
    if (!this.canRevive()) return;

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
    this.reviveBtn?.img.destroy();
    this.reviveBtn?.txt.destroy();
    this.reviveBtn?.hint.destroy();
    this.reviveBtn?.hit.destroy();
    this.reviveBtn = null;

    // Порядок важен: сначала снимаем экран смерти, потом возвращаем бой
    this.scene.stop('GameOver');
    this.scene.resume('Game');
  };

  // ================================================================
  // Навигация
  // ================================================================

  private rebuild = (): void => {
    // Перезапуск с той же статистикой — элементы встанут по новым размерам экрана
    this.scene.restart({ stats: this.payload.stats });
  };

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
