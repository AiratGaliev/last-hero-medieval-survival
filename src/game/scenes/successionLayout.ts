// ============ Раскладка окна преемственности (TZ §F.5) ============
//
// Чистая арифметика: на входе габариты экрана и ветки, на выходе —
// координаты всех блоков. Ни Phaser, ни сцены здесь нет намеренно:
// раскладку можно прогнать без браузера — локальный инструментарий
// (tools/check-layout.mjs, папка вне git) импортирует этот же модуль и
// проверяет, что блоки не перекрываются и не вылезают за пергамент, на
// девяти типовых экранах. Одна правда на сцену и на проверку.

/** Цвет ленты-заголовка окна преемственности. */
export const RIBBON_KEY = 'ribbon-red' as const;

export interface SuccessionLayoutOpts {
  /** Есть ли живые воины на поле (открывает ветку «взять командование»). */
  living: boolean;
  /** Доступна ли ветка призыва за ресурсы/первый бесплатный призыв. */
  resources: boolean;
  /** Сколько типов воина доступно для выбора. */
  options: number;
  /** Резерв места для обучающего блока при первом показе. */
  tutorial?: boolean;
}

export interface SuccessionBlock {
  /** Идентификатор блока — чтобы сопоставить с созданным объектом. */
  id: 'surrender' | 'branch' | 'warrior' | 'grid';
  /** Центр блока по вертикали. */
  cy: number;
  /** Высота блока (у warrior включает подпись под кнопкой). */
  h: number;
  /** Верх и низ блока — для проверок и отладки. */
  top: number;
  bottom: number;
}

export interface SuccessionLayout {
  /** Габариты пергаментной панели. */
  panelW: number;
  panelH: number;
  /** Панель по центру экрана. */
  cx: number;
  cy: number;
  top: number;
  bottom: number;
  /** Низкая высота — ужимаются кегли, отступы и высота кнопок. */
  compact: boolean;
  /** Отступ от края панели до контента. */
  pad: number;
  /** Зазор между блоками. */
  gap: number;
  /** Высота кнопок и базовый кегль. */
  btnH: number;
  btnFont: number;
  /** Высота карточки выбора типа. */
  cardH: number;
  cardW: number;
  /** Радиус сетки: шаг между центрами карточек. */
  cardStep: number;
  /** Центры карточек по X. */
  cardXs: number[];
  /** Нижняя граница шапки — выше неё контент не заходит. */
  headerBottom: number;
  /** Ширина каждой из двух кнопок в ряду. */
  halfW: number;
  /** Положение ленты, подзаголовка и обучающего блока. */
  ribbonY: number;
  subtitleY: number;
  tutorialY: number;
  tutorialH: number;
  ribbonH: number;
  ribbonW: number;
  /** Ширина кнопки «сдаться». */
  surrenderW: number;
  /** Кегль заголовка на ленте. */
  titleFont: number;
  /** Высота подписи под кнопкой «живой воин». */
  captionH: number;
  /** Центр сетки выбора типа; 0, если типов нет и сетка не рисуется. */
  gridY: number;
  /** Сколько панели нужно на самом деле, без потолка. */
  neededH: number;
  /** Центры блоков, нужные сцене для расстановки объектов. */
  surrenderY: number;
  branchY: number;
  warriorY: number;
  blocks: SuccessionBlock[];
}

