import Phaser from 'phaser';
import { FONT } from '../constants';
import { CURSOR_DATA } from './Cursor';
import { audio } from './Audio';
import { fitTextWidth as fitWidthText, shrinkToHeight, FS } from './Text';

// ============ Фабрика UI-элементов на NineSlice ============
// Ассеты Tiny Swords — 9-тайловые сетки, склеенные в бесшовные текстуры
// скриптом scripts/prepare-assets.mjs.

export const NINE_SLICE = {
  paper: { key: 'paper9', left: 52, right: 52, top: 44, bottom: 45 },
  paperSpecial: { key: 'paper-special9', left: 55, right: 55, top: 44, bottom: 43 },
  btnBlue: { key: 'btn-blue9', left: 45, right: 45, top: 47, bottom: 47 },
  btnRed: { key: 'btn-red9', left: 45, right: 45, top: 47, bottom: 47 },
  banner: { key: 'banner9', left: 100, right: 84, top: 68, bottom: 111 },
  table: { key: 'table9', left: 84, right: 84, top: 85, bottom: 103 },
} as const;

/**
 * Состояния кнопок. Раньше их не было вовсе — кнопка реагировала только на
 * наведение и выглядела «мёртвой»: нажатие не давало никакого отклика.
 * Теперь у нас настоящая отдача: обычное, наведение, нажатое, недоступное.
 */
export const BUTTON_STATES: Record<
  'blue' | 'red',
  { normal: Slices; pressed: Slices }
> = {
  blue: {
    normal: { key: 'btn-blue9', left: 45, right: 45, top: 47, bottom: 47 },
    pressed: { key: 'btn-blue9-pressed', left: 50, right: 50, top: 36, bottom: 49 },
  },
  red: {
    normal: { key: 'btn-red9', left: 45, right: 45, top: 47, bottom: 47 },
    pressed: { key: 'btn-red9-pressed', left: 50, right: 50, top: 36, bottom: 49 },
  },
};

export type NineKey = keyof typeof NINE_SLICE;

export interface ChipOpts {
  /** Цвет основной подписи. */
  color?: string;
  /** Цвет второй строки. */
  subColor?: string;
  /** Кегль основной подписи. */
  fontSize?: number;
  /** Кегль второй строки. */
  subFontSize?: number;
  /** Вторая строка (мелкая подпись под основной). */
  sub?: string;
  /** Чип выключен: подпись приглушена, клик не срабатывает. */
  disabled?: boolean;
  /** Прозрачность выключенного чипа. */
  disabledAlpha?: number;
}

export interface Chip {
  container: Phaser.GameObjects.Container;
  /** Основная подпись. */
  setLabel(text: string): void;
  /** Вторая строка. */
  setSub(text: string): void;
  /** Включает/выключает чип (серый + без клика). */
  setEnabled(on: boolean): void;
  destroy(): void;
}

/**
 * Плашка-чип на настоящем ассете ui/papers.
 *
 * Раньше такие плашки рисовались кодом (Graphics + fillRoundedRect) — они
 * выглядели как чужеродные скруглённые прямоугольники среди пергаментных
 * панелей. Теперь это тот же nine-slice пергамента, что и карточки
 * героя: единый стиль на всех экранах.
 */
