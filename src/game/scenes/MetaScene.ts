import Phaser from 'phaser';
import { Cursor } from '../systems/Cursor';
import { FONT } from '../constants';
import { audio } from '../systems/Audio';
import { makeButton, makePanel, makeRibbon, fitTextWidth, type Button } from '../systems/Ui';
import { t, num, type TranslationKey, type TranslateParams } from '../../i18n';
import { loadText, saveText, removeKey } from '../storage';
import { track } from '../../platform/analytics';
import { placementAvailable, showPlacementRewarded, showStickyBanner } from '../../platform/ads';
import { purchaseSku, showcaseVisible } from '../../platform/payments';
import {
  bonusAvailable,
  buyNode,
  claimChainReward,
  chainClaimed,
  claimDailyBonus,
  claimWeeklyFinal,
  CODEX_SECTIONS,
  codexCount,
  codexProgress,
  convertCrownsToGold,
  CHAINS,
  DAILY_BONUS,
  rerollQuestSlot,
  rollMetaDay,
  seasonDef,
  SEASON_STEPS,
  TREE_NODES,
  gloryBalance,
  loadMetaState,
  ordersUnlocked,
  ORDERS,
  PASS,
  passReward,
  QUEST_POOL,
  treeUnlocked,
  WEEKLY_STAGES,
  type OrderDef,
  type PassReward,
  type QuestDef,
  type TreeBranch,
  type TreeNodeDef,
} from '../meta';

// ============ «Хроника Долины»: мета-оверлей поверх меню (TZ §H.7–H.18) ============
//
// Паттерн PauseScene: затемнение + пергаментная панель + кнопка «Назад».
// Сцена ЛАУНЧИТСЯ поверх Menu (config.ts) и закрывается scene.stop() —
// меню остаётся живым под ней. Контент — 7 вкладок, каждая рисуется в
// отдельный контейнер методом renderTab() (перерисовка после действий).
// Маска WebGL для скролла не используется — вместо неё постраничные
// кнопки ‹ › (геймплейное требование ТЗ: маски в WebGL не работают).

type MetaTab = 'tree' | 'quests' | 'orders' | 'codex' | 'chains' | 'pass' | 'more';

const TAB_ORDER: MetaTab[] = ['tree', 'quests', 'orders', 'codex', 'chains', 'pass', 'more'];

const TAB_LABELS: Record<MetaTab, TranslationKey> = {
  tree: 'meta.tab.tree',
  quests: 'meta.tab.quests',
  orders: 'meta.tab.orders',
  codex: 'meta.tab.codex',
  chains: 'meta.tab.chains',
  pass: 'meta.tab.pass',
  more: 'meta.tab.more',
};

const BONUS_KIND_KEYS: Record<string, TranslationKey> = {
  gold: 'bonus.kind.gold',
  chest: 'bonus.kind.chest',
  blessing: 'bonus.kind.blessing',
  crowns: 'bonus.kind.crowns',
};

const PASS_REWARD_KEYS: Record<PassReward['kind'], TranslationKey> = {
  gold: 'pass.reward.gold',
  crowns: 'pass.reward.crowns',
  token: 'pass.reward.token',
  blessing: 'pass.reward.blessing',
  skin: 'pass.reward.skin',
  title: 'pass.reward.title',
  frame: 'pass.reward.frame',
  banner: 'pass.reward.banner',
};

/** Ключи справочников meta.ts хранятся строками — подставляем с приведением. */
function tr(key: string, params?: TranslateParams): string {
  return t(key as TranslationKey, params);
}

/** Строка награды пропуска: «120 золота», «Жетон ускорения» и т.п. */
function passRewardText(r: PassReward): string {
  if (r.kind === 'gold' || r.kind === 'crowns') return t(PASS_REWARD_KEYS[r.kind], { v: num(r.amount) });
  return t(PASS_REWARD_KEYS[r.kind]);
}

interface Row {
  draw: (cy: number, rowH: number) => void;
}

interface MetaPayload {
  tab?: MetaTab;
}

export class MetaScene extends Phaser.Scene {
  private payload: MetaPayload = {};
  private tab: MetaTab = 'tree';
  private pageIdx = 0;

  private pw = 0;
  private ph = 0;
  private px = 0;
  private py = 0;

  private statusText: Phaser.GameObjects.Text | null = null;
  private tabBox: Phaser.GameObjects.Container | null = null;
  private tabButtons: Button[] = [];
  private contentButtons: Button[] = [];
  private bonusOverlay: Phaser.GameObjects.Container | null = null;
  private bonusButtons: Button[] = [];

  private cursor!: Cursor;

  constructor() {
    super('Meta');
  }

