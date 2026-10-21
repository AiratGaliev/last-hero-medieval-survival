import Phaser from 'phaser';
import { FONT, DEPTH } from '../constants';
import { BUILDING_PLANS, type ResourceCost } from '../data';
import { showPlacementRewarded, placementAvailable } from '../../platform/ads';
import { makePanel, makeRibbon, makeButton, type Button } from '../systems/Ui';
import { shrinkToHeight, FS } from '../systems/Text';
import { successionLayout, RIBBON_KEY } from './successionLayout';
import { t, num } from '../../i18n';

// ============ Экран преемственности героя (TZ §F.5) ============
//
// Показывается при смерти героя, пока есть здание-источник воина.
// Часы матча на паузе. Ветки §F.4: живой воин (авто, бесплатно) →
// ресурсы (новый воин из здания) → реклама/золото матча с выбором типа.
// Кроны нигде не принимаются (§J.9). Первая преемственность аккаунта
// бесплатна — бейдж «ПЕРВЫЙ РАЗ — БЕСПЛАТНО» (§F.4).
//
// Разметка повторяет «Лавку» и «Хронику»: затемнение с гасящим клик блокером,
// пергаментная панель по габаритам экрана, лента-заголовок и пересборка
// сцены при ресайзе. Раньше окно было собрано из плоских прямоугольников
// (`add.rectangle` + заливка цветом), жило без ленты и без обработки
// поворота экрана — на телефоне при смене ориентации оно разъезжалось.

interface SuccessionOption {
  weapon: string;
  hero: string;
  source: string;
  available: boolean;
}

interface SuccessionData {
  options: SuccessionOption[];
  livingCount: number;
  livingKind: string | null;
  resourceCost: ResourceCost | null;
  goldCost: number;
  firstFree: boolean;
  /** Первый показ аккаунта: поясняющий блок вместо необходимости угадывать правило. */
  firstTutorial?: boolean;
  showResources: boolean;
  resourcesAffordable: boolean;
  goldAffordable: boolean;
  onTakeWarrior: () => boolean;
  onTakeResources: (weapon: string) => boolean;
  onTakeAd: (weapon: string) => boolean;
  onTakeGold: (weapon: string) => boolean;
  onSurrender: () => void;
}

/** Глубина оверлея. Панель и её содержимое лежат выше затемнения. */
const D = {
  dim: DEPTH.OVERLAY - 1,
  panel: DEPTH.OVERLAY,
  ribbon: DEPTH.OVERLAY + 1,
  content: DEPTH.OVERLAY + 2,
} as const;

/** Пункт выбора типа воина: карточка пергамента с рамкой выбора. */
interface OptionCard {
  container: Phaser.GameObjects.Container;
  setSelected(on: boolean): void;
  destroy(): void;
}

export class SuccessionScene extends Phaser.Scene {
  private data_: SuccessionData | null = null;
  private lastData_: SuccessionData | null = null;
  private adButton: Button | null = null;
  /** Выбранный тип воина для платных веток. */
  private picked: string = 'sword';
  private adUsed = false;
  private adInFlight = false;
  private surrendered = false;
  /** Карточки выбора типа — нужны для перерисовки рамки выбора. */
  private cards = new Map<string, OptionCard>();

  constructor() {
    super('Succession');
  }

