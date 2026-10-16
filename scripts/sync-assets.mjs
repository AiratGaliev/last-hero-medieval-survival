// ============ Импорт исходников Tiny Swords ============
// Запуск: node scripts/sync-assets.mjs                      сухая проверка, ничего не пишет
//         node scripts/sync-assets.mjs --write              копирует только различающиеся файлы
//         node scripts/sync-assets.mjs --write --src="D:\Tiny Swords"
//         node scripts/sync-assets.mjs --list-extra         показать пропущенное из пака
//
// Что делает: src/assets/tiny-swords — копия пака Pixel Frog (Tiny Swords),
// приведённая к правилам проекта: ASCII, нижний регистр, kebab-case, никаких
// пробелов и подчёркиваний (иначе ломаются пути в git на Windows и в сборке для
// Yandex). Имена менялись по всей папке, поэтому вручную скопировать новую
// версию пака «как есть» нельзя — получится каша из двух naming-схем.
//
// Здесь вместо ручного копирования зафиксированы ПРАВИЛА переименования:
// список префиксов «папка пака → папка проекта» + kebab-case для остальных
// сегментов. Скрипт сам обходит пак, строит карту «пак → проект» и сверяет её с
// тем, что уже лежит в репозитории.
//
// Гарантии:
//  • копируется байт в байт (файл не перекодируется — размеры кадров спрайт-листов
//    в BootScene не плывут);
//  • файл проекта перезаписывается, только если отличается от пака: совпадающие
//    400+ файлов не трогаются, git diff остаётся чистым;
//  • ничего не удаляется — файл проекта, которого нет в паке, попадает в отчёт;
//  • файл пака, для которого нет правила, — фатальная ошибка, а не молчаливый
//    импорт в случайную папку;
//  • после копирования хеш перечитывается и сверяется;
//  • после копирования проверяется, что хеши всех затронутых файлов совпали с
//    исходником пака (страховка от обрыва копирования).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DST_ROOT = path.join(ROOT, 'src/assets/tiny-swords');

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const LIST_EXTRA = args.includes('--list-extra');
const SRC_ROOT = path.resolve(
  args.find((a) => a.startsWith('--src='))?.slice('--src='.length) ?? 'D:\\Tiny Swords',
);

if (!fs.existsSync(SRC_ROOT)) {
  console.error(`Пак не найден: ${SRC_ROOT}`);
  console.error('Укажи путь явно: node scripts/sync-assets.mjs --write --src="D:\\Tiny Swords"');
  process.exit(1);
}

// --------------------------------------------------------------- правила

/** Цвет в проекте → цвет в паке (`Black Units` / `Black Pawn` / `Black Buildings`). */
const COLOR_SRC = {
  black: 'Black',
  blue: 'Blue',
  purple: 'Purple',
  red: 'Red',
  yellow: 'Yellow',
};

/**
 * Что не импортируем:
 *  • Unity Tile Guide — справочные картинки для Unity (1.1 МБ), игре не нужны;
 *  • всё, что не PNG: .meta/.anim/.controller — служебные файлы Unity,
 *    .aseprite — исходники спрайтов, .DS_Store — мусор macOS.
 */
const SKIP_DIRS = ['Terrain/Tileset/Unity Tile Guide'];

/**
 * Отдельные файлы, которые не импортируются, хотя правило для них есть:
 *  • `Gold Resource 2..7` — побайтово те же картинки, что `Gold Stone 1..6`
 *    лежащие рядом; в проекте остаются только gold-stone-*;
 *  • `Bush 1..4` — побайтово те же, что `Bushe1..4`.
 * Прочие совпадения (PowerStone `Attack`/`Inven_Attack`, `Arrow`,
 * `Heal_Effect`) НЕ трогаем: там одна и та же картинка означает разные вещи
 * в разных разделах пака, и имена файлов несут смысл.
 */
const SKIP_FILES = [
  /^Terrain\/Resources\/Gold\/Gold Resource\/Gold_Resource_[2-7](_Highlight)?\.png$/,
  /^Terrain\/Decorations\/Bushes\/Bush [1-4]\.png$/,
];

/**
 * Правила «папка пака → папка проекта».
 *
 * Порядок важен: более специфичные префиксы идут раньше общих. Шаблон «из»
 * должен совпасть с началом пути файла в паке, шаблон «в» — это путь проекта,
 * где `{color}` подставляется найденным цветом, а лишние уровни просто
 * отбрасываются (`UI/UI Elements` → `ui`). Оставшиеся сегменты пути и имя файла
 * приводятся к kebab-case.
 */
