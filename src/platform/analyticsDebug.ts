import { getAnalyticsSnapshot, subscribeAnalytics, type BufferedEvent } from './analytics';

const OVERLAY_ID = 'tss-analytics-debug';

/** Живой журнал аналитики для QA; события нельзя изменить из интерфейса. */
export function installAnalyticsDebugOverlay(): void {
  if (!import.meta.env.DEV || typeof window === 'undefined') return;
  if (!new URLSearchParams(window.location.search).has('debug')) return;
  if (document.getElementById(OVERLAY_ID)) return;
  const root = document.createElement('aside');
  root.id = OVERLAY_ID;
  root.setAttribute('role', 'log');
  root.setAttribute('aria-label', 'Журнал событий аналитики');
  root.setAttribute('aria-live', 'polite');
  Object.assign(root.style, {
    position: 'fixed', top: '8px', right: '8px', zIndex: '100000',
    width: 'min(430px, calc(100vw - 16px))', maxHeight: '34vh',
    overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: '4px',
    padding: '8px', boxSizing: 'border-box', border: '1px solid rgba(255,255,255,.35)',
    borderRadius: '6px', background: 'rgba(12, 16, 25, .94)', color: '#e8f2ff',
    font: '12px/1.35 ui-monospace, SFMono-Regular, Consolas, monospace',
    pointerEvents: 'none', contain: 'content',
  } satisfies Partial<CSSStyleDeclaration>);
  const title = document.createElement('div');
  title.textContent = 'ANALYTICS · DEV';
  Object.assign(title.style, { color: '#88d7ff', fontWeight: '700', letterSpacing: '.06em' });
  const log = document.createElement('pre');
  Object.assign(log.style, {
    margin: '0', overflow: 'auto', whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere', maxHeight: 'calc(34vh - 32px)',
  });
  root.append(title, log);
  document.body.appendChild(root);
  const render = (events: BufferedEvent[]): void => {
    log.textContent = events.slice(-36).map((event) => {
      let params = '';
      try { params = JSON.stringify(event.p); } catch { params = '[params unavailable]'; }
      return `${new Date(event.t).toLocaleTimeString()}  ${event.e}\n${params.slice(0, 420)}`;
    }).join('\n\n');
    log.scrollTop = log.scrollHeight;
  };
  render(getAnalyticsSnapshot());
  const unsubscribe = subscribeAnalytics((event) => {
    const snapshot = getAnalyticsSnapshot();
    if (snapshot[snapshot.length - 1]?.t !== event.t) snapshot.push(event);
    render(snapshot);
  });
  window.addEventListener('pagehide', unsubscribe, { once: true });
}
