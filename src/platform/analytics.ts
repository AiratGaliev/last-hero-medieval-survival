// ============ Событийная шина аналитики (TZ §K.1) ============
//
// Ограниченный in-memory буфер, локальная очередь доставки и архив ранов.
// В Метрику отправляем только внутри настоящего Yandex Games SDK.

import { readPlayerDataValue, writePlayerDataValue } from './player';

type Params = Record<string, unknown>;
export type AnalyticsEvent =
  | 'session_start' | 'run_start' | 'run_end' | 'ab_assignment'
  | 'first_house' | 'first_barracks' | 'first_order_used' | 'economy_stuck'
  | 'siege_start' | 'siege_result' | 'building_destroyed'
  | 'pawn_wounded' | 'pawn_bleeding_start' | 'pawn_died' | 'pawn_saved'
  | 'monastery_falling' | 'monastery_collapsed'
  | 'garrison_hired' | 'garrison_lost' | 'garrison_taunt' | 'garrison_retreat' | 'garrison_kite'
  | 'ally_kill' | 'field_heal_save'
  | 'succession_shown' | 'succession_taken' | 'succession_refused'
  | 'ad_impression' | 'ad_rewarded_complete' | 'ad_error'
  | 'speedup_bought' | 'combo_milestone' | 'levelup_card_picked'
  | 'perf_fps' | 'end_screen_action' | 'hint_shown' | 'hint_dismissed'
  | 'glory_earned' | 'tree_node_bought' | 'quest_progress' | 'quest_done' | 'quest_reroll'
  | 'daily_claim' | 'daily_chest_claim' | 'challenge_start' | 'challenge_result' | 'codex_entry'
  | 'contract_signed' | 'ukaz_taken' | 'endless_start' | 'endless_death'
  | 'pass_level' | 'sku_view' | 'skin_equipped' | 'shop_refreshed'
  | 'iap_purchase' | 'iap_consume_fail';

export interface BufferedEvent { e: AnalyticsEvent; p: Params; t: number; run: number }
interface DeliveryEvent { e: AnalyticsEvent; p: Params; t: number }

const MAX_BUFFER = 400;
const MAX_RUNS = 50;
const MAX_OUTBOX = 400;
const MAX_PLAYER_DATA_CHARS = 150_000;
const RUNS_KEY = 'tss-telemetry';
const OUTBOX_KEY = 'tss-analytics-outbox';
const PLAYER_DATA_RUNS_KEY = 'tss-telemetry-runs';

let buffer: BufferedEvent[] = [];
let runCounter = 0;
let sessionIdx = 0;
let ymCounterId: number | null = null;
let platformEnabled = false;
let devLog = false;
let onlineListenerInstalled = false;
let outbox: DeliveryEvent[] = [];
let cloudPersistenceQueue: Promise<void> = Promise.resolve();
const listeners = new Set<(event: BufferedEvent) => void>();

