// Security gap-fixes (GAP-PLAN): G17 redaction (INV-14), G15 consent gate (INV-16),
// G16 spawn hardening (§13.3), G05 utilization denominator (§10.2).
import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/server.js';
import { registerLoopConsole } from '../src/loop-console.js';
import { redactText, redactJson } from '../src/redact.js';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

// stub PTY manager so /api/term tests never spawn a real `claude` process
const stubPty = {
  spawn: (o: { cwd: string; mode?: string }) => ({ id: 'term-x', cwd: o.cwd, mode: o.mode ?? 'claude-only', createdAt: 0, alive: true }),
  list: () => [],
  attach: () => ({ replay: '', detach: () => {} }),
  write: () => {}, resize: () => {}, kill: () => {}, killAll: () => {},
} as never;

function consoleServer(env: Record<string, string | undefined>, extra: Record<string, unknown> = {}): FastifyInstance {
  const dir = tmp('gapfix-');
  return buildServer({
    env,
    listSessions: (async () => []) as never,
    getSessionMessages: (async () => []) as never,
    cliVersion: async () => 'test',
    auditFile: join(dir, 'audit.jsonl'),
    searchDbPath: join(dir, 'search.db'),
    ptyManager: stubPty,
    ...extra,
  });
}

// ---------------------------------------------------------------- G17 redaction (INV-14)
describe('redactText masks each secret format (G17)', () => {
  const cases: [string, string][] = [
    ['anthropic', 'key sk-ant-api03-ABCDEFGH1234567890 end'],
    ['github classic', 'tok ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 end'],
    ['github fine', 'tok github_pat_11ABCDE0000aaaaBBBBcc_ddddEEEEffff end'],
    ['aws', 'id AKIAIOSFODNN7EXAMPLE end'],
    ['slack', 'tok xoxb-1234567890-ABCDEFGHIJKL end'],
    ['jwt', 'auth eyJhbGciOi.eyJzdWIiOiJ4.SflKxwRJSMeKKF end'],
  ];
  for (const [name, input] of cases) {
    it(`redacts ${name}`, () => {
      const out = redactText(input);
      expect(out).toContain('***REDACTED***');
      // the secret token itself must be gone
      const secret = input.split(' ').find((w) => /sk-ant|ghp_|github_pat|AKIA|xox|eyJ/.test(w))!;
      expect(out).not.toContain(secret);
    });
  }

  it('redacts PEM private-key blocks', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEvQIBADANBg\nkqhkiG9w0BAQ==\n-----END RSA PRIVATE KEY-----';
    const out = redactText(`before ${pem} after`);
    expect(out).toBe('before ***REDACTED*** after');
  });

  it('redacts password= / token= / secret= value pairs (keeps the key)', () => {
    expect(redactText('password=hunter2')).toBe('password=***REDACTED***');
    expect(redactText('token: abc123')).toBe('token: ***REDACTED***');
    expect(redactText('DB_SECRET=s3cr3t;')).toContain('SECRET=***REDACTED***');
    expect(redactText('//registry.npmjs.org/:_authToken=npm_ABCDEF')).toContain('_authToken=***REDACTED***');
  });

  it('masks credential-file paths', () => {
    for (const p of ['~/.claude/.credentials.json', '.credentials.json', '/home/u/.ssh/id_rsa', '~/.npmrc']) {
      expect(redactText(`open ${p} now`)).toContain('***CREDENTIAL-PATH***');
      expect(redactText(`open ${p} now`)).not.toContain(p);
    }
  });

  it('does not touch benign text', () => {
    const benign = 'the quick brown fox tokens=used input_tokens: 42';
    expect(redactText(benign)).toBe(benign);
  });
});