  create(data: SuccessionData): void {
    // Resize перезапускает сцену с тем же payload — нельзя терять lock текущего
    // rewarded-показа. Новый объект данных означает новую ситуацию преемственности.
    if (data !== this.lastData_) {
      this.adUsed = false;
      this.adInFlight = false;
      this.lastData_ = data;
    }
    this.data_ = data;
    this.adButton = null;
    this.surrendered = false;
    this.cards.clear();
    // ⚠️ Выбор сбрасывается на первый ДОСТУПНЫЙ тип (§F.5). Раньше оставался
    // дефолт 'sword', и при одном лишь монастыре серый «мечник» оставался
    // помеченным как выбранный — красная обводка на недоступном варианте,
    // и ветка 2/3 отдавала мечника из казарм, которых нет.
    this.picked = data.options.find((o) => o.available)?.weapon ?? 'sword';

    const W = this.scale.width;
    const H = this.scale.height;
    // Вся арифметика раскладки живёт в successionLayout.ts — модуль намеренно
    // свободен от Phaser, чтобы раскладку можно было прогнать без браузера
    // (локальный tools/check-layout.mjs). Здесь сцена только расставляет
    // объекты по готовым координатам.
    const L = successionLayout(W, H, {
      living: data.livingCount > 0,
      resources: data.showResources,
      options: data.options.length,
      tutorial: data.firstTutorial === true,
    });
    const { cx, panelW, panelH } = L;

    // ---------- Затемнение: клик мимо панели сдаётся (тач-мисс §I.6) ----------
    this.add
      .rectangle(cx, H / 2, W + 40, H + 40, 0x07070d, 0.88)
      .setDepth(D.dim).setScrollFactor(0).setInteractive()
      .on('pointerdown', () => this.requestSurrender());

    // ---------- Панель ----------
    makePanel(this, cx, H / 2, 'paper', panelW, panelH).setDepth(D.panel).setScrollFactor(0);
    // Невидимый блокер: клик по пергаменту гасится и не доходит до затемнения.
    this.add.zone(cx, H / 2, panelW, panelH).setDepth(D.panel + 1).setInteractive();

    // ---------- Лента-заголовок + подпись ----------
    makeRibbon(this, cx, L.ribbonY, L.ribbonW, RIBBON_KEY, L.ribbonH)
      .setDepth(D.ribbon).setScrollFactor(0);
    this.add.text(cx, L.ribbonY, t('succession.title'), {
      fontFamily: FONT, fontSize: `${L.titleFont}px`, color: '#ffe9c0',
      stroke: '#1b1008', strokeThickness: 4,
    }).setOrigin(0.5).setDepth(D.ribbon + 1).setScrollFactor(0);

    // Подзаголовок: живой воин / никто. Показываем, только если есть смысл.
    const subtitle = data.livingCount > 0
      ? t('succession.subtitle')
      : t('succession.newWarrior');
    const sub = this.add.text(cx, L.subtitleY, subtitle, {
      fontFamily: FONT, fontSize: `${FS.small}px`, color: '#5a4327', align: 'center',
    }).setOrigin(0.5).setDepth(D.ribbon + 1).setScrollFactor(0);
    shrinkToHeight(sub, 34, FS.small);

    if (data.firstTutorial) {
      const lesson = this.add.text(
        cx,
        L.tutorialY,
        `${t('succession.tutorialTitle')}\n${t('succession.tutorialBody')}`,
        {
          fontFamily: FONT,
          fontSize: `${L.compact ? FS.micro : FS.small}px`,
          color: '#3b2410',
          align: 'center',
          wordWrap: { width: Math.max(120, panelW - 56) },
          lineSpacing: 3,
        },
      ).setOrigin(0.5).setDepth(D.content).setScrollFactor(0);
      shrinkToHeight(lesson, L.tutorialH, L.compact ? FS.micro : FS.small);
    }

    const { btnH, btnFont, halfW } = L;

    // ---- Сдаться (тач-мисс не должен терять матч, §I.6) ----
    this.addBtn(cx, L.surrenderY, L.surrenderW, btnH,
      t('succession.surrender'), 'red', btnFont, () => this.requestSurrender());

    // ---- Платные ветки: реклама / золото (первая преемственность — бесплатна)
    const free = data.firstFree;
    const freeLabel = `${t('succession.reason.free').toUpperCase()} — ${t('pawn.firstFree')}`;
    this.adButton = this.addBtn(cx - halfW / 2 - 7, L.branchY, halfW, btnH,
      t('succession.watchAd'), 'blue', btnFont, () => void this.takeAd(),
      free || !placementAvailable('succession'));
    this.addBtn(cx + halfW / 2 + 7, L.branchY, halfW, btnH,
      free ? freeLabel : t('succession.payGold', { v: num(data.goldCost) }),
      'blue', btnFont, () => {
        if (this.data_?.onTakeGold(this.picked)) this.scene.stop();
        else this.flash('speedup.poor');
      }, !data.goldAffordable);

    // ---- Выбор живого воина и призыв из поселения ----
    // Ресурсная ветка должна быть доступна и когда на поле не осталось ни одного
    // воина: в противном случае первый бесплатный призыв и базовый путь по TZ §F.4
    // исчезали бы именно в сценарии, ради которого они нужны.
    if (data.livingCount > 0 && data.showResources) {
      this.addBtn(cx - halfW / 2 - 7, L.warriorY, halfW, btnH,
        t('succession.takeCommand'), 'blue', btnFont, () => {
          if (this.data_?.onTakeWarrior()) this.scene.stop();
        });
      this.addBtn(cx + halfW / 2 + 7, L.warriorY, halfW, btnH,
        free ? freeLabel : `${t('succession.reason.resources').toUpperCase()} (${data.resourceCost ? costText(data.resourceCost) : '—'})`,
        'blue', btnFont, () => {
          if (!this.data_) return;
          if (this.data_.onTakeResources(this.picked)) this.scene.stop();
          else this.flash('speedup.poor');
        }, !data.resourcesAffordable);
      this.add.text(cx - halfW / 2 - 7, L.warriorY + btnH / 2 + L.captionH / 2,
        t('succession.warriorOnField', { v: data.livingCount }), {
          fontFamily: FONT, fontSize: `${FS.micro}px`, color: '#3b6ea5', align: 'center',
        }).setOrigin(0.5).setDepth(D.content).setScrollFactor(0);
    } else if (data.livingCount > 0) {
      this.addBtn(cx, L.warriorY, L.surrenderW, btnH,
        t('succession.takeCommand'), 'blue', btnFont, () => {
          if (this.data_?.onTakeWarrior()) this.scene.stop();
        });
      this.add.text(cx, L.warriorY + btnH / 2 + L.captionH / 2,
        t('succession.warriorOnField', { v: data.livingCount }), {
          fontFamily: FONT, fontSize: `${FS.micro}px`, color: '#3b6ea5', align: 'center',
        }).setOrigin(0.5).setDepth(D.content).setScrollFactor(0);
    } else if (data.showResources) {
      this.addBtn(cx, L.warriorY, Math.min(halfW * 2 + 14, W - 60), btnH,
        free ? freeLabel : `${t('succession.reason.resources').toUpperCase()} (${data.resourceCost ? costText(data.resourceCost) : '—'})`,
        'blue', btnFont, () => {
          if (!this.data_) return;
          if (this.data_.onTakeResources(this.picked)) this.scene.stop();
          else this.flash('speedup.poor');
        }, !data.resourcesAffordable);
    }

    // ---- Выбор типа воина (серые = нет здания, §F.5) ----
    // При нуле доступных типов (новый аккаунт без построек) сетка не
    // рисуется вовсе — и не резервирует место.
    data.options.forEach((opt, i) => {
      const x = L.cardXs[i];
      if (x === undefined) return;
      const card = this.makeOptionCard(x, L.gridY, L.cardW, L.cardH, opt);
      this.cards.set(opt.weapon, card);
    });

    // ---- Esc — сдаться (то же, что мимо панели) ----
    const kb = this.input.keyboard;
    kb?.on('keydown-ESC', this.requestSurrender, this);
    this.scale.on('resize', this.rebuild, this);
    this.events.once('shutdown', () => {
      this.scale.off('resize', this.rebuild, this);
      kb?.off('keydown-ESC', this.requestSurrender, this);
    });
  }

