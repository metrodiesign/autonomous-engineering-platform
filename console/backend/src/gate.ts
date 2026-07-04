// INV-15 fail-closed startup gate (§13.1).
export interface StartupInput {
  host: string;
  insecure: boolean;
  hasAuthProvider: boolean;
}

export interface StartupDecision {
  start: boolean;
  reason: string;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function decideStartup(i: StartupInput): StartupDecision {
  if (LOOPBACK.has(i.host)) return { start: true, reason: 'loopback bind — gate OFF' };
  if (i.hasAuthProvider) return { start: true, reason: 'non-loopback with auth provider' };
  // Phase 0: no provider implemented yet. F-Term makes the Console the highest-risk
  // surface, and INV-17 forbids unauthenticated remote in every case incl. --insecure.
  return {
    start: false,
    reason:
      `refusing to bind ${i.host}: no auth provider configured (INV-15 fail-closed). ` +
      `Run on 127.0.0.1, or configure an auth provider (available from Phase 3).`,
  };
}
