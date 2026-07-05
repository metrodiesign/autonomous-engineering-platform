// INV-15 fail-closed startup gate (§13.1): non-loopback needs an auth provider OR an explicit
// --insecure opt-in; provider state is derived from env (not hardcoded) so the Phase 3 path works.
import { describe, it, expect } from 'vitest';
import { decideStartup, hasConfiguredAuthProvider, SETUP_GUIDANCE } from '../src/gate.js';

describe('startup gate (INV-15 / §13.1)', () => {
  it('loopback binds start with gate OFF', () => {
    for (const host of ['127.0.0.1', '::1', 'localhost']) {
      expect(decideStartup({ host, insecure: false, hasAuthProvider: false }).start).toBe(true);
    }
  });

  it('non-loopback without provider refuses to start with actionable setup guidance', () => {
    const d = decideStartup({ host: '0.0.0.0', insecure: false, hasAuthProvider: false });
    expect(d.start).toBe(false);
    expect(d.reason).toMatch(/auth/i);
    expect(d.reason).toContain('PLATFORM_CONSOLE_PASSWORD_RECORD'); // decidable: names the fix
    expect(d.reason).toContain('hashPassword');
  });

  it('--insecure on non-loopback starts with gate OFF + warning (§13.1)', () => {
    const d = decideStartup({ host: '0.0.0.0', insecure: true, hasAuthProvider: false });
    expect(d.start).toBe(true);
    expect(d.reason).toMatch(/insecure/i);
  });

  it('non-loopback with provider starts (Phase 3 path)', () => {
    expect(decideStartup({ host: '0.0.0.0', insecure: false, hasAuthProvider: true }).start).toBe(true);
  });

  it('hasConfiguredAuthProvider requires BOTH env vars (matches server.ts activation)', () => {
    expect(hasConfiguredAuthProvider({ PLATFORM_CONSOLE_PASSWORD_RECORD: 'r', PLATFORM_CONSOLE_SIGNING_SECRET: 's' })).toBe(true);
    expect(hasConfiguredAuthProvider({ PLATFORM_CONSOLE_PASSWORD_RECORD: 'r' })).toBe(false);
    expect(hasConfiguredAuthProvider({ PLATFORM_CONSOLE_SIGNING_SECRET: 's' })).toBe(false);
    expect(hasConfiguredAuthProvider({})).toBe(false);
  });

  it('setup guidance names both env vars and the record generator', () => {
    expect(SETUP_GUIDANCE).toContain('PLATFORM_CONSOLE_SIGNING_SECRET');
    expect(SETUP_GUIDANCE).toContain('hashPassword');
  });
});
