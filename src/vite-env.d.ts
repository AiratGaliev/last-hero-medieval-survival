/// <reference types="vite/client" />

/**
 * ID счётчика Яндекс Метрики (§K.1). Задаётся переменной окружения
 * `VITE_YM_ID` при сборке — без него события пишутся только в локальный
 * буфер Player Data и в Метрику не уходят.
 */
interface ImportMetaEnv {
  readonly VITE_YM_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}