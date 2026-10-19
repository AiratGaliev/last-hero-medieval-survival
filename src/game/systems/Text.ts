import Phaser from 'phaser';
import { FONT } from '../constants';

// ============ Типографика игры ============
//
// Три причины, по которым текст читался плохо — и три лечения:
//
// 1. ШРИФТ ГРУЗИЛСЯ НЕ ПОЛНОСТЬЮ. @font-face нарезан на три подмножества
//    (латиница, кириллица, латиница-расширение). Вызов
//    document.fonts.load('16px "Pixelify Sans"') без текста подгружает только
//    то подмножество, в которое попал пробел, — то есть латиницу.
//    Кириллица оставалась в статусе 'unloaded', и браузер подставлял
//    системный моноширинный шрифт. Phaser мерял строки системным шрифтом,
//    а рисовал уже пиксельным: подписи вылезали за кнопки и панели,
//    логотип не влезал в экран.
//
// 2. ДРОБНЫЙ КЕГЛЬ. Шрифт пиксельный: глифы живут на целой пиксельной
//    сетке, и кегль 13.5 px (или зум камеры 0.848 на телефоне) эту сетку
//    ломает — буквы рассыпаются в кашу. Поэтому кегль округляется до
//    целого, а сам текст растеризуется вдвое крупнее (resolution = 2) и
//    уменьшается фильтром Nearest: получаются честные пиксельные глифы
//    вместо размытого антиалиасинга.
//
// 3. РАЗНЫЕ ШРИФТЫ В РАЗНЫХ МЕСТАХ. В подсказках был 'monospace', над
//    пешками — 'sans-serif'. Теперь подставляется один шрифт игры везде.
//
// Модуль работает как патч фабрики Phaser: правила применяются ко ВСЕМ
// текстовым объектам игры, включая те, что создаются в будущем, — не надо
// помнить про них при каждом new-тексте.

/**
 * Множитель растеризации текста.
 *
 * Текст рисуется в канве в N раз крупнее логического размера, а шейдер
 * уменьшает его обратно фильтром Nearest (игра работает в pixelArt-режиме).
 * Без этого подписи «плывут» при дробном зуме камеры.
 */
export const TEXT_RESOLUTION = 2;

/**
 * Типографическая шкала игры: кегли в логических пикселях.
 *
 * Числа подобраны так, чтобы на телефоне (где камера меню уменьшена
 * примерно до 0.85) самый мелкий кегль оставался читаемым.
 */
export const FS = {
  /** Подписи под иконками, сноски. Ниже 11 px на телефоне не читается. */
  micro: 11,
  /** Второстепенный текст: теги, описания. */
  small: 12,
  /** Основной текст: описания карточек, строки списков. */
  body: 14,
  /** Заголовки блоков и подписи кнопок. */
  lead: 16,
  /** Заголовки экранов. */
  title: 20,
  /** Крупные заголовки поверх пергамента. */
  display: 26,
  /** Логотип игры. */
  hero: 34,
} as const;

/** Минимальный кегль в игре: ниже текст нечитаем на телефоне. */
export const MIN_FONT = FS.micro;

/**
 * Абсолютный нижний порог кегля.
 *
 * Применяется ко всем текстовым объектам игры: 8–9 px на телефоне не
 * разобрать, а такие кегли в коде ещё оставались (уровень оружия на
 * иконке, подписи в лавке). Порог ниже «мелкого», но всё же гарантирует,
 * что ни один элемент интерфейса не превратится в пыль.
 */
export const FONT_FLOOR = 10;

/**
 * Толщина обводки под заданный кегль.
 *
 * Обводка держит подпись читаемой на пёстром фоне, но у толстого контура
 * есть предел: у счётчика серии «×14» кегль 20 px и обводка 6 — контур
 * съедал глифы, и цифра читалась как тёмно-красное пятно. Правило «кегль/4»
 * работает только до ~16 px; дальше контур обязан быть тоньше.
 */
export function outlineFor(fontSize: number): number {
  return Math.max(3, Math.round(fontSize / 5));
}

/** Стиль текста, приведённый к правилам игры. */
export type TextStyle = Phaser.Types.GameObjects.Text.TextStyle;

/**
 * Приводит стиль текста к правилам игры: шрифт игры, целый кегль,
 * двойная растеризация.
 *
 * Явно заданные вызывающим кодом поля (`fontFamily`, `resolution`)
 * сохраняются — так остаётся возможность точечно отступить от правил.
 */
export function normalizeTextStyle(style?: TextStyle): TextStyle {
  const out: TextStyle = { ...(style ?? {}) };

  if (!out.fontFamily) out.fontFamily = FONT;
  // ВАЖНО: нельзя добавлять ключ 'font' со значением undefined. Phaser
  // проверяет его через GetValue, который возвращает undefined для
  // СОБСТВЕННОГО свойства — и вызывает setFont(undefined), а тот сбрасывает
  // кегль на 16px. Все надписи в игре стали бы одного размера.

  // Кегль — всегда целое число пикселей: пиксельная сетка шрифта не
  // выдерживает дробей (см. преамбулу модуля). Ниже порога читаемости
  // кегль не опускается: мелкий текст в интерфейсе — это не «стиль».
  if (out.fontSize !== undefined) {
    const size = typeof out.fontSize === 'number' ? out.fontSize : parseFloat(String(out.fontSize));
    if (Number.isFinite(size) && size > 0) {
      out.fontSize = `${Math.max(FONT_FLOOR, Math.round(size))}px`;
    }
  }

  if (!out.resolution) out.resolution = TEXT_RESOLUTION;

  return out;
}