  create(payload: MetaPayload): void {
    this.cursor = new Cursor(this);
    this.payload = payload ?? {};
    this.tab = this.payload.tab ?? 'tree';
    this.pageIdx = 0;

    this.pw = Math.min(1020, this.scale.width * 0.92);
    this.ph = Math.min(this.scale.height * 0.92, 900);
    this.px = this.scale.width / 2;
    this.py = this.scale.height / 2;

    this.statusText = null;
    this.tabBox = null;
    this.tabButtons = [];
    this.contentButtons = [];
    this.bonusOverlay = null;
    this.bonusButtons = [];

    // Стики-баннер (§J.5): мета-сцены — вне рана
    showStickyBanner();

    const top = this.py - this.ph / 2;

    // ---------- Затемнение: клик мимо панели закрывает оверлей ----------
    const dim = this.add.rectangle(this.px, this.py, this.scale.width + 40, this.scale.height + 40, 0x0a0a12, 0.78)
      .setScrollFactor(0).setInteractive().setDepth(100);
    dim.on('pointerdown', () => this.close());

    // ---------- Панель + невидимый блокиратор над ней ----------
    // Блокиратор нужен потому, что сама бумага неинтерактивна: без него
    // клик по пустому месту панели проваливался бы в затемнение и закрывал
    // сцену. Zone выше панели — события гасятся, клик мимо панели всё ещё
    // доходит до затемнения (input.topOnly).
    const paper = makePanel(this, this.px, this.py, 'paper', this.pw, this.ph);
    paper.setDepth(101).setScrollFactor(0);
    this.add.zone(this.px, this.py, this.pw, this.ph).setInteractive().setDepth(102);

    // ---------- Заголовок ----------
    makeRibbon(this, this.px, top + 26, Math.min(430, this.pw - 80), 'ribbon-yellow', 50)
      .setDepth(103).setScrollFactor(0);
    this.add.text(this.px, top + 26, t('meta.title'), {
      fontFamily: FONT, fontSize: '21px', color: '#ffe9c0',
      stroke: '#1b1008', strokeThickness: 5,
    }).setOrigin(0.5).setDepth(104).setScrollFactor(0);

    // ---------- Строка статуса ----------
    // Слова валют разнесены по разным строкам кода — см. гейт ТЗ на rg.
    const st = rollMetaDay();
    const parts: string[] = [];
    parts.push(t('meta.glory', { v: num(st.glory) }));
    parts.push(t('meta.crowns', { v: num(st.crowns) }));
    parts.push(t('meta.matches', { v: num(st.matchesPlayed) }));
    this.statusText = this.add.text(this.px, top + 56, parts.join('   '), {
      fontFamily: FONT, fontSize: '11px', color: '#6b4a1e', align: 'center',
    }).setOrigin(0.5).setDepth(104).setScrollFactor(0);

    this.renderTabs();
    this.renderTab();

    // ---------- Назад ----------
    const back = makeButton(this, this.px, this.py + this.ph / 2 - 32, 170, 46, t('common.back'),
      () => this.close(), 'red', 15);
    back.img.setDepth(104).setScrollFactor(0);
    back.txt.setDepth(104).setScrollFactor(0);
    back.hit.setDepth(104);

    // Esc — закрыть оверлей
    const kb = this.input.keyboard;
    if (kb) kb.on('keydown-ESC', this.close, this);

    this.scale.on('resize', this.rebuild, this);
    this.events.once('shutdown', () => {
      this.scale.off('resize', this.rebuild, this);
      if (kb) kb.off('keydown-ESC', this.close, this);
    });
  }

  private close(): void {
    this.scene.stop();
  }

  private rebuild(): void {
    this.scene.restart(this.payload);
  }

  // ================================================================
  // Каркас: табы + контент
  // ================================================================

  private tabsTop(): number {
    return this.py - this.ph / 2 + 80;
  }

  private contentTop(): number {
    const narrow = this.scale.width < 760;
    return this.tabsTop() + (narrow ? 44 * 2 + 10 : 44) + 12;
  }

  /** Нижняя граница контента — выше кнопки «Назад». */
  private contentBottom(): number {
    return this.py + this.ph / 2 - 76;
  }

  private contentLeft(): number {
    return this.px - this.pw / 2 + 24;
  }

  private contentRight(): number {
    return this.px + this.pw / 2 - 24;
  }

  private contentWidth(): number {
    return this.contentRight() - this.contentLeft();
  }

  private renderTabs(): void {
    for (const b of this.tabButtons) b.destroy();
    this.tabButtons = [];

    const narrow = this.scale.width < 760;
    const rows: MetaTab[][] = narrow
      ? [TAB_ORDER.slice(0, 4), TAB_ORDER.slice(4)]
      : [TAB_ORDER];
    const gap = 8;

    rows.forEach((row, rowIdx) => {
      const tw = Math.min(narrow ? 96 : 132, (this.pw - 48 - (row.length - 1) * gap) / row.length);
      row.forEach((id, i) => {
        const x = this.px - (row.length * tw + (row.length - 1) * gap) / 2 + i * (tw + gap) + tw / 2;
        const active = id === this.tab;
        const b = makeButton(this, x, this.tabsTop() + rowIdx * 52, tw, 44, t(TAB_LABELS[id]),
          () => {
            if (this.tab === id) return;
            this.tab = id;
            this.pageIdx = 0;
            this.renderTabs();
            this.renderTab();
          }, active ? 'blue' : 'red', 11);
        b.img.setDepth(103).setScrollFactor(0);
        b.txt.setDepth(103).setScrollFactor(0);
        b.hit.setDepth(103);
        this.tabButtons.push(b);
      });
    });
  }

  /** Перерисовка контента текущей вкладки (уничтожает старых детей). */
  private renderTab(): void {
    for (const b of this.contentButtons) b.destroy();
    this.contentButtons = [];
    if (this.tabBox) this.tabBox.destroy(true);

    this.refreshStatus();
    this.pageIdx = Math.max(0, this.pageIdx);

    const box = this.add.container(0, 0).setDepth(103).setScrollFactor(0);
    this.tabBox = box;

    const x0 = this.contentLeft();
    const x1 = this.contentRight();
    const y0 = this.contentTop();
    const y1 = this.contentBottom();

    switch (this.tab) {
      case 'tree': this.renderTree(box, x0, x1, y0, y1); break;
      case 'quests': this.renderQuests(box, x0, x1, y0, y1); break;
      case 'orders': this.renderOrders(box, x0, x1, y0, y1); break;
      case 'codex': this.renderCodex(box, x0, x1, y0, y1); break;
      case 'chains': this.renderChains(box, x0, x1, y0, y1); break;
      case 'pass': this.renderPass(box, x0, x1, y0, y1); break;
      case 'more': this.renderMore(box, x0, x1, y0, y1); break;
    }
  }

