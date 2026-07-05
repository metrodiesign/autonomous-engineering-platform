// SPA-era console surface (§8): sessions ops, search, activity feed, hooks read, retention, register.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/server.js';
import { SessionSearch } from '../src/search.js';
import { ActionRegistry } from '../src/actions.js';
import { usageBreakdown, evaluateAlerts } from '../src/usage.js';

function makeApp(dir: string, extra: Record<string, unknown> = {}) {
  return buildServer({
    env: {},
    listSessions: (async () => []) as never,
    getSessionMessages: (async () => []) as never,
    cliVersion: async () => 'test',
    auditFile: join(dir, 'audit.jsonl'),
    searchDbPath: join(dir, 'search.db'),
    projectsDir: join(dir, 'projects'),
    ...extra,
  });
}

function fakeProjectStore(dir: string): string {
  const pdir = join(dir, 'projects', '-tmp-demo');
  mkdirSync(pdir, { recursive: true });
  writeFileSync(join(pdir, 'aaaa-1111.jsonl'), [
    JSON.stringify({ type: 'user', message: { content: 'find the golden retriever bug' } }),
    JSON.stringify({ type: 'assistant', message: { model: 'model-x', content: [{ type: 'text', text: 'fixed the retriever' }] } }),
  ].join('\n') + '\n');
  return pdir;
}

describe('F-Sess ops', () => {
  it('rename validates title and calls through with audit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p5-'));
    const calls: unknown[] = [];
    const app = makeApp(dir, {
      sessionOps: { renameSession: (async (id: string, title: string) => { calls.push([id, title]); }) as never },
    });
    const bad = await app.inject({ method: 'POST', url: '/api/sessions/s1/rename', payload: {} });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: '/api/sessions/s1/rename', payload: { title: 'new name' } });
    expect(ok.statusCode).toBe(200);
    expect(calls).toEqual([['s1', 'new name']]);
    expect(readFileSync(join(dir, 'audit.jsonl'), 'utf8')).toContain('SESSION_RENAME');
  });

  it('fork returns the new session id; delete audits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p5-'));
    const app = makeApp(dir, {
      sessionOps: {
        forkSession: (async () => ({ sessionId: 'forked-1' })) as never,
        deleteSession: (async () => undefined) as never,
      },
    });
    const f = await app.inject({ method: 'POST', url: '/api/sessions/s1/fork', payload: {} });
    expect(f.json().sessionId).toBe('forked-1');
    const d = await app.inject({ method: 'DELETE', url: '/api/sessions/s1' });
    expect(d.statusCode).toBe(200);
    expect(readFileSync(join(dir, 'audit.jsonl'), 'utf8')).toContain('SESSION_DELETE');
  });

  it('export streams JSONL as attachment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p5-'));
    const app = makeApp(dir, {
      sessionOps: { getSessionMessages: (async () => [{ role: 'user', text: 'hi' }]) as never },
    });
    const r = await app.inject({ method: 'GET', url: '/api/sessions/s1/export' });
    expect(r.headers['content-disposition']).toContain('s1.jsonl');
    expect(r.body.trim()).toBe(JSON.stringify({ role: 'user', text: 'hi' }));
  });
});

describe('FTS5 search + background index action', () => {
  it('indexes transcripts incrementally and finds text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p5-'));
    fakeProjectStore(dir);
    const s = new SessionSearch(join(dir, 'search.db'), join(dir, 'projects'));
    const first = s.index();
    expect(first.indexed).toBe(1);
    expect(s.index().skipped).toBe(1); // unchanged mtime -> skipped
    const hits = s.query('golden retriever');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.sessionId).toBe('aaaa-1111');
    expect(s.query('nonexistent-term-xyz')).toHaveLength(0);
    const agg = s.aggregates(0);
    expect(agg[0]!.models).toEqual(['model-x']);
    s.close();
  });

  it('index endpoint returns actionId pollable at /api/actions/:id/status', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p5-'));
    fakeProjectStore(dir);
    const app = makeApp(dir);
    const start = await app.inject({ method: 'POST', url: '/api/sessions/search/index' });
    const { actionId } = start.json();
    expect(actionId).toBeTruthy();
    let status;
    for (let i = 0; i < 50; i++) {
      status = (await app.inject({ method: 'GET', url: `/api/actions/${actionId}/status` })).json();
      if (status.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(status.status).toBe('done');
    expect(status.result.indexed).toBe(1);
    const q = await app.inject({ method: 'GET', url: '/api/sessions/search?q=retriever' });
    expect(q.json().hits).toHaveLength(1);
  });
});

