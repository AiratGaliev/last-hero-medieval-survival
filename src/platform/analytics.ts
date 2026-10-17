// ============ Событийная шина аналитики (TZ §K.1) ============
//
// Единая точка телеметрии: track(event, params). Вне Yandex — no-op с
// console.table в dev-сборке (гейт-ревью), на Yandex — ym(...) reachGoal.
// Все события сессии несут sessionIdx автоматически (§K.1) — прокидывается
// здесь, не вручную. Очередь при офлайне + буфер последних ранов.

type Params = Record<string, unknown>;

export type AnalyticsEvent =
  | 'session_start' | 'run_start' | 'run_end'
  | 'first_house' | 'first_barracks' | 'first_order_used' | 'economy_stuck'
  | 'siege_start' | 'siege_result'
  | 'building_destroyed'
  | 'pawn_wounded' | 'pawn_bleeding_start' | 'pawn_died' | 'pawn_saved'
  | 'monastery_falling' | 'monastery_collapsed'
  | 'garrison_hired' | 'garrison_lost' | 'garrison_taunt'
  | 'garrison_retreat' | 'garrison_kite'
  | 'ally_kill' | 'field_heal_save'
  | 'succession_shown' | 'succession_taken' | 'succession_refused'
  | 'ad_impression' | 'ad_rewarded_complete' | 'ad_error'
  | 'speedup_bought' | 'combo_milestone' | 'levelup_card_picked'
  | 'perf_fps' | 'end_screen_action'
  | 'hint_shown' | 'hint_dismissed'
  // Раунд 2 (фазы Q/S, TZ §K.2)
  | 'glory_earned' | 'tree_node_bought' | 'quest_complete' | 'quest_reroll'
  | 'daily_bonus_claim' | 'daily_chest_claim' | 'challenge_start' | 'contract_signed' | 'ukaz_active'
  | 'endless_start' | 'pass_level' | 'sku_view' | 'skin_applied'
  | 'iap_purchase' | 'iap_consume_fail';

const MAX_BUFFER = 400;   // события последнего рана (сжатый буфер §K.1)
const MAX_RUNS = 50;      // персистентный буфер: 50 ранов (§K.1)
const RUNS_KEY = 'tss-telemetry';

interface BufferedEvent { e: AnalyticsEvent; p?: Params; t: number; run: number }

let buffer: BufferedEvent[] = [];
let runCounter = 0;
let sessionIdx = 0;
let ymCounterId: number | null = null;
let devLog = false;

/** Инициализация шины. Вызывается один раз из main.ts. */
export function initAnalytics(opts?: { ymId?: number; dev?: boolean }): void {
  ymCounterId = opts?.ymId ?? null;
  devLog = opts?.dev ?? false;
  // sessionIdx: сколько сессий в этом браузере (персистится локально).
  try {
    const k = 'tss-session-idx';
    sessionIdx = (parseInt(window.localStorage.getItem(k) ?? '0', 10) || 0) + 1;
    window.localStorage.setItem(k, String(sessionIdx));
  } catch {
    sessionIdx = 1;
  }
  track('session_start', { sessionIdx });
}

/**
 * Персистентный буфер телеметрии (§K.1): события рана уходят в localStorage
 * (SDK Яндекса подменяет его надёжным облачным хранилищем) — переживает
 * потерю сети и закрытие вкладки. Хранятся последние 50 ранов.
 */
export function flushRunTelemetry(): void {
  const drained = drainRunBuffer();
  if (drained.length === 0) return;
  try {
    const prev = JSON.parse(window.localStorage.getItem(RUNS_KEY) ?? '[]') as BufferedEvent[][];
    prev.push(drained);
    while (prev.length > MAX_RUNS) prev.shift();
    window.localStorage.setItem(RUNS_KEY, JSON.stringify(prev));
  } catch {
    // приватный режим/нет доступа — буфер в памяти всё сохранил
  }
}

/** Метка нового рана: события группируются для буфера Player Data. */
export function beginRun(): void {
  runCounter++;
}

/** Ядро: отправка события. Debounce не нужен — события редкие (<1/сек). */
export function track(event: AnalyticsEvent, params?: Params): void {
  const p = { sessionIdx, ...(params ?? {}) };
  buffer.push({ e: event, p, t: Date.now(), run: runCounter });
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);

  if (ymCounterId !== null) {
    try {
      const w = window as unknown as { ym?: (id: number, op: string, name: string, prm?: Params) => void };
      w.ym?.(ymCounterId, 'reachGoal', event, p);
    } catch {
      // Метрика недоступна — буфер всё сохранил
    }
  }
  if (devLog) console.info(`[track] ${event}`, p);
}

/** Экспорт буфера (debug `?export`): JSON персистентных + текущих событий. */
export function exportBuffer(): string {
  let persisted: BufferedEvent[][] = [];
  try {
    persisted = JSON.parse(window.localStorage.getItem(RUNS_KEY) ?? '[]') as BufferedEvent[][];
  } catch {
    // нет данных — экспортируем только текущий буфер
  }
  return JSON.stringify({ runs: persisted, current: buffer }, null, 1);
}

/** Срез событий текущего рана — для выгрузки в Player Data (§K.1). */
export function drainRunBuffer(): BufferedEvent[] {
  const out = buffer.filter((b) => b.run === runCounter);
  buffer = buffer.filter((b) => b.run !== runCounter);
  if (buffer.length > MAX_RUNS * 10) buffer.splice(0, buffer.length - MAX_RUNS * 10);
  return out;
}