describe('redactJson keeps structure + stays valid JSON (G17)', () => {
  it('redacts string leaves and secret-named keys, preserves benign values', () => {
    const out = redactJson({
      ANTHROPIC_API_KEY: 'sk-ant-api03-ZZZZZZZZ1111', // secret value
      note: 'call with token=abc123',
      count: 42,
      nested: { password: 987654321, list: ['ghp_ABCDEFGHIJKLMNOPQRST0000'] },
    });
    expect(out.ANTHROPIC_API_KEY).toBe('***REDACTED***');
    expect(out.note).toBe('call with token=***REDACTED***');
    expect(out.count).toBe(42); // benign untouched
    expect(out.nested.password).toBe('***REDACTED***'); // numeric secret masked to sentinel (valid JSON)
    expect(out.nested.list[0]).toBe('***REDACTED***');
    expect(() => JSON.parse(JSON.stringify(out))).not.toThrow();
  });

  it('recurses object values under secret-named keys without corruption', () => {
    const out = redactJson({ token: { nested: 1 } });
    expect(out.token.nested).toBe(1);
  });
});

describe('messages endpoint redacts leaked secrets end-to-end (G17)', () => {
  it('a transcript containing sk-ant-XXXX comes back redacted', async () => {
    const app = consoleServer(
      {},
      { getSessionMessages: (async () => [{ role: 'assistant', content: 'my key is sk-ant-api03-ABCDEFGH12345678 ok' }]) as never },
    );
    const res = await app.inject({ url: '/api/sessions/s1/messages' });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('sk-ant-api03-ABCDEFGH12345678');
    expect(res.body).toContain('***REDACTED***');
  });
});

