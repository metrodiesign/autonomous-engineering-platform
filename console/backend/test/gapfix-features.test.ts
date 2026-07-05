// Console feature gap-fixes (C8): INV-17 F-Term guard (1), F-Status runs (2), F-Sub (3),
// F-Skill plugins (4), F-MCP 3-layer + test (5), F-Hook types/disable-all (6), F-Usage
// calibration (7), F-Term quota (8), F-Loop views (9), F-Sys update (10).
// HOME is redirected to a temp dir for the whole file so user-scoped writes never touch real settings.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/server.js';
import { registerLoopConsole } from '../src/loop-console.js';
import { INDEX_HTML } from '../src/web.js';
import { computeResets } from '../src/usage.js';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const enc = encodeURIComponent;

const origHome = process.env.HOME;
beforeAll(() => {
  const fakeHome = tmp('home-');
  mkdirSync(join(fakeHome, '.claude'), { recursive: true });
  process.env.HOME = fakeHome; // os.homedir() honors $HOME here — protects real ~/.claude
});
afterAll(() => { process.env.HOME = origHome; });

const stubPty = {
  spawn: (o: { cwd: string; mode?: string }) => ({ id: 'term-x', cwd: o.cwd, mode: o.mode ?? 'claude-only', createdAt: 0, alive: true }),
  list: () => [],
  attach: () => ({ replay: '', detach: () => {} }),
  write: () => {}, resize: () => {}, kill: () => {}, killAll: () => {},
} as never;

function consoleServer(env: Record<string, string | undefined> = {}, extra: Record<string, unknown> = {}): FastifyInstance {
  const dir = tmp('feat-');
  return buildServer({
    env,
    listSessions: (async () => []) as never,
    getSessionMessages: (async () => []) as never,
    cliVersion: async () => 'test',
    auditFile: join(dir, 'audit.jsonl'),
    searchDbPath: join(dir, 'search.db'),
    calibrationFile: join(dir, 'usage-calibration.json'),
    ptyManager: stubPty,
    ...extra,
  });
}

// ------------------------------------------------------------------ item 1: INV-17 F-Term guard
describe('INV-17 F-Term remote guard (item 1)', () => {
  const env = { PLATFORM_CONSOLE_HOST: 'ext.example' }; // bypasses the global peer-IP guard
  it('401s F-Term for a non-loopback peer when no provider; other routes reachable', async () => {
    const app = consoleServer(env);
    const term = await app.inject({ url: '/api/term', headers: { host: 'ext.example' }, remoteAddress: '10.1.2.3' });
    expect(term.statusCode).toBe(401);
    const status = await app.inject({ url: '/api/status', headers: { host: 'ext.example' }, remoteAddress: '10.1.2.3' });
    expect(status.statusCode).toBe(200);
  });
  it('allows F-Term from a loopback peer', async () => {
    const app = consoleServer(env);
    const term = await app.inject({ url: '/api/term', headers: { host: 'ext.example' }, remoteAddress: '127.0.0.1' });
    expect(term.statusCode).toBe(200);
  });
});

// ------------------------------------------------------------------ item 2: F-Status
describe('F-Status doctor brief + active runs both modes (item 2)', () => {
  it('/api/status carries doctorBrief + runs.terminals + runs.autonomous', async () => {
    const app = consoleServer({});
    const j = (await app.inject({ url: '/api/status' })).json();
    expect(typeof j.doctorBrief).toBe('string');
    expect(Array.isArray(j.runs.terminals)).toBe(true);
    expect(j.runs.autonomous.running).toBe(false); // no human-plane token file
  });
  it('status page markup renders both surfaces', () => {
    expect(INDEX_HTML).toContain('Autonomous loop');
    expect(INDEX_HTML).toContain('Doctor (brief)');
  });
});

// ------------------------------------------------------------------ item 3: F-Sub
describe('F-Sub delete + dry test-run (item 3)', () => {
  it('create → dry test-run (wouldLoad) → delete → 404', async () => {
    const app = consoleServer({});
    const dir = tmp('sub-');
    await app.inject({ method: 'PUT', url: '/api/subagents?dir=' + enc(dir), payload: { name: 'my-agent', description: 'd', prompt: 'p' } });
    const tr = await app.inject({ method: 'POST', url: '/api/subagents/my-agent/test-run?dir=' + enc(dir) });
    expect(tr.statusCode).toBe(200);
    expect(tr.json()).toMatchObject({ dryValidation: true, wouldLoad: true });
    const del = await app.inject({ method: 'DELETE', url: '/api/subagents/my-agent?dir=' + enc(dir) });
    expect(del.statusCode).toBe(200);
    const missing = await app.inject({ method: 'POST', url: '/api/subagents/my-agent/test-run?dir=' + enc(dir) });
    expect(missing.statusCode).toBe(404);
  });
  it('flags bad frontmatter and states no model was called', async () => {
    const app = consoleServer({});
    const dir = tmp('sub2-');
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'agents', 'bad.md'), '---\nname: bad\n---\n\nhi\n'); // no description
    const tr = await app.inject({ method: 'POST', url: '/api/subagents/bad/test-run?dir=' + enc(dir) });
    expect(tr.json().wouldLoad).toBe(false);
    expect(tr.json().issues.join(' ')).toMatch(/description/);
    expect(tr.json().note).toMatch(/no model/i);
  });
});

