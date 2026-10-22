/**
 * Единый календарь live-ops по московскому времени.
 * Дневные задания, ежедневные награды и дневные лимиты рекламы меняются
 * в 00:00 Europe/Moscow независимо от часового пояса устройства.
 */
const MOSCOW_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Moscow',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Возвращает календарную дату Москвы в ISO-формате YYYY-MM-DD. */
export function mskDayKey(epochMs: number): string {
  const parts = MOSCOW_DATE_FORMATTER.formatToParts(new Date(epochMs));
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (!year || !month || !day) {
    throw new Error('Не удалось получить московскую календарную дату');
  }
  return year + '-' + month + '-' + day;
}

/** Возвращает дату понедельника текущей недели по календарю Москвы. */
export function mskWeekKey(epochMs: number): string {
  const parts = mskDayKey(epochMs).split('-').map(Number);
  // UTC здесь используется только как арифметика даты после извлечения московского дня.
  const monday = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  const mondayOffset = (monday.getUTCDay() + 6) % 7;
  monday.setUTCDate(monday.getUTCDate() - mondayOffset);
  return monday.toISOString().slice(0, 10);
}
