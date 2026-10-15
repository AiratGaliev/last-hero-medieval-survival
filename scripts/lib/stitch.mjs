// ============ Штамповка бесшовных девятислайсов и полос из сетки 3×3 ============
// Ассеты Tiny Swords приходят нарисованными по сетке 3×3 с прозрачными
// зазорами между деталями. Phaser такие картинки растягивать не умеет: в
// середине торцов будут дыры. Поэтому вырезаем детали по фактическим границам
// непрозрачного содержимого и сшиваем их вплотную.

import { contentBounds, blank } from './png.mjs';

/**
 * Копирует деталь `part` в прямоугольник dw×dh, растягивая по недостающей
 * оси. `part` уже содержит координаты внутри исходной картинки.
 */
function blitPart(dst, dstW, src, srcW, part, dx, dy, dw, dh) {
  for (let y = 0; y < dh; y++) {
    const sy = part.y + Math.min(part.h - 1, Math.floor((y * part.h) / dh));
    for (let x = 0; x < dw; x++) {
      const sx = part.x + Math.min(part.w - 1, Math.floor((x * part.w) / dw));
      const from = (sy * srcW + sx) * 4;
      const to = ((dy + y) * dstW + dx + x) * 4;
      dst[to] = src[from];
      dst[to + 1] = src[from + 1];
      dst[to + 2] = src[from + 2];
      dst[to + 3] = src[from + 3];
    }
  }
}

/**
 * Собирает бесшовный девятислайс из картинки с сеткой 3×3.
 *
 * Детали в исходниках бывают разного размера: у баннера нижние углы выше
 * верхних. Для бесшовности все торцы должны быть одной толщины, поэтому
 * берём максимум и растягиваем меньшую деталь.
 *
 * @param {{width:number,height:number,data:Buffer}} img
 * @param {{left?:number,right?:number,top?:number,bottom?:number,midW?:number,midH?:number}} [fixed]
 */
export function stitch9slice(img, fixed = {}) {
  const cols = 3;
  const rows = 3;
  const cw = Math.floor(img.width / cols);
  const ch = Math.floor(img.height / rows);

  const parts = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const b = contentBounds(img.data, img.width, c * cw, r * ch, cw, ch);
      if (!b) throw new Error(`пустая ячейка ${r},${c} — исходник, похоже, не сетка 3×3`);
      parts.push({ col: c, row: r, ...b });
    }
  }

  const at = (col, row) => parts.find((p) => p.col === col && p.row === row);
  const max = (...v) => Math.max(...v);

  const left = fixed.left ?? max(at(0, 0).w, at(0, 2).w);
  const right = fixed.right ?? max(at(2, 0).w, at(2, 2).w);
  const top = fixed.top ?? max(at(0, 0).h, at(2, 0).h);
  const bottom = fixed.bottom ?? max(at(0, 2).h, at(2, 2).h);
  const midW = fixed.midW ?? at(1, 1).w;
  const midH = fixed.midH ?? at(1, 1).h;

  const outW = left + midW + right;
  const outH = top + midH + bottom;
  const image = blank(outW, outH);

  // Части адресуются координатами внутри исходника
  const P = (col, row) => {
    const p = at(col, row);
    return {
      x: col * cw + p.x,
      y: row * ch + p.y,
      w: p.w,
      h: p.h,
    };
  };

  const put = (col, row, dx, dy, dw, dh) =>
    blitPart(image.data, outW, img.data, img.width, P(col, row), dx, dy, dw, dh);

  // Углы
  put(0, 0, 0, 0, left, top);
  put(2, 0, left + midW, 0, right, top);
  put(0, 2, 0, top + midH, left, bottom);
  put(2, 2, left + midW, top + midH, right, bottom);

  // Середины рёбер: центральная деталь растягивается по всей длине
  put(1, 0, left, 0, midW, top);
  put(1, 2, left, top + midH, midW, bottom);
  put(0, 1, 0, top, left, midH);
  put(2, 1, left + midW, top, right, midH);

  // Центр
  put(1, 1, left, top, midW, midH);

  return { image, slices: { left, right, top, bottom }, middle: { w: midW, h: midH } };
}

/**
 * Штампует горизонтальную полосу: левый торец + растягиваемая середина +
 * правый торец. Именно так устроены ui/bars.
 *
 * @param {number} [midW] ширина участка заливки
 * @param {number} [height] высота результата
 */
export function stitchBar(src, midW = null, height = null) {
  const pieces = splitIntoPieces(src, 3);
  if (!pieces) throw new Error('не удалось разделить полосу на 3 части');

  const [l, m, r] = pieces;
  const outH = height ?? l.h;
  const outMW = midW ?? m.w;
  const outW = l.w + outMW + r.w;

  const image = blank(outW, outH);

  // Торцы копируем как есть (смещаем по вертикали, если высота изменилась),
  // середину растягиваем по ширине.
  const out = image.data;
  for (let y = 0; y < l.h && y < outH; y++) {
    for (let x = 0; x < l.w; x++) {
      const from = ((l.y + y) * src.width + l.x + x) * 4;
      const to = (y * outW + x) * 4;
      out[to] = src.data[from];
      out[to + 1] = src.data[from + 1];
      out[to + 2] = src.data[from + 2];
      out[to + 3] = src.data[from + 3];
    }
  }
  for (let y = 0; y < m.h && y < outH; y++) {
    for (let x = 0; x < outMW; x++) {
      const sx = m.x + Math.min(m.w - 1, Math.floor((x * m.w) / outMW));
      const from = ((m.y + y) * src.width + sx) * 4;
      const to = (y * outW + l.w + x) * 4;
      out[to] = src.data[from];
      out[to + 1] = src.data[from + 1];
      out[to + 2] = src.data[from + 2];
      out[to + 3] = src.data[from + 3];
    }
  }
  for (let y = 0; y < r.h && y < outH; y++) {
    for (let x = 0; x < r.w; x++) {
      const from = ((r.y + y) * src.width + r.x + x) * 4;
      const to = (y * outW + l.w + outMW + x) * 4;
      out[to] = src.data[from];
      out[to + 1] = src.data[from + 1];
      out[to + 2] = src.data[from + 2];
      out[to + 3] = src.data[from + 3];
    }
  }

  return { image, slices: { left: l.w, right: r.w } };
}

/** Делит картинку на N частей по вертикальным промежуткам без содержимого. */
function splitIntoPieces(src, count) {
  const stride = src.width * 4;
  const occupied = new Array(src.width).fill(false);

  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      if (src.data[y * stride + x * 4 + 3] > 8) occupied[x] = true;
    }
  }

  const groups = [];
  let start = -1;
  for (let x = 0; x < src.width; x++) {
    if (occupied[x] && start < 0) start = x;
    if (!occupied[x] && start >= 0) {
      groups.push({ x: start, w: x - start });
      start = -1;
    }
  }
  if (start >= 0) groups.push({ x: start, w: src.width - start });

  if (groups.length !== count) return null;

  return groups.map((g) => {
    const b = contentBounds(src.data, src.width, g.x, 0, g.w, src.height);
    return { x: b.x, y: b.y, w: b.w, h: b.h };
  });
}