// ------------------------------------------------------------------ item 4: F-Skill plugins
describe('F-Skill plugin toggle (item 4)', () => {
  it('enable needs consent (428); with consent 200; GET lists it; disable is free', async () => {
    const app = consoleServer({});
    const no = await app.inject({ method: 'PUT', url: '/api/skills/plugins', payload: { name: 'p@m', enabled: true } });
    expect(no.statusCode).toBe(428);
    const yes = await app.inject({ method: 'PUT', url: '/api/skills/plugins', payload: { name: 'p@m', enabled: true, consent: true } });
    expect(yes.statusCode).toBe(200);
    const skills = (await app.inject({ url: '/api/skills' })).json();
    expect(skills.plugins['p@m']).toBe(true);
    const off = await app.inject({ method: 'PUT', url: '/api/skills/plugins', payload: { name: 'p@m', enabled: false } });
    expect(off.statusCode).toBe(200);
    expect(off.json().enabledPlugins['p@m']).toBe(false);
  });
});

// ------------------------------------------------------------------ item 5: F-MCP
describe('F-MCP 3-layer + start-check + disable (item 5)', () => {
  it('GET returns user/project/managed layers + disabled; disable toggles user settings', async () => {
    const app = consoleServer({});
    const dir = tmp('mcp-');
    await app.inject({ method: 'PUT', url: '/api/mcp?dir=' + enc(dir), payload: { name: 'echo', server: { command: '/bin/echo' } } });
    const g = (await app.inject({ url: '/api/mcp?dir=' + enc(dir) })).json();
    expect(g.project.servers.echo).toBeTruthy();
    expect(g).toHaveProperty('user');
    expect(Array.isArray(g.disabled)).toBe(true);
    const dis = await app.inject({ method: 'POST', url: '/api/mcp/disable', payload: { name: 'echo', disabled: true } });
    expect(dis.json().disabled).toContain('echo');
    const g2 = (await app.inject({ url: '/api/mcp?dir=' + enc(dir) })).json();
    expect(g2.disabled).toContain('echo');
  });
  it('stdio start-check (consent-gated): echo → ok, nonzero exit → not ok, remote → null', async () => {
    const app = consoleServer({});
    const dir = tmp('mcp2-');
    await app.inject({ method: 'PUT', url: '/api/mcp?dir=' + enc(dir), payload: { name: 'ok', server: { command: '/bin/echo' } } });
    await app.inject({ method: 'PUT', url: '/api/mcp?dir=' + enc(dir), payload: { name: 'nope', server: { command: '/bin/sh', args: ['-c', 'exit 3'] } } });
    await app.inject({ method: 'PUT', url: '/api/mcp?dir=' + enc(dir), payload: { name: 'web', server: { url: 'https://example.com' } } });
    const okRes = (await app.inject({ method: 'POST', url: '/api/mcp/test?dir=' + enc(dir), payload: { name: 'ok', consent: true } })).json();
    expect(okRes).toMatchObject({ check: 'start-check', ok: true });
    expect(okRes.label).toMatch(/THIS host/); // labeled that it ran a command locally
    expect((await app.inject({ method: 'POST', url: '/api/mcp/test?dir=' + enc(dir), payload: { name: 'nope', consent: true } })).json().ok).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/api/mcp/test?dir=' + enc(dir), payload: { name: 'web', consent: true } })).json().ok).toBe(null);
  });
  it('start-check is consent-gated + dir/name validated (security)', async () => {
    const app = consoleServer({});
    const dir = tmp('mcp3-');
    await app.inject({ method: 'PUT', url: '/api/mcp?dir=' + enc(dir), payload: { name: 'echo', server: { command: '/bin/echo' } } });
    // (a) no consent → 428
    expect((await app.inject({ method: 'POST', url: '/api/mcp/test?dir=' + enc(dir), payload: { name: 'echo' } })).statusCode).toBe(428);
    // (b) name traversal → 400
    expect((await app.inject({ method: 'POST', url: '/api/mcp/test?dir=' + enc(dir), payload: { name: '../evil', consent: true } })).statusCode).toBe(400);
    // (c) dir without a .mcp.json → 400
    expect((await app.inject({ method: 'POST', url: '/api/mcp/test?dir=' + enc(tmp('empty-')), payload: { name: 'echo', consent: true } })).statusCode).toBe(400);
  });
});