function safeReadArray<T>(key: string): T[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(key) ?? '[]');
    return Array.isArray(value) ? value as T[] : [];
  } catch { return []; }
}
function persistOutbox(): void {
  try { window.localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox.slice(-MAX_OUTBOX))); }
  catch { /* Memory queue remains usable when storage is blocked. */ }
}
function loadOutbox(): void {
  outbox = safeReadArray<DeliveryEvent>(OUTBOX_KEY)
    .filter((item) => item && typeof item.e === 'string' && typeof item.t === 'number'
      && item.p !== null && typeof item.p === 'object')
    .slice(-MAX_OUTBOX);
}
function canAttemptDelivery(): boolean {
  if (!platformEnabled || ymCounterId === null) return false;
  try { return typeof navigator === 'undefined' || navigator.onLine !== false; }
  catch { return true; }
}
function deliver(event: DeliveryEvent): boolean {
  if (!canAttemptDelivery()) return false;
  try {
    const target = window as unknown as { ym?: (id: number, op: string, goal: string, params?: Params) => void };
    if (typeof target.ym !== 'function') return false;
    target.ym(ymCounterId!, 'reachGoal', event.e, event.p);
    return true;
  } catch { return false; }
}
function queueDelivery(event: DeliveryEvent): void {
  outbox.push(event);
  if (outbox.length > MAX_OUTBOX) outbox.splice(0, outbox.length - MAX_OUTBOX);
  persistOutbox();
}
function flushDeliveryQueue(): void {
  if (!canAttemptDelivery()) return;
  while (outbox.length > 0) {
    const next = outbox[0];
    if (!next || !deliver(next)) break;
    outbox.shift();
  }
  persistOutbox();
}
function isBufferedEvent(value: unknown): value is BufferedEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<BufferedEvent>;
  return typeof event.e === 'string' && typeof event.t === 'number'
    && typeof event.run === 'number' && event.p !== null && typeof event.p === 'object';
}
function readLocalHistory(): BufferedEvent[][] {
  return safeReadArray<BufferedEvent[]>(RUNS_KEY)
    .filter((run): run is BufferedEvent[] => Array.isArray(run))
    .map((run) => run.filter(isBufferedEvent))
    .slice(-MAX_RUNS);
}
function writeLocalHistory(history: BufferedEvent[][]): void {
  try { window.localStorage.setItem(RUNS_KEY, JSON.stringify(history.slice(-MAX_RUNS))); }
  catch { /* The in-memory buffer can still be exported. */ }
}
function mergeHistories(...histories: BufferedEvent[][][]): BufferedEvent[][] {
  const unique = new Map<string, BufferedEvent[]>();
  for (const history of histories) for (const run of history) {
    if (run.length) unique.set(JSON.stringify(run), run);
  }
  return [...unique.values()]
    .sort((a, b) => (a[0]?.t ?? 0) - (b[0]?.t ?? 0))
    .slice(-MAX_RUNS);
}
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const result = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) result[i] = binary.charCodeAt(i);
  return result;
}
async function encodeHistory(history: BufferedEvent[][]): Promise<string> {
  const json = JSON.stringify(history);
  if (typeof CompressionStream !== 'undefined') {
    try {
      const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
      const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      const compressed = `gzip:${bytesToBase64(bytes)}`;
      if (compressed.length < json.length) return compressed;
    } catch { /* Older browsers fall back to JSON. */ }
  }
  return `json:${json}`;
}
async function decodeHistory(payload: unknown): Promise<BufferedEvent[][]> {
  if (typeof payload !== 'string' || !payload) return [];
  try {
    let json: string;
    if (payload.startsWith('gzip:')) {
      if (typeof DecompressionStream === 'undefined') return [];
      const stream = new Blob([base64ToBytes(payload.slice(5))]).stream()
        .pipeThrough(new DecompressionStream('gzip'));
      json = await new Response(stream).text();
    } else {
      json = payload.startsWith('json:') ? payload.slice(5) : payload;
    }
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) return [];
    return value
      .filter((run): run is unknown[] => Array.isArray(run))
      .map((run) => run.filter(isBufferedEvent))
      .filter((run) => run.length > 0)
      .slice(-MAX_RUNS);
  } catch { return []; }
}
async function persistCloudHistory(history: BufferedEvent[][]): Promise<void> {
  if (!history.length) return;
  let limited = history.slice(-MAX_RUNS);
  let payload = await encodeHistory(limited);
  while (payload.length > MAX_PLAYER_DATA_CHARS && limited.length > 1) {
    limited = limited.slice(1);
    payload = await encodeHistory(limited);
  }
  if (payload.length <= MAX_PLAYER_DATA_CHARS) {
    await writePlayerDataValue(PLAYER_DATA_RUNS_KEY, payload);
  }
}

