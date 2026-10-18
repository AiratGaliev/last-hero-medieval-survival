/**
 * Shared damage budget for the settlement garrison.
 *
 * Token-bucket semantics avoid frame-rate-dependent caps: the squad receives
 * at most capDps damage tokens per second, with no more than one second of
 * damage banked. The first token is earned from elapsed time, not granted as
 * a free opening burst.
 */
export class GarrisonDpsBudget {
  private tokens = 0;
  private lastUpdatedAt: number | null = null;

  constructor(private readonly capFraction = 0.25) {}

  reset(nowMs?: number): void {
    this.tokens = 0;
    this.lastUpdatedAt = nowMs ?? null;
  }

  /** Returns the integer damage the whole garrison is allowed to apply. */
  apply(rawDamage: number, nowMs: number, heroDps: number): number {
    if (!Number.isFinite(rawDamage) || rawDamage <= 0
      || !Number.isFinite(nowMs) || !Number.isFinite(heroDps) || heroDps <= 0) {
      return 0;
    }

    const capDps = heroDps * this.capFraction;
    if (capDps <= 0) return 0;

    if (this.lastUpdatedAt === null) {
      this.lastUpdatedAt = nowMs;
      return 0;
    }

    const elapsedMs = Math.max(0, nowMs - this.lastUpdatedAt);
    this.lastUpdatedAt = Math.max(this.lastUpdatedAt, nowMs);
    this.tokens = Math.min(capDps, this.tokens + elapsedMs * capDps / 1000);

    const applied = Math.min(Math.max(0, Math.floor(rawDamage)), Math.floor(this.tokens + 1e-9));
    this.tokens -= applied;
    return applied;
  }

  /** Useful for telemetry and deterministic acceptance tests. */
  get availableDamage(): number {
    return this.tokens;
  }
}
