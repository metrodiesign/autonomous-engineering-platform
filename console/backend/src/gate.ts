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

/**
 * True when both Basic-auth env vars are set — the exact condition server.ts uses to
 * activate BasicAuthProvider (§13.2). The launcher must derive the provider state from
 * this, not hardcode it, or the "gate ON + provider → start" branch is unreachable.
 */
export function hasConfiguredAuthProvider(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.PLATFORM_CONSOLE_PASSWORD_RECORD && env.PLATFORM_CONSOLE_SIGNING_SECRET);
}

/** Actionable setup guidance (§13.1: "error ชี้วิธีแก้") for a non-loopback bind with no provider. */
export const SETUP_GUIDANCE = [
  'Configure the Basic auth provider before binding a non-loopback host:',
  '  1. Generate a password record (scrypt):',
  "       node -e \"import('./dist/auth-provider.js').then(m => console.log(m.hashPassword('YOUR_PASSWORD')))\"",
  '  2. Export it plus a stable signing secret, then relaunch:',
  '       export PLATFORM_CONSOLE_PASSWORD_RECORD=<record from step 1>',
  "       export PLATFORM_CONSOLE_SIGNING_SECRET=$(node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\")",
  '  Or rerun on 127.0.0.1 (loopback needs no provider), or pass --insecure to bind without auth',
  '  (NOT for untrusted networks).',
].join('\n');

export function decideStartup(i: StartupInput): StartupDecision {
  if (LOOPBACK.has(i.host)) return { start: true, reason: 'loopback bind — gate OFF' };
  if (i.hasAuthProvider) return { start: true, reason: 'non-loopback with auth provider' };
  if (i.insecure) {
    // §13.1: --insecure turns the gate OFF by explicit operator request. INV-17 still requires
    // remote F-Term to be authed; the server-side peer-IP guard blocks non-loopback peers unless
    // PLATFORM_CONSOLE_HOST is also set, so unauthenticated remote exposure needs a 2nd opt-in.
    return { start: true, reason: 'non-loopback with --insecure — auth gate OFF by operator request (remote peers still blocked unless PLATFORM_CONSOLE_HOST is set)' };
  }
  return {
    start: false,
    reason: `refusing to bind ${i.host}: no auth provider configured (INV-15 fail-closed).\n${SETUP_GUIDANCE}`,
  };
}