const PREFIX_RULES = [
  // --- Buildings/<Цвет> Buildings/*.png → buildings/<цвет>/*.png
  ['Buildings/{color} Buildings', 'buildings/{color}'],
  ['Buildings', 'buildings'],

  // --- Particle FX/*.png → particle-fx/*.png
  ['Particle FX', 'particle-fx'],

  // --- Terrain/Resources: рельефные ресурсы остаются в terrain/resources/*,
  // остальные (руда, камни силы, пешки) живут в resources/* и pawns/* —
  // поэтому правила стоят раньше общего `Terrain`.
  ['Terrain/Resources/Gold/Gold Resource', 'terrain/resources/gold-resource'],
  ['Terrain/Resources/Gold/Gold Stones', 'terrain/resources/gold-stones'],
  ['Terrain/Resources/Meat/Meat Resource', 'terrain/resources/meat-resource'],
  ['Terrain/Resources/Meat/Sheep', 'terrain/resources/sheep'],
  ['Terrain/Resources/Wood/Wood Resource', 'terrain/resources/wood-resource'],
  ['Terrain/Resources/Wood/Trees', 'terrain/resources/trees'],
  ['Terrain/Resources/Pawn/{color} Pawn', 'pawns/{color}'],
  ['Terrain/Resources/Gold', 'resources/gold'],
  ['Terrain/Resources/Bronze', 'resources/bronze'],
  ['Terrain/Resources/Iron', 'resources/iron'],
  ['Terrain/Resources/Meat', 'resources/meat'],
  ['Terrain/Resources/PowerStone', 'resources/power-stone'],
  ['Terrain/Resources/Rock', 'resources/rock'],
  ['Terrain/Resources/Wood', 'resources/wood'],

  ['Terrain/Decorations/Rocks in the Water', 'terrain/decorations/water-rocks'],
  ['Terrain', 'terrain'],

  // --- UI
  ['UI/UI Elements/Human Avatars', 'ui/avatars'],
  ['UI/UI Elements', 'ui'],
  ['UI/UI Banners from the store page', 'ui/store-banners'],
  ['UI', 'ui'],

  // --- Units/<Цвет> Units/<Юнит>/*.png → units/<цвет>/<юнит>/*.png
  ['Units/{color} Units', 'units/{color}'],
  ['Units/Extra', 'units/extra'],
  ['Units', 'units'],

  // --- Enemy Pack/Enemies/<группа>/[<юнит>]/ → enemies/<группа>/[<юнит>]/
  ['Enemy Pack/Enemies', 'enemies'],
  ['Enemy Pack/Enemy Avatars', 'enemies/avatars'],
];

/**
 * Имена файлов, которые kebab-case ломает.
 *
 * По умолчанию `BigBlueButton_Regular` → `big-blue-button-regular`, но в проекте
 * эти файлы с самого начала названы слитно (`bigbluebutton-regular.png`), и на
 * них ссылается код — `BootScene` и `prepare-assets.mjs`. Переименование сломало
 * бы загрузку ассетов, поэтому такие имена зафиксированы здесь явно.
 *
 * Ключ — имя файла в паке (с учётом регистра), значение — имя в проекте.
 */