  /** Пересборка под новые габариты: поворот экрана на телефоне. */
  private rebuild(): void {
    if (this.data_) this.scene.restart(this.data_);
  }

  // ================================================================
  // Элементы: кнопка и карточка выбора — на настоящих ассетах пака
  // ================================================================

  /**
   * Кнопка через общую фабрику Ui.makeButton.
   *
   * Раньше здесь был `add.rectangle` с заливкой цветом и подписью поверх —
   * серый брусок без состояния нажатия, без тени, без рамки в стиле пака.
   * Теперь это тот же nine-slice, что у «Лавки» и «Хроники», с теми же
   * состояниями наведения/нажатия/недоступности.
   */
  private addBtn(
    x: number, y: number, w: number, h: number,
    label: string,
    variant: 'blue' | 'red',
    fontSize: number,
    onClick: () => void,
    disabled = false,
  ): Button {
    const b = makeButton(this, x, y, w, h, label, onClick, variant, fontSize, { disabled });
    b.img.setDepth(D.content).setScrollFactor(0);
    b.txt.setDepth(D.content + 1).setScrollFactor(0);
    b.hit.setDepth(D.content + 2).setScrollFactor(0);
    return b;
  }

  /**
   * Карточка типа воина на пергаменте.
   *
   * Раньше это был серый прямоугольник с обводкой — единственное место в
   * игре, где UI был нарисован кодом. Теперь карточка собрана из того же
   * nine-slice, что и остальные панели; выбранный вариант помечается
   * золотой тонировкой и подписью-галочкой, а не сменой цвета заливки.
   */
  private makeOptionCard(
    x: number, y: number, w: number, h: number, opt: SuccessionOption,
  ): OptionCard {
    const c = this.add.container(x, y);
    const paper = makePanel(this, 0, 0, opt.available ? 'paper' : 'paperSpecial', w, h);
    if (!opt.available) paper.setAlpha(0.72);
    const hitZone = this.add.zone(0, 0, w, h).setInteractive({ useHandCursor: true });

    const name = this.add.text(0, opt.available ? -7 : 0, t(`hire.${opt.weapon}` as Parameters<typeof t>[0]), {
      fontFamily: FONT, fontSize: `${FS.small}px`,
      color: opt.available ? '#2a1608' : '#6b6155',
      align: 'center', wordWrap: { width: w - 14 },
    }).setOrigin(0.5);
    shrinkToHeight(name, opt.available ? h * 0.42 : h * 0.66, FS.small);

    const cost = this.add.text(0, h * 0.22, opt.available ? '' : t('succession.noBuilding'), {
      fontFamily: FONT, fontSize: `${FS.micro}px`, color: '#6b6155',
      align: 'center', wordWrap: { width: w - 12 },
    }).setOrigin(0.5);
    shrinkToHeight(cost, h * 0.28, FS.micro);

    // Метка выбора — золотая тонировка карточки плюс галочка. Раньше
    // выбранный вариант отличался только цветом обводки, а на серой
    // заливке («нет здания») этой обводки было почти не видно.
    const mark = this.add.text(w / 2 - 6, h / 2 - 8, '', {
      fontFamily: FONT, fontSize: `${FS.small}px`, color: '#9a6a08',
    }).setOrigin(0.5).setVisible(false);

    c.add([paper, hitZone, name, cost, mark]);
    c.setName(`opt-${opt.weapon}`);

    const setSelected = (on: boolean): void => {
      paper.setTint(on ? 0xffe9a0 : 0xffffff);
      mark.setText('★');
      mark.setVisible(on);
      name.setColor(on ? '#9a6a08' : (opt.available ? '#2a1608' : '#6b6155'));
    };

    if (opt.available) {
      hitZone.on('pointerdown', () => {
        this.picked = opt.weapon;
        this.refreshSelection();
      });
    }
    setSelected(this.picked === opt.weapon);

    return {
      container: c,
      setSelected,
      destroy(): void { c.destroy(true); },
    };
  }