  private refreshStatus(): void {
    const st = rollMetaDay();
    const parts: string[] = [];
    parts.push(t('meta.glory', { v: num(st.glory) }));
    parts.push(t('meta.crowns', { v: num(st.crowns) }));
    parts.push(t('meta.matches', { v: num(st.matchesPlayed) }));
    this.statusText?.setText(parts.join('   '));
  }

  // ================================================================
  // Постраничный вывод строк (вместо маски WebGL — кнопки ‹ ›)
  // ================================================================

  private renderRows(box: Phaser.GameObjects.Container, rows: Row[], y0: number, y1: number, rowH: number): void {
    const areaH = y1 - y0;
    let perPage = Math.max(1, Math.floor(areaH / rowH));
    let pages = Math.ceil(rows.length / perPage);
    if (pages > 1) {
      // Резервируем полосу под сам пагинатор и пересчитываем
      perPage = Math.max(1, Math.floor((areaH - 48) / rowH));
      pages = Math.ceil(rows.length / perPage);
    }
    const page = Math.min(this.pageIdx, pages - 1);
    rows.slice(page * perPage, (page + 1) * perPage).forEach((row, i) => {
      row.draw(y0 + i * rowH + rowH / 2, rowH);
    });

    if (pages > 1) {
      const pagerY = y1 - 20;
      const prev = makeButton(this, this.px - 120, pagerY, 48, 44, '‹', () => {
        this.pageIdx = Math.max(0, page - 1);
        this.renderTab();
      }, 'blue', 18);
      const next = makeButton(this, this.px + 120, pagerY, 48, 44, '›', () => {
        this.pageIdx = Math.min(pages - 1, page + 1);
        this.renderTab();
      }, 'blue', 18);
      const label = this.add.text(this.px, pagerY, `${page + 1} / ${pages}`, {
        fontFamily: FONT, fontSize: '12px', color: '#6b4a1e',
      }).setOrigin(0.5);
      box.add([prev.img, prev.txt, prev.hit, next.img, next.txt, next.hit, label]);
      this.contentButtons.push(prev, next);
    }
  }

  /** Фоновая карточка строки (перламутровая полоса). */
  private rowCard(box: Phaser.GameObjects.Container, cy: number, rowH: number, w: number, active = false): void {
    const g = this.add.graphics();
    g.fillStyle(active ? 0xffe9b0 : 0xfff6df, active ? 1 : 0.92)
      .fillRoundedRect(this.px - w / 2, cy - rowH / 2 + 2, w, rowH - 4, 8);
    g.lineStyle(active ? 3 : 2, active ? 0xd9a520 : 0xc9a25e, 1)
      .strokeRoundedRect(this.px - w / 2, cy - rowH / 2 + 2, w, rowH - 4, 8);
    box.add(g);
  }

  // ================================================================
  // Вкладка ДЕРЕВО (§H.16): 3 ветви по 10 узлов, страницы по ветвям
  // ================================================================

  private renderTree(box: Phaser.GameObjects.Container, x0: number, x1: number, y0: number, y1: number): void {
    if (!treeUnlocked()) {
      box.add(this.add.text(this.px, (y0 + y1) / 2, t('meta.lockedTree'), {
        fontFamily: FONT, fontSize: '15px', color: '#6b4a1e', align: 'center',
        wordWrap: { width: this.contentWidth() - 60 },
      }).setOrigin(0.5));
      return;
    }

    const branches: TreeBranch[] = ['economy', 'defence', 'military'];
    const rows: Row[] = [];
    for (const br of branches) {
      rows.push({
        draw: (cy) => {
          box.add(this.add.text(this.px, cy, tr(`tree.branch.${br}`), {
            fontFamily: FONT, fontSize: '14px', color: '#9a6a08',
            stroke: '#f7e7c3', strokeThickness: 3,
          }).setOrigin(0.5));
        },
      });
      for (const node of TREE_NODES.filter((n) => n.branch === br)) {
        rows.push({ draw: (cy, rowH) => this.treeNodeRow(box, node, cy, rowH, x0, x1) });
      }
    }
    this.renderRows(box, rows, y0, y1, 48);
  }

  private treeNodeRow(
    box: Phaser.GameObjects.Container, node: TreeNodeDef, cy: number, rowH: number, x0: number, x1: number,
  ): void {
    const bought = loadMetaState().nodes.includes(node.id);
    const w = x1 - x0;
    this.rowCard(box, cy, rowH, w, bought);

    const textX = x0 + 16;
    box.add(this.add.text(textX, cy - 9, tr(node.nameKey), {
      fontFamily: FONT, fontSize: '12px', color: '#3b2410',
    }).setOrigin(0, 0.5));
    box.add(this.add.text(textX, cy + 9, tr(node.descKey), {
      fontFamily: FONT, fontSize: '9px', color: '#8a5b12',
    }).setOrigin(0, 0.5));

    const btnX = x1 - 100;
    if (bought) {
      box.add(this.add.text(btnX, cy, t('tree.opened'), {
        fontFamily: FONT, fontSize: '12px', color: '#2e7d32',
        stroke: '#dcecc9', strokeThickness: 3,
      }).setOrigin(0.5));
      return;
    }
    const afford = gloryBalance() >= node.cost;
    const label = afford ? tr('tree.open', { v: num(node.cost) }) : t('tree.noGlory');
    const btn = makeButton(this, btnX, cy, 176, 44, label, () => {
      const res = buyNode(node.id);
      if (res.ok) {
        track('tree_node_bought', { id: node.id });
        audio.play('levelup');
        this.renderTab();
      }
    }, 'blue', 10, { disabled: !afford, hitW: 184, hitH: 48, stopPropagation: true });
    box.add([btn.img, btn.txt, btn.hit]);
    this.contentButtons.push(btn);
  }

