import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end smoke tests for the Phaser game.
 * Chromium runs desktop and mobile viewports to catch startup/layout regressions.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 1,
  // Игра держит в памяти WebGL-контекст и ~150 МБ ассетов. При 2+ воркерах
  // headless-Chromium на CI упирался в память и падал с «Target page … has
  // been closed» — тесты выглядели поломками приложения. Один воркер
  // проходит весь набор детерминированно.
  workers: 1,
  // Игра грузит ~1.5 МБ ассетов через dev-сервер Vite: холодная трансформация
  // первого воркера занимает до 60 сек, и при fullyParallel второй тест
  // успевал выйти по дефолтному таймауту, не дождавшись канваса. Это
  // выглядело как падение приложения, хотя старт занимает ~6 сек.
  // Бюджет теста покрывает и холодный старт (startupTimeout в спеках — 60 сек),
  // и сам сценарий, поэтому он заметно больше таймаута одного ожидания.
  timeout: 150_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }]]
    : 'list',
  use: {
    baseURL: 'http://127.0.0.1:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Локальные прогоны: channel chrome (--enable-gpu) даёт аппаратный WebGL-рендер.
    // Собранный headless-shell рисует через SwiftShader на CPU (~30 мс/кадр — ядро под
    // загрузкой весь прогон, игровой цикл держит лишь 24–37 fps); с реальным GPU
    // main thread занят на единицы процентов. На CI-агентах (Linux без GPU) блок
    // не применяется: там от флага всё равно откатываются на софт-рендер, а
    // channel 'chrome' потребовал бы установленного Chrome.
    ...(process.env.CI
      ? {}
      : { channel: 'chrome', launchOptions: { args: ['--enable-gpu', '--ignore-gpu-blocklist'] } }),
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium-mobile',
      use: { ...devices['Pixel 7'] },
    },
  ],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1',
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: !process.env.CI,
    // Старт dev-сервера: Vite поднимается быстро, но первый запрос
    // трансформирует весь граф модулей — запас нужен на холодный старт.
    timeout: 90_000,
  },
});