  private refreshSelection(): void {
    for (const [id, card] of this.cards) card.setSelected(id === this.picked);
  }

  // ================================================================
  // Действия
  // ================================================================

  private async takeAd(): Promise<void> {
    if (!this.data_ || this.adUsed || this.adInFlight) return;
    this.adInFlight = true;
    this.adButton?.setEnabled(false);
    try {
      const res = await showPlacementRewarded('succession');
      if (res.rewarded) {
        this.adUsed = true;
        if (this.data_?.onTakeAd(this.picked)) {
          this.scene.stop();
          return;
        }
      }

      // Отказ/ошибка текущего показа закрывает рекламную ветку этого окна:
      // игрок может выбрать другой способ преемственности или сдаться.
      this.adUsed = true;
      this.adButton?.setEnabled(false);
      this.flash('speedup.adUnavailable');
    } catch {
      this.adUsed = true;
      this.adButton?.setEnabled(false);
      this.flash('speedup.adUnavailable');
    } finally {
      this.adInFlight = false;
    }
  }

  /**
   * Сдаться — с подтверждением.
   *
   * Тouch-мисс не должен терять матч (§I.6): первое нажатие (и Esc, и клик
   * мимо панели) только спрашивает подтверждение, второе сдаёт.
   */
  private requestSurrender(): void {
    if (this.surrendered) {
      this.data_?.onSurrender();
      this.scene.stop();
      return;
    }
    this.surrendered = true;
    const W = this.scale.width;
    const H = this.scale.height;
    const bw = Math.min(280, W - 60);
    const bx = W / 2;
    const by = H / 2 + Math.min(120, H * 0.18);
    const label = t('succession.surrenderConfirm');

    // Подтверждение — та же пара кнопок, что и везде: «да» и «отмена».
    // Раньше это была одна мигающая надпись, и тач-мисс по ней ничего
    // не делал — игрок не понимал, что матч уже сдан.
    makePanel(this, bx, by, 'paper', bw + 24, 86).setDepth(DEPTH.OVERLAY + 9).setScrollFactor(0);
    this.add.zone(bx, by, bw + 24, 86).setDepth(DEPTH.OVERLAY + 9).setInteractive();
    const msg = this.add.text(bx, by - 18, label, {
      fontFamily: FONT, fontSize: `${FS.body}px`, color: '#8c1d18', align: 'center',
    }).setOrigin(0.5).setDepth(DEPTH.OVERLAY + 10).setScrollFactor(0)
      .setName('surrender-confirm');
    shrinkToHeight(msg, 24, FS.body);

    const half = Math.floor((bw - 16) / 2);
    const yes = makeButton(this, bx - half / 2 - 4, by + 20, half, 38,
      t('common.confirm'), () => {
        this.data_?.onSurrender();
        this.scene.stop();
      }, 'red', FS.small);
    const no = makeButton(this, bx + half / 2 + 4, by + 20, half, 38,
      t('common.cancel'), () => this.cancelSurrender(), 'blue', FS.small);
    for (const b of [yes, no]) {
      b.img.setDepth(DEPTH.OVERLAY + 11).setScrollFactor(0);
      b.txt.setDepth(DEPTH.OVERLAY + 12).setScrollFactor(0);
      b.hit.setDepth(DEPTH.OVERLAY + 13).setScrollFactor(0);
    }
  }