const FILE_OVERRIDES = new Map([
  // --- UI Elements/Bars
  ['BigBar_Base.png', 'bigbar-base.png'],
  ['BigBar_Fill.png', 'bigbar-fill.png'],
  ['SmallBar_Base.png', 'smallbar-base.png'],
  ['SmallBar_Fill.png', 'smallbar-fill.png'],

  // --- UI Elements/Buttons
  ['BigBlueButton_Pressed.png', 'bigbluebutton-pressed.png'],
  ['BigBlueButton_Regular.png', 'bigbluebutton-regular.png'],
  ['BigRedButton_Pressed.png', 'bigredbutton-pressed.png'],
  ['BigRedButton_Regular.png', 'bigredbutton-regular.png'],
  ['SmallBlueRoundButton_Pressed.png', 'smallblueroundbutton-pressed.png'],
  ['SmallBlueRoundButton_Regular.png', 'smallblueroundbutton-regular.png'],
  ['SmallBlueSquareButton_Pressed.png', 'smallbluesquarebutton-pressed.png'],
  ['SmallBlueSquareButton_Regular.png', 'smallbluesquarebutton-regular.png'],
  ['SmallRedRoundButton_Pressed.png', 'smallredroundbutton-pressed.png'],
  ['SmallRedRoundButton_Regular.png', 'smallredroundbutton-regular.png'],
  ['SmallRedSquareButton_Pressed.png', 'smallredsquarebutton-pressed.png'],
  ['SmallRedSquareButton_Regular.png', 'smallredsquarebutton-regular.png'],
  ['TinyRoundBlueButton.png', 'tinyroundbluebutton.png'],
  ['TinyRoundRedButton.png', 'tinyroundredbutton.png'],
  ['TinySquareBlueButton.png', 'tinysquarebluebutton.png'],
  ['TinySquareRedButton.png', 'tinysquareredbutton.png'],

  // --- UI Elements/Papers, Ribbons, Wood Table
  ['RegularPaper.png', 'regularpaper.png'],
  ['SpecialPaper.png', 'specialpaper.png'],
  ['BigRibbons.png', 'bigribbons.png'],
  ['SmallRibbons.png', 'smallribbons.png'],
  ['WoodTable.png', 'woodtable.png'],
  ['WoodTable_Slots.png', 'woodtable-slots.png'],

  // --- Lancer: в проекте «downright», а не «down-right»
  ['Lancer_DownRight_Attack.png', 'lancer-downright-attack.png'],
  ['Lancer_DownRight_Defence.png', 'lancer-downright-defence.png'],
  ['Lancer_UpRight_Attack.png', 'lancer-upright-attack.png'],
  ['Lancer_UpRight_Defence.png', 'lancer-upright-defence.png'],

  // --- G_Idle без расшифровки читается как мусор: G = gold
  ['G_Idle.png', 'gold-resource-idle.png'],
  ['G_Idle_(NoShadow).png', 'gold-resource-idle-no-shadow.png'],

  // --- опечатка в паке («pickaxet») — на новых файлах сразу чистая
  ['pawn_run_iron_pickaxet.png', 'pawn-run-iron-pickaxe.png'],
  ['pawn_run_rock_pickaxet.png', 'pawn-run-rock-pickaxe.png'],
]);

/**
 * `Water Rocks_01` → `water-rocks-01`, `Ogre Boss_ClubPart1` → `ogre-boss-club-part1`,
 * `G_Idle_(NoShadow)` → `g-idle-no-shadow`.
 */
