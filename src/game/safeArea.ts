// ============ Безопасные зоны экрана ============
// На телефонах с вырезом и жестовой полосой (iPhone, часть Android) область
// `env(safe-area-inset-*)` перекрывается системным интерфейсом. Игра рисуется
// на весь экран (viewport-fit=cover), поэтому HUD обязан сам держаться
// внутри этих отступов: иначе иконки оружия и кнопка паузы оказываются под
// полосой жестов и не нажимаются.
//
// Значения берутся из CSS через скрытый зонд: браузер единственный источник
// правды, дублировать его константами бессмысленно.

const PROBE_ID = 'tss-safe-probe';

let cache: { top: number; right: number; bottom: number; left: number } | null = null;

function readInsets(): { top: number; right: number; bottom: number; left: number } {
  if (cache) return cache;
  const zero = { top: 0, right: 0, bottom: 0, left: 0 };
  if (typeof document === 'undefined' || !document.body) {
    cache = zero;
    return cache;
  }

  let probe = document.getElementById(PROBE_ID) as HTMLDivElement | null;
  if (!probe) {
    probe = document.createElement('div');
    probe.id = PROBE_ID;
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = [
      'position:fixed',
      'top:0',
      'left:0',
      'width:0',
      'height:0',
      'visibility:hidden',
      'pointer-events:none',
      'padding-top:env(safe-area-inset-top)',
      'padding-right:env(safe-area-inset-right)',
      'padding-bottom:env(safe-area-inset-bottom)',
      'padding-left:env(safe-area-inset-left)',
    ].join(';');
    document.body.appendChild(probe);
  }

  const cs = getComputedStyle(probe);
  cache = {
    top: parseFloat(cs.paddingTop) || 0,
    right: parseFloat(cs.paddingRight) || 0,
    bottom: parseFloat(cs.paddingBottom) || 0,
    left: parseFloat(cs.paddingLeft) || 0,
  };
  return cache;
}

/** Отступы безопасных зон в CSS-пикселях. */
export function safeInsets(): { top: number; right: number; bottom: number; left: number } {
  return readInsets();
}

/**
 * Нижний отступ для элементов HUD: безопасная зона плюс небольшой запас,
 * чтобы иконка не прилипала к краю.
 */
export function hudBottomInset(pad = 16): number {
  return Math.round(readInsets().bottom + pad);
}

/** Сбрасывает кэш (нужно при смене ориентации или в тестах). */
export function resetSafeInsets(): void {
  cache = null;
}
