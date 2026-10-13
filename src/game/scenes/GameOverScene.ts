import Phaser from 'phaser';
import { FONT } from '../constants';
import { makePanel, makeButton } from '../systems/Ui';
import { audio } from '../systems/Audio';

// ============ Экран конца матча: статистика + ввод имени + запись в таблицу ============
// Всё внутри Phaser: имя вводится в нативный <input> (DOMElement), рекорд
// уходит в /api/scores напрямую из сцены.

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

export class GameOverScene extends Phaser.Scene {
  private payload!: GameOverData;
  /** Состояние сохранения переживает рестарт сцены (ресайз) — но не новый матч */
  private saveState: SaveState = 'idle';
  private lastStatsRef: GameOverStats | null = null;
  private nameValue = '';
  private nameInput: Phaser.GameObjects.DOMElement | null = null;
  private saveBtn: { img: Phaser.GameObjects.NineSlice; txt: Phaser.GameObjects.Text; hit: Phaser.GameObjects.Zone } | null = null;
  private saveMsg: Phaser.GameObjects.Text | null = null;
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

    const s = this.payload.stats;
    const { width, height } = this.scale;
    const compact = height < 520;

    this.add.rectangle(width / 2, height / 2, width + 40, height + 40, 0x0a0a12, 0.78)
      .setScrollFactor(0);

    // Баннер (в компактном ландшафтном режиме не помещается — пропускаем)
    if (!compact) {
      const banner = makePanel(this, width / 2, height * 0.19, 'banner', Math.min(430, width - 60), Math.min(240, height * 0.30));
      banner.setScrollFactor(0);
      this.tweens.add({ targets: banner, scale: { from: 0.6, to: 1 }, duration: 320, ease: 'Back.easeOut' });
    }

    const title = this.add.text(width / 2, compact ? 36 : height * 0.155, s.victory ? 'ПОБЕДА!' : 'ПОРАЖЕНИЕ', {
      fontFamily: FONT, fontSize: compact ? '28px' : '34px',
      color: s.victory ? '#ffd700' : '#ff6b5e',
      stroke: '#5a0808', strokeThickness: 9,
    }).setOrigin(0.5).setScrollFactor(0);
    void title;

    // ---------- Статистика ----------
    const mm = Math.floor(s.time / 60).toString().padStart(2, '0');
    const ss = Math.floor(s.time % 60).toString().padStart(2, '0');
    const lines = [
      s.hero ? `ГЕРОЙ: ${s.hero.toUpperCase()}` : '',
      `ВРЕМЯ: ${mm}:${ss}`,
      `УБИЙСТВ: ${s.kills}`,
      `УРОВЕНЬ: ${s.level}`,
      (s.bestCombo ?? 0) >= 5 ? `ЛУЧШАЯ СЕРИЯ: ×${s.bestCombo}` : '',
      `ЗОЛОТО: ${s.gold}`,
      `СЧЁТ: ${s.score.toLocaleString('ru-RU')}`,
    ].filter((l) => l.length > 0);

