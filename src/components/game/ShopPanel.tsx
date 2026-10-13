'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { loadShop, buyUpgrade, SHOP_UPGRADES, type ShopState } from '@/game/shop';

// ============ Лавка торговца: постоянные усиления за золото матчей ============

const EMPTY: ShopState = { balance: 0, upgrades: { might: 0, vitality: 0, speed: 0, magnet: 0, luck: 0 } };

export default function ShopPanel() {
  const [shop, setShop] = useState<ShopState>(EMPTY);
  const [flash, setFlash] = useState<string | null>(null);

  const read = useCallback((): ShopState => loadShop(), []);

  useEffect(() => {
    const update = (): void => setShop(read());
    window.addEventListener('tss-shop-updated', update);
    window.addEventListener('tss-meta-updated', update);
    // Первый срез данных — после монтирования (без синхронного setState в эффекте)
    const raf = requestAnimationFrame(update);
    return () => {
      window.removeEventListener('tss-shop-updated', update);
      window.removeEventListener('tss-meta-updated', update);
      cancelAnimationFrame(raf);
    };
  }, [read]);

  const buy = (id: 'might' | 'vitality' | 'speed' | 'magnet' | 'luck'): void => {
    const res = buyUpgrade(id);
    if (res.ok) {
      setFlash(id);
      window.setTimeout(() => setFlash(null), 700);
    }
    setShop(read());
  };

  return (
    <div className="rounded-xl border-2 border-amber-900/25 bg-gradient-to-b from-amber-50/90 to-amber-100/70 p-4 shadow-sm">
      <h3 className="mb-1 flex items-center gap-2 text-sm font-bold text-amber-900">
        <img src="/assets/game/icon-coin.png" alt="" className="h-5 w-5" aria-hidden />
        Лавка торговца
      </h3>
      <p className="mb-3 text-[11px] leading-relaxed text-amber-900/70">
        Золото, добытое в матчах, тратится на усиления — они действуют во всех следующих забегах.
      </p>

      <div className="mb-3 flex items-center justify-between rounded-lg border-2 border-amber-800/30 bg-white/70 px-3 py-2">
        <span className="text-xs font-semibold text-amber-900/80">Кошелёк</span>
        <span className="flex items-center gap-1.5 font-black tabular-nums text-amber-700">
          <img src="/assets/game/icon-coin.png" alt="Монеты" className="h-4 w-4" />
          {shop.balance.toLocaleString('ru-RU')}
        </span>
      </div>

      <ul className="space-y-2">
        {SHOP_UPGRADES.map((u) => {
          const lvl = shop.upgrades[u.id];
          const maxed = lvl >= 3;
          const price = maxed ? null : u.costs[lvl];
          const affordable = price !== null && shop.balance >= price;
          return (
            <li
              key={u.id}
              className={`flex items-center gap-3 rounded-lg border-2 px-3 py-2 transition-colors ${
                flash === u.id
                  ? 'border-emerald-500/60 bg-emerald-50'
                  : 'border-amber-800/20 bg-white/60'
              }`}
            >
              <img src={`/assets/game/${u.icon}.png`} alt="" className="h-9 w-9 shrink-0" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-bold text-amber-900">{u.name}</p>
                <p className="text-[10px] leading-tight text-amber-900/65">{u.desc}</p>
                <p className="mt-1 text-[10px] tracking-widest text-amber-700" aria-label={`Уровень ${lvl} из 3`}>
                  {'●'.repeat(lvl)}{'○'.repeat(3 - lvl)}
                </p>
              </div>
              {maxed ? (
                <span className="shrink-0 rounded-md border border-emerald-700/30 bg-emerald-100 px-2 py-1 text-[10px] font-bold text-emerald-800">
                  МАКС
                </span>
              ) : (
                <Button
                  size="sm"
                  onClick={() => buy(u.id)}
                  disabled={!affordable}
                  aria-label={`Купить ${u.name} за ${price} золота`}
                  className={`h-8 shrink-0 px-3 text-[11px] font-bold ${
                    affordable
                      ? 'bg-amber-700 hover:bg-amber-800'
                      : 'cursor-not-allowed bg-amber-700/40 text-amber-50/80'
                  }`}
                >
                  {price} 🪙
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