  // ================================================================
  // Вкладка ЗАДАНИЯ (§H.17): 3 карточки дня + реролл за рекламу R10
  // ================================================================

  private renderQuests(box: Phaser.GameObjects.Container, x0: number, x1: number, y0: number, y1: number): void {
    const st = rollMetaDay();
    const defs: QuestDef[] = st.quests.ids
      .map((id) => QUEST_POOL.find((q) => q.id === id))
      .filter((q): q is QuestDef => Boolean(q));
    const w = x1 - x0;
    const rowH = Math.max(62, Math.min(88, Math.floor((y1 - y0 - 8) / Math.max(1, defs.length))));

    defs.forEach((q, slot) => {
      const cy = y0 + slot * rowH + rowH / 2;
      const done = st.quests.done.includes(q.id);
      this.rowCard(box, cy, rowH - 6, w, done);

      box.add(this.add.text(x0 + 16, cy - 17, tr(q.descKey), {
        fontFamily: FONT, fontSize: '12px', color: '#3b2410',
      }).setOrigin(0, 0.5));

      const prog = st.quests.progress[q.id] ?? 0;
      box.add(this.add.text(x0 + 16, cy + 1, t('quest.progress', {
        a: num(Math.min(prog, q.goal)), b: num(q.goal),
      }), {
        fontFamily: FONT, fontSize: '10px', color: '#57431f',
      }).setOrigin(0, 0.5));

      box.add(this.add.text(x0 + 16, cy + 17, tr('quest.reward', { v: num(q.reward) }), {
        fontFamily: FONT, fontSize: '10px', color: '#9a6a08',
      }).setOrigin(0, 0.5));

      if (done) {
        box.add(this.add.text(x1 - 100, cy - 4, t('quest.done'), {
          fontFamily: FONT, fontSize: '12px', color: '#2e7d32',
          stroke: '#dcecc9', strokeThickness: 3,
        }).setOrigin(0.5));
        return;
      }

      // Реролл только за rewarded (лимит 3/день учитывает rerollQuestSlot)
      const canAd = placementAvailable('quest-reroll');
      const label = canAd ? tr('quest.reroll', { v: st.quests.rerolls }) : t('quest.rerollLimit');
      const btn = makeButton(this, x1 - 100, cy + 2, 156, 34, label, () => {
        void this.doQuestReroll(slot);
      }, 'red', 9, { disabled: !canAd, hitW: 162, hitH: 48, stopPropagation: true });
      box.add([btn.img, btn.txt, btn.hit]);
      this.contentButtons.push(btn);
    });
  }

  private async doQuestReroll(slot: number): Promise<void> {
    const res = await showPlacementRewarded('quest-reroll');
    if (!res.rewarded) return;
    const out = rerollQuestSlot(slot);
    if (out.ok) {
      track('quest_reroll', { slot });
      this.renderTab();
    } else if (out.reason === 'limit') {
      this.flashNote(t('quest.rerollLimit'));
    }
  }

  // ================================================================
  // Вкладка УКАЗЫ (§H.17): выбор/снятие, хранение 'tss-ukaz-pick'
  // ================================================================

  private renderOrders(box: Phaser.GameObjects.Container, x0: number, x1: number, y0: number, y1: number): void {
    if (!ordersUnlocked()) {
      box.add(this.add.text(this.px, (y0 + y1) / 2, t('meta.lockedOrders'), {
        fontFamily: FONT, fontSize: '15px', color: '#6b4a1e', align: 'center',
      }).setOrigin(0.5));
      return;
    }

    const active = loadText('tss-ukaz-pick');
    const w = x1 - x0;
    const rowH = Math.max(52, Math.min(62, Math.floor((y1 - y0 - 6) / ORDERS.length)));

    ORDERS.forEach((o: OrderDef, i) => {
      const cy = y0 + i * rowH + rowH / 2;
      const isActive = active === o.id;
      this.rowCard(box, cy, rowH - 4, w, isActive);

      box.add(this.add.text(x0 + 16, cy - 10, tr(o.nameKey), {
        fontFamily: FONT, fontSize: '12px', color: '#3b2410',
      }).setOrigin(0, 0.5));
      box.add(this.add.text(x0 + 16, cy + 9, tr(o.descKey), {
        fontFamily: FONT, fontSize: '9px', color: '#8a5b12',
      }).setOrigin(0, 0.5));

      const prem = Math.round(o.gloryPremium * 100);
      box.add(this.add.text(x1 - 92, cy - 9, tr('ukaz.premium', { v: prem }), {
        fontFamily: FONT, fontSize: '11px', color: '#9a6a08',
      }).setOrigin(0.5));
      box.add(this.add.text(x1 - 92, cy + 9, isActive ? '✓' : ' ', {
        fontFamily: FONT, fontSize: '13px', color: '#2e7d32',
        stroke: '#dcecc9', strokeThickness: 3,
      }).setOrigin(0.5));

      // Клик по строке — выбрать указ; повторный клик по активному — снять
      const zone = this.add.zone(this.px, cy, w, rowH - 4).setInteractive({ useHandCursor: true });
      zone.on('pointerdown', () => {
        audio.play('click');
        if (isActive) {
          removeKey('tss-ukaz-pick');
        } else {
          saveText('tss-ukaz-pick', o.id);
          track('ukaz_active', { id: o.id });
        }
        this.renderTab();
      });
      box.add(zone);
    });
  }

