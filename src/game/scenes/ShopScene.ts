import Phaser from 'phaser';
import { FONT } from '../constants';
import { audio } from '../systems/Audio';
import { Cursor } from '../systems/Cursor';
import { makeButton, makePanel, makeRibbon, resizePanel, fitTextWidth, type Button } from '../systems/Ui';
import { t, num, type TranslationKey } from '../../i18n';
import { track } from '../../platform/analytics';
import { fetchCatalog, purchaseSku, showcaseVisible, SKUS, type CatalogProduct } from '../../platform/payments';
import { isMockMode, isOnYandex } from '../../platform/sdk';
import { placementAvailable, showPlacementRewarded, showStickyBanner } from '../../platform/ads';
import {
  rollMetaDay,
  saveMetaState,
  hasIapEntitlement,
  buySkinWithCrowns,
  setActiveSkin,
  ownedBanners,
  passReward,
  convertCrownsToGold,
  SKINS,
  BANNERS,
  CONSUMABLES,
  PASS,
  type SkinDef,
  type BannerDef,
  type ConsumableDef,
  type PassReward,
  type MetaState,
} from '../meta';
import { loadShop, buyUpgrade, SHOP_UPGRADES, type ShopState, type ShopUpgradeDef } from '../shop';
import { getDailyShopRotation, refreshDailyShopRotation } from '../shopRotation';

// ============ Витрина фазы S (TZ §J.6): лавка / скины / пропуск / кроны ============
//
// Сцена ЛАУНЧИТСЯ поверх Menu (config.ts) и закрывается scene.stop() —
// тот же контракт оверлея, что у MetaScene. Четыре вкладки:
//   • ЛАВКА   — постоянные усиления за золото матчей (src/game/shop.ts);
//   • СКИНЫ   — перекраски setTint за кроны + знамёна (видны всегда);
//   • ПРОПУСК — сезонный pass «Хроника» и его награды;
//   • КРОНЫ   — полка SKU инапов, конвертация, расходники.
// Витрина инапов (скины-покупка, пропуск, кроны) скрыта до 5-го матча
// (§J.6.4, гейт 45) — showcaseVisible(). Сама витрина никогда не всплывает
// сама: открывается только кнопкой ЛАВКА из меню (§J.9).

type TabId = 'shop' | 'skins' | 'pass' | 'crowns';

/** Метки вкладок и заголовок шапки для каждой вкладки. */
const TAB_LABELS: Record<TabId, TranslationKey> = {
  shop: 'menu.shop',
  skins: 'skins.title',
  pass: 'pass.title',
  crowns: 'store.title',
};
const TAB_TITLES: Record<TabId, TranslationKey> = {
  shop: 'shop.title',
  skins: 'skins.title',
  pass: 'pass.title',
  crowns: 'store.title',
};

/** In-app products supported by both the SDK catalogue and the reward mapper. */
const STORE_SKUS: string[] = [
  'crowns_s', 'crowns_m', 'crowns_l', 'crowns_xl',
  'starter_castellan', 'no_interstitial', 'pass_chronicle',
  'skin_hero_warrior_red', 'skin_hero_warrior_yellow',
  'skin_hero_archer_red', 'skin_hero_archer_purple',
  'skin_hero_lancer_red', 'skin_hero_lancer_black',
  'skin_hero_monk_red', 'skin_hero_monk_yellow',
  'skin_bld_red', 'skin_bld_purple', 'skin_bld_yellow', 'skin_bld_black',
  'hero_trail_gold', 'hero_trail_ember',
];
const ONE_SHOT_SKUS: string[] = [
  'starter_castellan', 'no_interstitial',
  'skin_hero_warrior_red', 'skin_hero_warrior_yellow',
  'skin_hero_archer_red', 'skin_hero_archer_purple',
  'skin_hero_lancer_red', 'skin_hero_lancer_black',
  'skin_hero_monk_red', 'skin_hero_monk_yellow',
  'skin_bld_red', 'skin_bld_purple', 'skin_bld_yellow', 'skin_bld_black',
  'hero_trail_gold', 'hero_trail_ember',
];