function kebab(name) {
  return name
    .replace(/\.png$/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

/** Разбирает шаблон правила: `Units/{color} Units` → ['Units', '{color} Units']. */
const RULES = PREFIX_RULES.map(([from, to]) => ({ from: from.split('/'), to }));

/** Совпадает ли префикс пути пака с шаблоном правила. Возвращает найденный цвет. */
function matchPrefix(segs) {
  for (const rule of RULES) {
    if (rule.from.length > segs.length) continue;
    let color = null;
    let ok = true;
    for (let i = 0; i < rule.from.length; i++) {
      const pat = rule.from[i];
      if (pat.startsWith('{color}')) {
        // `Black Units` → 'black', `Black Pawn` → 'black', `Black Buildings` → 'black'
        const found = Object.keys(COLOR_SRC).find(
          (c) => `${COLOR_SRC[c]}${pat.slice('{color}'.length)}` === segs[i],
        );
        if (!found) { ok = false; break; }
        color = found;
      } else if (pat !== segs[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { rule, color };
  }
  return null;
}

/** Путь пака (без расширения) → путь в проекте, либо null если правила нет. */
function projectPath(srcRel) {
  const segs = srcRel.split('/');
  const file = segs.pop();
  const hit = matchPrefix(segs);
  if (!hit) return null;

  const out = hit.rule.to.replace('{color}', hit.color ?? '').split('/').filter(Boolean);
  for (const seg of segs.slice(hit.rule.from.length)) out.push(kebab(seg));
  // kebab() работает с именем без расширения — приклеиваем .png обратно
  const name = FILE_OVERRIDES.get(file) ?? `${kebab(file)}.png`;
  return [...out, name].join('/');
}

// --------------------------------------------------------------- обход пака

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function walk(dir, rel = '', out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.includes(r)) continue;
      walk(path.join(dir, entry.name), r, out);
    } else if (entry.name.toLowerCase().endsWith('.png')) {
      out.push(r);
    }
  }
  return out;
}

const packFiles = walk(SRC_ROOT).sort();

/**
 * Папки пака, содержимое которых дословно повторяет другие разделы:
 * `Terrain/Resources/Pawn/<Цвет> Pawn` = `Units/<Цвет> Units/Pawn` — одни и те же
 * 100 картинок в двух местах пака. Копии не импортируются: из этой папки берутся
 * только те спрайты, которых в units нет (18 чёрных пешек с iron/rock-инструментами).
 *
 * Сравнение идёт по содержимому всего пака, а не по наличию файла в проекте,
 * поэтому результат не зависит ни от порядка обхода, ни от того, с нуля ли
 * импортируется проект: копию всегда выигрывает раздел вне DEDUPE_DIRS.
 * Если бы сравнение шло по диску, при импорте с нуля можно было бы выиграть
 * «не тем» файлом — и сломать пути, на которые ссылается код.
 */
const DEDUPE_DIRS = ['Terrain/Resources/Pawn', 'Pawn and Resources/Pawn'];

const inDedupDir = (src) => DEDUPE_DIRS.some((d) => src.startsWith(`${d}/`));

const packHashes = new Map(packFiles.map((src) => [src, sha256(path.join(SRC_ROOT, src))]));
/** хеш → путь пака вне помеченных папок (первый попавшийся) */
const canonicalByHash = new Map();
for (const src of packFiles) {
  const h = packHashes.get(src);
  if (!inDedupDir(src) && !canonicalByHash.has(h)) canonicalByHash.set(h, src);
}

/** @type {Array<{src: string, dst: string}>} */
const MAP = [];
const unmapped = [];
const dupeCopy = [];
const skippedByRule = [];
const collisions = new Map();

for (const src of packFiles) {
  if (SKIP_FILES.some((re) => re.test(src))) { skippedByRule.push(src); continue; }
  if (inDedupDir(src)) {
    const twin = canonicalByHash.get(packHashes.get(src));
    if (twin) { dupeCopy.push([src, twin]); continue; }
  }
  const dst = projectPath(src);
  if (!dst) { unmapped.push(src); continue; }
  const clash = collisions.get(dst);
  if (clash) collisions.set(dst, [clash, src]);
  else collisions.set(dst, src);
  MAP.push({ src, dst });
}

if (unmapped.length) {
  console.error(`\nНет правила для ${unmapped.length} файлов пака — импорт прерван:`);
  for (const src of unmapped) console.error(`  ${src}`);
  console.error('\nДобавь правило в PREFIX_RULES и повтори.');
  process.exit(1);
}
const dupTargets = [...collisions].filter(([, v]) => Array.isArray(v));
if (dupTargets.length) {
  console.error(`\n${dupTargets.length} целевых путей получили по два файла — импорт прерван:`);
  for (const [dst, v] of dupTargets) console.error(`  ${dst}: ${v.join('  ←  ')}`);
  process.exit(1);
}

// --------------------------------------------------------------- проверки

/** В проекте допустимы только lowercase ASCII: пути едут в zip для Yandex и в git. */
const BAD_DST = /[^a-z0-9./-]/;

for (const { src, dst } of MAP) {
  if (BAD_DST.test(dst)) {
    console.error(`\nНедопустимое имя в проекте: ${dst}  ←  ${src}`);
    process.exit(1);
  }
}

// --------------------------------------------------------------- diff

const added = [];
const changed = [];
const same = [];
/** хеш → путь в проекте: нужен, чтобы отметить содержимые дубликаты. */
const dstByHash = new Map();

function walkProject(dir, rel = '', out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walkProject(path.join(dir, entry.name), r, out);
    else if (entry.name.toLowerCase().endsWith('.png')) out.push(r);
  }
  return out;
}

for (const rel of walkProject(DST_ROOT)) {
  const hash = sha256(path.join(DST_ROOT, rel));
  if (!dstByHash.has(hash)) dstByHash.set(hash, rel);
}

for (const { src, dst } of MAP) {
  const srcFile = path.join(SRC_ROOT, src);
  const dstFile = path.join(DST_ROOT, dst);
  const srcHash = sha256(srcFile);

  if (!fs.existsSync(dstFile)) {
    added.push({ src, dst, srcHash, dupeOf: dstByHash.get(srcHash) });
    continue;
  }
  if (sha256(dstFile) !== srcHash) {
    changed.push({ src, dst, before: fs.statSync(dstFile).size, after: fs.statSync(srcFile).size });
    continue;
  }
  same.push(dst);
}

/** Файлы проекта, которых нет в карте: их не трогаем, но показываем. */
const mappedDst = new Set(MAP.map((m) => m.dst));
const orphanDst = walkProject(DST_ROOT).filter((r) => !mappedDst.has(r)).sort();

// --------------------------------------------------------------- отчёт

const dupes = added.filter((a) => a.dupeOf);

console.log(`источник : ${SRC_ROOT}`);
console.log(`приёмник : ${path.relative(ROOT, DST_ROOT)}`);
console.log(`PNG в паке: ${packFiles.length} (справочник Unity пропущен)`);
console.log(`в карте  : ${MAP.length}${dupeCopy.length || skippedByRule.length ? ` (пропущено: ${dupeCopy.length} копий${skippedByRule.length ? `, ${skippedByRule.length} по списку` : ''})` : ''}`);
console.log(`совпали  : ${same.length}`);
console.log(`новые    : ${added.length}${dupes.length ? ` (из них ${dupes.length} — содержимые дубликаты)` : ''}`);
console.log(`изменились: ${changed.length}`);

if (dupeCopy.length) {
  console.log(`\nпропущены копии содержимого (${DEDUPE_DIRS.join(', ')} — те же картинки есть в других разделах пака):`);
  const byTwin = new Map();
  for (const [src, twin] of dupeCopy) {
    if (!byTwin.has(twin)) byTwin.set(twin, []);
    byTwin.get(twin).push(src);
  }
  console.log(`  ${byTwin.size} уникальных файлов в других разделах, ${dupeCopy.length} копий`);
  for (const [twin, copies] of [...byTwin].slice(0, 3)) {
    console.log(`    ${twin}\n      ← ${copies.length} копий, например ${copies[0]}`);
  }
  if (byTwin.size > 3) console.log(`    … и ещё ${byTwin.size - 3} таких файлов`);
}

if (changed.length) {
  console.log('\nизменились (проект ← пак):');
  for (const { dst, src, before, after } of changed) {
    console.log(`  ${dst.padEnd(56)} ${String(before).padStart(7)} → ${String(after).padStart(7)}   ← ${src}`);
  }
}
if (added.length) {
  const groups = new Map();
  for (const { dst } of added) {
    const top = dst.split('/').slice(0, 2).join('/');
    groups.set(top, (groups.get(top) ?? 0) + 1);
  }
  console.log('\nновые файлы по разделам:');
  for (const [top, n] of [...groups].sort()) console.log(`  ${String(n).padStart(4)}  ${top}/`);
  console.log('\nсписок (путь проекта ← путь пака):');
  for (const { dst, src } of added) console.log(`  ${dst.padEnd(56)} ← ${src}`);
}
if (orphanDst.length) {
  console.log(`\nв проекте есть файлы, которых нет в паке (${orphanDst.length}) — не удаляются:`);
  for (const r of orphanDst) console.log('  ' + r);
}
if (LIST_EXTRA) {
  const skipped = [];
  (function walkSkipped(dir, rel = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (SKIP_DIRS.includes(r)) {
        const full = path.join(SRC_ROOT, r);
        const n = walkAll(full).length;
        skipped.push(`${r}/* — ${n} файлов`);
        continue;
      }
      if (entry.isDirectory()) walkSkipped(path.join(dir, entry.name), r);
    }
  })(SRC_ROOT);
  function walkAll(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walkAll(path.join(dir, e.name)) : [e.name]);
  }
  const others = ['.meta', '.anim', '.controller', '.DS_Store', '.aseprite'].map((ext) => {
    let n = 0;
    const count = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) count(path.join(dir, e.name));
        else if (e.name.endsWith(ext)) n++;
      }
    };
    count(SRC_ROOT);
    return `${ext} — ${n}`;
  });
  console.log('\nпропущено намеренно:');
  for (const line of [...skipped, ...others]) console.log('  ' + line);
  if (dupeCopy.length) console.log(`  копии содержимого — ${dupeCopy.length} файлов (см. отчёт выше)`);
}

