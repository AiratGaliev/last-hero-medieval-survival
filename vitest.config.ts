import { defineConfig } from 'vitest/config';

// Юнит-тесты чистой математики мета-состояния (node, без браузера).
// include ограничен tests/unit — tests/e2e принадлежат Playwright.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.spec.ts'],
    environment: 'node',
  },
});
