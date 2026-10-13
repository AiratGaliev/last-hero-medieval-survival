'use client';

import { useEffect, useState } from 'react';
import { Swords, Trophy, Skull, Crown, Coins, Clock } from 'lucide-react';
import { loadMeta, type MetaStats } from '@/game/achievements';

const EMPTY: MetaStats = { matches: 0, victories: 0, kills: 0, gold: 0, bestScore: 0, playTime: 0 };

function fmtTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h} ч ${m} м`;
  return `${m} мин`;
}

export default function MetaStatsPanel() {
  const [meta, setMeta] = useState<MetaStats>(EMPTY);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const refresh = (): void => {
      setMeta(loadMeta());
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

  const items = [
    { icon: Swords, label: 'Матчей', value: meta.matches, color: 'text-amber-800' },
    { icon: Crown, label: 'Побед', value: meta.victories, color: 'text-yellow-700' },
    { icon: Skull, label: 'Убийств', value: meta.kills, color: 'text-red-800' },
    { icon: Coins, label: 'Золота', value: meta.gold, color: 'text-amber-700' },
    { icon: Trophy, label: 'Рекорд', value: meta.bestScore, color: 'text-emerald-800' },
    { icon: Clock, label: 'В игре', value: fmtTime(meta.playTime), color: 'text-stone-700' },
  ];

  const winRate = meta.matches > 0 ? Math.round((meta.victories / meta.matches) * 100) : 0;

  return (
    <div className="rounded-xl border-2 border-amber-900/25 bg-gradient-to-b from-amber-50/80 to-amber-100/60 p-4 shadow-inner">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-bold text-amber-900">
          <Swords className="h-4 w-4" aria-hidden /> Хроника воина
        </h3>
        {ready && meta.matches > 0 && (
          <span className="rounded-full border border-emerald-700/30 bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-900">
            винрейт {winRate}%
          </span>
        )}
      </div>

      {!ready || (meta.matches === 0 && meta.kills === 0) ? (
        <p className="py-2 text-center text-xs leading-relaxed text-amber-800/70">
          Статистика появится после первого матча.
          <br />
          Данные хранятся в этом браузере.
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-2">
          {items.map((it) => (
            <li
              key={it.label}
              className="flex items-center gap-2 rounded-lg border border-amber-900/15 bg-white/70 px-2.5 py-2"
            >
              <it.icon className={`h-4 w-4 shrink-0 ${it.color}`} aria-hidden />
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-wide text-amber-900/60">{it.label}</p>
                <p className={`truncate text-sm font-bold tabular-nums ${it.color}`}>
                  {typeof it.value === 'number' ? it.value.toLocaleString('ru-RU') : it.value}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
