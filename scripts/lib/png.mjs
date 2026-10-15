// ============ Минимальный PNG: чтение и запись без зависимостей ============
// Нужен для подготовки производных игровых текстур: девятислайсы из сеток 3×3,
// полосы из торцов и середин. Ассет Tiny Swords приходят с прозрачными
// зазорами между плитками, поэтому «просто скормить Phaser'у» нельзя —
// сначала нужно вырезать детали и сшить их вплотную.
//
// Поддерживается 8-битный PNG без чересполосицы (типичный вывод Pillow/Aseprite).

import { inflateSync, deflateSync } from 'node:zlib';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Разбирает PNG в { width, height, data: RGBA Buffer }. */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) throw new Error('не PNG');

  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len; // 4 длина + 4 тип + тело + 4 CRC

    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (bitDepth !== 8) throw new Error(`битовая глубина ${bitDepth} не поддерживается`);
  if (interlace !== 0) throw new Error('чересполосица не поддерживается');
  if (colorType !== 6 && colorType !== 2) {
    throw new Error(`тип цвета ${colorType} не поддерживается (нужен 2 или 6)`);
  }

  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);

  let prev = Buffer.alloc(stride);
  let src = 0;

  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const line = raw.subarray(src, src + stride);
    src += stride;
    const cur = Buffer.alloc(stride);

    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      const v = line[x];
      let value;
      switch (filter) {
        case 0: value = v; break;
        case 1: value = v + a; break;
        case 2: value = v + b; break;
        case 3: value = v + ((a + b) >> 1); break;
        case 4: value = v + paeth(a, b, c); break;
        default: throw new Error(`неизвестный фильтр ${filter}`);
      }
      cur[x] = value & 0xff;
    }

    // Приводим строку к RGBA
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      out[d] = cur[s];
      out[d + 1] = cur[s + 1];
      out[d + 2] = cur[s + 2];
      out[d + 3] = channels === 4 ? cur[s + 3] : 255;
    }
    prev = cur;
  }

  return { width, height, data: out };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Кодирует { width, height, data: RGBA Buffer } в PNG. */
export function encodePng({ width, height, data }) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);

  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // фильтр None — проще и достаточно для наших текстур
    data.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  const chunks = [PNG_MAGIC, chunk('IHDR', ihdr(width, height)), chunk('IDAT', deflateSync(raw, { level: 9 }))];
  chunks.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

function ihdr(width, height) {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(width, 0);
  b.writeUInt32BE(height, 4);
  b[8] = 8; // глубина
  b[9] = 6; // RGBA
  b[10] = 0;
  b[11] = 0;
  b[12] = 0;
  return b;
}

function chunk(type, body) {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'ascii');
  body.copy(out, 8);
  const crcInput = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  out.writeUInt32BE(crc32(crcInput), 8 + body.length);
  return out;
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Копирует прямоугольник из одного буфера в другой. */
export function blit(dst, dstW, src, srcW, sx, sy, sw, sh, dx, dy) {
  for (let y = 0; y < sh; y++) {
    const from = ((sy + y) * srcW + sx) * 4;
    const to = ((dy + y) * dstW + dx) * 4;
    src.copy(dst, to, from, from + sw * 4);
  }
}

/** Прозрачность в точке (x, y). */
export function alphaAt(data, width, x, y) {
  return data[(y * width + x) * 4 + 3];
}

/**
 * Плотные границы непрозрачного содержимого внутри прямоугольника.
 * Именно так находятся детали сетки 3×3: они нарисованы с зазорами.
 */
export function contentBounds(data, width, sx, sy, sw, sh, alphaMin = 8) {
  let x0 = sw;
  let y0 = sh;
  let x1 = -1;
  let y1 = -1;

  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      if (alphaAt(data, width, sx + x, sy + y) < alphaMin) continue;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }

  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Создаёт пустой RGBA-буфер нужного размера. */
export function blank(width, height) {
  return { width, height, data: Buffer.alloc(width * height * 4) };
}