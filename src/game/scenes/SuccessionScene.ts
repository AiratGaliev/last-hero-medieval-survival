import Phaser from 'phaser';
import { FONT } from '../constants';
import { BUILDING_PLANS, type ResourceCost } from '../data';
import { showPlacementRewarded, placementAvailable } from '../../platform/ads';
import { makePanel } from '../systems/Ui';
import { t, num } from '../../i18n';

// ============ Экран преемственности героя (TZ §F.5) ============
//
// Показывается при смерти героя, пока есть здание-источник воина.
// Часы матча на паузе. Ветки §F.4: живой воин (авто, бесплатно) →
// ресурсы (новый воин из здания) → реклама/золото матча с выбором типа.
// Кроны нигде не принимаются (§J.9). Первая преемственность аккаунта
// бесплатна — бейдж «ПЕРВЫЙ РАЗ — БЕСПЛАТНО» (§F.4).

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
  resourceCost: ResourceCost;
  goldCost: number;
  firstFree: boolean;
  onTakeWarrior: () => boolean;
  onTakeResources: (weapon: string) => boolean;
  onTakeAd: (weapon: string) => boolean;
  onTakeGold: (weapon: string) => boolean;
  onSurrender: () => void;
}

export class SuccessionScene extends Phaser.Scene {
  private data_: SuccessionData | null = null;
  /** Выбранный тип воина для платных веток. */
  private picked: string = 'sword';
  private adUsed = false;
  private surrendered = false;
  private confirmText: Phaser.GameObjects.Text | null = null;

  constructor() {
    super('Succession');
  }

  create(data: SuccessionData): void {
    this.data_ = data;
    this.surrendered = false;
    const W = this.scale.width;
    const H = this.scale.height;

    this.add.rectangle(W / 2, H / 2, W + 8, H + 8, 0x07070d, 0.88);

    const panelW = Math.min(560, W - 32);
    const panelH = Math.min(560, H - 60);
    const panel = makePanel(this, W / 2, H / 2, 'paper', panelW, panelH);
    void panel;

    let y = H / 2 - panelH / 2 + 40;
    this.add.text(W / 2, y, t('succession.title'), {
      fontFamily: FONT, fontSize: '22px', color: '#8c1d18',
      stroke: '#ffe9c0', strokeThickness: 3,
    }).setOrigin(0.5);
    y += 26;
    this.add.text(W / 2, y, t('succession.subtitle'), {
      fontFamily: FONT, fontSize: '12px', color: '#5a4327',
    }).setOrigin(0.5);

    // ---- Ветка 1: живой воин на поле ----
    y += 46;
    if (data.livingCount > 0) {
      const btn = this.makeButton(W / 2, y, t('succession.takeCommand'), 0x3b6ea5, () => {
        if (this.data_?.onTakeWarrior()) this.scene.stop();
      });
      void btn;
      this.add.text(W / 2, y - 22, t('succession.warriorOnField', { v: data.livingCount }), {
        fontFamily: FONT, fontSize: '11px', color: '#3b6ea5',
      }).setOrigin(0.5);
      y += 58;
    }

    // ---- Выбор типа воина (серые = нет здания, §F.5) ----
    this.add.text(W / 2, y, t('succession.newWarrior'), {
      fontFamily: FONT, fontSize: '12px', color: '#5a4327',
    }).setOrigin(0.5);
    y += 30;
    const bw = Math.min(104, (panelW - 40) / (data.options.length || 1) - 8);
    data.options.forEach((opt, i) => {
      const x = W / 2 + (i - (data.options.length - 1) / 2) * (bw + 10);
      const c = this.add.container(x, y);
      const bg = this.add.rectangle(0, 0, bw, 64, opt.available ? 0xd8c9a8 : 0x9a917e, 0.95)
        .setStrokeStyle(2, this.picked === opt.weapon ? 0x8c1d18 : 0x5a4327);
      const name = this.add.text(0, -18, t(`hire.${opt.weapon}` as Parameters<typeof t>[0]), {
        fontFamily: FONT, fontSize: '11px', color: opt.available ? '#2a1608' : '#6b6155',
      }).setOrigin(0.5);
      const cost = this.add.text(0, 12, opt.available ? '' : t('succession.noBuilding'), {
        fontFamily: FONT, fontSize: '9px', color: opt.available ? '#5a4327' : '#6b6155',
        align: 'center', wordWrap: { width: bw - 8 },
      }).setOrigin(0.5);
      c.add([bg, name, cost]);
      if (opt.available) {
        bg.setInteractive({ useHandCursor: true });
        bg.on('pointerdown', () => {
          this.picked = opt.weapon;
          bg.setStrokeStyle(2, 0x8c1d18);
          this.refreshSelection();
        });
      }
      c.setName(`opt-${opt.weapon}`);
    });
    y += 56;

    // ---- Платные ветки: реклама / золото (первая преемственность — бесплатна) ----
    const free = data.firstFree;
    const freeLabel = free ? ` — ${t('pawn.firstFree')}` : '';
    const btnResources = this.makeButton(W / 2 - 110, y,
      free ? t('succession.reason.free').toUpperCase() + freeLabel
        : `${t('succession.reason.resources').toUpperCase()} (${costText(data.resourceCost)})`,
      free ? 0x4a8a3d : 0x3b6ea5, () => {
        if (!this.data_) return;
        if (this.data_.onTakeResources(this.picked)) this.scene.stop();
        else this.flash('building.cannot');
      });
    void btnResources;
    y += 52;
    // Ролик предлагается только со второй смерти (§I.4): при первом бесплатном
    // показе кнопку рекламы глушим — ценность ролика игрок ещё не осознал
    this.makeButton(W / 2 - 110, y, t('succession.watchAd'), 0x3b6ea5, () => this.takeAd(),
      free || !placementAvailable('succession'));
    this.makeButton(W / 2 + 110, y, t('succession.payGold', { v: num(data.goldCost) }), 0x8a6d1d, () => {
      if (this.data_?.onTakeGold(this.picked)) this.scene.stop();
      else this.flash('speedup.poor');
    });

    // ---- Сдаться (с подтверждением — тач-мисс не должен терять матч, §I.6) ----
    y += 62;
    this.makeButton(W / 2, y, t('succession.surrender'), 0x8c1d18, () => {
      if (this.surrendered) {
        this.data_?.onSurrender();
        this.scene.stop();
        return;
      }
      this.surrendered = true;
      this.confirmText = this.add.text(W / 2, y + 26, t('succession.surrenderConfirm'), {
        fontFamily: FONT, fontSize: '10px', color: '#8c1d18',
      }).setOrigin(0.5);
    });
  }

