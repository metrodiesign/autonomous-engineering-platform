// Per-provider rate limit (§10.2): token bucket the router consumes BEFORE dispatch,
// so a healthy-but-throttled adapter is skipped without a retry storm (INV-5).
// Lazy refill from a timestamp, clock injectable for tests (same pattern as CircuitBreaker).
export interface TokenBucketOptions {
  capacity: number;
  refillPerSec: number;
  now?: () => number;
}

export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(readonly key: string, private opts: TokenBucketOptions) {
    this.tokens = opts.capacity;
    this.last = this.now();
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private refill(): void {
    const t = this.now();
    const elapsedSec = (t - this.last) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.opts.capacity, this.tokens + elapsedSec * this.opts.refillPerSec);
    this.last = t;
  }

  /** current token count after lazy refill — inspection only, never consumes */
  available(): number {
    this.refill();
    return this.tokens;
  }

  /** consume one token if available; false means throttled */
  tryTake(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}