  // ================================================================
  // Вкладка КОДЕКС (§H.10): прогресс, вехи, 5 разделов гридом 3×N
  // ================================================================

  private renderCodex(box: Phaser.GameObjects.Container, x0: number, x1: number, y0: number, y1: number): void {
    const prog = codexProgress();
    const rows: Row[] = [];

    rows.push({
      draw: (cy) => {
        box.add(this.add.text(this.px, cy - 8, t('codex.progress', {
          a: num(prog.seen), b: num(prog.total), v: Math.round(prog.ratio * 100),
        }), {
          fontFamily: FONT, fontSize: '13px', color: '#3b2410',
        }).setOrigin(0.5));
        box.add(this.add.text(this.px, cy + 10, [
          t('codex.milestone50'), t('codex.milestone75'), t('codex.milestone100'),
        ].join('  ·  '), {
          fontFamily: FONT, fontSize: '9px', color: '#9a6a08',
        }).setOrigin(0.5));
      },
    });

    const cols = 3;
    const chipGap = 8;
    const chipW = (x1 - x0 - (cols - 1) * chipGap) / cols;
    for (const sec of CODEX_SECTIONS) {
      const seen = sec.entries.filter((e) => codexCount(e.id) > 0).length;
      rows.push({
        draw: (cy) => {
          box.add(this.add.text(x0 + 4, cy, `${tr(sec.nameKey)} — ${seen}/${sec.entries.length}`, {
            fontFamily: FONT, fontSize: '12px', color: '#9a6a08',
          }).setOrigin(0, 0.5));
        },
      });
      for (let i = 0; i < sec.entries.length; i += cols) {
        const chunk = sec.entries.slice(i, i + cols);
        rows.push({
          draw: (cy, rowH) => {
            chunk.forEach((e, j) => {
              const unlocked = codexCount(e.id) > 0;
              const cx = x0 + j * (chipW + chipGap) + chipW / 2;
              const g = this.add.graphics();
              g.fillStyle(unlocked ? 0xffe9b0 : 0xefe6d0, 1)
                .fillRoundedRect(cx - chipW / 2, cy - rowH / 2 + 3, chipW, rowH - 6, 7);
              g.lineStyle(unlocked ? 2 : 1, unlocked ? 0xd9a520 : 0xbfa77a, 1)
                .strokeRoundedRect(cx - chipW / 2, cy - rowH / 2 + 3, chipW, rowH - 6, 7);
              box.add(g);
              const label = unlocked ? tr(e.nameKey) : '???';
              const txt = this.add.text(cx, cy, label, {
                fontFamily: FONT, fontSize: '10px', color: unlocked ? '#3b2410' : '#8d8577',
                align: 'center', wordWrap: { width: chipW - 10 },
              }).setOrigin(0.5);
              fitTextWidth(txt, chipW - 10, 10, 7);
              if (!unlocked) txt.setAlpha(0.55);
              box.add(txt);
            });
          },
        });
      }
    }
    this.renderRows(box, rows, y0, y1, 30);
  }

  // ================================================================
  // Вкладка ЦЕПИ (§H.11): 8 цепочек × 3 ступени
  // ================================================================

  private renderChains(box: Phaser.GameObjects.Container, x0: number, x1: number, y0: number, y1: number): void {
    const st = loadMetaState();
    const w = x1 - x0;
    const rows: Row[] = [];

    for (const c of CHAINS) {
      rows.push({
        draw: (cy, rowH) => {
          this.rowCard(box, cy, rowH - 4, w);
          const val = st.chains.counters[c.metric] ?? 0;
          box.add(this.add.text(x0 + 14, cy - 16, tr(c.nameKey), {
            fontFamily: FONT, fontSize: '12px', color: '#3b2410',
          }).setOrigin(0, 0.5));
          box.add(this.add.text(x0 + 14, cy + 4, `${val} ${t('chain.tier0')}·${c.tiers[0]}`, {
            fontFamily: FONT, fontSize: '8px', color: '#8a5b12',
          }).setOrigin(0, 0.5));

          const cellW = 116;
          const tierNames = [t('chain.tier0'), t('chain.tier1'), t('chain.tier2')];
          for (let tier = 0; tier < 3; tier++) {
            const goal = c.tiers[tier];
            const cx = x1 - 14 - (2 - tier) * (cellW + 6) - cellW / 2;
            const claimed = chainClaimed(c.id, tier);
            const ready = val >= goal && !claimed;
            box.add(this.add.text(cx, cy - 13, tierNames[tier], {
              fontFamily: FONT, fontSize: '8px', color: claimed ? '#2e7d32' : '#8a5b12',
            }).setOrigin(0.5));
            box.add(this.add.text(cx, cy, `${Math.min(val, goal)}/${goal}`, {
              fontFamily: FONT, fontSize: '10px', color: ready ? '#9a6a08' : '#57431f',
            }).setOrigin(0.5));

            if (claimed) {
              box.add(this.add.text(cx, cy + 14, t('chain.claimed'), {
                fontFamily: FONT, fontSize: '9px', color: '#2e7d32',
                stroke: '#dcecc9', strokeThickness: 2,
              }).setOrigin(0.5));
            } else {
              const btn = makeButton(this, cx, cy + 12, 66, 22,
                ready ? t('chain.claim') : `${goal}`, () => {
                  const res = claimChainReward(c.id, tier);
                  if (res.ok) {
                    audio.play('levelup');
                    this.renderTab();
                  }
                }, 'blue', 8, { disabled: !ready, hitW: 74, hitH: 44, stopPropagation: true });
              box.add([btn.img, btn.txt, btn.hit]);
              this.contentButtons.push(btn);
            }
          }
        },
      });
    }

    rows.push({
      draw: (cy) => {
        box.add(this.add.text(this.px, cy, [
          `${t('chain.tier0')}: ${tr('chain.reward.bronze')}`,
          `${t('chain.tier1')}: ${tr('chain.reward.silver')}`,
          `${t('chain.tier2')}: ${tr('chain.reward.gold')}`,
        ].join('   '), {
          fontFamily: FONT, fontSize: '9px', color: '#8a5b12', align: 'center',
        }).setOrigin(0.5));
      },
    });

    this.renderRows(box, rows, y0, y1, 76);
  }