if (!WRITE) {
  if (added.length || changed.length) {
    console.log('\nЭто сухая проверка. Повторить с --write, чтобы применить.');
    process.exit(2);
  }
  console.log('\nРасхождений нет: проект совпадает с паком байт в байт.');
  process.exit(0);
}

// --------------------------------------------------------------- запись

if (!added.length && !changed.length) {
  console.log('\nНечего писать: проект совпадает с паком байт в байт.');
  process.exit(0);
}

let written = 0;
for (const { src, dst } of [...added, ...changed]) {
  const dstFile = path.join(DST_ROOT, dst);
  fs.mkdirSync(path.dirname(dstFile), { recursive: true });
  fs.copyFileSync(path.join(SRC_ROOT, src), dstFile);
  if (sha256(dstFile) !== sha256(path.join(SRC_ROOT, src))) {
    console.error(`\nКопирование не совпало: ${dst}`);
    process.exit(1);
  }
  written++;
}

// Финальная сверка: каждый файл карты совпадает с паком.
for (const { src, dst } of MAP) {
  if (sha256(path.join(DST_ROOT, dst)) !== sha256(path.join(SRC_ROOT, src))) {
    console.error(`\nИтоговая проверка не прошла: ${dst}  ←  ${src}`);
    process.exit(1);
  }
}

console.log(`\nЗаписано файлов: ${written}. Итоговая сверка ${MAP.length}/${MAP.length} — ок.`);