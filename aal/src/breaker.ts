// Circuit breaker per (adapter, model) + quota-aware health (§10.2 / §5.4).
// closed -> open (error rate over window) -> half-open (probe) -> closed.
export type BreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerOptions {
  windowMs: number;
  minCalls: number;
  errorRateToOpen: number; // 0..1
  openMs: number; // how long to stay open before half-open probe
  /** optional quota probe: >= threshold marks unhealthy before hitting the real cap (§5.4) */
  quotaProbe?: () => number; // returns 0..1 utilization estimate
  quotaThreshold?: number;
  now?: () => number;
}

interface Sample { ts: number; ok: boolean }

export class CircuitBreaker {
  private samples: Sample[] = [];
  private opened = false;
  private openedAt = 0;
  private halfOpenProbeIssued = false;
  private forcedState: BreakerState | null = null;

  constructor(readonly key: string, private opts: BreakerOptions) {}

  private now(): number { return this.opts.now?.() ?? Date.now(); }

  record(ok: boolean): void {
    const now = this.now();
    this.samples.push({ ts: now, ok });
    this.samples = this.samples.filter((s) => now - s.ts <= this.opts.windowMs);
    if (this.state === 'half-open') {
      // probe outcome decides: success closes, failure re-opens
      this.forcedState = null;
      if (ok) { this.samples = []; this.opened = false; }
      else { this.openedAt = now; }
      this.halfOpenProbeIssued = false;
      return;
    }
    if (this.state === 'closed' && this.samples.length >= this.opts.minCalls) {
      const errRate = this.samples.filter((s) => !s.ok).length / this.samples.length;
      if (errRate >= this.opts.errorRateToOpen) { this.opened = true; this.openedAt = now; }
    }
  }

  /** quota unhealthy = treated as open without consuming error budget (§5.4) */
  get quotaUnhealthy(): boolean {
    const p = this.opts.quotaProbe;
    if (!p) return false;
    return p() >= (this.opts.quotaThreshold ?? 0.85);
  }

  get state(): BreakerState {
    if (this.forcedState) return this.forcedState;
    if (!this.opened) return 'closed';
    return this.now() - this.openedAt >= this.opts.openMs ? 'half-open' : 'open';
  }

  /** router asks: may I send work here? half-open admits exactly one probe call */
  admit(): boolean {
    if (this.quotaUnhealthy) return false;
    const s = this.state;
    if (s === 'closed') return true;
    if (s === 'half-open' && !this.halfOpenProbeIssued) {
      this.halfOpenProbeIssued = true;
      return true;
    }
    return false;
  }
}
