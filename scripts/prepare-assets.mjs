// ============ Генерация производных игровых текстур ============
// Запуск: node scripts/prepare-assets.mjs
//
// Исходники (ассеты Tiny Swords) не меняются. Здесь из них штампуются
// бесшовные девятислайсы и детали полос, которые Phaser умеет растягивать.
// Результат кладётся в src/assets/game/ и коммитится — чтобы игру можно было
// собрать, не запуская этот скрипт.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng, contentBounds, blank, blit } from './lib/png.mjs';
import { stitch9slice } from './lib/stitch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src/assets/tiny-swords');
const OUT = path.join(ROOT, 'src/assets/game');

const generated = [];

function read(rel) {
  return decodePng(fs.readFileSync(path.join(SRC, rel)));
}

function write(name, image, note = '') {
  fs.writeFileSync(path.join(OUT, name), encodePng(image));
  generated.push(`${name.padEnd(26)} ${String(image.width).padStart(4)}x${String(image.height).padEnd(4)} ${note}`);
}

/**
 * Перекрашивает картинку в заданный цвет, сохраняя яркость исходника.
 *
 * Зачем: Phaser'овский setTint УМНОЖАЕТ цвет текстуры на тон. Исходная
 * заливка bar-big-fill красная (#ff3e3e), поэтому синий тон 0x54c2ff даёт
 * тёмно-красный, а не синий. Вместо умножения берём яркость исходника
 * (у этой текстуры она совпадает с красным каналом) и красим ею целевой цвет.
 */
function recolor(img, hex) {
  const tr = (hex >> 16) & 0xff;
  const tg = (hex >> 8) & 0xff;
  const tb = hex & 0xff;
  const out = blank(img.width, img.height);
  const src = img.data;
  const dst = out.data;

  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3];
    if (a === 0) continue;
    // Красный канал исходника — это и есть яркость градиента
    const lum = src[i] / 255;
    dst[i] = Math.round(tr * lum);
    dst[i + 1] = Math.round(tg * lum);
    dst[i + 2] = Math.round(tb * lum);
    dst[i + 3] = a;
  }
  return out;
}

/** Вырезает прямоугольник из картинки. */
function crop(img, x, y, w, h) {
  const out = blank(w, h);
  for (let row = 0; row < h; row++) {
    img.data.copy(
      out.data,
      row * w * 4,
      ((y + row) * img.width + x) * 4,
      ((y + row) * img.width + x + w) * 4,
    );
  }
  return out;
}

// ============================================================== кнопки
//
// Состояния normal/pressed. Раньше нажатия не было вовсе — кнопка реагировала
// только на наведение и выглядела «мёртвой».
console.log('\n[кнопки и панели — бесшовные девятислайсы]');
for (const [srcName, outName] of [
  ['ui/buttons/bigbluebutton-regular.png', 'btn-blue9.png'],
  ['ui/buttons/bigbluebutton-pressed.png', 'btn-blue9-pressed.png'],
  ['ui/buttons/bigredbutton-regular.png', 'btn-red9.png'],
  ['ui/buttons/bigredbutton-pressed.png', 'btn-red9-pressed.png'],
  ['ui/papers/regularpaper.png', 'paper9.png'],
  ['ui/papers/specialpaper.png', 'paper-special9.png'],
  ['ui/banners/banner.png', 'banner9.png'],
  ['ui/wood-table/woodtable.png', 'table9.png'],
]) {
  const { image, slices } = stitch9slice(read(srcName));
  write(outName, image, `L${slices.left} R${slices.right} T${slices.top} B${slices.bottom}`);
}

// ============================================================== полосы
//
// ui/bars устроены иначе: это три детали в ряд — левый торец, середина с
// вертикальным градиентом (растягивается по длине) и правый торец. Плюс
// отдельная текстура заливки. Собираются в Phaser тремя спрайтами.
console.log('\n[полосы HP/XP — три детали + заливка]');