export function makeChip(
  scene: Phaser.Scene,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  opts: ChipOpts = {},
): Chip {
  const container = scene.add.container(x, y);
  const paper = makePanel(scene, 0, 0, 'paper', w, h);
  container.add(paper);

  const fontSize = opts.fontSize ?? FS.small;
  const subFontSize = opts.subFontSize ?? FS.micro;
  const hasSub = opts.sub !== undefined;
  // Подпись может занять две строки — тогда она центрируется по вертикали,
  // а кегль ужимается, чтобы текст не вылез за пергамент.
  //
  // Резерв по высоте берётся от краёв плашки (минус 6 px на поля), а не
  // «высота минус 8»: у чипа пре-рана подпись вроде «Откроется после
  // 3 го матча» переносилась на вторую строку и вылезала за верхний край.
  const mainRoom = hasSub ? h * 0.52 : h - 12;
  const main = scene.add.text(0, hasSub ? -h * 0.17 : 0, label, {
    fontFamily: FONT,
    fontSize: `${fontSize}px`,
    color: opts.color ?? '#3b2410',
    align: 'center',
    wordWrap: { width: w - 16 },
  }).setOrigin(0.5);
  shrinkToHeight(main, mainRoom, fontSize);
  container.add(main);

  let sub: Phaser.GameObjects.Text | null = null;
  if (hasSub) {
    sub = scene.add.text(0, h * 0.22, opts.sub ?? '', {
      fontFamily: FONT,
      fontSize: `${subFontSize}px`,
      color: opts.subColor ?? '#8a5b12',
      align: 'center',
      wordWrap: { width: w - 14 },
    }).setOrigin(0.5);
    shrinkToHeight(sub, h * 0.3, subFontSize);
    container.add(sub);
  }

  let enabled = !opts.disabled;
  const apply = (): void => {
    // Недоступный чип гаснет тёплым коричневым, а не холодным серым.
    // Серый #8d8577 на кремовой бумаге при 72 % прозрачности выглядел как
    // выцветшая надпись: подпись «После 10 го матча» и «Откроется после
    // 3 го матча» на телефоне было не прочитать — а именно они объясняют,
    // почему функция недоступна.
    const alpha = enabled ? 1 : (opts.disabledAlpha ?? 0.82);
    paper.setAlpha(alpha);
    main.setAlpha(alpha);
    sub?.setAlpha(alpha);
    main.setColor(enabled ? (opts.color ?? '#3b2410') : '#9a8460');
  };
  apply();

  return {
    container,
    setLabel(text: string): void {
      main.setText(text);
      shrinkToHeight(main, mainRoom, fontSize);
    },
    setSub(text: string): void {
      sub?.setText(text);
      if (sub) shrinkToHeight(sub, h * 0.3, subFontSize);
    },
    setEnabled(on: boolean): void {
      enabled = on;
      apply();
    },
    destroy(): void {
      container.destroy(true);
    },
  };
}

export interface Slices {
  key: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Подгоняет слайсы под размер элемента.
 *
 * У девятислайса торцы складываются: у кнопки это 45+45 px по ширине и
 * 47+47 px по высоте, то есть 94 px. Кнопка 92×34 физически не вмещает столько
 * — Phaser рисует верхний торец, вырожденную середину и нижний, и торцы
 * наезжают друг на друга (видимо как «синий брусок с белой шапкой»).
 * Поэтому каждый торец ограничиваем половиной доступного места.
 */
function fitSlices(cfg: Slices, w: number, h: number): Slices {
  const halfW = Math.floor(w / 2);
  const halfH = Math.floor(h / 2);
  return {
    key: cfg.key,
    left: Math.min(cfg.left, halfW),
    right: Math.min(cfg.right, halfW),
    top: Math.min(cfg.top, halfH),
    bottom: Math.min(cfg.bottom, halfH),
  };
}

/**
 * Минимальная высота, на которой пергамент ещё читается как пергамент.
 *
 * Срезы по вертикали — 44 и 45 px, всего 89. Ниже этого Phaser рисует
 * верхний торец и нижний торец, а «пустоты» между ними не остаётся: лента
 * событий в HUD превращалась в тёмную полосу из двух рамок без бумаги
 * между ними. Поэтому низкие элементы рисуются в натуральную высоту и
 * просто сжимаются по вертикали — получается ровная пергаментная лента
 * с тонкой тёмной каймой.
 */
const PAPER_MIN_H = 96;

/** Панель (пергамент/лента/стол) на NineSlice. */
export function makePanel(
  scene: Phaser.Scene, x: number, y: number, kind: NineKey, w: number, h: number,
): Phaser.GameObjects.NineSlice {
  // Низкие панели (лента событий, плашка тоста) рисуем в натуральную высоту
  // и сжимаем: срезы остаются родными, а лента не выглядит пустой рамкой.
  const cfg = fitSlices(NINE_SLICE[kind], w, Math.max(h, PAPER_MIN_H));
  const panel = scene.add.nineslice(
    x, y, cfg.key, undefined, w, Math.max(h, PAPER_MIN_H), cfg.left, cfg.right, cfg.top, cfg.bottom,
    true, true,
  );
  if (h < PAPER_MIN_H) panel.setDisplaySize(w, h);
  return panel;
}

/** Соответствие «текстура девятислайса → его слайсы». */
const SLICES_BY_TEXTURE: Record<string, Slices> = Object.fromEntries(
  Object.values(NINE_SLICE).map((s) => [s.key, s]),
);

/**
 * Меняет размер панели, пересчитав слайсы под новый размер.
 *
 * У Phaser NineSlice.setSize меняет только габариты, но не слайсы — панель
 * после ресайза оставалась бы со старыми срезами и «схлопывалась».
 */
export function resizePanel(
  panel: Phaser.GameObjects.NineSlice, w: number, h: number,
): void {
  const base = SLICES_BY_TEXTURE[panel.texture.key] ?? NINE_SLICE.paper;
  const drawH = Math.max(h, PAPER_MIN_H);
  const cfg = fitSlices(base, w, drawH);
  panel.setSlices(w, drawH, cfg.left, cfg.right, cfg.top, cfg.bottom);
  panel.setDisplaySize(w, h);
}

/**
 * Подгоняет готовый Phaser-текст под ширину: уменьшает кегль, а если не
 * помогло — сжимает по ширине. Нужен там, где подпись нельзя обрезать
 * (имена в таблице рекордов, названия достижений), но и не влезает.
 *
 * Реализация вынесена в systems/Text.ts: правила подгонки должны быть
 * одни и те же для всех экранов.
 */
export function fitTextWidth(
  txt: Phaser.GameObjects.Text,
  maxW: number,
  fontSize: number,
  minSize: number = FS.micro,
): void {
  fitWidthText(txt, maxW, fontSize, minSize);
}

/**
 * Слой модального окна.
 *
 * Оверлеи (пауза, левел-ап, итоги матча) запускаются ПОВЕРХ игровой сцены,
 * у которой HUD лежит на глубине DEPTH.HUD (9000). Затемнение же создавалось
 * через `this.add.rectangle` без глубины — то есть на нулевой, под миром и
 * под HUD. Результат: затемнение гасило только землю, а счётчики, полоса
 * опыта, иконки оружия и лента событий светились поверх «паузы» и поверх
 * затемнения левел-апа. Слой собирает содержимое окна в контейнер выше HUD
 * и держит правильный порядок.
 *
 * Координаты остаются экранными: контейнер в нуле, `scrollFactor(0)`.
 */
export class OverlayLayer {
  readonly container: Phaser.GameObjects.Container;
  private scene: Phaser.Scene;

