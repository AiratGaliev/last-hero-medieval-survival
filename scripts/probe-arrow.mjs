// Где на самом деле остриё у cursor-01.png и в какую сторону он смотрит
// при нулевом повороте. Считаем по непрозрачным пикселям.
// Та же стрелка показывается и как курсор мыши, и как указатель на цель
// за экраном (systems/HUD.ts), поэтому hotspot один на оба случая.
import fs from 'node:fs';
import { decodePng } from './lib/png.mjs';

const img = decodePng(fs.readFileSync(
  'src/assets/tiny-swords/ui/cursors/cursor-01.png',
));

const px = [];
for (let y = 0; y < img.height; y++) {
  for (let x = 0; x < img.width; x++) {
    if (img.data[(y * img.width + x) * 4 + 3] > 40) px.push([x, y]);
  }
}

const xs = px.map((p) => p[0]);
const ys = px.map((p) => p[1]);
const minX = Math.min(...xs), maxX = Math.max(...xs);
const minY = Math.min(...ys), maxY = Math.max(...ys);

console.log('картинка', img.width + 'x' + img.height, '| непрозрачных пикселей:', px.length);
console.log('границы: x', minX, '..', maxX, ' y', minY, '..', maxY);

// Остриё — самый дальний от центра масс угловой пиксель, лежащий на
// диагонали корпуса. Берём четыре угла и смотрим, какой выдаётся дальше
// всех от центра масс.
const cx = xs.reduce((a, b) => a + b, 0) / xs.length;
const cy = ys.reduce((a, b) => a + b, 0) / ys.length;
console.log('центр масс:', cx.toFixed(1), cy.toFixed(1));

const corners = [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]];
for (const [x, y] of corners) {
  const d = Math.hypot(x - cx, y - cy);
  // Угол в стандартной математике: вверх = +90°
  const ang = (Math.atan2(-(y - cy), x - cx) * 180 / Math.PI + 360) % 360;
  console.log('  угол (' + x + ',' + y + ')  d=' + d.toFixed(1) + '  направление=' + ang.toFixed(1) + '°');
}

// Уточнение: самая верхняя точка и самая левая — где настоящее остриё
const top = px.reduce((a, b) => (b[1] < a[1] ? b : a));
const left = px.reduce((a, b) => (b[0] < a[0] ? b : a));
const bottom = px.reduce((a, b) => (b[1] > a[1] ? b : a));
const right = px.reduce((a, b) => (b[0] > a[0] ? b : a));
console.log('самая верхняя:', top, ' самая левая:', left);
console.log('самая нижняя:', bottom, ' самая правая:', right);