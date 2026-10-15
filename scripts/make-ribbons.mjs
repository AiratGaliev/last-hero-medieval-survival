// Собирает бесшовную ленту для экрана левел-апа из bigribbons.png.
//
// Исходник — 5 цветов, каждый разложен на три детали с зазорами:
// левый хвост, растягиваемая середина, правый хвост. Границы деталей
// находятся по непрозрачным колонкам, а не задаются константами:
// в исходнике они стоят неравномерно (30..128, 192..256, 320..417).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng, blank } from './lib/png.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const src = decodePng(fs.readFileSync(
  path.join(ROOT, 'src/assets/tiny-swords/ui/ribbons/bigribbons.png'),
));

const CELL = 128;

/** Непустые колонки внутри строки, собранные в группы. */
function columnGroups(rowTop, rowH, width) {
  const occupied = new Array(width).fill(false);
  for (let y = rowTop; y < rowTop + rowH; y++) {
    for (let x = 0; x < width; x++) {
      if (src.data[(y * src.width + x) * 4 + 3] > 8) occupied[x] = true;
    }
  }
  const out = [];
  let start = -1;
  for (let x = 0; x < width; x++) {
    if (occupied[x] && start < 0) start = x;
    if (!occupied[x] && start >= 0) { out.push([start, x - start]); start = -1; }
  }
  if (start >= 0) out.push([start, width - start]);
  return out;
}

/** Копирует кусок, растягивая по недостающей оси. */
function blit(dst, dstW, sx, sy, sw, sh, dx, dy, dw, dh) {
  for (let j = 0; j < dh; j++) {
    const y = sy + Math.min(sh - 1, Math.floor((j * sh) / dh));
    for (let i = 0; i < dw; i++) {
      const x = sx + Math.min(sw - 1, Math.floor((i * sw) / dw));
      const from = (y * src.width + x) * 4;
      const to = ((dy + j) * dstW + dx + i) * 4;
      dst[to] = src.data[from];
      dst[to + 1] = src.data[from + 1];
      dst[to + 2] = src.data[from + 2];
      dst[to + 3] = src.data[from + 3];
    }
  }
}

const NAMES = ['ribbon-blue', 'ribbon-red', 'ribbon-yellow', 'ribbon-purple'];
const MID_W = 48; // растягиваемая середина

NAMES.forEach((name, row) => {
  const groups = columnGroups(row * CELL, CELL, src.width);
  if (groups.length !== 3) {
    throw new Error('ряд ' + row + ': найдено деталей ' + groups.length + ', ожидалось 3');
  }
  const [[lx, lw], [mx, mw], [rx, rw]] = groups;

  const outW = lw + MID_W + rw;
  const image = blank(outW, CELL);
  const d = image.data;

  // Торцы копируем как есть, середину растягиваем по ширине
  blit(d, outW, lx, row * CELL, lw, CELL, 0, 0, lw, CELL);
  blit(d, outW, mx, row * CELL, mw, CELL, lw, 0, MID_W, CELL);
  blit(d, outW, rx, row * CELL, rw, CELL, lw + MID_W, 0, rw, CELL);

  fs.writeFileSync(path.join(ROOT, 'src/assets/game/' + name + '.png'), encodePng(image));
  console.log(
    name.padEnd(16) + image.width + 'x' + image.height
    + '  торцы ' + lw + '/' + rw + '  середина ' + mw + ' -> ' + MID_W,
  );
});