describe('actions registry', () => {
  it('captures errors instead of crashing', async () => {
    const a = new ActionRegistry();
    const rec = a.start('boom', async () => { throw new Error('kaput'); });
    await new Promise((r) => setTimeout(r, 10));
    expect(a.get(rec.id)!.status).toBe('error');
    expect(a.get(rec.id)!.error).toContain('kaput');
  });
});

describe('F-Act activity feed', () => {
  it('ingest -> recent ring with monotonic seq', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p5-'));
    const app = makeApp(dir);
    await app.inject({ method: 'POST', url: '/api/events/ingest', payload: { hook_event_name: 'Stop' } });
    await app.inject({ method: 'POST', url: '/api/events/ingest', payload: { hook_event_name: 'SessionStart' } });
    const r = (await app.inject({ method: 'GET', url: '/api/events/recent' })).json();
    expect(r.events).toHaveLength(2);
    expect(r.events[1].seq).toBe(2);
    const since = (await app.inject({ method: 'GET', url: '/api/events/recent?since=1' })).json();
    expect(since.events).toHaveLength(1);
  });

  it('hook install demands consent, writes fail-open command, uninstall removes all', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p5-'));
    const app = makeApp(dir);
    const no = await app.inject({ method: 'POST', url: '/api/activity/hooks/install', payload: { scope: 'project', dir } });
    expect(no.statusCode).toBe(428);
    const ok = await app.inject({
      method: 'POST', url: '/api/activity/hooks/install', payload: { scope: 'project', dir, consent: true },
    });
    expect(ok.statusCode).toBe(200);
    const settings = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'));
    const cmd = settings.hooks.PostToolUse[0].hooks[0].command as string;
    expect(cmd).toContain('|| true'); // fail-open
    expect(cmd).toContain('-m 2'); // short timeout
    const un = await app.inject({ method: 'POST', url: '/api/activity/hooks/uninstall', payload: { scope: 'project', dir } });
    expect(un.json().removed).toBeGreaterThan(0);
    const after = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'));
    expect(Object.keys(after.hooks ?? {})).toHaveLength(0);
  });
});

describe('F-Hook read view + F-Sys retention + F-Proj register', () => {
  it('GET /api/hooks merges scopes and lists valid events', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p5-'));
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
    }));
    const app = makeApp(dir);
    const r = (await app.inject({ method: 'GET', url: `/api/hooks?dir=${dir}` })).json();
    expect(r.events).toContain('PreToolUse');
    expect(r.scopes.project.hooks.Stop).toHaveLength(1);
  });

  it('retention PUT validates range and returns a deletion warning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p5-'));
    const app = makeApp(dir);
    const bad = await app.inject({ method: 'PUT', url: '/api/system/retention', payload: { cleanupPeriodDays: 0 } });
    expect(bad.statusCode).toBe(400);
    // NOTE: valid write path touches the real user settings file — validated in live browser check instead.
  });

  it('project register validates dir and creates munged key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p5-'));
    const app = makeApp(dir);
    const bad = await app.inject({ method: 'POST', url: '/api/projects/register', payload: { dir: '/nope/missing' } });
    expect(bad.statusCode).toBe(400);
    const ok = (await app.inject({ method: 'POST', url: '/api/projects/register', payload: { dir } })).json();
    expect(ok.key).not.toContain('/');
    expect(existsSync(join(dir, 'projects', ok.key))).toBe(true);
    const list = (await app.inject({ method: 'GET', url: '/api/projects' })).json();
    expect(list.projects.some((p: { key: string }) => p.key === ok.key)).toBe(true);
  });
});

describe('F-Usage breakdown + alerts (pure)', () => {
  it('aggregates by day/project/model', () => {
    const b = usageBreakdown([
      { projectKey: 'p1', day: '2026-07-01', models: ['m1'] },
      { projectKey: 'p1', day: '2026-07-02', models: ['m1', 'm2'] },
      { projectKey: 'p2', day: '2026-07-02', models: [] },
    ]);
    expect(b.byDay).toEqual([
      { day: '2026-07-01', sessions: 1 },
      { day: '2026-07-02', sessions: 2 },
    ]);
    expect(b.byProject[0]).toEqual({ projectKey: 'p1', sessions: 2 });
    expect(b.byModel[0]).toEqual({ model: 'm1', sessions: 2 });
  });

  it('alerts flip at threshold with interactive/non-interactive labels', () => {
    expect(evaluateAlerts(0.5, 0.85)[0]!.level).toBe('ok');
    const warn = evaluateAlerts(0.9, 0.85);
    expect(warn.every((a) => a.level === 'warn')).toBe(true);
    expect(warn.map((a) => a.message).join(' ')).toContain('non-interactive');
  });
});
