// Breaker + router (§10.2 / §5.4 / §7.4): open on error rate, quota-aware skip,
// half-open single probe, clean BLOCKED(no_capacity).
import { describe, it, expect } from 'vitest';
import { CircuitBreaker } from '../src/breaker.js';
import { route, type RouteEntry } from '../src/router.js';
import type { Adapter } from '../src/protocol.js';

function fakeAdapter(id: string, structuredOutput = true): Adapter {
  return {
    manifest: () => ({
      adapterId: id, structuredOutput, toolCalling: false,
      contextWindowTokens: 100_000, executionBackend: false, seedDeterminism: false,
    }),
    invoke: async () => { throw new Error('not called in routing tests'); },
  };
}

const mkBreaker = (over: Partial<ConstructorParameters<typeof CircuitBreaker>[1]> = {}, clock = { t: 0 }) =>
  new CircuitBreaker('a:m', {
    windowMs: 10_000, minCalls: 4, errorRateToOpen: 0.5, openMs: 5_000,
    now: () => clock.t, ...over,
  });

describe('circuit breaker', () => {
  it('opens on error rate over window, half-opens after openMs, closes on probe success', () => {
    const clock = { t: 0 };
    const b = mkBreaker({}, clock);
    b.record(true); b.record(false); b.record(false); b.record(false);
    expect(b.state).toBe('open');
    expect(b.admit()).toBe(false);
    clock.t = 6_000;
    expect(b.state).toBe('half-open');
    expect(b.admit()).toBe(true);   // exactly one probe admitted
    expect(b.admit()).toBe(false);  // second call denied while probing
    b.record(true);                  // probe success
    expect(b.state).toBe('closed');
    expect(b.admit()).toBe(true);
  });

  it('probe failure re-opens', () => {
    const clock = { t: 0 };
    const b = mkBreaker({}, clock);
    for (let i = 0; i < 4; i++) b.record(false);
    clock.t = 6_000;
    expect(b.admit()).toBe(true);
    b.record(false);
    expect(b.state).toBe('open');
  });

  it('quota probe over threshold refuses admission before the real cap (§5.4)', () => {
    let quota = 0.5;
    const b = mkBreaker({ quotaProbe: () => quota, quotaThreshold: 0.85 });
    expect(b.admit()).toBe(true);
    quota = 0.9;
    expect(b.admit()).toBe(false);
    expect(b.state).toBe('closed'); // quota-unhealthy, not error-open
  });
});

describe('router', () => {
  it('skips breaker-open adapters and picks next eligible', () => {
    const clock = { t: 0 };
    const openB = mkBreaker({}, clock);
    for (let i = 0; i < 4; i++) openB.record(false);
    const entries: RouteEntry[] = [
      { adapter: fakeAdapter('primary'), breaker: openB },
      { adapter: fakeAdapter('fallback'), breaker: mkBreaker({}, clock) },
    ];
    const r = route(entries, { structuredOutput: true });
    expect(r.ok && r.entry.adapter.manifest().adapterId).toBe('fallback');
  });

  it('no eligible -> BLOCKED(no_capacity) cleanly', () => {
    const clock = { t: 0 };
    const b1 = mkBreaker({}, clock);
    for (let i = 0; i < 4; i++) b1.record(false);
    const r = route([{ adapter: fakeAdapter('only'), breaker: b1 }], {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_capacity');
  });

  it('capability mismatch -> no_capability (role must not be degraded, §10.2)', () => {
    const r = route([{ adapter: fakeAdapter('a', false), breaker: mkBreaker() }], { structuredOutput: true });
    expect(!r.ok && r.reason).toBe('no_capability');
  });
});
