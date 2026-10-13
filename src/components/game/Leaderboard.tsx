'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

interface ScoreRow {
  id: number;
  name: string;
  score: number;
  kills: number;
  level: number;
  timeSurvived: number;
  victory: boolean;
  createdAt: string;
}

export default function Leaderboard() {
  const [rows, setRows] = useState<ScoreRow[] | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/scores?limit=10', { cache: 'no-store' });
      if (!res.ok) throw new Error('load failed');
      const data: ScoreRow[] = await res.json();
      setRows(data);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const onUpdate = (): void => { void load(); };
    window.addEventListener('tss-scores-updated', onUpdate);
    return () => window.removeEventListener('tss-scores-updated', onUpdate);
  }, [load]);

  const fmtTime = (t: number): string =>
    `${Math.floor(t / 60)}:${Math.floor(t % 60).toString().padStart(2, '0')}`;

  return (
    <div className="rounded-xl border-2 border-amber-900/25 bg-gradient-to-b from-amber-50/80 to-amber-100/60 p-4 shadow-inner">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-lg font-bold text-amber-900">🏆 Зал славы</h3>
        <Button
          size="sm"
          variant="outline"
          className="h-8 border-amber-800/40 text-amber-900"
          onClick={() => void load()}
          aria-label="Обновить таблицу рекордов"
        >
          Обновить
        </Button>
      </div>

      {error && (
        <p className="py-6 text-center text-sm text-red-600">
          Не удалось загрузить рекорды. Попробуй обновить.
        </p>
      )}

      {!error && rows === null && (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full bg-amber-200/50" />
          ))}
        </div>
      )}

      {!error && rows !== null && rows.length === 0 && (
        <p className="py-6 text-center text-sm text-amber-800/70">
          Пока никто не сражался. Стань первым героем!
        </p>
      )}

      {!error && rows !== null && rows.length > 0 && (
        <div className="max-h-96 overflow-y-auto pr-1 [scrollbar-width:thin]">
          <Table>
            <TableHeader className="sticky top-0 bg-amber-100/95">
              <TableRow className="border-amber-900/20 hover:bg-transparent">
                <TableHead className="w-8 text-amber-900">#</TableHead>
                <TableHead className="text-amber-900">Герой</TableHead>
                <TableHead className="text-right text-amber-900">Счёт</TableHead>
                <TableHead className="text-right text-amber-900">Убийств</TableHead>
                <TableHead className="text-right text-amber-900">Время</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow
                  key={r.id}
                  className="border-amber-900/10 hover:bg-amber-200/40"
                >
                  <TableCell className="font-semibold text-amber-800">{i + 1}</TableCell>
                  <TableCell className="font-medium">
                    {r.name}
                    {r.victory && <span className="ml-1" title="Победа">⭐</span>}
                  </TableCell>
                  <TableCell className="text-right font-bold tabular-nums text-amber-800">
                    {r.score.toLocaleString('ru-RU')}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.kills}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtTime(r.timeSurvived)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
