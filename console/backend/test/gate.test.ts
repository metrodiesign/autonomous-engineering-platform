// INV-15 fail-closed startup gate (§13.1) — Phase 0 slice: no provider exists yet,
// so any non-loopback bind must refuse to start, --insecure included per remote rule for F-Term.
import { describe, it, expect } from 'vitest';
import { decideStartup } from '../src/gate.js';

describe('startup gate (INV-15 / §13.1)', () => {
  it('loopback binds start with gate OFF', () => {
    for (const host of ['127.0.0.1', '::1', 'localhost']) {
      expect(decideStartup({ host, insecure: false, hasAuthProvider: false }).start).toBe(true);
    }
  });

  it('non-loopback without provider refuses to start with actionable error', () => {
    const d = decideStartup({ host: '0.0.0.0', insecure: false, hasAuthProvider: false });
    expect(d.start).toBe(false);
    expect(d.reason).toMatch(/auth/i);
  });

  it('--insecure on non-loopback still refuses in Phase 0 (no provider exists; F-Term rule INV-17)', () => {
    const d = decideStartup({ host: '0.0.0.0', insecure: true, hasAuthProvider: false });
    expect(d.start).toBe(false);
  });

  it('non-loopback with provider starts (Phase 3 path)', () => {
    expect(decideStartup({ host: '0.0.0.0', insecure: false, hasAuthProvider: true }).start).toBe(true);
  });
});