/** Фабрика текста с правилами игры (короткая запись для сцен). */
export function makeText(
  scene: Phaser.Scene,
  x: number,
  y: number,
  content: string | string[],
  style?: TextStyle,
): Phaser.GameObjects.Text {
  return scene.add.text(x, y, content, normalizeTextStyle(style));
}

type TextFactory = (
  this: Phaser.GameObjects.GameObjectFactory,
  x: number,
  y: number,
  text: string | string[],
  style?: TextStyle,
) => Phaser.GameObjects.Text;

let patched = false;

/**
 * Включает правила типографики для всех текстовых объектов игры.
 *
 * Патчится фабрика Phaser, а не отдельные вызовы: правило «шрифт игры,
 * целый кегль, двойная растеризация» должно выполняться ВСЕГДА, иначе
 * через полгода в новом экране снова появится «monospace» 9 px.
 */
export function installTextDefaults(): void {
  if (patched) return;
  patched = true;

  const proto = Phaser.GameObjects.GameObjectFactory.prototype as unknown as {
    text: TextFactory;
  };
  const original = proto.text;
  if (typeof original !== 'function') return;

  proto.text = function (
    this: Phaser.GameObjects.GameObjectFactory,
    x: number,
    y: number,
    text: string | string[],
    style?: TextStyle,
  ): Phaser.GameObjects.Text {
    return original.call(this, x, y, text, normalizeTextStyle(style));
  };
}

/**
 * Подгоняет готовый текст под ширину: сначала уменьшает кегль, а если и
 * минимального не хватает — сжимает по ширине.
 *
 * Ширина Phaser-текста включает обводку, поэтому лишние пиксели уже учтены
 * и дополнительный запас не нужен.
 */
export function fitTextWidth(
  txt: Phaser.GameObjects.Text,
  maxW: number,
  fontSize: number,
  minSize: number = FS.micro,
): void {
  if (txt.width <= maxW || txt.width === 0) return;
  const fitted = Math.max(minSize, Math.floor(fontSize * (maxW / txt.width)));
  if (fitted < fontSize) {
    txt.setStyle({ fontSize: `${fitted}px`, strokeThickness: outlineFor(fitted) });
  }
  // Крайний случай: даже минимальный кегль не влезает — сжимаем по ширине.
  // Шаг округляем: произвольный дробный масштаб растягивает глифы на
  // доли пикселя, и при nearest-фильтре они «дрожат» между кадрами.
  if (txt.width > maxW) txt.setScale(Math.round((maxW / txt.width) * 20) / 20);
}

/**
 * Тот же подгон, но с сохранением высоты строки: уменьшенный кегль не
 * должен «прыгать» при переносе строк (текст с переносом строк).
 */
export function fitTextBlock(
  txt: Phaser.GameObjects.Text,
  maxW: number,
  fontSize: number,
  minSize: number = FS.micro,
): void {
  if (txt.width <= maxW || txt.width === 0) return;
  const fitted = Math.max(minSize, Math.floor(fontSize * (maxW / txt.width)));
  if (fitted < fontSize) {
    txt.setStyle({ fontSize: `${fitted}px`, strokeThickness: outlineFor(fitted) });
  }
  if (txt.width > maxW) txt.setWordWrapWidth(maxW);
}

/**
 * Уменьшает кегль, пока блок текста не поместится по высоте.
 *
 * Нужно там, где содержимое заранее известно, а места мало: карточка
 * героя, ячейка достижения. Ширина при этом не трогается — перенос строк
 * уже задан в стиле.
 *
 * ⚠️ Обрезка строк по умолчанию ВЫКЛЮЧЕНА. Раньше лишние строки просто
 * отбрасывались, и карточка героя на телефоне молча теряла вторую
 * характеристику («−10 HP» просто исчезал). Теперь подгонка только уменьшает
 * кегль; если даже минимального не хватает, текст выходит за границу, но
 * остаётся целым — вызывающий код обязан зарезервировать место сам.
 * Обрезка включается явно (`trim: true`) там, где потеря строки не страшна.
 */
export function shrinkToHeight(
  txt: Phaser.GameObjects.Text,
  maxH: number,
  fontSize: number,
  minSize: number = FS.micro,
  opts: { trim?: boolean } = {},
): void {
  let size = Math.round(fontSize);
  while (size > minSize && txt.height > maxH) {
    size -= 1;
    txt.setStyle({ fontSize: `${size}px`, strokeThickness: outlineFor(size) });
  }
  if (txt.height <= maxH || !opts.trim) return;

  // Явная обрезка: режем число строк до нужного.
  const lines = Math.max(1, Math.floor(maxH / Math.max(1, size * 1.2)));
  const rows = txt.text.split('\n');
  if (rows.length > lines) txt.setText(rows.slice(0, lines).join('\n'));
}