// ---------------------------------------------------------------- G15 consent gate (INV-16)
describe('settings consent gate: bypassPermissions (G15)', () => {
  it('428 without consent, 200 with consent, and the file is written', async () => {
    const dir = tmp('g15-');
    const app = consoleServer({});
    const payload = { settings: { permissions: { defaultMode: 'bypassPermissions' } } };

    const blocked = await app.inject({ method: 'PUT', url: `/api/settings/project?dir=${dir}`, payload });
    expect(blocked.statusCode).toBe(428);
    expect(blocked.json().error).toMatch(/consent required/i);
    expect(existsSync(join(dir, '.claude', 'settings.json'))).toBe(false); // not written

    const ok = await app.inject({ method: 'PUT', url: `/api/settings/project?dir=${dir}`, payload: { ...payload, consent: true } });
    expect(ok.statusCode).toBe(200);
    expect(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')).toContain('bypassPermissions');
  });

  it('benign settings write needs no consent', async () => {
    const dir = tmp('g15b-');
    const app = consoleServer({});
    const ok = await app.inject({ method: 'PUT', url: `/api/settings/project?dir=${dir}`, payload: { settings: { model: 'sonnet' } } });
    expect(ok.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------- G16 spawn hardening (§13.3)
function loopApp(overrides: Record<string, unknown>): FastifyInstance {
  const app = Fastify({ logger: false });
  const dir = tmp('loop-');
  writeFileSync(join(dir, 'token'), 'x');
  registerLoopConsole(app, {
    humanPlaneUrl: 'http://127.0.0.1:1',
    tokenFile: join(dir, 'token'),
    automationGuard: async () => ({ allowed: true, utilization: 0 }),
    audit: () => {},
    ...overrides,
  } as never);
  return app;
}

describe('sched spawn hardening (G16)', () => {
  it('rate-limits after 5 starts/min (6th → 429)', async () => {
    const app = loopApp({ env: { PLATFORM_SCHED_ALLOWLIST: '/bin/echo' } });
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({ method: 'POST', url: '/api/sched/start', payload: { name: `r${i}`, cmd: '/bin/echo', args: [] } });
      expect(r.statusCode).toBe(200);
    }
    const sixth = await app.inject({ method: 'POST', url: '/api/sched/start', payload: { name: 'r5', cmd: '/bin/echo' } });
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json().error).toMatch(/rate limit/i);
  });

  it('403s a command outside scripts/ and not on the allowlist', async () => {
    const app = loopApp({ schedScriptsDir: tmp('scr-'), env: {} });
    const r = await app.inject({ method: 'POST', url: '/api/sched/start', payload: { name: 'x', cmd: 'sleep', args: ['0'] } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toMatch(/not allowed/i);
  });

  it('allows a command listed in PLATFORM_SCHED_ALLOWLIST', async () => {
    const app = loopApp({ schedScriptsDir: tmp('scr2-'), env: { PLATFORM_SCHED_ALLOWLIST: '/bin/echo' } });
    const r = await app.inject({ method: 'POST', url: '/api/sched/start', payload: { name: 'y', cmd: '/bin/echo' } });
    expect(r.statusCode).toBe(200);
  });

  it('allows a command resolving inside the scripts/ dir', async () => {
    const scr = tmp('scr3-');
    const script = join(scr, 'ok.sh');
    writeFileSync(script, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const app = loopApp({ schedScriptsDir: scr, env: {} });
    const r = await app.inject({ method: 'POST', url: '/api/sched/start', payload: { name: 'z', cmd: script } });
    expect(r.statusCode).toBe(200);
  });

  it('rejects flag args + control chars; allowlisted flags pass', async () => {
    const scr = tmp('scr4-');
    writeFileSync(join(scr, 'ok.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const app = loopApp({ schedScriptsDir: scr, env: { PLATFORM_SCHED_ARG_ALLOWLIST: '--safe' } });
    const cmd = join(scr, 'ok.sh');
    // unlisted flag → 400
    const flag = await app.inject({ method: 'POST', url: '/api/sched/start', payload: { name: 'a', cmd, args: ['--danger'] } });
    expect(flag.statusCode).toBe(400);
    expect(flag.json().error).toMatch(/flag not in/i);
    // control char in arg → 400
    const ctl = await app.inject({ method: 'POST', url: '/api/sched/start', payload: { name: 'b', cmd, args: ['line1\nline2'] } });
    expect(ctl.statusCode).toBe(400);
    // non-string arg → 400
    const nonstr = await app.inject({ method: 'POST', url: '/api/sched/start', payload: { name: 'c', cmd, args: [123] } });
    expect(nonstr.statusCode).toBe(400);
    // allowlisted flag + plain positional → 200
    const ok = await app.inject({ method: 'POST', url: '/api/sched/start', payload: { name: 'd', cmd, args: ['--safe', 'value'] } });
    expect(ok.statusCode).toBe(200);
  });
});

describe('term full-shell consent (G16)', () => {
  it('428 for full-shell without consent; claude-only and consented full-shell pass', async () => {
    const app = consoleServer({});
    const dir = tmp('term-');
    const blocked = await app.inject({ method: 'POST', url: '/api/term', payload: { cwd: dir, mode: 'full-shell' } });
    expect(blocked.statusCode).toBe(428);
    expect(blocked.json().error).toMatch(/consent required/i);

    const consented = await app.inject({ method: 'POST', url: '/api/term', payload: { cwd: dir, mode: 'full-shell', consent: true } });
    expect(consented.statusCode).toBe(200);

    const claudeOnly = await app.inject({ method: 'POST', url: '/api/term', payload: { cwd: dir } });
    expect(claudeOnly.statusCode).toBe(200); // frictionless
  });
});

// ---------------------------------------------------------------- G05 utilization denominator (§10.2)
describe('utilization uses PLATFORM_QUOTA_WINDOW_BUDGET (G05)', () => {
  const now = Date.now();
  const fiveSessions = (async () => Array.from({ length: 5 }, () => ({ sessionId: 'x', summary: '', lastModified: now, fileSize: 1 }))) as never;

  it('budget=10 → 5 sessions report 0.5 utilization', async () => {
    const app = consoleServer({ PLATFORM_QUOTA_WINDOW_BUDGET: '10' }, { listSessions: fiveSessions });
    const res = await app.inject({ url: '/api/usage/alerts' });
    expect(res.json().utilization).toBeCloseTo(0.5, 5);
  });

  it('default budget (50) → 5 sessions report 0.1', async () => {
    const app = consoleServer({}, { listSessions: fiveSessions });
    const res = await app.inject({ url: '/api/usage/alerts' });
    expect(res.json().utilization).toBeCloseTo(0.1, 5);
  });

  it('invalid budget falls back to 50', async () => {
    const app = consoleServer({ PLATFORM_QUOTA_WINDOW_BUDGET: 'nonsense' }, { listSessions: fiveSessions });
    const res = await app.inject({ url: '/api/usage/alerts' });
    expect(res.json().utilization).toBeCloseTo(0.1, 5);
  });
});