function catalogTextureKey(uri: string): string {
  let hash = 2166136261;
  for (let i = 0; i < uri.length; i++) {
    hash ^= uri.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return 'catalog-' + (hash >>> 0).toString(36);
}

const SKU_LABELS: Record<string, TranslationKey> = {
  crowns_s: 'store.crowns_s',
  crowns_m: 'store.crowns_m',
  crowns_l: 'store.crowns_l',
  crowns_xl: 'store.crowns_xl',
  starter_castellan: 'store.starter',
  no_interstitial: 'store.no_interstitial',
  pass_chronicle: 'store.pass',
  skin_hero_warrior_red: 'skins.skin.hero_warrior_red',
  skin_hero_warrior_yellow: 'skins.skin.hero_warrior_yellow',
  skin_hero_archer_red: 'skins.skin.hero_archer_red',
  skin_hero_archer_purple: 'skins.skin.hero_archer_purple',
  skin_hero_lancer_red: 'skins.skin.hero_lancer_red',
  skin_hero_lancer_black: 'skins.skin.hero_lancer_black',
  skin_hero_monk_red: 'skins.skin.hero_monk_red',
  skin_hero_monk_yellow: 'skins.skin.hero_monk_yellow',
  skin_bld_red: 'skins.skin.bld_red',
  skin_bld_purple: 'skins.skin.bld_purple',
  skin_bld_yellow: 'skins.skin.bld_yellow',
  skin_bld_black: 'skins.skin.bld_black',
  hero_trail_gold: 'skins.skin.trail_gold',
  hero_trail_ember: 'skins.skin.trail_ember',
};

interface ShopPayload {
  tab?: TabId;
}

interface ShopTabItem {
  /** Высота строки — страницы собираются по сумме высот (§: без масок WebGL). */
  h: number;
  /** Строка-заголовок секции: к следующей странице держится вместе с контентом. */
  hdr?: boolean;
  draw: (cy: number) => void;
}

// ---------- i18n: имя скина/знамени словарём (t() возвращает ключ, если его нет) ----------

function i18nOr(key: string): string | null {
  const s = t(key as TranslationKey);
  return s === key ? null : s;
}

/** def.nameKey задан в SKINS, но словарь хранит имена под skins.skin.*. */
function skinLabel(def: SkinDef): string {
  return (
    i18nOr(def.nameKey) ??
    i18nOr(`skins.skin.${def.id}`) ??
    i18nOr(`skins.skin.${def.id.replace(/^skin_/, '')}`) ??
    def.id
  );
}

function bannerLabel(def: BannerDef): string {
  return i18nOr(def.nameKey) ?? def.id;
}

/** Подпись награды пропуска (t('pass.reward.*')). */
function rewardLabel(r: PassReward | null): string {
  if (!r) return '—';
  switch (r.kind) {
    case 'gold': return t('pass.reward.gold', { v: r.amount });
    case 'crowns': return t('pass.reward.crowns', { v: r.amount });
    case 'token': return t('pass.reward.token');
    case 'blessing': return t('pass.reward.blessing');
    case 'skin': return t('pass.reward.skin');
    case 'title': return t('pass.reward.title');
    case 'frame': return t('pass.reward.frame');
    case 'banner': return t('pass.reward.banner');
    default: return '—';
  }
}

export class ShopScene extends Phaser.Scene {
  private payload: ShopPayload = {};
  private cursor!: Cursor;

  private tab: TabId = 'shop';
  private pageIdx = 0;
  /** Защита от двойного клика по платёжным кнопкам на время await. */
  private busy = false;
  /** Separate guard for the once-per-day rewarded shop refresh. */
  private refreshBusy = false;
  /** Today's featured IDs are marked in the full catalogue as well. */
  private dailyOfferIds = new Set<string>();
  /** Идентификатор апгрейда для «встряски» строки после покупки (как в MenuScene). */
  private flashUpgradeId: string | null = null;
  /** SDK catalog is the source of truth for platform prices and portal currency. */
  private catalogState: 'idle' | 'loading' | 'sdk' | 'fallback' | 'unavailable' = 'idle';
  private catalogProducts = new Map<string, CatalogProduct>();
  private catalogRequestId = 0;

  // Геометрия панели
  private pw = 0;
  private ph = 0;
  private px = 0;
  private py = 0;

  private titleText: Phaser.GameObjects.Text | null = null;
  private crownText: Phaser.GameObjects.Text | null = null;
  private backBtn: Button | null = null;
  /** Каркас панели: подгоняется под содержимое вкладки (см. fitShellToContent). */
  private paper: Phaser.GameObjects.NineSlice | null = null;
  private blocker: Phaser.GameObjects.Zone | null = null;
  private ribbon: Phaser.GameObjects.Container | null = null;
  private tabButtons: Button[] = [];
  private contentButtons: Button[] = [];
  private contentBox: Phaser.GameObjects.Container | null = null;
  private toastText: Phaser.GameObjects.Text | null = null;

  constructor() {
    super('Shop');
  }

  create(payload?: ShopPayload): void {
    this.cursor = new Cursor(this);
    this.payload = payload ?? {};
    this.tab = this.payload.tab ?? 'shop';
    this.pageIdx = 0;
    this.busy = false;
    this.refreshBusy = false;
    this.flashUpgradeId = null;
    this.catalogRequestId += 1;
    this.catalogState = 'idle';
    this.catalogProducts = new Map();
    this.titleText = null;
    this.crownText = null;
    this.backBtn = null;
    this.tabButtons = [];
    this.contentButtons = [];
    this.contentBox = null;
    this.toastText = null;

    this.pw = Math.min(620, Math.floor(this.scale.width * 0.92));
    this.ph = Math.min(680, Math.floor(this.scale.height * 0.92));
    this.px = this.scale.width / 2;
    this.py = this.scale.height / 2;

    // Стики-баннер (§J.5): витрина — вне рана
    showStickyBanner();

    const top = this.py - this.ph / 2;
    const compact = this.ph < 480;

    // ---------- Затемнение: клик мимо панели закрывает оверлей ----------
    const dim = this.add
      .rectangle(this.px, this.py, this.scale.width + 40, this.scale.height + 40, 0x0a0a12, 0.78)
      .setScrollFactor(0).setInteractive().setDepth(100);
    dim.on('pointerdown', () => this.close());

    // ---------- Панель + невидимый блокиратор над ней (клик по бумаге гасится) ----------
    this.paper = makePanel(this, this.px, this.py, 'paper', this.pw, this.ph)
      .setDepth(101).setScrollFactor(0);
    this.blocker = this.add.zone(this.px, this.py, this.pw, this.ph)
      .setInteractive().setDepth(102);

    // ---------- Заголовок вкладки — текст меняется вместе со вкладкой ----------
    this.ribbon = makeRibbon(this, this.px, top + 26, Math.min(400, this.pw - 80), 'ribbon-yellow', 50)
      .setDepth(103).setScrollFactor(0);
    this.titleText = this.add.text(this.px, top + 26, t(TAB_TITLES[this.tab]), {
      fontFamily: FONT, fontSize: compact ? '18px' : '21px', color: '#ffe9c0',
      stroke: '#1b1008', strokeThickness: 5,
    }).setOrigin(0.5).setDepth(104).setScrollFactor(0);

    // ---------- Баланс крон в шапке — обновляется при каждой перерисовке ----------
    this.crownText = this.add.text(this.px, top + 64, '', {
      fontFamily: FONT, fontSize: '12px', color: '#6b4a1e', align: 'center',
    }).setOrigin(0.5).setDepth(104).setScrollFactor(0);

    this.renderTabs();

    // Трекинг: витрина крон открыта (в т.ч. сразу при payload.tab = 'crowns')
    if (this.tab === 'crowns') track('sku_view', {});

    this.renderTab();
    if (this.tab === 'crowns') void this.loadCatalog();

    // ---------- Назад ----------
    this.backBtn = makeButton(this, this.px, this.py + this.ph / 2 - 30, 170, 46, t('common.back'),
      () => this.close(), 'red', 15);
    this.backBtn.img.setDepth(104).setScrollFactor(0);
    this.backBtn.txt.setDepth(104).setScrollFactor(0);
    this.backBtn.hit.setDepth(104);

    // Esc — закрыть
    const kb = this.input.keyboard;
    if (kb) kb.on('keydown-ESC', this.close, this);

    // Поворот/ресайз — перерисовать всё на новых размерах (как в MetaScene)
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
  // Каркас: вкладки + контент текущей вкладки
  // ================================================================

  private tabsTop(): number {
    const top = this.py - this.ph / 2;
    return top + (this.ph < 480 ? 80 : 88);
  }

  private contentTop(): number {
    return this.tabsTop() + 34;
  }

  private contentBottom(): number {
    return this.py + this.ph / 2 - 84;
  }

  private contentWidth(): number {
    return this.pw - 64;
  }

  private renderTabs(): void {
    for (const b of this.tabButtons) b.destroy();
    this.tabButtons = [];

    const ids: TabId[] = ['shop', 'skins', 'pass', 'crowns'];
    const gap = 8;
    const tw = Math.min(126, (this.pw - 48 - (ids.length - 1) * gap) / ids.length);
    ids.forEach((id, i) => {
      const x = this.px - (ids.length * tw + (ids.length - 1) * gap) / 2 + i * (tw + gap) + tw / 2;
      const b = makeButton(this, x, this.tabsTop(), tw, 44, t(TAB_LABELS[id]), () => {
        this.openTab(id);
      }, id === this.tab ? 'blue' : 'red', 11);
      b.img.setDepth(103).setScrollFactor(0);
      b.txt.setDepth(103).setScrollFactor(0);
      b.hit.setDepth(103);
      this.tabButtons.push(b);
    });
  }

  /** Переключение вкладки: сброс страницы, трекинг витрины, перерисовка. */
  private openTab(id: TabId): void {
    if (this.tab === id && this.contentBox) return;
    this.tab = id;
    this.pageIdx = 0;
    if (id === 'crowns') track('sku_view', {});
    this.renderTabs();
    this.renderTab();
    if (id === 'crowns') void this.loadCatalog();
  }

  /** Загружает каталог SDK один раз за открытие сцены. */
  private async loadCatalog(): Promise<void> {
    if (this.catalogState !== 'idle') return;
    const requestId = ++this.catalogRequestId;
    if (import.meta.env.DEV && (!isOnYandex() || isMockMode())) {
      this.catalogState = 'fallback';
      if (this.scene.isActive() && this.tab === 'crowns') this.renderTab();
      return;
    }
    if (!isOnYandex()) {
      this.catalogState = 'unavailable';
      if (this.scene.isActive() && this.tab === 'crowns') this.renderTab();
      return;
    }
    this.catalogState = 'loading';
    if (this.scene.isActive() && this.tab === 'crowns') this.renderTab();

    let fetched: CatalogProduct[] = [];
    try { fetched = await fetchCatalog(); } catch { /* fail closed below */ }
    if (requestId !== this.catalogRequestId || !this.scene.isActive()) return;

    // Only show SKU IDs that this game knows how to grant; never expose an unknown console SKU.
    const byId = new Map<string, CatalogProduct>();
    for (const product of fetched) {
      if (STORE_SKUS.includes(product.id) && product.price?.trim()) byId.set(product.id, product);
    }
    const ordered = STORE_SKUS
      .map((sku) => byId.get(sku))
      .filter((product): product is CatalogProduct => product !== undefined);
    this.catalogProducts = new Map(ordered.map((product) => [product.id, product]));

    if (ordered.length === 0) {
      this.catalogState = 'unavailable';
    } else {
      try {
        await this.preloadCatalogImages(ordered);
      } catch {
        // Product text and price remain usable even if an image host fails.
      }
      if (requestId !== this.catalogRequestId || !this.scene.isActive()) return;
      this.catalogState = 'sdk';
    }
    if (this.tab === 'crowns') this.renderTab();
  }

  /** Load SDK imagery on the scene loader. A bad image must not block text or purchases. */
  private async preloadCatalogImages(products: CatalogProduct[]): Promise<void> {
    const pending = new Map<string, string>();
    for (const product of products) {
      for (const uri of [product.imageURI, product.priceCurrencyImage]) {
        if (!uri) continue;
        const key = catalogTextureKey(uri);
        if (!this.textures.exists(key)) pending.set(key, uri);
      }
    }
    if (pending.size === 0) return;
    await new Promise<void>((resolve) => {
      this.load.once('complete', () => resolve());
      for (const [key, uri] of pending) this.load.image(key, uri);
      if (!this.load.isLoading()) this.load.start();
    });
  }

  /** Перерисовка контента вкладки: заголовок, баланс в шапке, перестройка строк. */
  private renderTab(): void {
    for (const b of this.contentButtons) b.destroy();
    this.contentButtons = [];
    if (this.contentBox) this.contentBox.destroy(true);
    this.pageIdx = Math.max(0, this.pageIdx);

    this.titleText?.setText(t(TAB_TITLES[this.tab]));
    this.crownText?.setText(t('meta.crowns', { v: num(rollMetaDay().crowns) }));

    const box = this.add.container(0, 0).setDepth(103).setScrollFactor(0);
    this.contentBox = box;

    switch (this.tab) {
      case 'shop': this.renderShopTab(box); break;
      case 'skins': this.renderSkinsTab(box); break;
      case 'pass': this.renderPassTab(box); break;
      case 'crowns': this.renderCrownsTab(box); break;
    }

    // Панель подгоняется под содержимое вкладки. Раньше высота была
    // фиксированной (92 % экрана), и на вкладке из пяти товаров под списком
    // оставалось до 200 px пустой бумаги — витрина выглядела недоделанной.
    // Пересборка контента после подгонки нужна один раз: строки стоят от
    // верхнего края панели, который сдвинулся.
    if (this.fitShellToContent()) this.renderTab();
  }

  /**
   * Подгоняет высоту пергамента под фактическое содержимое вкладки.
   *
   * Возвращает true, если высота изменилась и содержимое нужно пересобрать.
   */
  private fitShellToContent(): boolean {
    if (!this.contentBox || !this.paper) return false;
    const maxH = Math.min(680, Math.floor(this.scale.height * 0.92));
    const minH = Math.min(340, maxH);
    const bounds = this.contentBox.getBounds();
    // Нижний резерв: 20 px поля пергамента + место под кнопку «Назад».
    const needed = Math.ceil(bounds.y + bounds.height) - (this.py - this.ph / 2) + 92;
    const ph = Phaser.Math.Clamp(needed, minH, maxH);
    if (Math.abs(ph - this.ph) < 2) return false;

    this.ph = ph;
    const top = this.py - ph / 2;
    resizePanel(this.paper, this.pw, ph);
    this.paper.setPosition(this.px, this.py);
    this.blocker?.setPosition(this.px, this.py).setSize(this.pw, ph);
    this.ribbon?.setPosition(this.px, top + 26);
    this.titleText?.setPosition(this.px, top + 26);
    this.crownText?.setPosition(this.px, top + 64);
    // Кнопка «Назад» создаётся после первой отрисовки вкладки, поэтому на
    // первом проходе её ещё нет — её положение поправит следующий проход.
    if (this.backBtn) {
      const backY = this.py + ph / 2 - 30;
      this.backBtn.img.setPosition(this.px, backY);
      this.backBtn.txt.setPosition(this.px, backY);
      this.backBtn.hit.setPosition(this.px, backY);
    }
    this.renderTabs();
    return true;
  }

  // ================================================================
  // Общие элементы строк
  // ================================================================

  private sectionTitle(box: Phaser.GameObjects.Container, cy: number, label: string): void {
    box.add(this.add.text(this.px - this.contentWidth() / 2 + 6, cy, label.toUpperCase(), {
      fontFamily: FONT, fontSize: '12px', color: '#9a6a08',
      stroke: '#f7e7c3', strokeThickness: 3,
    }).setOrigin(0, 0.5));
  }

  private label(
    x: number, y: number, s: string, size: number, color: string, originX = 0.5,
  ): Phaser.GameObjects.Text {
    return this.add.text(x, y, s, {
      fontFamily: FONT, fontSize: `${size}px`, color,
    }).setOrigin(originX, 0.5);
  }

  /** Ширина строки в указанном кегле: замер на живой текстовой метке. */
  private measure(s: string, size: number): number {
    const probe = this.add.text(0, 0, s, { fontFamily: FONT, fontSize: `${size}px` });
    const w = probe.width;
    probe.destroy();
    return w;
  }

  /**
   * Постраничный вывод смешанных по высоте строк (заголовки секций + карточки):
   * страницы собираются жадно по сумме высот, висячий заголовок уезжает вниз.
   */
  private renderPaged(box: Phaser.GameObjects.Container, items: ShopTabItem[], y0 = this.contentTop()): void {
    const gap = 6;
    const availH = this.contentBottom() - y0;

    const pages: number[][] = [];
    let cur: number[] = [];
    let acc = 0;
    for (let i = 0; i < items.length; i++) {
      const need = cur.length === 0 ? items[i].h : gap + items[i].h;
      if (cur.length > 0 && acc + need > availH) {
        pages.push(cur);
        cur = [];
        acc = items[i].h;
      } else {
        acc += need;
      }
      cur.push(i);
    }
    if (cur.length > 0) pages.push(cur);

    // Заголовок секции не остаётся последней строкой страницы
    for (let p = 0; p < pages.length - 1; p++) {
      const arr = pages[p];
      while (arr.length > 1 && items[arr[arr.length - 1]].hdr === true) {
        pages[p + 1].unshift(arr.pop() as number);
      }
    }

    const totalPages = Math.max(1, pages.length);
    const page = Phaser.Math.Clamp(this.pageIdx, 0, totalPages - 1);
    let y = y0;
    for (const idx of pages[page] ?? []) {
      const it = items[idx];
      it.draw(y + it.h / 2);
      y += it.h + gap;
    }

    if (totalPages > 1) {
      const pagerY = this.contentBottom() + 20;
      const prev = makeButton(this, this.px - 120, pagerY, 48, 44, '‹', () => {
        this.pageIdx = Math.max(0, page - 1);
        this.renderTab();
      }, 'blue', 18);
      const next = makeButton(this, this.px + 120, pagerY, 48, 44, '›', () => {
        this.pageIdx = Math.min(totalPages - 1, page + 1);
        this.renderTab();
      }, 'blue', 18);
      const info = this.label(this.px, pagerY, `${page + 1} / ${totalPages}`, 12, '#6b4a1e');
      box.add([prev.img, prev.txt, prev.hit, next.img, next.txt, next.hit, info]);
      this.contentButtons.push(prev, next);
    }
  }

  // ================================================================
  // Вкладка ЛАВКА: SHOP_UPGRADES за золото кошелька (вёрстка MenuScene)
  // ================================================================

  private renderShopTab(box: Phaser.GameObjects.Container): void {
    const st = loadShop();
    const cw = this.contentWidth();

    // Кошелёк. Плашка подгоняется под содержимое: раньше она была фиксированной
// ширины 180 px, и при короткой сумме («0») монета с цифрой жались в левый
// край, а справа оставалась пустая бумага.
    const chipY = this.contentTop() + 16;
    const amount = num(st.balance);
    const amountW = this.measure(amount, 15);
    const chipW = Math.min(this.contentWidth(), amountW + 62);
    const chipX = this.px - chipW / 2;
    const g = this.add.graphics();
    g.fillStyle(0xf7e7c3, 1).fillRoundedRect(chipX, chipY - 15, chipW, 30, 9);
    g.lineStyle(2, 0xc9a25e, 1).strokeRoundedRect(chipX, chipY - 15, chipW, 30, 9);
    box.add(g);
    box.add(this.add.image(chipX + 17, chipY, 'icon-coin').setDisplaySize(20, 20));
    box.add(this.label(chipX + 31 + amountW / 2, chipY, amount, 15, '#7a4e0e'));

    const items: ShopTabItem[] = SHOP_UPGRADES.map((u) => ({
      h: 56,
      draw: (cy) => box.add(this.upgradeRow(u, cy, st, cw)),
    }));
    // Кошелёк занимает первую полосу — строки начинаются ниже
    this.renderPaged(box, items, this.contentTop() + 38);
  }

  private upgradeRow(u: ShopUpgradeDef, cy: number, st: ShopState, w: number): Phaser.GameObjects.Container {
    const row = this.add.container(this.px, cy);
    const rowH = 56;
    const bg = this.add.graphics();
    bg.fillStyle(0xfff6df, 0.92).fillRoundedRect(-w / 2, -rowH / 2 + 2, w, rowH - 4, 8);
    bg.lineStyle(2, 0xc9a25e, 1).strokeRoundedRect(-w / 2, -rowH / 2 + 2, w, rowH - 4, 8);
    row.add(bg);

    const lvl = st.upgrades[u.id];
    const maxed = lvl >= 3;
    const price = maxed ? null : u.costs[lvl];
    const affordable = price !== null && st.balance >= price;
    const dense = w < 430;
    const iconSize = dense ? 22 : 28;

    row.add(this.add.image(-w / 2 + 26, 0, u.icon).setDisplaySize(iconSize, iconSize));
    const textX = -w / 2 + 26 + iconSize / 2 + 8;
    const name = this.label(textX, -10, u.name, dense ? 12 : 13, '#3b2410', 0);
    fitTextWidth(name, w - (dense ? 150 : 190), dense ? 12 : 13);
    row.add(name);
    const desc = this.label(textX, 10, u.desc, dense ? 11 : 12, '#8a5b12', 0);
    fitTextWidth(desc, w - (dense ? 150 : 190), dense ? 11 : 12, 7);
    row.add(desc);

    // Уровень улучшения. Раньше here стояли точки «●●○» — в пиксельном
    // шрифте на 10 px круг «○» неотличим от цифры «0», и покупатель видел
    // «100» вместо уровня. Теперь это подпись «УР. N».
    const lvlTag = this.label(w / 2 - (dense ? 104 : 124), -11, t('hud.level', { v: lvl }), 12, '#b0803a');
    row.add(lvlTag);

    if (maxed) {
      row.add(this.label(w / 2 - 52, 1, t('shop.max'), 12, '#2e7d32'));
      return row;
    }

    const buy = (): void => {
      const res = buyUpgrade(u.id);
      if (res.ok) {
        audio.play('levelup');
        this.flashUpgradeId = u.id;
        this.renderTab();
      } else if (res.reason === 'poor') {
        // Не хватило золота: короткая встряска кнопки (как в MenuScene)
        const btnImg = priceBtn.img;
        this.tweens.add({ targets: btnImg, x: { from: btnImg.x - 5, to: btnImg.x }, duration: 180 });
      }
    };
    const priceBtn = makeButton(
      this, w / 2 - 52, 0, 84, 34, price === null ? '' : String(price),
      buy, 'blue', 12, { disabled: !affordable, hitW: 92, hitH: rowH, stopPropagation: true },
    );
    row.add([priceBtn.img, priceBtn.txt, priceBtn.hit]);
    this.contentButtons.push(priceBtn);
    if (!affordable) row.setAlpha(0.75);

    if (this.flashUpgradeId === u.id) {
      this.flashUpgradeId = null;
      row.setScale(1.1);
      this.tweens.add({ targets: row, scale: 1, duration: 260, ease: 'Back.easeOut' });
    }
    return row;
  }

  // ================================================================
  // Вкладка СКИНЫ: герой / постройки / шлейф + знамёна
  // ================================================================

  private renderSkinsTab(box: Phaser.GameObjects.Container): void {
    const st = rollMetaDay();
    let catalogTop = this.contentTop();
    const rotation = showcaseVisible() ? getDailyShopRotation() : null;
    this.dailyOfferIds = new Set(rotation?.ids ?? []);

    // R8: daily cosmetic selection. It is opt-in, persistent, and independent
    // of the full catalogue, which remains available below the featured offers.
    if (rotation) {
      catalogTop = this.renderDailyOffers(box, st, catalogTop, rotation);
    }

    const items: ShopTabItem[] = [];
    const section = (key: TranslationKey): void => {
      items.push({ h: 24, hdr: true, draw: (cy) => this.sectionTitle(box, cy, t(key)) });
    };

    section('skins.hero');
    for (const def of SKINS.filter((s) => s.kind === 'hero')) {
      items.push({ h: 46, draw: (cy) => box.add(this.skinRow(def, cy, st)) });
    }
    section('skins.building');
    for (const def of SKINS.filter((s) => s.kind === 'building')) {
      items.push({ h: 46, draw: (cy) => box.add(this.skinRow(def, cy, st)) });
    }
    section('skins.trail');
    for (const def of SKINS.filter((s) => s.kind === 'trail')) {
      items.push({ h: 46, draw: (cy) => box.add(this.skinRow(def, cy, st)) });
    }
    section('skins.banner');
    for (const def of BANNERS) {
      items.push({ h: 46, draw: (cy) => box.add(this.bannerRow(def, cy, st)) });
    }
    // Сброс активного знамени
    items.push({ h: 46, draw: (cy) => box.add(this.bannerResetRow(cy, st)) });

    this.renderPaged(box, items, catalogTop);
  }

  /** Fixed R8 header keeps the daily offer and refresh action visible on every catalogue page. */
  private renderDailyOffers(
    box: Phaser.GameObjects.Container,
    st: MetaState,
    top: number,
    rotation: ReturnType<typeof getDailyShopRotation>,
  ): number {
    const cw = this.contentWidth();
    const isCompact = this.ph < 480;
    const titleY = top + 9;
    box.add(this.add.text(this.px - cw / 2 + 4, titleY, t('store.dailyOffers'), {
      fontFamily: FONT, fontSize: isCompact ? '9px' : '11px', color: '#9a6a08',
      stroke: '#f7e7c3', strokeThickness: 2,
    }).setOrigin(0, 0.5));

    const refreshLabel = rotation.refreshed
      ? t('store.refreshDone')
      : placementAvailable('shop-refresh') ? t('store.refreshAd') : t('store.refreshUnavailable');
    const canRefresh = !rotation.refreshed && placementAvailable('shop-refresh') && !this.refreshBusy;
    const refreshButton = makeButton(
      this, this.px + cw / 2 - (isCompact ? 55 : 66), titleY,
      isCompact ? 94 : 116, 34, refreshLabel,
      () => { void this.refreshDailyOffers(); },
      'blue', isCompact ? 11 : 12,
      { disabled: !canRefresh, hitW: isCompact ? 104 : 124, hitH: 44, stopPropagation: true },
    );
    box.add([refreshButton.img, refreshButton.txt, refreshButton.hit]);
    this.contentButtons.push(refreshButton);

    // On short landscape viewports, keep the offer names and action compact so
    // the paged catalogue can still be reached without scrolling or clipping.
    if (isCompact) {
      const labels = rotation.ids.map((id) => {
        const def = SKINS.find((skin) => skin.id === id);
        return def ? skinLabel(def) : id;
      });
      box.add(this.add.text(this.px, top + 31, labels.join(' · '), {
        fontFamily: FONT, fontSize: '12px', color: '#6b4a1e',
        align: 'center', wordWrap: { width: cw - 12 },
      }).setOrigin(0.5, 0.5));
      return top + 50;
    }

    let y = top + 38;
    for (const id of rotation.ids) {
      const def = SKINS.find((skin) => skin.id === id);
      if (!def) continue;
      box.add(this.skinRow(def, y + 23, st));
      y += 48;
    }

    // Small separator between featured offers and the full catalogue.
    const separator = this.add.graphics();
    separator.lineStyle(1, 0xc9a25e, 0.65)
      .lineBetween(this.px - cw / 2, y + 1, this.px + cw / 2, y + 1);
    box.add(separator);
    return y + 12;
  }

  private async refreshDailyOffers(): Promise<void> {
    if (this.refreshBusy || !placementAvailable('shop-refresh')) return;
    this.refreshBusy = true;
    this.renderTab();

    try {
      const result = await showPlacementRewarded('shop-refresh');
      if (result.rewarded) {
        refreshDailyShopRotation();
        audio.play('levelup');
        this.pageIdx = 0;
        track('shop_refreshed', { date: getDailyShopRotation().date });
      } else if (!result.available) {
        this.toast(t('store.refreshUnavailable'));
      }
    } finally {
      this.refreshBusy = false;
      if (this.scene.isActive()) this.renderTab();
    }
  }

  /** Карточка скина: превью-квадрат (fill tint) + имя + состояние справа. */
  private skinRow(def: SkinDef, cy: number, st: MetaState): Phaser.GameObjects.Container {
    const row = this.add.container(this.px, cy);
    const w = this.contentWidth();
    const rowH = 46;
    const bg = this.add.graphics();
    bg.fillStyle(0xfff6df, 0.92).fillRoundedRect(-w / 2, -rowH / 2 + 2, w, rowH - 4, 8);
    bg.lineStyle(2, 0xc9a25e, 1).strokeRoundedRect(-w / 2, -rowH / 2 + 2, w, rowH - 4, 8);
    row.add(bg);

    // Превью: цветной квадрат с рамкой
    const pv = this.add.graphics();
    pv.fillStyle(def.tint, 1).fillRoundedRect(-w / 2 + 12, -14, 28, 28, 6);
    pv.lineStyle(2, 0x3b2410, 1).strokeRoundedRect(-w / 2 + 12, -14, 28, 28, 6);
    row.add(pv);

    const displayName = this.dailyOfferIds.has(def.id) ? `★ ${skinLabel(def)}` : skinLabel(def);
    const name = this.label(-w / 2 + 48, 0, displayName, 12, '#3b2410', 0);
    fitTextWidth(name, w - 180, 12);
    row.add(name);

    const owned = st.skins.owned.includes(def.id);
    const active = owned
      && (def.kind === 'hero' ? st.skins.hero
        : def.kind === 'building' ? st.skins.building : st.skins.trail) === def.id;

    if (active) {
      row.add(this.appliedChip(w / 2 - 54, 0, t('skins.applied')));
    } else if (owned) {
      const btn = makeButton(this, w / 2 - 54, 0, 88, 34, t('skins.apply'), () => {
        if (setActiveSkin(def.kind, def.id)) {
          audio.play('levelup');
          track('skin_equipped', { id: def.id });
          this.renderTab();
        }
      }, 'blue', 11, { hitW: 94, hitH: 42, stopPropagation: true });
      row.add([btn.img, btn.txt, btn.hit]);
      this.contentButtons.push(btn);
    } else if (def.price > 0) {
      if (showcaseVisible()) {
        const btn = makeButton(this, w / 2 - 54, 0, 88, 34, String(def.price), () => {
          this.buySkin(def);
        }, 'blue', 11, { hitW: 94, hitH: 42, stopPropagation: true });
        row.add([btn.img, btn.txt, btn.hit]);
        this.contentButtons.push(btn);
      } else {
        // Витрина скрыта: скин виден, цена — нет (§J.6.4)
        const locked = this.add.text(w / 2 - 12, 0, t('store.locked'), {
          fontFamily: FONT, fontSize: '12px', color: '#8a5b12',
          align: 'right', wordWrap: { width: 130 },
        }).setOrigin(1, 0.5);
        row.add(locked);
      }
    } else {
      // price === 0: скин добывается игрой (пропуск/кодекс/сезон)
      row.add(this.label(w / 2 - 54, 0, '—', 14, '#b0803a'));
    }
    return row;
  }

  /** Карточка знамени: превью-флажок + имя; доступность — ownedBanners(). */
  private bannerRow(def: BannerDef, cy: number, st: MetaState): Phaser.GameObjects.Container {
    const row = this.add.container(this.px, cy);
    const w = this.contentWidth();
    const rowH = 46;
    const bg = this.add.graphics();
    bg.fillStyle(0xfff6df, 0.92).fillRoundedRect(-w / 2, -rowH / 2 + 2, w, rowH - 4, 8);
    bg.lineStyle(2, 0xc9a25e, 1).strokeRoundedRect(-w / 2, -rowH / 2 + 2, w, rowH - 4, 8);
    row.add(bg);

    // Превью: флажок на древке
    const pv = this.add.graphics();
    const bx = -w / 2 + 14;
    pv.lineStyle(3, 0x3b2410, 1).lineBetween(bx, -17, bx, 17);
    pv.fillStyle(def.tint, 1).fillTriangle(bx + 2, -16, bx + 28, -8, bx + 2, 0);
    pv.lineStyle(2, 0x3b2410, 1).strokeTriangle(bx + 2, -16, bx + 28, -8, bx + 2, 0);
    row.add(pv);

    const name = this.label(-w / 2 + 48, 0, bannerLabel(def), 12, '#3b2410', 0);
    fitTextWidth(name, w - 180, 12);
    row.add(name);

    const owned = ownedBanners().includes(def.id);
    const active = owned && st.skins.banner === def.id;
    if (active) {
      row.add(this.appliedChip(w / 2 - 54, 0, t('skins.applied')));
    } else if (owned) {
      const btn = makeButton(this, w / 2 - 54, 0, 88, 34, t('skins.apply'), () => {
        if (setActiveSkin('banner', def.id)) {
          audio.play('levelup');
          track('skin_equipped', { id: def.id });
          this.renderTab();
        }
      }, 'blue', 11, { hitW: 94, hitH: 42, stopPropagation: true });
      row.add([btn.img, btn.txt, btn.hit]);
      this.contentButtons.push(btn);
    } else {
      row.add(this.label(w / 2 - 54, 0, '—', 14, '#b0803a'));
    }
    return row;
  }

  /** Строка «Нет» — сброс активного знамени (setActiveSkin('banner', '')). */
  private bannerResetRow(cy: number, st: MetaState): Phaser.GameObjects.Container {
    const row = this.add.container(this.px, cy);
    const w = this.contentWidth();
    const rowH = 46;
    const bg = this.add.graphics();
    bg.fillStyle(0xfff6df, 0.6).fillRoundedRect(-w / 2, -rowH / 2 + 2, w, rowH - 4, 8);
    bg.lineStyle(1, 0xc9a25e, 0.8).strokeRoundedRect(-w / 2, -rowH / 2 + 2, w, rowH - 4, 8);
    row.add(bg);

    row.add(this.label(-w / 2 + 16, 0, t('skins.none'), 12, '#8a5b12', 0));
    if (st.skins.banner !== '') {
      const btn = makeButton(this, w / 2 - 54, 0, 88, 34, t('skins.none'), () => {
        setActiveSkin('banner', '');
        audio.play('click');
        this.renderTab();
      }, 'red', 11, { hitW: 94, hitH: 42, stopPropagation: true });
      row.add([btn.img, btn.txt, btn.hit]);
      this.contentButtons.push(btn);
    } else {
      row.add(this.label(w / 2 - 54, 0, '—', 14, '#b0803a'));
    }
    return row;
  }

  /** Зелёная плашка «НАДЕТО» — неактивная, без кнопки. */
  private appliedChip(x: number, y: number, label: string): Phaser.GameObjects.Container {
    const c = this.add.container(x, y);
    const g = this.add.graphics();
    g.fillStyle(0x3f9b46, 1).fillRoundedRect(-44, -16, 88, 32, 8);
    g.lineStyle(2, 0x2e7d32, 1).strokeRoundedRect(-44, -16, 88, 32, 8);
    const txt = this.add.text(0, 0, label, {
      fontFamily: FONT, fontSize: '12px', color: '#ffffff',
    }).setOrigin(0.5);
    fitTextWidth(txt, 78, 11, 8);
    c.add([g, txt]);
    return c;
  }

  /** Покупка скина за кроны прямо из витрины (цена — из SKINS). */
  private buySkin(def: SkinDef): void {
    const res = buySkinWithCrowns(def.id);
    if (res.ok) {
      // Купил — сразу надел: витрина не оставляет шаг «а теперь найди НАДЕТЬ»
      setActiveSkin(def.kind, def.id);
      audio.play('levelup');
      track('skin_equipped', { id: def.id });
      this.renderTab();
    } else {
      this.toast(t('store.fail'));
    }
  }

  // ================================================================
  // Вкладка ПРОПУСК: уровень, XP-полоса, премиум и награды +1..+3
  // ================================================================

  private renderPassTab(box: Phaser.GameObjects.Container): void {
    const st = rollMetaDay();
    const cw = this.contentWidth();
    const level = Math.min(PASS.LEVELS, Math.floor(st.pass.xp / PASS.XP_PER_LEVEL));
    const inLvl = level >= PASS.LEVELS
      ? PASS.XP_PER_LEVEL
      : st.pass.xp - level * PASS.XP_PER_LEVEL;

    // На низких панелях вертикальные отступы сжимаются
    const y0 = this.contentTop();
    const tight = this.contentBottom() - y0 < 300;
    const withXpLine = this.contentBottom() - y0 > 230;

    let y = y0 + (tight ? 12 : 16);
    box.add(this.label(this.px, y, t('pass.level', { v: level }), tight ? 14 : 16, '#3b2410'));
    y += tight ? 18 : 24;

    // XP-полоса до следующего уровня
    const barW = Math.min(320, cw - 60);
    const bar = this.add.graphics();
    bar.fillStyle(0x3b2a1a, 1).fillRoundedRect(this.px - barW / 2, y - 6, barW, 12, 6);
    const frac = Phaser.Math.Clamp(inLvl / PASS.XP_PER_LEVEL, 0, 1);
    if (frac > 0) {
      bar.fillStyle(0xd9a520, 1).fillRoundedRect(this.px - barW / 2 + 2, y - 4, Math.max(6, (barW - 4) * frac), 8, 4);
    }
    box.add(bar);
    y += tight ? 15 : 20;

    if (withXpLine) {
      const xpLine = level >= PASS.LEVELS
        ? t('pass.xp', { v: num(st.pass.xp) })
        : `${t('pass.xp', { v: num(st.pass.xp) })} · ${t('pass.nextLevel', { v: PASS.XP_PER_LEVEL - inLvl })}`;
      box.add(this.label(this.px, y, xpLine, 10, '#8a5b12'));
      y += tight ? 14 : 22;
    }

    box.add(this.label(this.px, y, `${t('pass.premium')}: ${st.pass.premium ? t('pass.premiumOn') : t('pass.premiumOff')}`,
      12, st.pass.premium ? '#2e7d32' : '#8a5b12'));
    y += tight ? 18 : 24;

    if (!st.pass.premium) {
      if (showcaseVisible()) {
        const bh = tight ? 40 : 44;
        const buy = makeButton(this, this.px, y + bh / 2, 280, bh, t('store.pass'),
          () => { void this.buySku('pass_chronicle'); }, 'blue', 13, { stopPropagation: true });
        box.add([buy.img, buy.txt, buy.hit]);
        this.contentButtons.push(buy);
        y += bh + (tight ? 8 : 12);
      } else {
        box.add(this.label(this.px, y + 8, t('store.locked'), 12, '#8a5b12'));
        y += tight ? 22 : 30;
      }
    }
    y += tight ? 4 : 8;

    // Награды уровней level+1..+3: бесплатный и премиум треки
    const colLvl = this.px - cw / 2 + 20;
    const colFree = this.px - cw * 0.26;
    const colPrem = this.px + cw * 0.18;
    box.add(this.label(colFree, y, t('pass.free'), 11, '#8a5b12', 0));
    box.add(this.label(colPrem, y, t('pass.premium'), 11, '#9a6a08', 0));
    y += 18;

    const rowStep = tight ? 24 : 28;
    for (let i = 0; i < 3; i++) {
      const lv = level + 1 + i;
      if (lv > PASS.LEVELS) break;
      const rowY = y + 13;
      if (rowY > this.contentBottom() - 6) break; // на очень низких панелях хвост не рисуем
      const g = this.add.graphics();
      g.fillStyle(0xfff6df, 0.92).fillRoundedRect(this.px - cw / 2, rowY - 11, cw, 24, 6);
      g.lineStyle(1, 0xc9a25e, 0.8).strokeRoundedRect(this.px - cw / 2, rowY - 11, cw, 24, 6);
      box.add(g);
      box.add(this.label(colLvl, rowY, String(lv), 11, '#b0803a', 0));
      const freeTxt = this.label(colFree, rowY, rewardLabel(passReward(lv, false)), 11, '#3b2410', 0);
      fitTextWidth(freeTxt, colPrem - colFree - 14, 11);
      box.add(freeTxt);
      const premTxt = this.label(colPrem, rowY, rewardLabel(passReward(lv, true)), 11, '#9a6a08', 0);
      fitTextWidth(premTxt, this.px + cw / 2 - 20 - colPrem, 11);
      box.add(premTxt);
      y += rowStep;
    }
  }

  // ================================================================
  // Вкладка КРОНЫ: полка SKU, конвертация, расходники (§J.6)
  // ================================================================

  private renderCrownsTab(box: Phaser.GameObjects.Container): void {
    const st = rollMetaDay();
    if (!showcaseVisible()) {
      box.add(this.add.text(this.px, (this.contentTop() + this.contentBottom()) / 2, t('store.locked'), {
        fontFamily: FONT, fontSize: '16px', color: '#6b4a1e', align: 'center',
        wordWrap: { width: this.contentWidth() - 40 },
      }).setOrigin(0.5));
      return;
    }

    const cw = this.contentWidth();
    const items: ShopTabItem[] = [];
    if (this.catalogState === 'idle' || this.catalogState === 'loading') {
      items.push({ h: 34, draw: (cy) => {
        const notice = this.label(this.px, cy, t('store.catalogLoading'), 10, '#8a5b12');
        fitTextWidth(notice, cw - 20, 10, 8);
        box.add(notice);
      } });
    } else if (this.catalogState === 'unavailable') {
      items.push({ h: 40, draw: (cy) => {
        const notice = this.label(this.px, cy, t('store.catalogUnavailable'), 10, '#9a4a2a');
        fitTextWidth(notice, cw - 20, 10, 8);
        box.add(notice);
      } });
    } else {
      const fallback = this.catalogState === 'fallback';
      const catalogSkus = fallback
        ? STORE_SKUS.map((sku) => ({ sku, product: undefined as CatalogProduct | undefined }))
        : STORE_SKUS.map((sku) => ({ sku, product: this.catalogProducts.get(sku) }))
          .filter((item): item is { sku: string; product: CatalogProduct } => item.product !== undefined);
      const hasTopUp = fallback || catalogSkus.some(({ sku }) => sku.startsWith('crowns_'));
      if (hasTopUp && !st.purchasedSkus.includes('first_topup')) {
        items.push({ h: 26, draw: (cy) => {
          const g = this.add.graphics();
          g.fillStyle(0xf7e7c3, 1).fillRoundedRect(this.px - 110, cy - 12, 220, 24, 8);
          g.lineStyle(2, 0xd9a520, 1).strokeRoundedRect(this.px - 110, cy - 12, 220, 24, 8);
          box.add(g);
          box.add(this.label(this.px, cy, t('store.firstBonus'), 11, '#7a4e0e'));
        } });
      }
      for (const { sku, product } of catalogSkus) {
        if (sku === 'starter_castellan' && !this.starterCastellanAvailable(st)) continue;
        if (product) items.push({ h: 68, draw: (cy) => box.add(this.catalogSkuRow(product, cy, st, cw)) });
        else items.push({ h: 46, draw: (cy) => box.add(this.skuRow(sku, cy, st, cw)) });
      }
    }

    // Currency conversion and consumables still work if the platform catalogue is unavailable.
    items.push({ h: 46, draw: (cy) => {
      const btn = makeButton(this, this.px, cy, cw - 8, 42,
        t('store.convert', { v: st.crownConvert.count }), () => {
          const res = convertCrownsToGold();
          if (res.ok) {
            audio.play('levelup');
            this.renderTab();
          } else {
            this.toast(res.reason === 'limit' ? t('store.convertLimit') : t('store.fail'));
          }
        }, 'blue', 12, { stopPropagation: true });
      box.add([btn.img, btn.txt, btn.hit]);
      this.contentButtons.push(btn);
    } });

    items.push({ h: 24, hdr: true, draw: (cy) => this.sectionTitle(box, cy, t('consumable.title')) });
    for (const def of CONSUMABLES) {
      items.push({ h: 50, draw: (cy) => box.add(this.consumableRow(def, cy, st, cw)) });
    }
    items.push({ h: 20, draw: (cy) => box.add(this.label(this.px, cy, t('consumable.limit'), 9, '#8a5b12')) });
    this.renderPaged(box, items);
  }

  /** SDK product card: title, description, price and portal currency artwork. */
  private catalogSkuRow(product: CatalogProduct, cy: number, st: MetaState, w: number): Phaser.GameObjects.Container {
    const row = this.add.container(this.px, cy);
    const rowH = 66;
    const bg = this.add.graphics();
    bg.fillStyle(0xfff6df, 0.96).fillRoundedRect(-w / 2, -rowH / 2 + 2, w, rowH - 4, 8);
    bg.lineStyle(2, 0xc9a25e, 1).strokeRoundedRect(-w / 2, -rowH / 2 + 2, w, rowH - 4, 8);
    row.add(bg);

    const sku = product.id;
    const titleText = product.title?.trim() || t(SKU_LABELS[sku] ?? 'store.title');
    const imageKey = product.imageURI ? catalogTextureKey(product.imageURI) : null;
    if (imageKey && this.textures.exists(imageKey)) {
      row.add(this.add.image(-w / 2 + 20, -7, imageKey).setDisplaySize(30, 30));
    } else {
      const placeholder = this.add.graphics();
      placeholder.fillStyle(0xe8d19c, 1).fillRoundedRect(-w / 2 + 5, -23, 30, 32, 6);
      row.add(placeholder);
      row.add(this.label(-w / 2 + 20, -7, titleText.slice(0, 1).toUpperCase(), 13, '#7a4e0e'));
    }

    const title = this.label(-w / 2 + 41, -16, titleText, 11, '#3b2410', 0);
    fitTextWidth(title, Math.max(82, w - 150), 11, 7);
    row.add(title);
    if (product.description?.trim()) {
      const description = this.label(-w / 2 + 41, 1, product.description.trim(), 8, '#8a5b12', 0);
      fitTextWidth(description, Math.max(82, w - 150), 8, 6);
      row.add(description);
    }

    const price = this.label(w / 2 - 14, -14, product.price ?? '—', 10, '#3b2410', 1);
    fitTextWidth(price, 58, 10, 7);
    row.add(price);
    const currencyKey = product.priceCurrencyImage ? catalogTextureKey(product.priceCurrencyImage) : null;
    if (currencyKey && this.textures.exists(currencyKey)) {
      row.add(this.add.image(w / 2 - 80, -14, currencyKey).setDisplaySize(13, 13));
    }

    const sold = (ONE_SHOT_SKUS.includes(sku) && hasIapEntitlement(st, sku))
      || (sku === 'pass_chronicle' && st.pass.premium);
    if (sold) {
      row.add(this.appliedChip(w / 2 - 45, 13, t('store.sold')));
    } else {
      const buy = makeButton(this, w / 2 - 48, 13, 82, 26, t('store.buy'), () => {
        void this.buySku(sku);
      }, 'blue', 9, { hitW: 88, hitH: 34, stopPropagation: true });
      row.add([buy.img, buy.txt, buy.hit]);
      this.contentButtons.push(buy);
    }
    return row;
  }

  /** Витрина крон скрыта до 5-го матча (§J.6.4, гейт 45) — только подпись.
   *  Окно starter_castellan: 48ч после первой победы и не куплен (§J.6.2). */
  private starterCastellanAvailable(st: MetaState): boolean {
    if (st.purchasedSkus.includes('starter_castellan')) return false;
    return st.firstWinAt > 0 && Date.now() - st.firstWinAt < 48 * 3600 * 1000;
  }

  /** Строка полки SKU: имя + цена-примечание (note) в кнопке / «Куплено». */
  private skuRow(sku: string, cy: number, st: MetaState, w: number): Phaser.GameObjects.Container {
    const row = this.add.container(this.px, cy);
    const rowH = 46;
    const bg = this.add.graphics();
    bg.fillStyle(0xfff6df, 0.92).fillRoundedRect(-w / 2, -rowH / 2 + 2, w, rowH - 4, 8);
    bg.lineStyle(2, 0xc9a25e, 1).strokeRoundedRect(-w / 2, -rowH / 2 + 2, w, rowH - 4, 8);
    row.add(bg);

    const note = SKUS[sku]?.note ?? '';
    const oneShot = ONE_SHOT_SKUS.includes(sku);
    const bought = st.purchasedSkus.includes(sku);
    const sold = (oneShot && bought) || (sku === 'pass_chronicle' && st.pass.premium);

    // Для купленных one-shot справа ещё и note — имя ужмём сильнее
    const name = this.label(-w / 2 + 14, 0, t(SKU_LABELS[sku] ?? 'store.title'), 12, '#3b2410', 0);
    fitTextWidth(name, sold ? w - 240 : w - 130, 12);
    row.add(name);

    if (sold) {
      if (note) {
        const noteTxt = this.label(w / 2 - 106, 0, note, 10, '#8a5b12', 1);
        fitTextWidth(noteTxt, 110, 10, 7);
        row.add(noteTxt);
      }
      row.add(this.appliedChip(w / 2 - 54, 0, t('store.sold')));
    } else {
      const btn = makeButton(this, w / 2 - 54, 0, 88, 34, note, () => {
        void this.buySku(sku);
      }, 'blue', 10, { hitW: 94, hitH: 42, stopPropagation: true });
      row.add([btn.img, btn.txt, btn.hit]);
      this.contentButtons.push(btn);
    }
    return row;
  }

  /** Строка расходника: имя+описание, запас, покупка за кроны / за ролик. */
  private consumableRow(def: ConsumableDef, cy: number, st: MetaState, w: number): Phaser.GameObjects.Container {
    const row = this.add.container(this.px, cy);
    const rowH = 50;
    const bg = this.add.graphics();
    bg.fillStyle(0xfff6df, 0.92).fillRoundedRect(-w / 2, -rowH / 2 + 2, w, rowH - 4, 8);
    bg.lineStyle(2, 0xc9a25e, 1).strokeRoundedRect(-w / 2, -rowH / 2 + 2, w, rowH - 4, 8);
    row.add(bg);

    const stock = st.consumables[def.id];
    const dense = w < 460;
    const nameMax = w - (def.forAd ? (dense ? 250 : 290) : (dense ? 170 : 210));

    const name = this.label(-w / 2 + 14, -10, t(def.nameKey as TranslationKey), 12, '#3b2410', 0);
    fitTextWidth(name, nameMax, 12);
    row.add(name);
    const desc = this.label(-w / 2 + 14, 9, t(def.descKey as TranslationKey), dense ? 11 : 12, '#8a5b12', 0);
    fitTextWidth(desc, nameMax, dense ? 11 : 12, 7);
    row.add(desc);

    const pickW = dense ? 108 : 128;
    const adW = 72;
    let pickX: number;
    let stockX: number;
    if (def.forAd) {
      const adX = -w / 2 + w - 12 - adW / 2;
      pickX = adX - adW / 2 - 8 - pickW / 2;
      stockX = pickX - pickW / 2 - 10;
      const adBtn = makeButton(this, adX, 0, adW, 34, t('consumable.ad'), () => {
        void this.rewardConsumable();
      }, 'blue', 10, {
        disabled: !placementAvailable('consumable'), hitW: adW + 6, hitH: 42, stopPropagation: true,
      });
      row.add([adBtn.img, adBtn.txt, adBtn.hit]);
      this.contentButtons.push(adBtn);
    } else {
      pickX = -w / 2 + w - 12 - pickW / 2;
      stockX = pickX - pickW / 2 - 10;
    }

    const pickBtn = makeButton(this, pickX, 0, pickW, 34, t('consumable.pick', { v: def.price }), () => {
      void this.buySku(def.id);
    }, 'blue', 10, { hitW: pickW + 6, hitH: 42, stopPropagation: true });
    row.add([pickBtn.img, pickBtn.txt, pickBtn.hit]);
    this.contentButtons.push(pickBtn);

    const stockTxt = this.label(stockX, 0, stock > 0 ? `×${stock}` : t('consumable.out'), 11,
      stock > 0 ? '#2e7d32' : '#b0803a', 1);
    row.add(stockTxt);
    return row;
  }

  /** Покупка SKU с защитой от двойного клика и перерисовкой после начисления. */
  private async buySku(sku: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const res = await purchaseSku(sku);
      if (!this.scene.isActive()) return;
      if (res.ok) {
        audio.play('levelup');
        this.renderTab();
      } else {
        this.toast(t('store.fail'));
      }
    } finally {
      this.busy = false;
    }
  }

  /** «Подкова удачи» за rewarded-ролик: +1 в запас (R12, лимит 1/день). */
  private async rewardConsumable(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const res = await showPlacementRewarded('consumable');
      if (!this.scene.isActive()) return;
      if (res.rewarded) {
        const st = rollMetaDay();
        st.consumables.cs_horseshoe += 1;
        saveMetaState(st);
        audio.play('levelup');
        this.renderTab();
      }
    } finally {
      this.busy = false;
    }
  }

  // ================================================================
  // Вспомогательное
  // ================================================================

  /** Всплывающее сообщение об ошибке (гаснет само). */
  private toast(msg: string): void {
    this.toastText?.destroy();
    const txt = this.add.text(this.px, this.contentBottom() - 16, msg, {
      fontFamily: FONT, fontSize: '13px', color: '#ffd76e',
      stroke: '#3b2410', strokeThickness: 4, align: 'center',
      wordWrap: { width: this.contentWidth() },
    }).setOrigin(0.5).setDepth(200).setScrollFactor(0);
    this.toastText = txt;
    this.tweens.add({
      targets: txt, alpha: 0, delay: 1600, duration: 450,
      onComplete: () => {
        txt.destroy();
        if (this.toastText === txt) this.toastText = null;
      },
    });
  }
}