  /** Отмена сдачи: окно возвращается к выбору, матч продолжается. */
  private cancelSurrender(): void {
    this.surrendered = false;
    for (const name of ['surrender-confirm']) {
      const obj = this.children.list.find((g) => g.name === name);
      obj?.destroy();
    }
  }

  private flash(key: string): void {
    this.cameras.main.flash(140, 190, 40, 30, false);
    this.add.text(this.scale.width / 2, this.scale.height / 2 + 200, t(key as Parameters<typeof t>[0]), {
      fontFamily: FONT, fontSize: `${FS.body}px`, color: '#8c1d18',
      stroke: '#ffe9c0', strokeThickness: 3,
    }).setOrigin(0.5).setDepth(DEPTH.OVERLAY + 10).setScrollFactor(0)
      .setName('flash-msg');
    this.time.delayedCall(1400, () => {
      this.children.list.filter((g) => g.name === 'flash-msg').forEach((g) => g.destroy());
    });
  }
}

function costText(cost: ResourceCost): string {
  const parts: string[] = [];
  if (cost.wood) parts.push(`${cost.wood} ${t('resource.wood').toLowerCase()}`);
  if (cost.ore) parts.push(`${cost.ore} ${t('resource.ore').toLowerCase()}`);
  if (cost.meat) parts.push(`${cost.meat} ${t('resource.meat').toLowerCase()}`);
  return parts.join(' + ');
}

// BUILDING_PLANS импортирован для связи здания с типом воина (документация)
void BUILDING_PLANS;