    const statsTop = compact ? 62 : height * 0.19 + Math.min(240, height * 0.30) / 2 + 14;
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
      this.add.text(width / 2, cursor, `СЛОЖНОСТЬ: ${s.difficulty.toUpperCase()}${s.difficulty === 'Кошмар' ? ' ☠' : ''}`, {
        fontFamily: FONT, fontSize: compact ? '11px' : '13px', color: '#cbb389',
        stroke: '#1b1008', strokeThickness: 4,
      }).setOrigin(0.5).setScrollFactor(0);
      cursor += compact ? 20 : 24;
    }

    // ---------- Статистика оружия (v1.8) ----------
    cursor = this.renderWeaponStats(s, cursor, compact, width);

    // ---------- Новые достижения (не в компактном режиме) ----------
    if (!compact && s.newAch && s.newAch.length > 0) {
      this.add.text(width / 2, cursor, 'НОВЫЕ ДОСТИЖЕНИЯ:', {
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

    // ---------- Ввод имени (нативный <input> поверх канваса) ----------
    const inputY = cursor + 26;
    this.createNameInput(inputY);
    cursor = inputY + 46;

    // ---------- Сохранение рекорда ----------
    this.saveY = cursor + 14;
    this.createSaveUi();

    // ---------- Кнопки действий ----------
    const btnsY = Math.min(this.saveY + 58, height - 34);
    const w1 = Math.min(240, width * 0.55);
    const w2 = Math.min(150, width * 0.30);
    const gapB = 12;
    if (w1 + w2 + gapB <= width - 30) {
      this.btn(width / 2 - (w1 + w2 + gapB) / 2 + w1 / 2, btnsY, 'ИГРАТЬ СНОВА', 'blue', w1, 54, () => this.restart(), 16);
      this.btn(width / 2 + (w1 + w2 + gapB) / 2 - w2 / 2, btnsY, 'В МЕНЮ', 'red', w2, 54, () => this.toMenu(), 15);
    } else {
      this.btn(width / 2, btnsY - 30, 'ИГРАТЬ СНОВА', 'blue', w1, 50, () => this.restart(), 15);
      this.btn(width / 2, btnsY + 28, 'В МЕНЮ', 'red', w2, 44, () => this.toMenu(), 14);
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
    this.add.text(cx, cursor, '⚔ УРОН ПО ОРУЖИЮ', {
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

  private createNameInput(y: number): void {
    const width = this.scale.width;
    const el = document.createElement('input');
    el.type = 'text';
    el.maxLength = 24;
    el.autocomplete = 'off';
    el.spellcheck = false;
    el.placeholder = 'Имя рыцаря для рекордов';
    el.value = this.nameValue;
    el.setAttribute('aria-label', 'Имя игрока');
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

  private createSaveUi(): void {
    const width = this.scale.width;
    if (this.saveState === 'saved') {
      this.saveMsg = this.add.text(width / 2, this.saveY, '✓ РЕКОРД СОХРАНЁН', {
        fontFamily: FONT, fontSize: '17px', color: '#7dc95e',
        stroke: '#1b1008', strokeThickness: 5,
      }).setOrigin(0.5).setScrollFactor(0);
      return;
    }
    const label = this.saveState === 'error' ? 'ПОПРОБУЙ СНОВА' : 'СОХРАНИТЬ РЕКОРД';
    const b = makeButton(this, width / 2, this.saveY, Math.min(260, width - 70), 46, label, () => {
      void this.saveScore();
    }, 'blue', 15);
    b.img.setScrollFactor(0);
    b.txt.setScrollFactor(0);
    b.hit.setScrollFactor(0);
    this.saveBtn = b;
    if (this.saveState === 'error') {
      this.saveMsg = this.add.text(width / 2, this.saveY - 34, 'не удалось сохранить — проверь связь', {
        fontFamily: FONT, fontSize: '10px', color: '#ff8a7a',
        stroke: '#1b1008', strokeThickness: 3,
      }).setOrigin(0.5).setScrollFactor(0);
    }
  }

  private saveScore = async (): Promise<void> => {
    if (this.saveState === 'saving' || this.saveState === 'saved') return;
    this.saveState = 'saving';
    this.saveBtn?.txt.setText('СОХРАНЯЕМ...');
    const s = this.payload.stats;
    const raw = this.getName().trim();
    const name = (raw.length > 0 ? raw : 'Безымянный рыцарь').slice(0, 24);
    try {
      const res = await fetch('/api/scores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          score: s.score,
          kills: s.kills,
          level: s.level,
          timeSurvived: s.time,
          victory: s.victory,
        }),
      });
      if (!res.ok) throw new Error('save failed');
      this.saveState = 'saved';
      try {
        window.localStorage.setItem('tss-name', name);
      } catch {
        // приватный режим
      }
      audio.play('ach');
      this.saveBtn?.img.destroy();
      this.saveBtn?.txt.destroy();
      this.saveBtn?.hit.destroy();
      this.saveBtn = null;
      this.saveMsg?.destroy();
      this.saveMsg = this.add.text(this.scale.width / 2, this.saveY, '✓ РЕКОРД СОХРАНЁН', {
        fontFamily: FONT, fontSize: '17px', color: '#7dc95e',
        stroke: '#1b1008', strokeThickness: 5,
      }).setOrigin(0.5).setScrollFactor(0);
    } catch {
      this.saveState = 'error';
      this.saveBtn?.txt.setText('ПОПРОБУЙ СНОВА');
      this.saveMsg?.destroy();
      this.saveMsg = this.add.text(this.scale.width / 2, this.saveY - 34, 'не удалось сохранить — проверь связь', {
        fontFamily: FONT, fontSize: '10px', color: '#ff8a7a',
        stroke: '#1b1008', strokeThickness: 3,
      }).setOrigin(0.5).setScrollFactor(0);
    }
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
