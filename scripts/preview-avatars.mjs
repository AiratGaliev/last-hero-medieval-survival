// Контактный лист портретов: все avatars-*.png рядом с номерами.
// Каждый портрет обрезан по фактическому содержимому — в файлах 256×256
// персонаж занимает ~150-200 px, а по краям пустое поле.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng, blank, contentBounds } from './lib/png.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'src/assets/tiny-swords/ui/avatars');

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.png')).sort();

const cols = 5;
const cell = 128;
const rows = Math.ceil(files.length / cols);
const out = blank(cols * cell, rows * cell);

files.forEach((f, i) => {
  const img = decodePng(fs.readFileSync(path.join(DIR, f)));
  const b = contentBounds(img.data, img.width, 0, 0, img.width, img.height);
  const cx = (i % cols) * cell;
  const cy = Math.floor(i / cols) * cell;

  // клетка-шахматка, чтобы видеть прозрачность
  for (let y = 0; y < cell; y++) {
    for (let x = 0; x < cell; x++) {
      const to = ((cy + y) * out.width + cx + x) * 4;
      const checker = ((x >> 4) + (y >> 4)) % 2 ? 210 : 170;
      out.data[to] = checker;
      out.data[to + 1] = checker;
      out.data[to + 2] = checker;
      out.data[to + 3] = 255;
    }
  }

  // содержимое вписывается в клетку целиком
  const s = (cell - 8) / Math.max(b.w, b.h);
  const w = Math.max(1, Math.round(b.w * s));
  const h = Math.max(1, Math.round(b.h * s));
  const ox = cx + Math.floor((cell - w) / 2);
  const oy = cy + Math.floor((cell - h) / 2);

  for (let y = 0; y < h; y++) {
    const sy = b.y + Math.min(b.h - 1, Math.floor(y / s));
    for (let x = 0; x < w; x++) {
      const sx = b.x + Math.min(b.w - 1, Math.floor(x / s));
      const from = (sy * img.width + sx) * 4;
      if (img.data[from + 3] === 0) continue;
      const to = ((oy + y) * out.width + ox + x) * 4;
      out.data[to] = img.data[from];
      out.data[to + 1] = img.data[from + 1];
      out.data[to + 2] = img.data[from + 2];
      out.data[to + 3] = 255;
    }
  }
});

const file = path.join(ROOT, 'src/assets/game/_preview-avatars.png');
fs.writeFileSync(file, encodePng(out));
console.log('контактный лист:', file, `${out.width}x${out.height}`);
console.log('порядок (слева направо, сверху вниз):');
console.log(' ', files.map((f) => f.replace('avatars-', '').replace('.png', '')).join(' '));