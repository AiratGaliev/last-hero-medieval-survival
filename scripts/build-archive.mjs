/**
 * Сборка архива для Yandex Games.
 *
 * Требования платформы, которые проверяем автоматически (см. раздел 1
 * «Game requirements»):
 *   • 1.21 — суммарный размер распакованных файлов ≤ 100 МБ;
 *   • 1.22 — index.html в корне архива, в именах нет пробелов и кириллицы.
 *
 * Запуск: npm run build:yg  (собирает и упаковывает)
 *         npm run check:yg  (только проверяет готовый dist/)
 */

import { createWriteStream, existsSync, readdirSync, readFileSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const OUT_DIR = join(ROOT, 'release');
const OUT_ZIP = join(OUT_DIR, 'tiny-sword-survivors.zip');

/** Лимит распакованных данных, п. 1.21. */
const MAX_UNCOMPRESSED = 100 * 1024 * 1024;

const problems = [];

function fail(msg) {
  problems.push(msg);
}

// (предупреждения выводятся на месте, список не нужен)

// ---------------------------------------------------------------- проверки

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

/** П. 1.22: имена файлов и папок — без пробелов и кириллицы. */
function checkNames(files) {
  for (const file of files) {
    const rel = relative(DIST, file);
    for (const part of rel.split(/[/\\]/)) {
      if (/\s/.test(part)) fail(`пробел в имени: ${rel}`);
      if (/[\u0400-\u04FF]/.test(part)) fail(`кириллица в имени: ${rel}`);
    }
  }
}

/** П. 1.22: index.html обязан лежать в корне архива. */
function checkIndexHtml(files) {
  if (!files.some((f) => relative(DIST, f).replace(/\\/g, '/') === 'index.html')) {
    fail('в корне dist/ нет index.html');
  }
}

/** П. 1.21: суммарный размер распакованных файлов. */
function checkSize(files) {
  const total = files.reduce((sum, f) => sum + statSync(f).size, 0);
  if (total > MAX_UNCOMPRESSED) {
    fail(`размер ${(total / 1048576).toFixed(1)} МБ превышает лимит 100 МБ`);
  }
  return total;
}

/**
 * Требование 1.2: игра обязана запускаться без внешних сервисов.
 * Проверяем, что в собранном index.html не осталось ссылок на CDN.
 */
function checkNoExternalUrls() {
  const index = join(DIST, 'index.html');
  if (!existsSync(index)) return;
  // Комментарии вырезаем: упоминание внешнего сервиса в тексте не является
  // сетевым запросом (так выглядит наш комментарий про Google Fonts).
  const html = readFileSync(index, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const external = html.match(/(?:src|href)\s*=\s*["'](?:https?:)?\/\/[^"']+/gi) ?? [];
  for (const match of external) {
    // Абсолютные ссылки на S3 Яндекса отдельно запрещены п. 1.7.
    fail(`внешняя ссылка в index.html: ${match}`);
  }
  if (html.includes('fonts.googleapis.com') || html.includes('fonts.gstatic.com')) {
    fail('index.html тянет Google Fonts — шрифт должен лежать в архиве');
  }
}

/** SDK Яндекса должен лежать в архиве: п. 1.1 требует установленный SDK. */
function checkSdkPresent(files) {
  const rel = files.map((f) => relative(DIST, f).replace(/\\/g, '/'));
  if (!rel.includes('vendor/yandex-sdk.js')) {
    fail('в архиве нет vendor/yandex-sdk.js — SDK не будет подключён');
  }
}

// ------------------------------------------------------------------ zip

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * Минимальный ZIP-писатель (deflate + crc32), без зависимостей.
 * Яндекс принимает обычный zip, поэтому структурных излишеств не нужно.
 */
function writeZip(entries, outPath) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const compressed = deflateRawSync(data, { level: 9 });

    // Если сжатие не помогло (уже сжатый PNG), кладём как есть.
    const useDeflate = compressed.length < data.length;
    const payload = useDeflate ? compressed : data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date (1996-01-01, детерминированно)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, payload);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x21, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(payload.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt16LE(0, 30);
    dir.writeUInt16LE(0, 32);
    dir.writeUInt16LE(0, 34);
    dir.writeUInt16LE(0, 36);
    dir.writeUInt32LE(0, 38);
    dir.writeUInt32LE(offset, 42);

    central.push(dir, nameBuf);
    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  const out = createWriteStream(outPath);
  out.write(Buffer.concat([...chunks, centralBuf, end]));
  return new Promise((resolveOut, reject) => {
    out.on('error', reject);
    out.end(() => resolveOut());
  });
}

// ------------------------------------------------------------------ main

function main() {
  if (!existsSync(DIST)) {
    console.error('dist/ не найден — сначала выполните: npm run build');
    process.exit(1);
  }

  const files = walk(DIST);

  checkNames(files);
  checkIndexHtml(files);
  checkSdkPresent(files);
  checkNoExternalUrls();
  const total = checkSize(files);

  console.log('Проверка архива Yandex Games');
  console.log(`  файлов:            ${files.length}`);
  console.log(`  распакованный:     ${(total / 1048576).toFixed(2)} МБ из 100 МБ`);

  for (const p of problems) console.log(`  ✗ ${p}`);

  if (problems.length) {
    console.error(`\nПровалено проверок: ${problems.length}`);
    process.exit(1);
  }
  console.log('  ✓ требования архива выполнены');

  if (process.argv.includes('--check')) return;

  const entries = files.map((f) => ({
    name: relative(DIST, f).split(sep).join('/'),
    data: readFileSync(f),
  }));

  mkdirSync(OUT_DIR, { recursive: true });
  rmSync(OUT_ZIP, { force: true });

  writeZip(entries, OUT_ZIP).then(() => {
    const size = statSync(OUT_ZIP).size;
    console.log(`\nАрхив готов: ${relative(ROOT, OUT_ZIP)} (${(size / 1048576).toFixed(2)} МБ)`);
    console.log('Загружать в консоли: https://games.yandex.com/console');
  });
}

main();