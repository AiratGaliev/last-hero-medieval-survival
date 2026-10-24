/**
 * Пространственный хеш для частых запросов соседей.
 *
 * Пересборка переиспользует корзины, а query заполняет переданный массив.
 * Координаты ячеек упакованы в два signed 16-bit значения: текущий игровой
 * мир 3200×3200 px намного меньше этого диапазона.
 */
export class SpatialHash<T extends { x: number; y: number }> {
  private readonly buckets = new Map<number, T[]>();

  constructor(private readonly cellSize: number) {
    if (!Number.isFinite(cellSize) || cellSize <= 0) {
      throw new RangeError('cellSize должен быть положительным конечным числом');
    }
  }

  rebuild(items: readonly T[]): void {
    for (const bucket of this.buckets.values()) bucket.length = 0;

    for (const item of items) {
      if (!Number.isFinite(item.x) || !Number.isFinite(item.y)) continue;

      const cellX = Math.floor(item.x / this.cellSize);
      const cellY = Math.floor(item.y / this.cellSize);
      const key = SpatialHash.cellKey(cellX, cellY);
      let bucket = this.buckets.get(key);

      if (!bucket) {
        bucket = [];
        this.buckets.set(key, bucket);
      }
      bucket.push(item);
    }
  }

  /**
   * Возвращает кандидатов из ячеек, пересекающих квадрат запроса.
   * Для точного кругового радиуса вызывающий код должен проверить расстояние.
   */
  query(x: number, y: number, radius: number, out: T[]): T[] {
    out.length = 0;
    if (!Number.isFinite(x) || !Number.isFinite(y)
      || !Number.isFinite(radius) || radius < 0) {
      return out;
    }

    const minCellX = Math.floor((x - radius) / this.cellSize);
    const maxCellX = Math.floor((x + radius) / this.cellSize);
    const minCellY = Math.floor((y - radius) / this.cellSize);
    const maxCellY = Math.floor((y + radius) / this.cellSize);

    for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
      for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
        const bucket = this.buckets.get(SpatialHash.cellKey(cellX, cellY));
        if (bucket) {
          for (const item of bucket) out.push(item);
        }
      }
    }
    return out;
  }

  private static cellKey(cellX: number, cellY: number): number {
    return ((cellX & 0xffff) << 16) | (cellY & 0xffff);
  }
}