  // ================================================================
  // Вкладка ПРОПУСК (§J.6.3): уровень, XP, премиум, ближайшие награды
  // ================================================================

  private renderPass(box: Phaser.GameObjects.Container, x0: number, x1: number, y0: number, y1: number): void {
    const st = loadMetaState();
    const level = Math.min(PASS.LEVELS, Math.floor(st.pass.xp / PASS.XP_PER_LEVEL));
    const xpInto = st.pass.xp - level * PASS.XP_PER_LEVEL;
    const w = x1 - x0;
    let cy = y0 + 18;

    box.add(this.add.text(this.px, cy, tr('pass.level', { v: level }), {
      fontFamily: FONT, fontSize: '17px', color: '#3b2410',
    }).setOrigin(0.5));
    cy += 24;
    const premLabel = st.pass.premium ? t('pass.premiumOn') : t('pass.premiumOff');
    box.add(this.add.text(this.px, cy, `${t('pass.premium')}: ${premLabel}`, {
      fontFamily: FONT, fontSize: '11px',
      color: st.pass.premium ? '#2e7d32' : '#8a5b12',
      stroke: st.pass.premium ? '#dcecc9' : '#f7e7c3', strokeThickness: 3,
    }).setOrigin(0.5));

    // Полоса XP до следующего уровня
    cy += 24;
    const barW = w - 170;
    const frac = level >= PASS.LEVELS ? 1 : Phaser.Math.Clamp(xpInto / PASS.XP_PER_LEVEL, 0, 1);
    const bar = this.add.graphics();
    bar.fillStyle(0x3b2a1a, 1).fillRoundedRect(this.px - barW / 2, cy - 6, barW, 12, 6);
    if (frac > 0) {
      bar.fillStyle(0xd9a520, 1)
        .fillRoundedRect(this.px - barW / 2 + 2, cy - 4, Math.max(6, (barW - 4) * frac), 8, 4);
    }
    box.add(bar);
    box.add(this.add.text(this.px, cy, level >= PASS.LEVELS
      ? `${num(st.pass.xp)} XP`
      : `${num(xpInto)} / ${num(PASS.XP_PER_LEVEL)} XP`, {
      fontFamily: FONT, fontSize: '9px', color: '#ffffff', stroke: '#3b2410', strokeThickness: 3,
    }).setOrigin(0.5));

    // Покупка пропуска: только при открытой витрине (5-й матч, §J.6.4)
    cy += 26;
    if (!st.pass.premium) {
      if (showcaseVisible()) {
        const buyPassBtn = makeButton(this, this.px, cy, 260, 44, t('store.pass'), () => {
          void this.buyPass();
        }, 'red', 12);
        box.add([buyPassBtn.img, buyPassBtn.txt, buyPassBtn.hit]);
        this.contentButtons.push(buyPassBtn);
      } else {
        box.add(this.add.text(this.px, cy, t('store.locked'), {
          fontFamily: FONT, fontSize: '10px', color: '#8a5b12',
        }).setOrigin(0.5));
      }
    }

    // Ближайшие награды: уровень+1..+3, бесплатный и премиум-трек
    cy += 26;
    box.add(this.add.text(x0 + 12, cy, t('pass.free'), {
      fontFamily: FONT, fontSize: '10px', color: '#8a5b12',
    }).setOrigin(0, 0.5));
    if (st.pass.premium) {
      box.add(this.add.text(x1 - 12, cy, t('pass.premium'), {
        fontFamily: FONT, fontSize: '10px', color: '#9a6a08',
      }).setOrigin(1, 0.5));
    }

    const rewards: Row[] = [];
    for (let lv = level + 1; lv <= Math.min(PASS.LEVELS, level + 3); lv++) {
      rewards.push({
        draw: (rcy, rrowH) => {
          this.rowCard(box, rcy, rrowH - 4, w);
          box.add(this.add.text(x0 + 16, rcy, tr('pass.level', { v: lv }), {
            fontFamily: FONT, fontSize: '10px', color: '#8a5b12',
          }).setOrigin(0, 0.5));
          const fr = passReward(lv, false);
          if (fr) {
            box.add(this.add.text(x0 + 120, rcy, passRewardText(fr), {
              fontFamily: FONT, fontSize: '11px', color: '#3b2410',
            }).setOrigin(0, 0.5));
          }
          if (st.pass.premium) {
            const pr = passReward(lv, true);
            if (pr) {
              box.add(this.add.text(x1 - 16, rcy, passRewardText(pr), {
                fontFamily: FONT, fontSize: '11px', color: '#9a6a08',
              }).setOrigin(1, 0.5));
            }
          }
        },
      });
    }
    if (rewards.length > 0) {
      this.renderRows(box, rewards, cy + 12, y1 - 4, 32);
    }
  }