  private refreshSelection(): void {
    for (const opt of this.data_?.options ?? []) {
      const c = this.children.list.find((g) => g.name === `opt-${opt.weapon}`) as Phaser.GameObjects.Container | undefined;
      const bg = c?.list[0] as Phaser.GameObjects.Rectangle | undefined;
      if (bg) bg.setStrokeStyle(2, this.picked === opt.weapon ? 0x8c1d18 : 0x5a4327);
    }
    if (this.confirmText) this.confirmText.destroy();
  }

  private async takeAd(): Promise<void> {
    if (!this.data_ || this.adUsed) return;
    const res = await showPlacementRewarded('succession');
    if (res.rewarded) {
      this.adUsed = true;
      if (this.data_.onTakeAd(this.picked)) this.scene.stop();
    } else {
      this.flash('speedup.adUnavailable');
    }
  }

  private flash(key: string): void {
    this.cameras.main.flash(140, 190, 40, 30, false);
    this.add.text(this.scale.width / 2, this.scale.height / 2 + 200, t(key as Parameters<typeof t>[0]), {
      fontFamily: FONT, fontSize: '11px', color: '#8c1d18',
    }).setOrigin(0.5).setDepth(10)
      .setAlpha(1)
      .setName('flash-msg');
    this.time.delayedCall(1400, () => {
      this.children.list.filter((g) => g.name === 'flash-msg').forEach((g) => g.destroy());
    });
  }

  private makeButton(x: number, y: number, label: string, color: number, onClick: () => void, disabled = false): Phaser.GameObjects.Container {
    const c = this.add.container(x, y);
    const bg = this.add.rectangle(0, 0, 210, 40, disabled ? 0x9a917e : color, disabled ? 0.6 : 0.95)
      .setStrokeStyle(2, 0x2a1608);
    const txt = this.add.text(0, 0, label, {
      fontFamily: FONT, fontSize: '11px', color: disabled ? '#6b6155' : '#ffffff',
      align: 'center', wordWrap: { width: 196 },
    }).setOrigin(0.5);
    c.add([bg, txt]);
    if (!disabled) {
      bg.setInteractive({ useHandCursor: true });
      bg.on('pointerover', () => bg.setStrokeStyle(3, 0xffe9b0));
      bg.on('pointerout', () => bg.setStrokeStyle(2, 0x2a1608));
      bg.on('pointerdown', onClick);
    }
    return c;
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