  constructor(scene: Phaser.Scene, depth: number) {
    this.scene = scene;
    this.container = scene.add.container(0, 0).setScrollFactor(0).setDepth(depth);
  }

  /**
   * Кладёт объект в слой и возвращает ЕГО, а не контейнер.
   *
   * В Phaser 4 `Container.add()` возвращает сам контейнер (ради цепочек
   * вида `container.add(a).add(b)`), поэтому возвращаемое значение
   * приходится отдавать вручную — иначе вызывающий код получает не текст,
   * а контейнер, и `.setOrigin()` уезжает на сам слой.
   */
  add<T extends Phaser.GameObjects.GameObject>(obj: T): T {
    this.container.add(obj);
    return obj;
  }

  /** Несколько объектов разом; наружу отдаётся контейнер для цепочек. */
  addAll(objects: Phaser.GameObjects.GameObject[]): this {
    this.container.add(objects);
    return this;
  }

  text(x: number, y: number, content: string | string[], style?: Phaser.Types.GameObjects.Text.TextStyle): Phaser.GameObjects.Text {
    return this.add(this.scene.add.text(x, y, content, style));
  }

  rectangle(x: number, y: number, w: number, h: number, color?: number, alpha?: number): Phaser.GameObjects.Rectangle {
    return this.add(this.scene.add.rectangle(x, y, w, h, color, alpha));
  }

  zone(x: number, y: number, w: number, h: number): Phaser.GameObjects.Zone {
    return this.add(this.scene.add.zone(x, y, w, h));
  }

  group(x: number, y: number): Phaser.GameObjects.Container {
    return this.add(this.scene.add.container(x, y));
  }

  image(x: number, y: number, key: string): Phaser.GameObjects.Image {
    return this.add(this.scene.add.image(x, y, key));
  }

  graphics(): Phaser.GameObjects.Graphics {
    return this.add(this.scene.add.graphics());
  }

