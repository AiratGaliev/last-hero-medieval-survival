'use client';

import { useEffect, useRef } from 'react';
import type Phaser from 'phaser';
import { createGame } from '@/game/config';

export default function GameCanvas() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const gameRef = useRef<Phaser.Game | null>(null);

  useEffect(() => {
    let cancelled = false;

    const boot = async (): Promise<void> => {
      // Ждём пиксельный шрифт, чтобы Phaser-тексты отрисовались им сразу
      try {
        if (typeof document !== 'undefined' && document.fonts) {
          await Promise.race([
            document.fonts.load('16px "Pixelify Sans"'),
            new Promise((r) => setTimeout(r, 1200)),
          ]);
        }
      } catch {
        // шрифт недоступен — используем fallback
      }
      if (cancelled || !hostRef.current || gameRef.current) return;
      gameRef.current = createGame(hostRef.current);
      // Debug-хук для автоматического тестирования (agent-browser QA)
      (window as unknown as { __tss?: Phaser.Game }).__tss = gameRef.current;
    };

    void boot();

    return () => {
      cancelled = true;
      gameRef.current?.destroy(true);
      gameRef.current = null;
      if (hostRef.current) hostRef.current.innerHTML = '';
    };
  }, []);

  return (
    <div
      ref={hostRef}
      className="h-full w-full overflow-hidden rounded-xl [&_canvas]:block [&_canvas]:h-full [&_canvas]:w-full"
      aria-label="Игровое поле Tiny Sword Survivors"
      role="img"
    />
  );
}
