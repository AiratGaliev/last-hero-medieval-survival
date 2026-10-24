import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { armIdleThrottle, IDLE_DELAY_MS, IDLE_FPS } from '../../src/game/systems/IdleThrottle';

type Loop = { setFPSLimit(fps: number): void };
type ShutdownHandler = () => void;

const shutdownHandlers: ShutdownHandler[] = [];
const browserWindow = {
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
};

function fakeScene(loop: Loop): Parameters<typeof armIdleThrottle>[0] {
  return {
    game: { loop },
    events: {
      once: (_event: string, handler: ShutdownHandler) => shutdownHandlers.push(handler),
    },
  } as unknown as Parameters<typeof armIdleThrottle>[0];
}

describe('idle render throttle', () => {
  beforeEach(() => {
    shutdownHandlers.length = 0;
    vi.useFakeTimers();
    vi.stubGlobal('window', browserWindow);
    browserWindow.addEventListener.mockClear();
    browserWindow.removeEventListener.mockClear();
  });

  afterEach(() => {
    // Выпускаем все сцены даже при падении assertion, чтобы тесты не делили
    // состояние глобального координатора.
    for (const shutdown of [...shutdownHandlers]) shutdown();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps idle FPS when one of multiple active scenes shuts down', () => {
    let fps = 60;
    const loop: Loop & { setFPSLimit: ReturnType<typeof vi.fn> } = {
      setFPSLimit: vi.fn((next: number) => { fps = next; }),
    };
    const menu = fakeScene(loop);
    const overlay = fakeScene(loop);

    armIdleThrottle(menu);
    armIdleThrottle(overlay);

    // Два экрана делят один набор слушателей и один таймер простоя.
    expect(browserWindow.addEventListener).toHaveBeenCalledTimes(5);
    vi.advanceTimersByTime(IDLE_DELAY_MS);
    expect(fps).toBe(IDLE_FPS);

    // Программное закрытие overlay не должно оставлять глобальный loop на 60:
    // таймер простоя уже сработал и у оставшегося Menu больше нет своего таймера.
    shutdownHandlers[1]();
    expect(fps).toBe(IDLE_FPS);
    expect(browserWindow.removeEventListener).not.toHaveBeenCalled();

    // Только последняя сцена сбрасывает ограничение и снимает слушателей.
    shutdownHandlers[0]();
    expect(fps).toBe(60);
    expect(browserWindow.removeEventListener).toHaveBeenCalledTimes(5);
  });
});