  destroy(): void {
    this.container.destroy(true);
  }
}

export interface ButtonOpts {
  /** Недоступна для нажатия: тускнеет и не реагирует. */
  disabled?: boolean;
  /** Начальное состояние наведения (для кнопок под курсором). */
  focused?: boolean;
  /** Прозрачность для недоступной кнопки. */
  disabledAlpha?: number;
  /** Размер хит-зоны. По умолчанию чуть больше самой кнопки. */
  hitW?: number;
  hitH?: number;
  /** Поглощать ли событие, чтобы не сработало и на родителе (строке лавки). */
  stopPropagation?: boolean;
}

export interface Button {
  img: Phaser.GameObjects.NineSlice;
  txt: Phaser.GameObjects.Text;
  hit: Phaser.GameObjects.Zone;
  /** Блокирует повторные нажатия во время анимации. */
  setEnabled(on: boolean): void;
  setLabel(text: string): void;
  destroy(): void;
}

/**
 * Кнопка на NineSlice с полным набором состояний.
 *
 * Раньше здесь был единственный NineSlice и твин на `pointerover`. Теперь:
 * наведение — подъём и золотистый оттенок, нажатие — смена текстуры на
 * «утопленную» и короткое смещение вниз, недоступность — приглушение.
 */
/**
 * Лента-заголовок: растягивается по ширине, но только за счёт середины —
 * хвосты остаются натуральной ширины и не растягиваются.
 *
 * Собрана скриптом scripts/make-ribbons.mjs из ui/ribbons/bigribbons.png:
 * 98 | 48 | 97 — левый хвост, середина, правый хвост.
 *
 * Раньше лента собиралась nine-slice'ом, и это было неверно: Phaser рисует
 * углы девятислайса в натуральную величину, а хвосты ленты содержат
 * изгибы — лента «разъезжалась» и выглядела смятой. Теперь это три
 * картинки: хвосты масштабируются пропорционально высоте, тянется только
 * середина.
 */
export const RIBBON_SRC = { w: 243, h: 128, tailL: 98, mid: 48, tailR: 97 } as const;

export function makeRibbon(
  scene: Phaser.Scene,
  x: number,
  y: number,
  width: number,
  key: 'ribbon-blue' | 'ribbon-yellow' | 'ribbon-purple' | 'ribbon-red',
  height = 60,
): Phaser.GameObjects.Container {
  const k = height / RIBBON_SRC.h;
  const lw = Math.round(RIBBON_SRC.tailL * k);
  const rw = Math.round(RIBBON_SRC.tailR * k);
  const midW = Math.max(8, width - lw - rw);
  const box = scene.add.container(x, y);
  box.add([
    scene.add.image(-width / 2 + lw / 2, 0, key, 'ribbon-l').setDisplaySize(lw, height),
    scene.add.image(0, 0, key, 'ribbon-m').setDisplaySize(midW, height),
    scene.add.image(width / 2 - rw / 2, 0, key, 'ribbon-r').setDisplaySize(rw, height),
  ]);
  return box;
}

export function makeButton(
  scene: Phaser.Scene,
  x: number, y: number,
  w: number, h: number,
  label: string,
  onClick: () => void,
  variant: 'blue' | 'red' = 'blue',
  fontSize = 20,
  opts: ButtonOpts = {},
): Button {
  const states = BUTTON_STATES[variant];

  const normal = fitSlices(states.normal, w, h);
  const pressed = fitSlices(states.pressed, w, h);
  const img = scene.add.nineslice(
    x, y, normal.key, undefined, w, h,
    normal.left, normal.right, normal.top, normal.bottom,
  );

  const txt = scene.add.text(x, y, label, {
    fontFamily: FONT,
    fontSize: `${fontSize}px`,
    color: '#ffffff',
    stroke: '#2a1608',
    strokeThickness: Math.max(4, Math.round(fontSize / 4)),
  }).setOrigin(0.5);

  // Подпись не должна вылезать за девятислайс: русское «СОХРАНИТЬ РЕКОРД»
  // шире английского «SAVE SCORE» и в кнопку 260 px не влезало. Уменьшаем
  // кегль, а не масштаб — так сохраняется читаемая пиксельная сетка.
  fitWidthText(txt, w - 28, fontSize);

  const hit = scene.add
    .zone(x, y, opts.hitW ?? w + 36, opts.hitH ?? h + 30)
    .setInteractive({ useHandCursor: true });

  let enabled = !opts.disabled;
  let hovering = false;
  let holding = false;
  const idleAlpha = 1;
  const offAlpha = opts.disabledAlpha ?? 0.55;

  const applyVisual = (): void => {
    const state = holding && enabled ? pressed : normal;
    // Меняем текстуру только когда она реально отличается — иначе лишний
    // вызов setTexture на каждый кадр анимации
    if (img.texture.key !== state.key) {
      img.setTexture(state.key);
      // ВАЖНО: setSlices в Phaser 4 начинается с размеров — (ширина,
      // высота, лево, право, верх, низ). Если передать слайсы на их месте,
      // девятислайс схлопывается в квадрат 45×45 и остаётся таким после
      // отпускания кнопки.
      img.setSlices(w, h, state.left, state.right, state.top, state.bottom);
    }
    img.setAlpha(enabled ? idleAlpha : offAlpha);
    txt.setAlpha(enabled ? idleAlpha : offAlpha);
    if (hit.input) hit.input.cursor = enabled ? 'pointer' : 'default';
    // Помечаем для Cursor: над заблокированной кнопкой показывается
    // знак запрета, а не «рука», обещающая нажатие.
    hit.setData(CURSOR_DATA, enabled ? undefined : 'disabled');

    // «Утопленная» кнопка визуально садится на пару пикселей
    const sink = holding && enabled ? 3 : 0;
    const lift = hovering && enabled && !holding ? -2 : 0;
    img.setY(y + sink + lift);
    txt.setY(y + sink + lift);
    hit.setY(y + sink + lift);

    if (!enabled) img.clearTint();
  };

  // Подпись, не влезшая по кеглю, сжимается по ширине (см. fitWidth), и её
  // масштаб перестаёт быть единицей. Поэтому твины умножают базовый масштаб
  // каждого объекта, а не задают абсолютный, — иначе после первого наведения
  // подпись вылезла бы из кнопки. Старый твин убивается: два твина на одном
  // свойстве в Phaser не отменяют друг друга, и кнопка застревала на
  // промежуточном масштабе после быстрого клика.
  const baseImg = { x: img.scaleX, y: img.scaleY };
  const baseTxt = { x: txt.scaleX, y: txt.scaleY };
  const tweenScale = (factor: number, duration = 110): void => {
    scene.tweens.killTweensOf([img, txt]);
    scene.tweens.add({
      targets: [img, txt],
      scaleX: [baseImg.x * factor, baseTxt.x * factor],
      scaleY: [baseImg.y * factor, baseTxt.y * factor],
      duration,
      ease: 'Back.easeOut',
    });
  };

  hit.on('pointerover', () => {
    if (!enabled) return;
    hovering = true;
    tweenScale(1.06);
    img.setTint(0xfff2cc);
    applyVisual();
  });

  hit.on('pointerout', () => {
    hovering = false;
    holding = false;
    tweenScale(1);
    img.clearTint();
    applyVisual();
  });

  hit.on('pointerdown', () => {
    if (!enabled) return;
    holding = true;
    tweenScale(0.97, 70);
    applyVisual();
  });

  hit.on('pointerup', (pointer?: Phaser.Input.Pointer) => {
    const wasHolding = holding;
    holding = false;
    tweenScale(hovering ? 1.06 : 1, 120);
    applyVisual();
    if (!wasHolding || !enabled) return;
    // Клик по кнопке внутри строки лавки не должен доходить до родителя.
    // Первым аргументом Phaser отдаёт свой Pointer, а DOM-событие лежит в
    // pointer.event — раньше здесь стоял stopPropagation на самом Pointer,
    // которого там нет, и вызов молча ничего не делал.
    if (opts.stopPropagation) pointer?.event?.stopPropagation?.();
    audio.play('click');
    onClick();
  });

  // Нажали на кнопку и отпустили за пределами окна (или вкладки): Phaser
  // объекту pointerup не присылает, и без этого кнопка навсегда осталась бы
  // «утопленной» — с нажатой текстурой и на 3 px ниже.
  const onUpOutside = (): void => {
    if (!holding) return;
    holding = false;
    hovering = false;
    tweenScale(1);
    img.clearTint();
    applyVisual();
  };
  scene.input.on(Phaser.Input.Events.POINTER_UP_OUTSIDE, onUpOutside);

  if (opts.focused) {
    hovering = true;
    img.setTint(0xfff2cc);
  }
  applyVisual();

  const api: Button = {
    img,
    txt,
    hit,
    setEnabled(on: boolean): void {
      enabled = on;
      if (!on) {
        hovering = false;
        holding = false;
        img.clearTint();
      }
      applyVisual();
    },
    setLabel(text: string): void {
      txt.setText(text);
      fitWidthText(txt, w - 28, fontSize);
      // fitTextWidth мог сжать подпись по ширине — база пересчитывается, и
      // текущее состояние (наведение/нажатие) возвращается на новый масштаб
      baseTxt.x = txt.scaleX;
      baseTxt.y = txt.scaleY;
      tweenScale(holding ? 0.97 : hovering ? 1.06 : 1, 0);
    },
    destroy(): void {
      scene.input.off(Phaser.Input.Events.POINTER_UP_OUTSIDE, onUpOutside);
      scene.tweens.killTweensOf([img, txt]);
      img.destroy();
      txt.destroy();
      hit.destroy();
    },
  };

  return api;
}