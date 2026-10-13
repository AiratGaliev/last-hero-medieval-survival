'use client';

import { useEffect, useState } from 'react';
import { Medal, Lock } from 'lucide-react';
import { ACHIEVEMENTS, loadUnlocked } from '@/game/achievements';

export default function AchievementsPanel() {
  const [unlocked, setUnlocked] = useState<Set<string>>(new Set());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const refresh = (): void => {
      setUnlocked(loadUnlocked());
      setReady(true);
    };
    refresh();
    window.addEventListener('tss-meta-updated', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener('tss-meta-updated', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  const count = unlocked.size;
  const total = ACHIEVEMENTS.length;

  return (
    <div className="rounded-xl border-2 border-amber-900/25 bg-gradient-to-b from-amber-50/80 to-amber-100/60 p-4 shadow-inner">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-bold text-amber-900">
          <Medal className="h-4 w-4" aria-hidden /> Достижения
        </h3>
        <span className="rounded-full border border-amber-700/30 bg-amber-100 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-amber-900">
          {count} / {total}
        </span>
      </div>

      {/* Полоса прогресса */}
      <div
        className="mb-3 h-2.5 overflow-hidden rounded-full border border-amber-900/20 bg-amber-200/60"
        role="progressbar"
        aria-valuenow={count}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-label="Прогресс достижений"
      >
        <div
          className="h-full rounded-full bg-gradient-to-r from-amber-400 to-amber-600 transition-all duration-500"
          style={{ width: `${(count / total) * 100}%` }}
        />
      </div>

      <ul className="grid grid-cols-3 gap-2">
        {ACHIEVEMENTS.map((a) => {
          const has = unlocked.has(a.id);
          return (
            <li
              key={a.id}
              title={has ? `${a.name} — ${a.desc}` : `Скрытое: ${a.desc}`}
              className={`flex flex-col items-center gap-0.5 rounded-lg border px-1.5 py-2 text-center transition-colors ${
                has
                  ? 'border-amber-700/40 bg-gradient-to-b from-amber-200/90 to-amber-300/60 shadow-sm'
                  : 'border-amber-900/10 bg-white/40 opacity-60'
              }`}
            >
              <span className="text-lg leading-none" aria-hidden>
                {ready && has ? a.emoji : <Lock className="h-4 w-4 text-stone-500" aria-hidden />}
              </span>
              <span
                className={`text-[9px] font-semibold leading-tight ${
                  has ? 'text-amber-900' : 'text-stone-500'
                }`}
              >
                {a.name}
              </span>
            </li>
          );
        })}
      </ul>

      {count === total && count > 0 && (
        <p className="mt-3 text-center text-xs font-bold text-amber-700">
          👑 Все достижения собраны!
        </p>
      )}
    </div>
  );
}
