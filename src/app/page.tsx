'use client';

import dynamic from 'next/dynamic';
import { Swords, Trophy, Heart, Zap, Users, Flame, ChevronRight } from 'lucide-react';
import GameOverDialog from '@/components/game/GameOverDialog';
import Leaderboard from '@/components/game/Leaderboard';
import MetaStatsPanel from '@/components/game/MetaStats';
import AchievementsPanel from '@/components/game/Achievements';

const GameCanvas = dynamic(() => import('@/components/game/GameCanvas'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center bg-[#274b6d]">
      <div className="flex flex-col items-center gap-3 text-amber-200/70">
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

const HIGHLIGHTS = [
  {
    icon: Users,
    title: '3 героя',
    desc: 'Воин, Лучница и Копейщик — у каждого своё оружие и стиль',
  },
  {
    icon: Flame,
    title: '2 сложности',
    desc: '«Поход» для расслабленной охоты и «Кошмар» ×1.6 очков',
  },
  {
    icon: Zap,
    title: '7 оружий + 9 бонусов',
    desc: 'Вихрь меча, стрелы, копья, молот, бомбы, аура и ножи',
  },
];

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col bg-gradient-to-b from-sky-100 via-amber-50 to-emerald-50">
      {/* Шапка */}
      <header className="relative border-b-2 border-amber-900/20 bg-gradient-to-r from-amber-100/95 via-amber-50/95 to-amber-100/95 backdrop-blur">
        {/* Декоративный верхний кант */}
        <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-emerald-500/60 via-amber-500/80 to-red-500/60" />
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="relative flex h-12 w-12 items-center justify-center rounded-lg border-2 border-amber-800/40 bg-gradient-to-b from-amber-200 to-amber-400 shadow-inner">
              <Swords className="h-7 w-7 text-amber-900" aria-hidden />
              <span className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-amber-900/30 bg-red-600 text-[10px] font-bold text-white shadow">
                3
              </span>
            </div>
            <div>
              <h1 className="text-xl font-black leading-none tracking-wide text-amber-900 sm:text-2xl">
                TINY SWORD SURVIVORS
              </h1>
              <p className="mt-1 text-xs text-amber-800/70">
                bullet-heaven роглайк • клон Vampire Survivors • Phaser 4
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-700/30 bg-emerald-100 px-3 py-1 font-medium text-emerald-900">
              <Heart className="h-3.5 w-3.5" aria-hidden /> 15 минут до победы
            </span>
            <span className="inline-flex items-center gap-1 rounded-full border border-red-700/30 bg-red-100 px-3 py-1 font-medium text-red-900">
              <Flame className="h-3.5 w-3.5" aria-hidden /> Кошмар ×1.6
            </span>
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-700/30 bg-amber-100 px-3 py-1 font-medium text-amber-900">
              <Zap className="h-3.5 w-3.5" aria-hidden /> 7 оружий • 9 бонусов
            </span>
          </div>
        </div>
      </header>

      {/* Основной контент */}
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-5">
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
          {/* Игровое поле */}
          <section aria-label="Игра" className="min-w-0">
            <div className="relative overflow-hidden rounded-xl border-4 border-amber-900/50 bg-sky-800 shadow-[0_10px_30px_-10px_rgba(80,40,10,0.5)]">
              {/* Уголки-декор рамки */}
              <div className="pointer-events-none absolute left-2 top-2 z-10 h-4 w-4 border-l-2 border-t-2 border-amber-300/40" aria-hidden />
              <div className="pointer-events-none absolute right-2 top-2 z-10 h-4 w-4 border-r-2 border-t-2 border-amber-300/40" aria-hidden />
              <div className="pointer-events-none absolute bottom-2 left-2 z-10 h-4 w-4 border-b-2 border-l-2 border-amber-300/40" aria-hidden />
              <div className="pointer-events-none absolute bottom-2 right-2 z-10 h-4 w-4 border-b-2 border-r-2 border-amber-300/40" aria-hidden />
              <div className="h-[70vh] min-h-[420px] w-full sm:h-[76vh]">
                <GameCanvas />
              </div>
            </div>

            {/* Подсказки управления */}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {CONTROLS.map((c) => (
                <span
                  key={c.keys}
                  className="inline-flex items-center gap-2 rounded-lg border border-amber-900/25 bg-white/70 px-3 py-1.5 text-xs text-amber-900 shadow-sm"
                >
                  <kbd className="rounded border border-amber-900/30 bg-amber-100 px-1.5 py-0.5 font-mono text-[11px] font-bold">
                    {c.keys}
                  </kbd>
                  {c.label}
                </span>
              ))}
            </div>

            {/* Что нового */}
            <div className="mt-4 grid gap-2 sm:grid-cols-3">
              {HIGHLIGHTS.map((h) => (
                <div
                  key={h.title}
                  className="rounded-lg border-2 border-amber-900/15 bg-white/60 p-3 shadow-sm"
                >
                  <p className="flex items-center gap-1.5 text-sm font-bold text-amber-900">
                    <h.icon className="h-4 w-4 text-amber-700" aria-hidden />
                    {h.title}
                  </p>
                  <p className="mt-1 text-[11px] leading-relaxed text-amber-900/70">{h.desc}</p>
                </div>
              ))}
            </div>

            <p className="mt-3 flex items-start gap-1.5 text-sm leading-relaxed text-amber-900/70">
              <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden />
              <span>
                Герой атакует автоматически: собирай кристаллы опыта, выбирай улучшения на каждом
                уровне и выживи 15 минут, чтобы встретиться с Чёрным Копейщиком. Элиты ждут на
                5-й и 10-й минуте, а бочки-камикадзе охотятся за тобой с 4-й!
              </span>
            </p>
          </section>

          {/* Сайдбар: прогресс, рекорды */}
          <aside aria-label="Прогресс и таблица рекордов" className="space-y-4">
            <Leaderboard />
            <MetaStatsPanel />
            <AchievementsPanel />
            <div className="rounded-xl border-2 border-amber-900/25 bg-white/60 p-4">
              <h3 className="mb-2 flex items-center gap-2 text-sm font-bold text-amber-900">
                <Trophy className="h-4 w-4" aria-hidden /> Формула счёта
              </h3>
              <ul className="space-y-1 text-xs text-amber-900/75">
                <li>• 10 очков за убийство</li>
                <li>• 100 очков за минуту выживания</li>
                <li>• 50 очков за уровень героя</li>
                <li>• +5000 за победу над боссом</li>
                <li>• золото, криты и «Кошмар» — множители!</li>
              </ul>
            </div>
          </aside>
        </div>
      </main>

      {/* Футер (прижат к низу) */}
      <footer className="mt-auto border-t-2 border-amber-900/20 bg-amber-100/90 pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-4 text-xs text-amber-900/70">
          <span>
            Ассеты:{' '}
            <a
              href="https://pixelfrog-assets.itch.io/tiny-swords"
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-amber-800 underline decoration-amber-700/40 underline-offset-2 transition-colors hover:text-amber-900"
            >
              Tiny Swords © Pixel Frog
            </a>
          </span>
          <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="rounded-full border border-amber-800/20 bg-white/50 px-2 py-0.5 font-mono text-[10px]">
              v1.2 · R3
            </span>
            <span>Движок: Phaser 4 • Next.js 16 • Сделано с ❤️ и мечом</span>
          </span>
        </div>
      </footer>

      {/* Диалог конца матча */}
      <GameOverDialog />
    </div>
  );
}
