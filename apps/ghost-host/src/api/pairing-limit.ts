/**
 * Failed pairing-attempt limits. Only failures count, so a client behind a shared
 * address is never starved by other clients' successful claims, while a global cap
 * bounds brute force through a reverse proxy that collapses addresses. Windows are
 * fixed one-minute buckets; expired entries are pruned on every touch.
 */
export class PairingLimiter {
  private readonly perAddress = new Map<string, { failed: number; resetAt: number }>();
  private global = { failed: 0, resetAt: 0 };

  constructor(
    private readonly perAddressLimit: number,
    private readonly globalLimit: number,
    private readonly windowMs = 60_000,
  ) {}

  /** True when `address` may attempt a claim now; successful attempts consume nothing. */
  allows(address: string, now: number): boolean {
    this.prune(now);
    const entry = this.perAddress.get(address);
    return (entry?.failed ?? 0) < this.perAddressLimit && this.global.failed < this.globalLimit;
  }

  noteFailure(address: string, now: number): void {
    this.prune(now);
    const entry = this.perAddress.get(address);
    if (entry === undefined) this.perAddress.set(address, { failed: 1, resetAt: now + this.windowMs });
    else entry.failed += 1;
    this.global.failed += 1;
  }

  private prune(now: number): void {
    if (this.global.resetAt <= now) this.global = { failed: 0, resetAt: now + this.windowMs };
    for (const [address, entry] of this.perAddress) if (entry.resetAt <= now) this.perAddress.delete(address);
  }
}
