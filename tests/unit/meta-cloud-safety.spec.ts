import { beforeEach, describe, expect, it, vi } from 'vitest';

const clock = vi.hoisted(() => ({ now: Date.parse('2026-10-20T10:00:00Z') }));
const cloud = vi.hoisted(() => ({
  available: true,
  value: null as unknown,
  writes: [] as Array<{ key: string; value: unknown; flush: boolean }>,
}));

vi.mock('../../src/platform/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/platform/sdk')>();
  return { ...actual, serverNow: () => clock.now };
});

vi.mock('../../src/platform/player', () => ({
  persistExperimentFlagsToPlayerData: () => {},
  readPlayerDataEntry: async () => ({ available: cloud.available, value: cloud.value }),
  writePlayerDataValue: async (key: string, value: unknown, flush = false) => {
    cloud.writes.push({ key, value, flush });
    return true;
  },
}));

const store = new Map<string, string>();
let meta: typeof import('../../src/game/meta');

function installWindow(): void {
  const localStorage = {
    getItem: (key: string): string | null => store.get(key) ?? null,
    setItem: (key: string, value: string): void => { store.set(key, String(value)); },
    removeItem: (key: string): void => { store.delete(key); },
    clear: (): void => { store.clear(); },
  };
  (globalThis as { window?: unknown }).window = { localStorage };
}

function localState(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 2,
    savedAt: 1_000,
    matchesPlayed: 2,
    glory: 100,
    nodes: [],
    dailyBonus: { last: '2026-10-20', lastAt: clock.now, streak: 2 },
    quests: { date: '', ids: [], progress: {}, done: [], rerolls: 0 },
    ...over,
  };
}

beforeEach(async () => {
  vi.resetModules();
  store.clear();
  cloud.available = true;
  cloud.value = null;
  cloud.writes.length = 0;
  clock.now = Date.parse('2026-10-20T10:00:00Z');
  installWindow();
  store.set('tss-meta2', JSON.stringify(localState()));
  meta = await import('../../src/game/meta');
});

describe('облачные сохранения не затирают неизвестные данные', () => {
  it.each([
    [
      'неподдерживаемая версия конверта',
      { version: 2, savedAt: 9_000, state: localState({ savedAt: 9_000, matchesPlayed: 50, glory: 999 }) },
    ],
    [
      'несовпадающий savedAt',
      { version: 1, savedAt: 9_000, state: localState({ savedAt: 8_000, matchesPlayed: 50, glory: 999 }) },
    ],
    [
      'повреждённая существующая секция магазина',
      {
        version: 1,
        savedAt: 9_000,
        state: localState({ savedAt: 9_000, matchesPlayed: 50, glory: 999 }),
        shop: { balance: -1, upgrades: {} },
      },
    ],
  ])('сохраняет облако при сценарии «%s»', async (_description, envelope) => {
    cloud.value = envelope;
    await meta.hydrateMetaStateFromPlayerData();

    expect(meta.loadMetaState().matchesPlayed).toBe(2);
    expect(meta.loadMetaState().glory).toBe(100);
    expect(await meta.flushMetaStateToPlayerData()).toBe(false);
    expect(cloud.writes).toHaveLength(0);
  });

  it('инициализирует облако локальным снимком, только если облачного значения нет', async () => {
    cloud.value = null;
    await meta.hydrateMetaStateFromPlayerData();

    expect(await meta.flushMetaStateToPlayerData()).toBe(true);
    expect(cloud.writes).toHaveLength(1);
    expect(cloud.writes[0].value).toMatchObject({
      version: 1,
      state: { matchesPlayed: 2, glory: 100 },
    });
  });
});