/** Делит картинку на N частей по вертикальным промежуткам без содержимого. */
function splitIntoPieces(img, count) {
  const stride = img.width * 4;
  const occupied = new Array(img.width).fill(false);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[y * stride + x * 4 + 3] > 8) occupied[x] = true;
    }
  }
  const groups = [];
  let start = -1;
  for (let x = 0; x < img.width; x++) {
    if (occupied[x] && start < 0) start = x;
    if (!occupied[x] && start >= 0) {
      groups.push({ x: start, w: x - start });
      start = -1;
    }
  }
  if (start >= 0) groups.push({ x: start, w: img.width - start });
  if (groups.length !== count) return null;
  // contentBounds ищет границы ВНУТРИ среза, поэтому x возвращается
  // относительно начала группы — прибавляем смещение самой группы
  return groups.map((g) => {
    const b = contentBounds(img.data, img.width, g.x, 0, g.w, img.height);
    return { x: g.x + b.x, y: b.y, w: b.w, h: b.h };
  });
}

/**
 * Полосы устроены по-разному:
 *  • `*-base.png` — три детали в ряд (торец, середина, торец), их надо разрезать;
 *  • `*-fill.png` — одна цельная деталь, её только обрезать по содержимому.
 */
function emitBar(srcName, prefix, label) {
  const img = read(srcName);
  const isBase = srcName.includes('base');

  if (isBase) {
    const parts = splitIntoPieces(img, 3);
    if (!parts) throw new Error(`${srcName}: не удалось разделить на 3 детали`);
    const names = ['cap-l', 'mid', 'cap-r'];
    parts.forEach((p, i) => {
      write(`bar-${prefix}-${names[i]}.png`, crop(img, p.x, p.y, p.w, p.h), label);
    });
    return;
  }

  const b = contentBounds(img.data, img.width, 0, 0, img.width, img.height);
  if (!b) throw new Error(`${srcName}: пустая картинка`);
  write(`bar-${prefix}-fill.png`, crop(img, b.x, b.y, b.w, b.h), label);
}

for (const [srcName, prefix, label] of [
  ['ui/bars/bigbar-base.png', 'big', 'полоса босса'],
  ['ui/bars/smallbar-base.png', 'small', 'полоса HUD'],
  ['ui/bars/bigbar-fill.png', 'big', 'заливка'],
  ['ui/bars/smallbar-fill.png', 'small', 'подсветка'],
]) {
  emitBar(srcName, prefix, label);
}

// ============================================================== заливки
//
// Цвета под gameplay: синий — опыт, зелёный — здоровье, жёлтый — мало,
// красный — на грани. Глянец — белый.
console.log('\n[заливки полос — перекрашенные под gameplay]');
{
  const src = read('ui/bars/bigbar-fill.png');
  const b = contentBounds(src.data, src.width, 0, 0, src.width, src.height);
  const cropped = crop(src, b.x, b.y, b.w, b.h);
  for (const [name, hex] of [
    ['blue', 0x54c2ff],
    ['green', 0x53b44a],
    ['yellow', 0xe0a030],
    ['red', 0xd03028],
    ['ghost', 0xffb090],
    ['white', 0xffffff],
  ]) {
    write('bar-fill-' + name + '.png', recolor(cropped, hex), 'заливка');
  }
}

// ============================================================== портреты
//
// ui/avatars — 25 файлов по 256×256: пять типов персонажей в пяти цветовых
// схемах. Подбираем по одному под каждого героя и обрезаем по содержимому
// (персонаж занимает ~150-200 px, по краям пустое поле).
console.log('\n[портреты героев]');
{
  // warrior — латник с плюмажером и щитом, lancer — рыцарь в шлеме с
  // забралом, archer — солдат в остроконечном шлеме, monk — бородатый старец
  const picks = { warrior: '01', lancer: '02', archer: '03', monk: '04' };
  for (const [id, num] of Object.entries(picks)) {
    const img = read('ui/avatars/avatars-' + num + '.png');
    const b = contentBounds(img.data, img.width, 0, 0, img.width, img.height);
    if (!b) throw new Error('пустой портрет avatars-' + num);
    write('avatar-' + id + '.png', crop(img, b.x, b.y, b.w, b.h), 'портрет');
  }
}

