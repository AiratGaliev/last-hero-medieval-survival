'use client';

import dynamic from 'next/dynamic';
import { Swords, Trophy, Heart, Zap } from 'lucide-react';
import GameOverDialog from '@/components/game/GameOverDialog';
import Leaderboard from '@/components/game/Leaderboard';

const GameCanvas = dynamic(() => import('@/components/game/GameCanvas'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center rounded-xl bg-sky-900/20">
      <div className="flex flex-col items-center gap-3 text-amber-900/70">
        <Swords className="h-10 w-10 animate-pulse" aria-hidden />
        <p className="font-semibold">Загружаем игру...</p>
      </div>
    </div>
  ),
});

const CONTROLS = [
  { keys: 'WASD / ←↑→↓', label: 'движение' },
  { keys: 'ESC / P', label: 'пауза' },
  { keys: 'M', label: 'звук' },
  { keys: 'Тач', label: 'джойстик' },
];

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col bg-gradient-to-b from-sky-100 via-amber-50 to-emerald-50">
      {/* Шапка */}
      <header className="border-b-2 border-amber-900/20 bg-gradient-to-r from-amber-100/90 via-amber-50/90 to-amber-100/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-lg border-2 border-amber-800/40 bg-gradient-to-b from-amber-200 to-amber-400 shadow-inner">
              <Swords className="h-6 w-6 text-amber-900" aria-hidden />
            </div>
            <div>
              <h1 className="text-xl font-black leading-none tracking-wide text-amber-900">
                TINY SWORD SURVIVORS
              </h1>
              <p className="mt-1 text-xs text-amber-800/70">
                bullet-heaven роглайт • клон Vampire Survivors
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-700/30 bg-emerald-100 px-3 py-1 font-medium text-emerald-900">
              <Heart className="h-3.5 w-3.5" aria-hidden /> 15 минут до победы
            </span>
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-700/30 bg-amber-100 px-3 py-1 font-medium text-amber-900">
              <Zap className="h-3.5 w-3.5" aria-hidden /> 6 оружий • 8 бонусов
            </span>
          </div>
        </div>
      </header>

      {/* Основной контент */}
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-5">
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
          {/* Игровое поле */}
          <section aria-label="Игра" className="min-w-0">
            <div className="relative overflow-hidden rounded-xl border-4 border-amber-900/50 bg-sky-800 shadow-lg">
              <div className="h-[70vh] min-h-[420px] w-full sm:h-[76vh]">
                <GameCanvas />
              </div>
            </div>

            {/* Подсказки управления */}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {CONTROLS.map((c) => (
                <span
                  key={c.keys}
                  className="inline-flex items-center gap-2 rounded-lg border border-amber-900/25 bg-white/70 px-3 py-1.5 text-xs text-amber-900"
                >
                  <kbd className="rounded border border-amber-900/30 bg-amber-100 px-1.5 py-0.5 font-mono text-[11px] font-bold">
                    {c.keys}
                  </kbd>
                  {c.label}
                </span>
              ))}
            </div>

            <p className="mt-3 text-sm leading-relaxed text-amber-900/70">
              Воин атакует автоматически: собирай кристаллы опыта, выбирай улучшения на каждом
              уровне и выживи 15 минут, чтобы встретиться с Чёрным Копейщиком. Элиты ждут на
              5-й и 10-й минуте!
            </p>
          </section>

          {/* Сайдбар: рекорды */}
          <aside aria-label="Таблица рекордов" className="space-y-4">
            <Leaderboard />
            <div className="rounded-xl border-2 border-amber-900/25 bg-white/60 p-4">
              <h3 className="mb-2 flex items-center gap-2 text-sm font-bold text-amber-900">
                <Trophy className="h-4 w-4" aria-hidden /> Формула счёта
              </h3>
              <ul className="space-y-1 text-xs text-amber-900/75">
                <li>• 10 очков за убийство</li>
                <li>• 100 очков за минуту выживания</li>
                <li>• 50 очков за уровень героя</li>
                <li>• +5000 за победу над боссом</li>
                <li>• золото и криты — в дело!</li>
              </ul>
            </div>
          </aside>
        </div>
      </main>

      {/* Футер (прижат к низу) */}
      <footer className="mt-auto border-t-2 border-amber-900/20 bg-amber-100/90 pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-4 text-xs text-amber-900/70">
          <span>
            Ассеты:{" "}
            <a
              href="https://pixelfrog-assets.itch.io/tiny-swords"
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-amber-800 underline decoration-amber-700/40 underline-offset-2 hover:text-amber-900"
            >
              Tiny Swords © Pixel Frog
            </a>
          </span>
          <span>Движок: Phaser 4 • Next.js 16 • Сделано с ❤️ и мечом</span>
        </div>
      </footer>

      {/* Диалог конца матча */}
      <GameOverDialog />
    </div>
  );
}