  private async buyPass(): Promise<void> {
    const res = await purchaseSku('pass_chronicle');
    if (res.ok) {
      audio.play('levelup');
      this.renderTab();
    }
  }

  // ================================================================
  // Вкладка ЕЩЁ: сезон, неделя, дар дня, конвертация крон, жетоны
  // ================================================================

  private renderMore(box: Phaser.GameObjects.Container, x0: number, x1: number, y0: number, y1: number): void {
    const st = loadMetaState();
    const sd = seasonDef();
    const w = x1 - x0;
    const rows: Row[] = [];

    // --- Сезон (§H.18): тема + модификатор мира + мини-прогресс
    rows.push({
      draw: (cy, rowH) => {
        this.rowCard(box, cy, rowH - 4, w);
        box.add(this.add.text(x0 + 16, cy - 14, tr(sd.themeKey), {
          fontFamily: FONT, fontSize: '13px', color: '#3b2410',
        }).setOrigin(0, 0.5));
        box.add(this.add.text(x0 + 16, cy + 3, tr(sd.modDescKey), {
          fontFamily: FONT, fontSize: '9px', color: '#8a5b12',
        }).setOrigin(0, 0.5));
        box.add(this.add.text(x1 - 16, cy - 2, t('season.progress', { v: st.season.runs }), {
          fontFamily: FONT, fontSize: '10px', color: '#9a6a08',
        }).setOrigin(1, 0.5));
        box.add(this.add.text(x1 - 16, cy + 13,
          `${Math.min(st.season.claimed, SEASON_STEPS.length)}/${SEASON_STEPS.length}`, {
          fontFamily: FONT, fontSize: '9px', color: '#8a5b12',
        }).setOrigin(1, 0.5));
      },
    });

    // --- Недельная цепочка (§H.17): 5 этапов → финал (150 крон / знамя)
    rows.push({
      draw: (cy, rowH) => {
        this.rowCard(box, cy, rowH - 4, w);
        box.add(this.add.text(x0 + 16, cy - 13, t('weekly.title'), {
          fontFamily: FONT, fontSize: '13px', color: '#3b2410',
        }).setOrigin(0, 0.5));
        const stageGoal = WEEKLY_STAGES[Math.min(st.weekly.stage, WEEKLY_STAGES.length - 1)];
        box.add(this.add.text(x0 + 16, cy + 5, [
          t('weekly.stage', { v: Math.min(st.weekly.stage, WEEKLY_STAGES.length) }),
          t('weekly.progress', { a: num(st.weekly.progress), b: num(stageGoal) }),
        ].join('   '), {
          fontFamily: FONT, fontSize: '9px', color: '#8a5b12',
        }).setOrigin(0, 0.5));

        if (st.weekly.claimed) {
          box.add(this.add.text(x1 - 92, cy, t('weekly.claimed'), {
            fontFamily: FONT, fontSize: '10px', color: '#2e7d32',
            stroke: '#dcecc9', strokeThickness: 2,
          }).setOrigin(0.5));
        } else {
          const canClaim = st.weekly.stage >= WEEKLY_STAGES.length;
          const btn = makeButton(this, x1 - 92, cy, 152, 34, t('weekly.claim'), () => {
            const res = claimWeeklyFinal();
            if (res) {
              audio.play('levelup');
              this.renderTab();
            }
          }, 'red', 10, { disabled: !canClaim, hitW: 158, hitH: 44, stopPropagation: true });
          box.add([btn.img, btn.txt, btn.hit]);
          this.contentButtons.push(btn);
        }
      },
    });

    // --- Дар дня: тот же оверлей, что и чип в меню
    rows.push({
      draw: (cy, rowH) => {
        this.rowCard(box, cy, rowH - 4, w);
        box.add(this.add.text(x0 + 16, cy, [
          t('bonus.title'),
          t('bonus.streak', { v: st.dailyBonus.streak }),
        ].join('   '), {
          fontFamily: FONT, fontSize: '11px', color: '#3b2410',
        }).setOrigin(0, 0.5));
        const btn = makeButton(this, x1 - 110, cy, 172, 40, t('bonus.claim'), () => {
          this.showBonusOverlay();
        }, 'blue', 11);
        box.add([btn.img, btn.txt, btn.hit]);
        this.contentButtons.push(btn);
      },
    });

    // --- Конвертация крон в золото (§J.8): 100 → 600, 3/день
    rows.push({
      draw: (cy, rowH) => {
        this.rowCard(box, cy, rowH - 4, w);
        const canConvert = st.crowns >= 100 && st.crownConvert.count < 3;
        const btn = makeButton(this, x1 - 132, cy, 214, 40,
          tr('store.convert', { v: st.crownConvert.count }), () => {
            const res = convertCrownsToGold();
            if (!res.ok) {
              this.flashNote(res.reason === 'limit' ? t('store.convertLimit') : t('store.fail'));
              return;
            }
            audio.play('levelup');
            this.renderTab();
          }, 'blue', 10, { disabled: !canConvert, hitW: 220, hitH: 44, stopPropagation: true });
        box.add([btn.img, btn.txt, btn.hit]);
        this.contentButtons.push(btn);
      },
    });

    // --- Жетоны (сведения)
    rows.push({
      draw: (cy) => {
        const lines: string[] = [];
        lines.push(t('meta.tokens', { v: st.speedupTokens }));
        lines.push(t('meta.blessingTokens', { v: st.blessingTokens }));
        box.add(this.add.text(this.px, cy, lines.join('   '), {
          fontFamily: FONT, fontSize: '10px', color: '#57431f', align: 'center',
        }).setOrigin(0.5));
      },
    });

    this.renderRows(box, rows, y0, y1, 60);
  }

