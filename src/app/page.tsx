'use client';

import dynamic from 'next/dynamic';

// Вся игра (меню, лавка, достижения, рекорды, ввод имени, HUD) живёт внутри Phaser.
// React-часть — только полноэкранный монтировочный контейнер канваса.

const GameCanvas = dynamic(() => import('@/components/game/GameCanvas'), {
  ssr: false,
  loading: () => (
    <div className="flex h-dvh w-full items-center justify-center bg-[#3f8ed0]">
      <div className="flex flex-col items-center gap-3 text-amber-100/90">
        <span className="text-5xl" aria-hidden>
          ⚔
        </span>
        <p className="animate-pulse text-lg font-semibold tracking-wide">
          Загружаем игру...
        </p>
      </div>
    </div>
  ),
});

export default function Home() {
  return (
    <main
      className="h-dvh w-full overflow-hidden bg-[#3f8ed0]"
      aria-label="Tiny Sword Survivors — игра целиком внутри Phaser"
    >
      <GameCanvas />
    </main>
  );
}
