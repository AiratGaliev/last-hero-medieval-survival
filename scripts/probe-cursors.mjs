// Границы непрозрачных пикселей у курсоров: по ним ставится точка
// привязки (hotspot). У стрелки это остриё, у ладони — кончик пальца,
// у «запрета» — середина знака.
//
// Вторая часть — разбор cursor-04: в этой картинке 128×128 собраны сразу
// четыре угла рамки. Чтобы из неё получилась тянущаяся под любой размер
// рамка, углы вырезаются по квадрантам (scripts/prepare-assets.mjs),
// и печатаются их границы.
import fs from 'node:fs';
import { decodePng, contentBounds } from './lib/png.mjs';

const files = [
  'src/assets/tiny-swords/ui/cursors/cursor-01.png',
  'src/assets/tiny-swords/ui/cursors/cursor-02.png',
  'src/assets/tiny-swords/ui/cursors/cursor-03.png',
  'src/assets/tiny-swords/ui/cursors/cursor-04.png',
];

for (const f of files) {
  const img = decodePng(fs.readFileSync(f));
  const px = [];
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] > 40) px.push([x, y]);
    }
  }
  if (!px.length) { console.log(f, '— пусто'); continue; }
  const xs = px.map((p) => p[0]), ys = px.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const top = px.reduce((a, b) => (b[1] < a[1] ? b : a));
  const left = px.reduce((a, b) => (b[0] < a[0] ? b : a));
  console.log(
    f.split('/').pop().padEnd(14) + img.width + 'x' + img.height
    + '  непрозрачных: ' + px.length
    + '  рамка x ' + minX + '..' + maxX + ' y ' + minY + '..' + maxY
    + '  остриё(сверху-слева)=(' + top[0] + ',' + top[1] + ')'
    + '  левый край=(' + left[0] + ',' + left[1] + ')',
  );

  // Углы рамки: по квадрантам, чтобы вырезать их в отдельные текстуры
  if (img.width >= 96) {
    const half = img.width / 2;
    for (const [name, qx, qy] of [
      ['tl', 0, 0], ['tr', half, 0], ['br', half, half], ['bl', 0, half],
    ]) {
      const b = contentBounds(img.data, img.width, qx, qy, half, half);
      console.log(
        '  угол ' + name + ': '
        + (b ? `x ${qx + b.x}..${qx + b.x + b.w - 1}  y ${qy + b.y}..${qy + b.y + b.h - 1}  ${b.w}x${b.h}` : 'пусто'),
      );
    }
  }
}