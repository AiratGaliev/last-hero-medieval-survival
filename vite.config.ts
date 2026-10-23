import { defineConfig } from 'vite';

// Открытый bind и отключённая проверка Host нужны только доверенной песочнице.
// В обычной разработке оставляем безопасный локальный bind и встроенный allowlist.
const sandboxServer = process.env.TSS_SANDBOX_SERVER === '1';

/**
 * Игра публикуется на Yandex Games архивом: платформа отдаёт файлы из своего
 * CDN по подкаталогу, поэтому все ссылки в собранном index.html должны быть
 * относительными (base: './'), а не вести от корня домена.
 */
export default defineConfig({
  base: './',

  // Порт 3000 удобен для локальной разработки.
  server: {
    port: 3000,
    strictPort: true,
    ...(sandboxServer
      ? {
          // Только в доверенной изолированной песочнице, где прокси приносит
          // внешний Host: включаем доступ через все интерфейсы и отключаем allowlist.
          host: true as const,
          allowedHosts: true as const,
        }
      : { host: '127.0.0.1' as const }),
  },
  preview: {
    port: 3000,
    strictPort: true,
  },

  build: {
    target: 'es2022',
    // Спрайты весят сотни килобайт — инлайнить их в бандл невыгодно,
    // но хешировать имена обязательно (cache-busting ассетов).
    assetsInlineLimit: 4096,
    // Внутри архива имена файлов не должны содержать пробелов и кириллицы
    // (требование 1.22 к загружаемым играм). Наш assetsDir и так даёт
    // безопасные ascii-имена, но проверим это на этапе сборки архива.
    assetsDir: 'assets',
    // Карта кода весит ~12 МБ и в архиве игры не нужна.
    // Для отладки: VITE_SOURCEMAP=1 npm run build
    sourcemap: process.env.VITE_SOURCEMAP === '1',
    // Единственный крупный чанк — сам Phaser (~720 КБ gzip). Код-сплитинг
    // сцен не имеет смысла: они все нужны в первую секунду загрузки.
    chunkSizeWarningLimit: 2500,
  },
});