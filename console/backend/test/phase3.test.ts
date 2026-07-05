// Phase 3 console: Basic auth provider, auth-gated server, F-Loop proxy, F-Sched guard.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { buildServer } from '../src/server.js';
import { BasicAuthProvider, hashPassword } from '../src/auth-provider.js';
import { ApprovalStore, startHumanPlane, EventLog } from '@platform/core';

const servers: Server[] = [];
afterAll(() => { for (const s of servers) s.close(); });

describe('basic auth provider (§13.2)', () => {
  const cfg = { passwordRecord: hashPassword('hunter2'), signingSecret: 'sec', sessionTtlMs: 1000 };

  it('login issues verifiable token; wrong password generic 401; expiry honored', () => {
    let t = 0;
    const p = new BasicAuthProvider({ ...cfg, now: () => t });
    const r = p.login('hunter2');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(p.verify(r.token)).toBe(true);
      t = 2000;
      expect(p.verify(r.token)).toBe(false); // expired
    }
    expect(p.login('wrong')).toEqual({ ok: false, error: 'unauthorized' });
  });

  it('rate limits after 5 attempts/minute', () => {
    const p = new BasicAuthProvider({ ...cfg, now: () => 0 });
    for (let i = 0; i < 5; i++) p.login('wrong');
    expect(p.login('hunter2')).toEqual({ ok: false, error: 'rate_limited' });
  });
});

describe('auth-gated console (§13.1/§13.3)', () => {
  it('every endpoint 401s without session; login sets HttpOnly cookie; bearer works', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p3-'));
    const app = buildServer({
      env: {
        PLATFORM_CONSOLE_PASSWORD_RECORD: hashPassword('pw'),
        PLATFORM_CONSOLE_SIGNING_SECRET: 'stable-secret',
      },
      listSessions: (async () => []) as never,
      getSessionMessages: (async () => []) as never,
      cliVersion: async () => 'test',
      auditFile: join(dir, 'audit.jsonl'),
    searchDbPath: join(dir, 'search.db'),
    });
    expect((await app.inject({ url: '/api/status' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/terminal' })).statusCode).toBe(401); // F-Term always auth (INV-17)

    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'no' } });
    expect(bad.statusCode).toBe(401);
    expect(bad.body).not.toMatch(/password|scrypt/i); // generic error

    const ok = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'pw' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['set-cookie']).toMatch(/HttpOnly/);
    const token = ok.json().token;
    const st = await app.inject({ url: '/api/status', headers: { authorization: `Bearer ${token}` } });
    expect(st.statusCode).toBe(200);
  });
});

describe('F-Loop proxies the Human Plane API (INV-11)', () => {
  it('lists + approves an approval package from the console layer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p3hp-'));
    const log = new EventLog(join(dir, 'events.db'));
    const approvals = new ApprovalStore(log);
    const created = approvals.create({
      taskId: 'T-web', riskLevel: 'L3', goalExcerpt: 'g', diff: '+x',
      evidenceRefs: [], assumptions: [], unresolvedRisks: [],
    });
    if (!created.ok) throw new Error('setup');
    const tokenFile = join(dir, 'token');
    const { server } = await startHumanPlane({ log, approvals, tokenFile }, 0);
    servers.push(server);
    const port = (server.address() as { port: number }).port;

    const app = buildServer({
      env: {
        PLATFORM_HUMAN_PLANE_URL: `http://127.0.0.1:${port}`,
        PLATFORM_HUMAN_PLANE_TOKEN_FILE: tokenFile,
      },
      listSessions: (async () => []) as never,
      getSessionMessages: (async () => []) as never,
      cliVersion: async () => 'test',
      auditFile: join(dir, 'audit.jsonl'),
    searchDbPath: join(dir, 'search.db'),
    });
    const list = await app.inject({ url: '/api/loop/approvals' });
    expect(list.json().approvals).toHaveLength(1);

    const approve = await app.inject({
      method: 'POST', url: `/api/loop/approvals/${created.pkg.id}`, payload: { verdict: 'approved' },
    });
    expect(approve.json().pkg.status).toBe('approved');
    expect(log.eventsFor('T-web').some((e) => e.type === 'APPROVAL_GRANTED')).toBe(true);
  });
});

describe('F-Sched (§8): opaque process + quota guard', () => {
  it('starts/stops a process and blocks when guard says yield', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p3s-'));
    writeFileSync(join(dir, 'token'), 'x');
    const now = Date.now();
    // 60 recent sessions -> utilization > 0.85 -> guard blocks
    const busy = buildServer({
      env: { PLATFORM_HUMAN_PLANE_TOKEN_FILE: join(dir, 'token') },
      listSessions: (async () => Array.from({ length: 60 }, () => ({ sessionId: 'x', summary: '', lastModified: now, fileSize: 1 }))) as never,
      getSessionMessages: (async () => []) as never,
      cliVersion: async () => 'test',
      auditFile: join(dir, 'a.jsonl'),
    });
    const blocked = await busy.inject({ method: 'POST', url: '/api/sched/start', payload: { name: 'j1', cmd: 'sleep', args: ['5'] } });
    expect(blocked.statusCode).toBe(429);

    const idle = buildServer({
      env: { PLATFORM_HUMAN_PLANE_TOKEN_FILE: join(dir, 'token') },
      listSessions: (async () => []) as never,
      getSessionMessages: (async () => []) as never,
      cliVersion: async () => 'test',
      auditFile: join(dir, 'b.jsonl'),
    });
    const started = await idle.inject({ method: 'POST', url: '/api/sched/start', payload: { name: 'j1', cmd: 'sleep', args: ['30'] } });
    expect(started.statusCode).toBe(200);
    expect((await idle.inject({ url: '/api/sched' })).json().jobs).toContain('j1');
    const stopped = await idle.inject({ method: 'POST', url: '/api/sched/stop', payload: { name: 'j1' } });
    expect(stopped.json().ok).toBe(true);
  });
});
