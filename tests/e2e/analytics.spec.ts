import { expect, test, type Page } from '@playwright/test';

const startupTimeout = 60_000;

async function openGame(page: Page, query = ''): Promise<void> {
  await page.goto(`/?lang=en&ysdk=mock${query}`);
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });
}

test('debug overlay streams analytics and protects sessionIdx', async ({ page }) => {
  await openGame(page, '&debug=1');
  const overlay = page.locator('#tss-analytics-debug');
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText('session_start');
  const result = await page.evaluate(async () => {
    const url = new URL('/src/platform/analytics.ts', location.origin).href;
    const a = await import(/* @vite-ignore */ url) as {
      track: (event: 'run_start', params: Record<string, unknown>) => void;
      getAnalyticsSnapshot: () => Array<{ e: string; p: Record<string, unknown> }>;
    };
    a.track('run_start', { hero: 'qa', seed: 42, sessionIdx: 999 });
    const last = a.getAnalyticsSnapshot().at(-1);
    return { event: last?.e, params: last?.p };
  });
  expect(result.event).toBe('run_start');
  expect(result.params?.hero).toBe('qa');
  expect(result.params?.seed).toBe(42);
  expect(result.params?.sessionIdx).not.toBe(999);
  await expect(overlay).toContainText('run_start');
});

test('A/B assignment is deterministic and persisted in MetaState.flags', async ({ page }) => {
  await openGame(page);
  const result = await page.evaluate(async () => {
    const url = new URL('/src/game/meta.ts', location.origin).href;
    const m = await import(/* @vite-ignore */ url) as {
      getOrAssignExperimentVariant: (experiment: string, identity: string, variants: readonly string[]) => string;
      loadMetaState: () => { flags: Record<string, string> };
    };
    const first = m.getOrAssignExperimentVariant('qa-persistence', 'stable-test-profile', ['control', 'soft']);
    const second = m.getOrAssignExperimentVariant('qa-persistence', 'stable-test-profile', ['control', 'soft']);
    const raw = localStorage.getItem('tss-meta2');
    return { first, second, stored: m.loadMetaState().flags['ab:qa-persistence'], localHasFlag: raw?.includes('"ab:qa-persistence"') ?? false };
  });
  expect(['control', 'soft']).toContain(result.first);
  expect(result.second).toBe(result.first);
  expect(result.stored).toBe(result.first);
  expect(result.localHasFlag).toBe(true);
});

test('run archive includes the current run and its numeric seed', async ({ page }) => {
  await openGame(page);
  const result = await page.evaluate(async () => {
    const url = new URL('/src/platform/analytics.ts', location.origin).href;
    const a = await import(/* @vite-ignore */ url) as {
      beginRun: () => void;
      track: (event: 'run_start', params: Record<string, unknown>) => void;
      flushRunTelemetry: () => void;
      exportBuffer: () => string;
    };
    a.beginRun();
    a.track('run_start', { seed: 145982 });
    a.flushRunTelemetry();
    return JSON.parse(a.exportBuffer()) as { runs: Array<Array<{ e: string; p: Record<string, unknown> }>> };
  });
  expect(result.runs.length).toBeGreaterThan(0);
  const latest = result.runs.at(-1);
  expect(latest?.some((event) => event.e === 'run_start' && event.p.seed === 145982)).toBe(true);
});

test('delivery to Metrica stays disabled if platform delivery is not enabled', async ({ page }) => {
  await page.addInitScript(() => {
    const probe = window as unknown as { __ymCalls: number; ym: () => void };
    probe.__ymCalls = 0;
    probe.ym = () => { probe.__ymCalls += 1; };
  });
  await openGame(page);
  const calls = await page.evaluate(async () => {
    const url = new URL('/src/platform/analytics.ts', location.origin).href;
    const a = await import(/* @vite-ignore */ url) as {
      initAnalytics: (options: { dev: boolean; ymId: number; platformEnabled: boolean }) => void;
      track: (event: 'run_start', params: Record<string, unknown>) => void;
    };
    a.initAnalytics({ dev: false, ymId: 123456, platformEnabled: false });
    a.track('run_start', { hero: 'qa' });
    return (window as unknown as { __ymCalls: number }).__ymCalls;
  });
  expect(calls).toBe(0);
});