// ------------------------------------------------------------------ item 6: F-Hook
describe('F-Hook handler types + disable-all (item 6)', () => {
  it('GET lists handlerTypes; PUT honors type + consent gate; bad type 400; disable-all gated', async () => {
    const app = consoleServer({});
    const dir = tmp('hook-');
    const g = (await app.inject({ url: '/api/hooks?dir=' + enc(dir) })).json();
    expect(g.handlerTypes).toContain('command');
    expect(g.handlerTypes.length).toBeGreaterThan(1); // not hardcoded to just 'command'
    const noConsent = await app.inject({ method: 'PUT', url: '/api/hooks/project?dir=' + enc(dir), payload: { event: 'PreToolUse', type: 'command', command: 'echo hi' } });
    expect(noConsent.statusCode).toBe(428);
    const ok = await app.inject({ method: 'PUT', url: '/api/hooks/project?dir=' + enc(dir), payload: { event: 'PreToolUse', type: 'command', command: 'echo hi', consent: true } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().type).toBe('command');
    const badType = await app.inject({ method: 'PUT', url: '/api/hooks/project?dir=' + enc(dir), payload: { event: 'PreToolUse', type: 'nonsense', command: 'x', consent: true } });
    expect(badType.statusCode).toBe(400);
    const daNo = await app.inject({ method: 'PUT', url: '/api/hooks/project/disable-all?dir=' + enc(dir), payload: { disableAllHooks: true } });
    expect(daNo.statusCode).toBe(428);
    const daYes = await app.inject({ method: 'PUT', url: '/api/hooks/project/disable-all?dir=' + enc(dir), payload: { disableAllHooks: true, consent: true } });
    expect(daYes.statusCode).toBe(200);
    expect(daYes.json().disableAllHooks).toBe(true);
  });
});

// ------------------------------------------------------------------ item 7: F-Usage calibration
describe('F-Usage calibration + reset estimate (item 7)', () => {
  it('computeResets: 5h window end + next weekly reset', () => {
    const now = Date.now();
    const r = computeResets(now - 3_600_000, { weeklyResetDay: (new Date(now).getDay() + 1) % 7, weeklyResetHour: 9 }, now);
    expect(r.windowResetAt).toBe(now - 3_600_000 + 5 * 3_600_000);
    expect(typeof r.weeklyResetAt).toBe('number');
    expect(r.weeklyResetAt! > now).toBe(true);
  });
  it('computeResets: null window + no calibration → nulls', () => {
    expect(computeResets(null, {}, Date.now())).toEqual({ windowResetAt: null, weeklyResetAt: null });
  });
  it('GET/PUT calibration validates; /api/usage returns resetEstimate', async () => {
    const app = consoleServer({}, { calibrationFile: join(tmp('cal-'), 'c.json') });
    expect((await app.inject({ method: 'PUT', url: '/api/usage/calibration', payload: { actualPct: 200 } })).statusCode).toBe(400);
    const ok = await app.inject({ method: 'PUT', url: '/api/usage/calibration', payload: { actualPct: 42, weeklyResetDay: 1, weeklyResetHour: 9 } });
    expect(ok.statusCode).toBe(200);
    expect((await app.inject({ url: '/api/usage/calibration' })).json().calibration.actualPct).toBe(42);
    const usage = (await app.inject({ url: '/api/usage' })).json();
    expect(usage.resetEstimate).toBeTruthy();
    expect(typeof usage.resetEstimate.weeklyResetAt).toBe('number');
  });
});

// ------------------------------------------------------------------ item 8: F-Term quota
describe('F-Term quota estimate (item 8)', () => {
  it('terminal page markup + launcher page show a quota line', async () => {
    expect(INDEX_HTML).toContain('Quota estimate');
    const app = consoleServer({});
    const page = await app.inject({ url: '/terminal' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('/api/usage');
    expect(page.body).toContain('quota');
  });
});

// ------------------------------------------------------------------ item 9: F-Loop views
describe('F-Loop task state + calibration (item 9)', () => {
  function loopApp(overrides: Record<string, unknown>): FastifyInstance {
    const app = Fastify({ logger: false });
    const dir = tmp('loopf-');
    writeFileSync(join(dir, 'token'), 'x');
    registerLoopConsole(app, {
      humanPlaneUrl: 'http://127.0.0.1:1', tokenFile: join(dir, 'token'),
      automationGuard: async () => ({ allowed: true, utilization: 0 }), audit: () => {}, ...overrides,
    } as never);
    return app;
  }
  it('GET /api/loop/calibration returns newest record; empty dir → null', async () => {
    const cdir = tmp('calib-');
    writeFileSync(join(cdir, 'a.json'), JSON.stringify({ heldOutPassed: '1/2' }));
    const r = (await loopApp({ calibrationDir: cdir }).inject({ url: '/api/loop/calibration' })).json();
    expect(r.calibration).toBeTruthy();
    const emptyApp = loopApp({ calibrationDir: tmp('calib2-') });
    expect((await emptyApp.inject({ url: '/api/loop/calibration' })).json().calibration).toBe(null);
  });
  it('loop page markup includes task state-machine + calibration + escalations + pause/resume', () => {
    expect(INDEX_HTML).toContain('Tasks (state machine)');
    expect(INDEX_HTML).toContain('Latest calibration');
    expect(INDEX_HTML).toContain('Escalations');
    expect(INDEX_HTML).toContain('data-pause');
    expect(INDEX_HTML).toContain('/api/loop/escalations/');
  });
});

// ------------------------------------------------------------------ item 10: F-Sys update
describe('F-Sys update check (item 10)', () => {
  it('/api/system exposes updateHint (fail-open string)', async () => {
    const app = consoleServer({});
    const j = (await app.inject({ url: '/api/system' })).json();
    expect(typeof j.updateHint).toBe('string');
  });
  it('system page renders the update hint', () => {
    expect(INDEX_HTML).toContain('claude update');
  });
});

// ------------------------------------------------------------------ addendum: new Human Plane proxies
describe('F-Loop escalation + pause/resume proxies (addendum)', () => {
  function loopAppWith(url: string, audits: Record<string, unknown>[]) {
    const app = Fastify({ logger: false });
    const dir = tmp('hp-');
    writeFileSync(join(dir, 'token'), 'tok');
    registerLoopConsole(app, {
      humanPlaneUrl: url, tokenFile: join(dir, 'token'),
      automationGuard: async () => ({ allowed: true, utilization: 0 }), audit: (e) => audits.push(e),
    } as never);
    return app;
  }

  it('proxies GET/resolve escalations + pause/resume to the Human Plane with audit', async () => {
    const seen: string[] = [];
    const hp: Server = createServer((req, res) => {
      req.on('data', () => { /* drain */ });
      req.on('end', () => {
        seen.push(`${req.method} ${req.url}`);
        res.writeHead(req.headers.authorization === 'Bearer tok' ? 200 : 401, { 'content-type': 'application/json' });
        if (req.url === '/escalations' && req.method === 'GET') {
          return res.end(JSON.stringify({ escalations: [{ id: 'e1', taskId: 'T1', question: 'retry?', options: [{ label: 'retry', estimatedCost: '1 iter', risk: 'low' }] }] }));
        }
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((r) => hp.listen(0, '127.0.0.1', () => r()));
    const port = (hp.address() as { port: number }).port;
    const audits: Record<string, unknown>[] = [];
    const app = loopAppWith(`http://127.0.0.1:${port}`, audits);

    const esc = (await app.inject({ url: '/api/loop/escalations' })).json();
    expect(esc.escalations[0].id).toBe('e1');
    expect((await app.inject({ method: 'POST', url: '/api/loop/escalations/e1', payload: { optionLabel: 'retry' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/loop/pause', payload: { taskId: 'T1' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/loop/resume', payload: { taskId: 'T1' } })).statusCode).toBe(200);

    expect(seen).toContain('GET /escalations');
    expect(seen).toContain('POST /escalations/e1');
    expect(seen).toContain('POST /steering/pause');
    expect(seen).toContain('POST /steering/resume');
    const auditTypes = audits.map((a) => a.type);
    expect(auditTypes).toEqual(expect.arrayContaining(['LOOP_ESCALATION_RESOLVE', 'LOOP_PAUSE', 'LOOP_RESUME']));
    hp.close();
  });

  it('validates required fields before proxying', async () => {
    const app = loopAppWith('http://127.0.0.1:1', []); // unreachable — must 400 before any fetch
    expect((await app.inject({ method: 'POST', url: '/api/loop/escalations/e1', payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/loop/pause', payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/loop/resume', payload: {} })).statusCode).toBe(400);
  });
});
