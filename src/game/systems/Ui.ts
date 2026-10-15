import Phaser from 'phaser';
import { FONT } from '../constants';
import { CURSOR_DATA } from './Cursor';
import { audio } from './Audio';

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

/** Панель (бумага/баннер/стол) на NineSlice */
export function makePanel(
  scene: Phaser.Scene, x: number, y: number, kind: NineKey, w: number, h: number,
): Phaser.GameObjects.NineSlice {
  const cfg = fitSlices(NINE_SLICE[kind], w, h);
  return scene.add.nineslice(
    x, y, cfg.key, undefined, w, h, cfg.left, cfg.right, cfg.top, cfg.bottom,
    true, true,
  );
}

/**
 * Подгоняет текст под ширину кнопки. Иначе длинный текст вылезает за
 * девятислайс: русское «СОХРАНИТЬ РЕКОРД» шире английского «SAVE SCORE»
 * и в кнопку 260 px не влезало. Уменьшаем кегль, а не масштаб — так
 * сохраняется читаемая пиксельная сетка.
 */
function fitWidth(
  txt: Phaser.GameObjects.Text,
  maxW: number,
  fontSize: number,
  minSize = 9,
): void {
  if (txt.width <= maxW || txt.width === 0) return;
  const fitted = Math.max(minSize, Math.floor(fontSize * (maxW / txt.width)));
  if (fitted < fontSize) {
    txt.setStyle({ fontSize: `${fitted}px`, strokeThickness: Math.max(3, fitted / 4) });
  }
  // Крайний случай: даже минимальный кегль не влезает — сжимаем по ширине
  if (txt.width > maxW) txt.setScale(maxW / txt.width);
}

/**
 * Подгоняет готовый Phaser-текст под ширину: уменьшает кегль, а если не
 * помогло — сжимает по ширине. Нужен там, где подпись нельзя обрезать
 * (имена в таблице рекордов, названия достижений), но и не влезает.
 */
export function fitTextWidth(
  txt: Phaser.GameObjects.Text,
  maxW: number,
  fontSize: number,
  minSize = 8,
): void {
  fitWidth(txt, maxW, fontSize, minSize);
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
 * Собрана скриптом scripts/make-ribbons.mjs из ui/ribbons/bigribbons.png.
 */
export function makeRibbon(
  scene: Phaser.Scene,
  x: number,
  y: number,
  width: number,
  key: 'ribbon-blue' | 'ribbon-yellow' | 'ribbon-purple' | 'ribbon-red',
  height = 60,
): Phaser.GameObjects.NineSlice {
  const src = scene.textures.get(key).getSourceImage() as HTMLImageElement;
  // Слайс не может превышать половину элемента: иначе углы NineSlice
  // рисуются в натуральную величину и вылезают за его границы.
  const tail = Math.max(
    2,
    Math.min(Math.round(src.width * 0.4), Math.floor(width / 2), Math.floor(height / 2)),
  );
  return scene.add.nineslice(x, y, key, undefined, width, height, tail, tail, tail, tail);
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
    strokeThickness: Math.max(4, fontSize / 4),
  }).setOrigin(0.5);

  fitWidth(txt, w - 28, fontSize);

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
      fitWidth(txt, w - 28, fontSize);
      // fitWidth мог сжать подпись по ширине — база пересчитывается, и
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