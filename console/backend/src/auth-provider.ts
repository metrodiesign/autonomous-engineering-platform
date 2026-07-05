// Basic auth provider (§13.2, Phase 3): scrypt password hash + stateless HMAC session token.
// Single operator (INV-15): exactly one credential, no user-creation endpoint anywhere.
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export interface BasicAuthConfig {
  /** scrypt hash record: salt:hex(hash) — created out-of-band via `platform auth set-password` */
  passwordRecord: string;
  /** stable signing secret (persisted) so sessions survive restarts */
  signingSecret: string;
  sessionTtlMs: number;
  now?: () => number;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

export class BasicAuthProvider {
  private attempts: number[] = [];

  constructor(private cfg: BasicAuthConfig) {}

  private now(): number { return this.cfg.now?.() ?? Date.now(); }

  /** rate-limited, generic-failure login (§13.2) */
  login(password: string): { ok: true; token: string } | { ok: false; error: 'unauthorized' | 'rate_limited' } {
    const now = this.now();
    this.attempts = this.attempts.filter((t) => now - t < 60_000);
    if (this.attempts.length >= 5) return { ok: false, error: 'rate_limited' };
    this.attempts.push(now);

    const [salt, expected] = this.cfg.passwordRecord.split(':');
    if (!salt || !expected) return { ok: false, error: 'unauthorized' };
    const actual = scryptSync(password, salt, 32);
    const expectedBuf = Buffer.from(expected, 'hex');
    if (actual.length !== expectedBuf.length || !timingSafeEqual(actual, expectedBuf)) {
      return { ok: false, error: 'unauthorized' }; // generic — no detail leaks
    }
    const exp = now + this.cfg.sessionTtlMs;
    const payload = `v1.${exp}`;
    const sig = createHmac('sha256', this.cfg.signingSecret).update(payload).digest('hex');
    return { ok: true, token: `${payload}.${sig}` };
  }

  verify(token: string | undefined): boolean {
    if (!token) return false;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') return false;
    const exp = Number(parts[1]);
    if (!Number.isFinite(exp) || exp < this.now()) return false;
    const sig = createHmac('sha256', this.cfg.signingSecret).update(`v1.${exp}`).digest('hex');
    const a = Buffer.from(sig, 'hex');
    const b = Buffer.from(parts[2] ?? '', 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
