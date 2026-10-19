import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'release/**',
      'node_modules/**',
      'docs/**',
      'src/assets/**',
      // Скрипт SDK Яндекс Игр — сторонний минифицированный код, логинить его незачем
      'public/vendor/**',
      // Инфраструктура песочницы (не часть проекта; см. .gitignore)
      'skills/**',
      '.zscripts/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ---------- Игра: браузерный код Phaser ----------
  {
    files: ['src/**/*.ts', 'vite.config.ts'],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Сцены Phaser держат состояние в полях и обращаются к нему до
      // инициализации — no-use-before-define мешает читать игровой код.
      'no-use-before-define': 'off',
      '@typescript-eslint/no-use-before-define': 'off',
      eqeqeq: ['warn', 'smart'],
      'prefer-const': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
    },
  },

  // ---------- Playwright-диагностика с кодом в двух контекстах ----------
  {
    // Скрипты QA исполняются в Node, но колбэки page.evaluate сериализуются
    // и выполняются браузером. Объявляем оба набора globals, не ослабляя
    // lint приложения.
    // `tools/` лежит вне git (см. .gitignore) и нужен только локально.
    // Глоб без папки ничего не находит и ошибкой не считается — проверено,
    // `npm run lint` зелёный и при наличии папки, и без неё.
    files: ['shop-probe.mjs', 'tools/**/*.mjs'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      'no-console': 'off',
    },
  },

  // ---------- Скрипты сборки и упаковки: Node ----------
  {
    files: ['scripts/**/*.mjs', 'scripts/**/*.js', 'playwright.config.ts', 'tests/e2e/**/*.ts'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      // Здесь console — основной способ отчитаться о результате сборки.
      'no-console': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);