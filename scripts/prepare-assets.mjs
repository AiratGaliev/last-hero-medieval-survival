// ============ Генерация производных игровых текстур ============
// Запуск: node scripts/prepare-assets.mjs
//
// Исходники (ассеты Tiny Swords) не меняются. Здесь из них штампуются только
// то, что в игре не воспроизвести без подготовки:
//   • бесшовные девятислайсы кнопок и панелей (исходники с прозрачными зазорами
//     между тайлами нельзя растягивать напрямую);
//   • перекрашенные заливки полос (setTint умножает цвет, а исходная заливка
//     красная — тон дал бы тёмно-красный);
//   • мечи логотипа (три детали с зазорами склеиваются вплотную).
//
// Всё остальное, что можно взять из пака как есть, в src/assets/game НЕ кладётся:
// портреты, углы рамки, детали полос, тень и тайл травы грузятся из
// tiny-swords напрямую (см. BootScene.registerFrames) — обрезки и дубликаты в
// репозитории только раздувают его.
//
// ============ ЧТО ЛЕЖИТ В src/assets/game ============
// Папка делится на три части, и важно их не путать:
//
// 1. ВЫВОД ЭТОГО СКРИПТА — обязательные производные: девятислайсы кнопок и
//    панелей (btn-*/paper9/paper-special9/banner9/table9), перекрашенные
//    заливки полос (bar-fill-*), мечи логотипа (sword-*/knife/spear), слэш.
//    Портреты, углы рамки, мягкая тень и тайл травы сюда больше НЕ входят:
//    они грузятся из tiny-swords напрямую (BootScene.registerFrames) —
//    обрезки-дубликаты в репозитории только раздувают его.
//
// 2. ВЫВОД scripts/make-ribbons.mjs — ленты экрана левел-апа из
//    ui/ribbons/bigribbons.png.
//
// 3. АВТОРСКИЕ ОРИГИНАЛЫ — перекрашенные и уникальные:
//      · gem-*.png — перекраска золотых жил (камня нужного оттенка в ассете нет);
//      · icon-{spear,bomb,aura,boots,magnet,heart,might,haste,knives}.png —
//        пиксельно совпадающих файлов в tiny-swords НЕТ (проверено сравнением
//        RGBA со всеми 410 файлами ассета), нарисованы отдельно;
//      · aoe-ring, slash, spear, knife, barrel.png — эффекты и реквизит,
//        которых в ассете тоже нет.
//
// ПРАВИЛО: сюда НЕ кладутся копии файлов tiny-swords. Если картинка уже есть
// в ассете — грузится прямо оттуда (см. BootScene: meat, arrow и иконки
// ui/icons грузятся из tiny-swords). Копия оправдана только когда оригинал
// не годится: обрезка ради размера (shadow-soft) или потому что Phaser не
// возьмёт кусок листа (всё из пункта 1).

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
//
// Сами детали в src/assets/game не нарезаются: игра грузит листы
// ui/bars/{big,small}bar-base.png целиком и берёт из них кадры
// bar-{big,small}-cap-l/mid/r (координаты — в BootScene.registerFrames).
console.log('\n[полосы HP/XP — детали как кадры листов + заливка]');

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
// Портреты героев больше НЕ вырезаются в src/assets/game: игра грузит
// исходники `ui/avatars/*.png` целиком и сама компенсирует прозрачные поля по
// рамке персонажа (см. HeroDef.portrait в src/game/data.ts). Держать вторую
// копию картинки ради обрезки — значит хранить в репозитории дубликат пака.
//
// Соответствие портретов героям (ui/avatars — 25 файлов по 256×256, пять типов
// персонажей в пяти цветовых схемах). Раскладка 5×5: читать по строкам (цвет)
// и столбцам (тип).
//
//   столбец 1 — латник с загнутым плюмажером и щитом  → warrior
//   столбец 2 — рыцарь в круглом шлеме с забралом     → lancer
//   столбец 3 — конусный капюшон с плюмажем (арчер)  → archer
//   столбец 4 — лысый бородач в балах                → monk
//   столбец 5 — длинноволосый (в игре не используется)
//
//   строка 1 — синий (цвет игрока), 2 — красный, 3 — жёлтый,
//   строка 4 — фиолетовый, 5 — чёрный.
//
// Герои в игре всегда синие, поэтому берём верхнюю строку — 01..04.
// Рамки персонажа (box) измерены по этим же файлам. Сверить соответствие типов
// со спрайтами героев позволяет scripts/preview-avatars.mjs.
console.log('\n[портреты героев]');
{
  const picks = { warrior: '01', lancer: '02', archer: '03', monk: '04' };
  for (const [id, num] of Object.entries(picks)) {
    const img = read('ui/avatars/avatars-' + num + '.png');
    const b = contentBounds(img.data, img.width, 0, 0, img.width, img.height);
    if (!b) throw new Error('пустой портрет avatars-' + num);
    console.log(`  avatar-${id.padEnd(7)} ui/avatars/avatars-${num}.png  ${img.width}x${img.height}` +
      `  персонаж: ${b.w}x${b.h} @ ${b.x},${b.y}`);
  }
}

// ============================================================== рамка выделения
//
// ui/cursors/cursor-04 — четыре угла рамки, собранные в одной картинке
// 128×128. В таком виде рамка годится только под квадрат, а рамки выделения
// нужны произвольного размера (карточка героя, карточка левел-апа, чип
// сложности). Поэтому из квадрантов 64×64 регистрируются кадры
// corner-tl/tr/br/bl (по 21×25 каждый), а systems/Corners.ts собирает из них
// рамку, тянущуюся под любой размер. Отдельных копий corner-*.png в
// src/assets/game нет.
console.log('\n[рамка выделения — углы как кадры cursor-04]');

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
  // Тень и траву в src/assets/game не вырезаем — это точные фрагменты картинок
  // пака (Shadow.png 192×192 и тайл 64×64 из tilemap-color3), игра берёт их
  // кадрами тех же текстур (см. BootScene.registerFrames). Пустые поля
  // компенсируются при отрисовке — см. SHADOW_BOX и портреты выше.
  const shadow = read('terrain/tileset/shadow.png');
  const sb = contentBounds(shadow.data, shadow.width, 0, 0, shadow.width, shadow.height);
  console.log(`  shadow ← terrain/tileset/shadow.png  содержимое: ${sb.w}x${sb.h} @ ${sb.x},${sb.y}`);
  console.log('  grass-tile ← terrain/tileset/tilemap-color3.png  тайл 64x64 @ 64,64 (сетка 9x6)');
}

// ============================================================== отчёт
console.log('\nГотово:');
for (const line of generated) console.log('  ' + line);
console.log(`\nВсего файлов: ${generated.length}`);