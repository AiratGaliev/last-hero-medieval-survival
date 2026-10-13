'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from '@/components/ui/dialog';

interface GameOverStats {
  victory: boolean;
  time: number;
  kills: number;
  level: number;
  gold: number;
  score: number;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export default function GameOverDialog() {
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState<GameOverStats | null>(null);
  const [name, setName] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const nameRef = useRef('');

  useEffect(() => {
    nameRef.current = name;
  }, [name]);

  useEffect(() => {
    const onGameOver = (e: Event) => {
      const detail = (e as CustomEvent<GameOverStats>).detail;
      setStats(detail);
      setSaveState('idle');
      setOpen(true);
    };
    window.addEventListener('tss-gameover', onGameOver);
    return () => window.removeEventListener('tss-gameover', onGameOver);
  }, []);

  const saveScore = async (): Promise<void> => {
    if (!stats || saveState === 'saving' || saveState === 'saved') return;
    setSaveState('saving');
    try {
      const res = await fetch('/api/scores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: (nameRef.current || 'Безымянный рыцарь').slice(0, 24),
          score: stats.score,
          kills: stats.kills,
          level: stats.level,
          timeSurvived: stats.time,
          victory: stats.victory,
        }),
      });
      if (!res.ok) throw new Error('save failed');
      setSaveState('saved');
      window.dispatchEvent(new CustomEvent('tss-scores-updated'));
    } catch {
      setSaveState('error');
    }
  };

  const restart = (): void => {
    setOpen(false);
    window.dispatchEvent(new CustomEvent('tss-restart'));
  };

  const toMenu = (): void => {
    setOpen(false);
    window.dispatchEvent(new CustomEvent('tss-menu'));
  };

  const mm = stats ? Math.floor(stats.time / 60).toString().padStart(2, '0') : '00';
  const ss = stats ? Math.floor(stats.time % 60).toString().padStart(2, '0') : '00';

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md rounded-xl border-4 border-amber-900/60 bg-gradient-to-b from-amber-50 to-amber-100 p-6">
        <DialogHeader>
          <DialogTitle className="text-center text-2xl font-bold tracking-wide">
            {stats?.victory ? '🏆 ПОБЕДА!' : '💀 Поражение'}
          </DialogTitle>
          <DialogDescription className="text-center">
            {stats?.victory
              ? 'Чёрный Копейщик повержен! Королевство спасено.'
              : 'Воин пал в бою... но память о нём жива.'}
          </DialogDescription>
        </DialogHeader>

        {stats && (
          <div className="grid grid-cols-2 gap-2 rounded-lg border-2 border-amber-800/30 bg-amber-50 p-3 text-sm">
            <span className="text-amber-900/70">Время</span>
            <span className="text-right font-semibold tabular-nums">{mm}:{ss}</span>
            <span className="text-amber-900/70">Убийств</span>
            <span className="text-right font-semibold tabular-nums">{stats.kills}</span>
            <span className="text-amber-900/70">Уровень</span>
            <span className="text-right font-semibold tabular-nums">{stats.level}</span>
            <span className="text-amber-900/70">Золото</span>
            <span className="text-right font-semibold tabular-nums">{stats.gold}</span>
            <span className="text-amber-900/70">Счёт</span>
            <span className="text-right font-bold tabular-nums text-amber-700">{stats.score.toLocaleString('ru-RU')}</span>
          </div>
        )}

        <div className="space-y-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Имя рыцаря для таблицы рекордов"
            maxLength={24}
            className="border-amber-800/40 bg-white/80"
            aria-label="Имя игрока"
          />
          {saveState === 'error' && (
            <p className="text-center text-xs text-red-600">Не удалось сохранить, попробуй ещё раз</p>
          )}
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-col">
          {saveState !== 'saved' ? (
            <Button
              onClick={() => void saveScore()}
              disabled={saveState === 'saving'}
              className="w-full bg-amber-700 hover:bg-amber-800"
            >
              {saveState === 'saving' ? 'Сохраняем...' : '💾 Сохранить рекорд'}
            </Button>
          ) : (
            <p className="w-full text-center text-sm font-semibold text-green-700">✓ Рекорд сохранён!</p>
          )}
          <div className="flex w-full gap-2">
            <Button variant="outline" className="flex-1 border-amber-800/40" onClick={toMenu}>
              🏰 В меню
            </Button>
            <Button className="flex-1 bg-emerald-700 hover:bg-emerald-800" onClick={restart}>
              ⚔️ Играть снова
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
