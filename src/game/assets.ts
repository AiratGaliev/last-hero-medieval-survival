// ============ Ассеты: карта «путь → URL с хешем» ============
// Файлы лежат в src/assets и подключаются через import.meta.glob, поэтому
// Vite кладёт их в dist с хешем в имени: после деплоя браузер тянет свежие
// спрайты, а не закешированные старые (раньше ассеты лежали в public/ и были
// неизменяемыми — обновление картинки незаметно ломало игру у старых клиентов).
//
// ВАЖНО: eager-glob подтягивает в dist все файлы из src/assets (642 PNG), даже
// неиспользуемые. На скорость загрузки это не влияет: Phaser грузит только те
// ключи, что перечислены в BootScene, — остальные просто лежат на диске.
// Чтобы выкинуть неиспользуемые, сузьте паттерн glob до нужных каталогов.

const RAW = import.meta.glob<string>('../assets/**/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
});

/** Два набора ассетов: исходники Tiny Swords (Pixel Frog) и производные игровые */
export type AssetPack = 'tiny-swords' | 'game';

const ASSETS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(RAW).map(([path, url]) => [
      path.replace(/^\.\.\/assets\//, ''),
      url,
    ]),
  ),
);

/**
 * Возвращает URL ассета. Бросает ошибку на этапе загрузки, если файл
 * переименован или удалён — лучше явный падёж в консоли, чем пустой спрайт.
 */
export function asset(pack: AssetPack, path: string): string {
  const url = ASSETS[`${pack}/${path}`];
  if (!url) {
    throw new Error(`[assets] не найден ассет «${pack}/${path}»`);
  }
  return url;
}

/** Диагностика: сколько ассетов реально попало в бандл (для QA). */
export function assetCount(): number {
  return Object.keys(ASSETS).length;
}