export function successionLayout(
  W: number, H: number, opts: SuccessionLayoutOpts,
): SuccessionLayout {
  const cx = W / 2;

  // ⚠️ Потолок по высоте НЕ фиксированный, а считается от содержимого.
  // Раньше панель всегда была 620 px, и когда доступных типов воина мало
  // (или их нет вовсе — новый аккаунт без построек), низ контента
  // прижимался к нижнему краю, а сверху оставалась пустая кремовая
  // простыня в половину экрана. «Лавка» и «Хроника» подстраиваются под
  // контент — здесь должно быть так же.
  const capH = Math.min(620, Math.floor(H * 0.94));
  const capW = Math.min(560, Math.floor(W * 0.94));

  // Габариты считаются в два прохода: сначала стек блоков от шапки вниз,
  // потом панель обтягивается вокруг него. Один проход невозможен —
  // высота панели влияет на `compact`, а `compact` — на высоту блоков.
  const measure = (panelH: number): SuccessionLayout => {
    const compact = panelH < 460;
    const pad = compact ? 14 : 24;
    const btnH = compact ? 40 : 48;
    const btnFont = compact ? 12 : 14;
    const gap = compact ? 8 : 12;
    const baseHeaderH = compact ? 54 : 66;
    const tutorialH = opts.tutorial ? (compact ? 46 : 54) : 0;
    const headerH = baseHeaderH + (tutorialH > 0 ? tutorialH + gap : 0);

    // Блоки считаются в СИСТЕМЕ ЭКРАНА, как и headerBottom: иначе при
    // «обтягивании» панели под контент координаты разъезжаются с шапкой
    // (проверка tools/check-layout.mjs это ловит; папки tools/ может не быть).
    const panelTop = (H - panelH) / 2;
    const blocks: SuccessionBlock[] = [];
    let y = panelTop + panelH - pad;
    const slot = (id: SuccessionBlock['id'], h: number): number => {
      const cy = y - h / 2;
      blocks.push({ id, cy, h, top: cy - h / 2, bottom: cy + h / 2 });
      y -= h + gap;
      return cy;
    };

    const surrenderH = btnH;
    const surrenderY = slot('surrender', surrenderH);
    const branchY = slot('branch', btnH);

    // Строка выбора резервируется для живого воина и/или призыва за ресурсы.
    // При отсутствии живого кандидата ресурсная ветка остаётся на том же месте.
    const captionH = compact ? 11 : 14;
    const warriorH = (opts.living || opts.resources) ? btnH + (opts.living ? captionH : 0) : 0;
    const warriorY = warriorH ? slot('warrior', warriorH) : y + gap - btnH / 2;

    const n = Math.max(0, opts.options);
    const headerBottom = panelTop + headerH;
    const cardW = Math.min(124, Math.floor((capW - pad * 2 - Math.max(0, n - 1) * 10) / Math.max(1, n)));
    let cardStep = 0;
    let cardXs: number[] = [];
    let cardH = 0;
    let gridY = 0;
    // Сетка рисуется, только когда есть из чего выбирать. На новом аккаунте
    // без построек типов воина нет, и пустая сетка оставляла в панели
    // мёртвую полосу в треть высоты.
    if (n > 0) {
      const room = Math.max(compact ? 44 : 54, y - gap - headerBottom);
      cardH = Math.max(compact ? 44 : 54, Math.min(compact ? 54 : 64, room - 10));
      const gridH = cardH + 10;
      const gridCenterY = Math.min(y - gap, headerBottom + room) - gridH / 2;
      gridY = gridCenterY;
      blocks.push({
        id: 'grid', cy: gridCenterY, h: gridH,
        top: gridCenterY - gridH / 2, bottom: gridCenterY + gridH / 2,
      });
      cardStep = Math.min(cardW + 10, (capW - pad * 2) / n);
      const startX = cx - (cardStep * n - 10) / 2 + cardW / 2;
      cardXs = Array.from({ length: n }, (_, i) => startX + i * cardStep);
    }

    // Сколько панели нужно на самом деле: шапка + стек блоков + отступ снизу.
    const used = headerH + (panelTop + panelH - pad - y + gap) + pad;
    const titleFont = compact ? 18 : 22;

    return {
      panelW: capW, panelH, cx, cy: H / 2,
      top: panelTop, bottom: panelTop + panelH,
      compact, pad, gap, btnH, btnFont,
      cardH, cardW, cardStep, cardXs, gridY,
      headerBottom,
      halfW: Math.floor((capW - pad * 3 - 14) / 2),
      ribbonY: panelTop + (compact ? 22 : 28),
      subtitleY: panelTop + (compact ? 44 : 56),
      tutorialY: tutorialH > 0 ? panelTop + baseHeaderH + gap + tutorialH / 2 : 0,
      tutorialH,
      ribbonH: compact ? 42 : 50,
      ribbonW: Math.min(capW - 60, 380),
      surrenderW: Math.min(260, capW - pad * 4),
      titleFont, captionH, surrenderY, branchY, warriorY, blocks,
      neededH: used,
    };
  };

  // Минимально возможная высота панели. Формула выведена из самого стека:
  //   panelH − pad − 2·btnH − warriorH − 4·gap − gridH ≥ headerH
  // Четыре gap, потому что между блоками их три, а от верха сетки до
  // курсора — ещё один. Раньше здесь стоял минимум сетки без
  // десятипиксельного зазора карточек, и сетка всё равно наезжала на шапку.
  const minStack = (isCompact: boolean): number => {
    const p = isCompact ? 14 : 24;
    const b = isCompact ? 40 : 48;
    const g = isCompact ? 8 : 12;
    const baseHead = isCompact ? 54 : 66;
    const tutorial = opts.tutorial ? (isCompact ? 46 : 54) + g : 0;
    const head = baseHead + tutorial;
    const warrior = (opts.living || opts.resources) ? b + (opts.living ? (isCompact ? 11 : 14) : 0) : 0;
    const gridH = opts.options > 0 ? (isCompact ? 44 : 54) + 10 : 0;
    return head + gridH + warrior + 2 * b + 4 * g + 2 * p;
  };

  // Первый проход — на максимальной панели, чтобы понять `compact`.
  // Второй — на требуемой высоте; если режим compact поменялся, считаем
  // заново (один лишний проход, зато без расхождений).
  let r = measure(capH);
  r = measure(Math.min(capH, Math.max(240, Math.round(r.neededH))));
  if (r.compact !== (capH < 460)) {
    r = measure(Math.min(capH, Math.max(240, Math.round(r.neededH))));
  }
  // Последнее ограничение снизу: панель не может стать меньше стопки.
  const floorH = minStack(r.compact);
  if (r.panelH < floorH) r = measure(Math.min(capH, Math.max(r.panelH, floorH)));
  return r;
}