/** Инициализация шины: общий sessionIdx и параметры старта сессии. */
export function initAnalytics(opts?: {
  ymId?: number; dev?: boolean; platformEnabled?: boolean; newUser?: boolean; matchesTotal?: number;
}): void {
  ymCounterId = opts?.ymId && Number.isFinite(opts.ymId) && opts.ymId > 0 ? opts.ymId : null;
  platformEnabled = opts?.platformEnabled === true;
  devLog = opts?.dev ?? false;
  try {
    const key = 'tss-session-idx';
    sessionIdx = (parseInt(window.localStorage.getItem(key) ?? '0', 10) || 0) + 1;
    window.localStorage.setItem(key, String(sessionIdx));
  } catch { sessionIdx = 1; }
  loadOutbox();
  if (!onlineListenerInstalled && typeof window !== 'undefined') {
    window.addEventListener('online', flushDeliveryQueue);
    onlineListenerInstalled = true;
  }
  track('session_start', {
    new_user: opts?.newUser ?? false,
    matches_total: Math.max(0, Math.floor(opts?.matchesTotal ?? 0)),
  });
  flushDeliveryQueue();
}

/** Attach session_start and pre-run events to the first run in this session. */
export function beginRun(): void {
  const nextRun = runCounter + 1;
  for (const event of buffer) if (event.run === 0) event.run = nextRun;
  runCounter = nextRun;
}
/** sessionIdx is forced last and cannot be overwritten by caller params. */
export function track(event: AnalyticsEvent, params?: Params): void {
  const t = Date.now();
  const p = { ...(params ?? {}), sessionIdx };
  const record: BufferedEvent = { e: event, p, t, run: runCounter };
  buffer.push(record);
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);

  if (platformEnabled && ymCounterId !== null) {
    const delivery = { e: event, p, t };
    if (outbox.length > 0) {
      queueDelivery(delivery);
      flushDeliveryQueue();
    } else if (!deliver(delivery)) {
      queueDelivery(delivery);
    }
  }
  if (devLog) console.info(`[track] ${event}`, p);
  for (const listener of listeners) {
    try { listener({ ...record, p: { ...p } }); } catch { /* Observers must not affect gameplay. */ }
  }
}
export function subscribeAnalytics(listener: (event: BufferedEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function getAnalyticsSnapshot(): BufferedEvent[] {
  return buffer.slice(-MAX_BUFFER).map((event) => ({ ...event, p: { ...event.p } }));
}

/** Archive one completed run locally and asynchronously in Player Data. */
export function flushRunTelemetry(): void {
  const drained = drainRunBuffer();
  if (!drained.length) return;
  const history = readLocalHistory();
  history.push(drained);
  while (history.length > MAX_RUNS) history.shift();
  writeLocalHistory(history);
  cloudPersistenceQueue = cloudPersistenceQueue
    .then(() => persistCloudHistory(history))
    .catch(() => { /* Cloud sync must not block gameplay. */ });
}
/** Merge the cloud archive before scenes start, preserving up to 50 recent runs. */
export async function hydrateRunTelemetryFromPlayerData(): Promise<void> {
  const remote = await decodeHistory(await readPlayerDataValue(PLAYER_DATA_RUNS_KEY));
  const local = readLocalHistory();
  const merged = mergeHistories(remote, local);
  if (!merged.length) return;
  writeLocalHistory(merged);
  if (JSON.stringify(merged) !== JSON.stringify(remote)) {
    cloudPersistenceQueue = cloudPersistenceQueue
      .then(() => persistCloudHistory(merged))
      .catch(() => { /* Cloud sync is a soft dependency. */ });
  }
}
export function exportBuffer(): string {
  return JSON.stringify({ runs: readLocalHistory(), current: buffer }, null, 1);
}
export function drainRunBuffer(): BufferedEvent[] {
  const out = buffer.filter((event) => event.run === runCounter);
  buffer = buffer.filter((event) => event.run !== runCounter);
  if (buffer.length > MAX_RUNS * 10) buffer.splice(0, buffer.length - MAX_RUNS * 10);
  return out;
}
export function detectDeviceClass(): 'mobile' | 'tablet' | 'desktop' {
  if (typeof navigator === 'undefined') return 'desktop';
  const ua = navigator.userAgent;
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) return 'tablet';
  return /Android|iPhone|iPod|Mobile/i.test(ua) ? 'mobile' : 'desktop';
}