  /** Короткое сообщение поверх вкладки (лимит конвертации и т.п.). */
  private flashNote(text: string): void {
    const note = this.add.text(this.px, this.contentBottom() - 4, text, {
      fontFamily: FONT, fontSize: '11px', color: '#ffe9b0',
      stroke: '#1b1008', strokeThickness: 4, align: 'center',
    }).setOrigin(0.5).setDepth(200);
    this.tweens.add({
      targets: note, alpha: 0, y: note.y - 18, delay: 1600, duration: 400,
      onComplete: () => note.destroy(),
    });
  }

  // ================================================================
  // Оверлей дара дня (§H.7): 7 кружков недели + забор / ×2 за рекламу
  // ================================================================

  private showBonusOverlay(): void {
    this.closeBonusOverlay();
    const st = rollMetaDay();
    const w = Math.min(470, this.scale.width - 40);
    const h = Math.min(430, this.scale.height - 60);
    const cx = this.scale.width / 2;
    const cy = this.scale.height / 2;
    const top = cy - h / 2;

    const container = this.add.container(0, 0).setDepth(300);
    this.bonusOverlay = container;
    const dim = this.add.rectangle(cx, cy, this.scale.width + 40, this.scale.height + 40, 0x0a0a12, 0.8)
      .setInteractive().setScrollFactor(0);
    dim.on('pointerdown', () => this.closeBonusOverlay());
    container.add(dim);

    const paper = makePanel(this, cx, cy, 'paper', w, h);
    container.add(paper);
    // Блокиратор над бумагой: клик по пустому месту не закрывает
    container.add(this.add.zone(cx, cy, w, h).setInteractive());
    container.add(this.add.text(cx, top + 36, t('bonus.title'), {
      fontFamily: FONT, fontSize: '22px', color: '#3b2410',
    }).setOrigin(0.5));
    container.add(this.add.text(cx, top + 62, [
      t('bonus.day', { v: (st.dailyBonus.streak % 7) + 1 }),
      t('bonus.streak', { v: st.dailyBonus.streak }),
    ].join('   '), {
      fontFamily: FONT, fontSize: '11px', color: '#8a5b12',
    }).setOrigin(0.5));

    // Кружки недели: подсвечен текущий день стрика (streak % 7)
    const todayIdx = st.dailyBonus.streak % 7;
    const circleY = top + 128;
    const span = w - 110;
    const step = span / 6;
    for (let i = 0; i < 7; i++) {
      const cxx = cx - span / 2 + i * step;
      const isToday = i === todayIdx;
      const passed = i < todayIdx;
      const r = isToday ? 19 : 15;
      const g = this.add.graphics();
      g.fillStyle(isToday ? 0xd9a520 : passed ? 0xffe9b0 : 0xefe6d0, 1).fillCircle(cxx, circleY, r);
      g.lineStyle(isToday ? 3 : 2, isToday ? 0x9a6a08 : 0xc9a25e, 1).strokeCircle(cxx, circleY, r);
      container.add(g);
      container.add(this.add.text(cxx, circleY, `${i + 1}`, {
        fontFamily: FONT, fontSize: isToday ? '13px' : '11px',
        color: isToday ? '#ffffff' : passed ? '#9a6a08' : '#8d8577',
      }).setOrigin(0.5));
    }

    // Награда текущего дня
    const def = DAILY_BONUS[todayIdx];
    const kindText = def
      ? t(BONUS_KIND_KEYS[def.kind] ?? 'bonus.kind.gold',
        def.kind === 'gold' || def.kind === 'crowns' ? { v: num(def.amount) } : undefined)
      : '';
    container.add(this.add.text(cx, top + 176, kindText, {
      fontFamily: FONT, fontSize: '13px', color: '#9a6a08', align: 'center',
    }).setOrigin(0.5));

    // Кнопки забора: простой клик и ×2 за rewarded R11
    const canClaim = bonusAvailable();
    const btnY = top + h - 76;
    const claim = makeButton(this, cx - 90, btnY, 160, 48, t('bonus.claim'), () => {
      this.finishBonusClaim(false);
    }, 'blue', 13, { disabled: !canClaim });
    container.add([claim.img, claim.txt, claim.hit]);
    this.bonusButtons.push(claim);

    if (placementAvailable('bonus-x2')) {
      const claimX2 = makeButton(this, cx + 90, btnY, 160, 48, t('bonus.claimX2'), () => {
        void this.claimBonusWithAd();
      }, 'red', 13, { disabled: !canClaim });
      container.add([claimX2.img, claimX2.txt, claimX2.hit]);
      this.bonusButtons.push(claimX2);
    }
  }

  private async claimBonusWithAd(): Promise<void> {
    const res = await showPlacementRewarded('bonus-x2');
    if (res.rewarded) this.finishBonusClaim(true);
  }

  private finishBonusClaim(doubled: boolean): void {
    const res = claimDailyBonus(doubled);
    if (res.ok) {
      track('daily_bonus_claim', { day: res.day, doubled });
      audio.play('levelup');
    }
    this.closeBonusOverlay();
    this.renderTab();
  }

  private closeBonusOverlay(): void {
    for (const b of this.bonusButtons) b.destroy();
    this.bonusButtons = [];
    this.bonusOverlay?.destroy(true);
    this.bonusOverlay = null;
  }
}