// ============================================================== рамка выделения
//
// ui/cursors/cursor-04 — четыре угла рамки, собранные в одной картинке
// 128×128. В таком виде рамка годится только под квадрат, а рамки выделения
// нужны произвольного размера (карточка героя, карточка левел-апа, чип
// сложности). Поэтому углы вырезаются по квадрантам и дальше растягиваются
// по краям пустотой между ними — см. systems/Corners.ts.
//
// Legacy/ui/pointers для этого больше не используется: тот же набор углов
// там есть, но ассеты берутся только из ui/.
console.log('\n[рамка выделения — углы из cursor-04]');
{
  const img = read('ui/cursors/cursor-04.png');
  const half = img.width / 2;
  for (const [name, qx, qy] of [
    ['tl', 0, 0], ['tr', half, 0], ['br', half, half], ['bl', 0, half],
  ]) {
    const b = contentBounds(img.data, img.width, qx, qy, half, half);
    if (!b) throw new Error(`cursor-04: пустой угол ${name}`);
    write('corner-' + name + '.png', crop(img, qx + b.x, qy + b.y, b.w, b.h), 'угол рамки');
  }
}

// ============================================================== мечи логотипа
//
// ui/swords/swords.png — сетка 3×5: пять цветов мечей, каждый ряд из трёх
// деталей (рукоять, середина клинка, наконечник), нарисованных с
// прозрачными зазорами — в паке это рамка для надписи. Для логотипа
// детали склеиваются вплотную в один меч 261×128, иначе клинок выглядит
// разорванным на куски. Синий ряд — верхний меч, красный — нижний.
console.log('\n[мечи логотипа — два ряда из сетки 3×5, детали склеены]');
{
  const img = read('ui/swords/swords.png');
  const rowH = img.height / 5;
  if (!Number.isInteger(rowH)) throw new Error('swords: высота не делится на 5 рядов');

  // Колонки сетки: группы непрозрачных столбцов через прозрачные зазоры
  const used = new Array(img.width).fill(false);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] > 8) used[x] = true;
    }
  }
  const cols = [];
  let start = -1;
  for (let x = 0; x <= used.length; x++) {
    const on = used[x] === true;
    if (on && start < 0) start = x;
    if (!on && start >= 0) { cols.push([start, x - 1]); start = -1; }
  }
  if (cols.length !== 3) throw new Error(`swords: ожидались 3 колонки, получилось ${cols.length}`);

  for (const [name, row] of [['blue', 0], ['red', 1]]) {
    // contentBounds возвращает координаты ОТНОСИТЕЛЬНО среза, поэтому
    // смещение ряда прибавляем здесь — иначе оба меча выходят синими
    const parts = cols.map(([x0, x1]) => {
      const b = contentBounds(img.data, img.width, x0, row * rowH, x1 - x0 + 1, rowH);
      if (!b) throw new Error(`swords: пустая деталь в ряду ${name}`);
      return { x: x0 + b.x, y: row * rowH + b.y, w: b.w, h: b.h };
    });
    const totalW = parts.reduce((s, p) => s + p.w, 0);
    const totalH = Math.max(...parts.map((p) => p.h));
    const out = blank(totalW, totalH);
    let dx = 0;
    for (const p of parts) {
      // детали по вертикали центрируются: рукоять выше клинка
      blit(out.data, totalW, img.data, img.width, p.x, p.y, p.w, p.h,
        dx, Math.round((totalH - p.h) / 2));
      dx += p.w;
    }
    write(`sword-${name}.png`, out, 'меч логотипа');
  }
}

// ============================================================== прочее
console.log('\n[прочее]');
{
  // Тень из тайлсета вместо самодельной
  const img = read('terrain/tileset/shadow.png');
  const b = contentBounds(img.data, img.width, 0, 0, img.width, img.height);
  if (b) write('shadow-soft.png', crop(img, b.x, b.y, b.w, b.h), 'мягкая тень');
}

// ============================================================== отчёт
console.log('\nГотово:');
for (const line of generated) console.log('  ' + line);
console.log(`\nВсего файлов: ${generated.length}`);