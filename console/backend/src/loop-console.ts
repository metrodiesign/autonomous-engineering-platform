// F-Loop + F-Sched (§8, Phase 3). F-Loop is a CLIENT of the Human Plane API (INV-11 —
// no core state owned here); F-Sched only starts/stops opaque processes, never task-schedules.
import type { FastifyInstance } from 'fastify';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { redactJson } from './redact.js';

export interface LoopConsoleDeps {
  humanPlaneUrl: string; // e.g. http://127.0.0.1:9210
  tokenFile: string;
  automationGuard: () => Promise<{ allowed: boolean; utilization: number }>;
  /** env source for PLATFORM_SCHED_ALLOWLIST (§13.3 spawn allowlist); defaults to process.env */
  env?: Record<string, string | undefined>;
  /** allowlist root for spawn commands; defaults to <cwd>/scripts */
  schedScriptsDir?: string;
  /** directory holding calibration records; defaults to .ai/calibration */
  calibrationDir?: string;
  audit: (e: Record<string, unknown>) => void;
}

export function registerLoopConsole(app: FastifyInstance, deps: LoopConsoleDeps): void {
  const authHeader = () => ({ authorization: `Bearer ${readFileSync(deps.tokenFile, 'utf8').trim()}` });
  const proxy = async (path: string, init?: RequestInit) => {
    const r = await fetch(`${deps.humanPlaneUrl}${path}`, { ...init, headers: { ...authHeader(), 'content-type': 'application/json' } });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  // ---- F-Loop: read-only views + decision actions, all via Human Plane API ----
  app.get('/api/loop/approvals', async (_req, reply) => {
    if (!existsSync(deps.tokenFile)) return reply.code(503).send({ error: 'loop not running (no token file)' });
    const { status, body } = await proxy('/approvals');
    return reply.code(status).send(body);
  });

  app.post<{ Params: { id: string }; Body: { verdict: 'approved' | 'rejected' } }>(
    '/api/loop/approvals/:id',
    async (req, reply) => {
      const { status, body } = await proxy(`/approvals/${req.params.id}`, {
        method: 'POST', body: JSON.stringify({ verdict: req.body?.verdict }),
      });
      deps.audit({ type: 'LOOP_APPROVAL_DECISION', id: req.params.id, verdict: req.body?.verdict, ts: Date.now() });
      return reply.code(status).send(body);
    },
  );

  app.get<{ Querystring: { since?: string } }>('/api/loop/events', async (req, reply) => {
    const { status, body } = await proxy(`/events?since=${req.query.since ?? 0}`);
    return reply.code(status).send(redactJson(body)); // INV-14: Human Plane events may echo diffs/notes
  });

  app.post<{ Body: { taskId?: string; guidance?: string } }>('/api/loop/steer', async (req, reply) => {
    const { taskId, guidance } = req.body ?? {};
    if (!taskId || !guidance) return reply.code(400).send({ error: 'taskId + guidance required' });
    const { status, body } = await proxy('/steer', { method: 'POST', body: JSON.stringify({ taskId, guidance }) });
    deps.audit({ type: 'LOOP_STEER', taskId, ts: Date.now() });
    return reply.code(status).send(body);
  });

  app.post('/api/loop/kill', async (_req, reply) => {
    const { status, body } = await proxy('/kill', { method: 'POST', body: '{}' });
    deps.audit({ type: 'LOOP_KILL', ts: Date.now() });
    return reply.code(status).send(body);
  });

  // ---- F-Loop: decidable escalations (§10.3 — question + priced options, never a log dump) ----
  app.get('/api/loop/escalations', async (_req, reply) => {
    if (!existsSync(deps.tokenFile)) return reply.code(503).send({ error: 'loop not running (no token file)' });
    const { status, body } = await proxy('/escalations');
    return reply.code(status).send(redactJson(body)); // INV-14: escalation questions/options are free text
  });

  app.post<{ Params: { id: string }; Body: { optionLabel?: string } }>('/api/loop/escalations/:id', async (req, reply) => {
    if (!req.body?.optionLabel) return reply.code(400).send({ error: 'optionLabel required' });
    const { status, body } = await proxy(`/escalations/${req.params.id}`, {
      method: 'POST', body: JSON.stringify({ optionLabel: req.body.optionLabel }),
    });
    deps.audit({ type: 'LOOP_ESCALATION_RESOLVE', id: req.params.id, optionLabel: req.body.optionLabel, ts: Date.now() });
    return reply.code(status).send(redactJson(body));
  });

  // ---- F-Loop: PAUSE / RESUME per task (§10.3 — reversible, distinct from KILL) ----
  app.post<{ Body: { taskId?: string } }>('/api/loop/pause', async (req, reply) => {
    if (!req.body?.taskId) return reply.code(400).send({ error: 'taskId required' });
    const { status, body } = await proxy('/steering/pause', { method: 'POST', body: JSON.stringify({ taskId: req.body.taskId }) });
    deps.audit({ type: 'LOOP_PAUSE', taskId: req.body.taskId, ts: Date.now() });
    return reply.code(status).send(body);
  });

  app.post<{ Body: { taskId?: string } }>('/api/loop/resume', async (req, reply) => {
    if (!req.body?.taskId) return reply.code(400).send({ error: 'taskId required' });
    const { status, body } = await proxy('/steering/resume', { method: 'POST', body: JSON.stringify({ taskId: req.body.taskId }) });
    deps.audit({ type: 'LOOP_RESUME', taskId: req.body.taskId, ts: Date.now() });
    return reply.code(status).send(body);
  });

  // F-Loop (§8): most recent calibration record from .ai/calibration/
  app.get('/api/loop/calibration', async (_req, reply) => {
    const dir = deps.calibrationDir ?? join('.ai', 'calibration');
    if (!existsSync(dir)) return { calibration: null, note: 'no calibration runs yet' };
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    if (!files.length) return { calibration: null, note: 'no calibration runs yet' };
    const newest = files
      .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0]!;
    try {
      return { file: newest.f, calibration: JSON.parse(readFileSync(join(dir, newest.f), 'utf8')) };
    } catch {
      return reply.code(500).send({ error: 'calibration record unreadable' });
    }
  });

  // ---- F-Sched: opaque process start/stop ONLY (§8 F-Sched B-rule) ----
  const jobs = new Map<string, ChildProcess>();
  const startTimes: number[] = []; // §13.3 spawn rate limit (5/min, like login)
  const env = deps.env ?? process.env;
  const scriptsDir = resolve(deps.schedScriptsDir ?? join(process.cwd(), 'scripts'));
  const allowlist = (env.PLATFORM_SCHED_ALLOWLIST ?? '').split(':').filter(Boolean);
  const argAllowlist = (env.PLATFORM_SCHED_ARG_ALLOWLIST ?? '').split(':').filter(Boolean);

  // §13.3: only commands resolving inside the repo's scripts/ dir, or explicitly allowlisted,
  // may be spawned — otherwise /api/sched/start is arbitrary code execution.
  const commandAllowed = (cmd: string): boolean => {
    const abs = resolve(cmd);
    if (abs === scriptsDir || abs.startsWith(scriptsDir + sep)) return true;
    return allowlist.includes(cmd) || allowlist.includes(abs);
  };

  // §13.3: args must be plain strings with no control chars, and flags (leading '-') must be
  // explicitly allowlisted — otherwise an allowlisted script can be driven into unsafe modes.
  const badArg = (a: unknown): string | null => {
    if (typeof a !== 'string') return 'non-string arg';
    if (/[\n\r\0]/.test(a)) return `arg has control chars: ${JSON.stringify(a)}`;
    if (a.startsWith('-') && !argAllowlist.includes(a)) return `flag not in PLATFORM_SCHED_ARG_ALLOWLIST: ${a}`;
    return null;
  };

  app.post<{ Body: { name: string; cmd: string; args?: string[] } }>('/api/sched/start', async (req, reply) => {
    const { name, cmd, args } = req.body ?? {};
    if (!name || !cmd) return reply.code(400).send({ error: 'name + cmd required' });
    if (args !== undefined && !Array.isArray(args)) return reply.code(400).send({ error: 'args must be a string array' });
    const now = Date.now();
    startTimes.splice(0, startTimes.length, ...startTimes.filter((t) => now - t < 60_000));
    if (startTimes.length >= 5) return reply.code(429).send({ error: 'sched start rate limit exceeded (5/min, §13.3)' });
    if (jobs.has(name)) return reply.code(409).send({ error: `job ${name} already running` });
    const guard = await deps.automationGuard();
    if (!guard.allowed) {
      return reply.code(429).send({
        error: `automation guard: quota utilization ${(guard.utilization * 100).toFixed(0)}% over threshold — yield to interactive (INV-13)`,
        deferUntilReset: true,
      });
    }
    if (!commandAllowed(cmd)) {
      return reply.code(403).send({
        error: `command not allowed: must resolve inside ${scriptsDir} or be listed in PLATFORM_SCHED_ALLOWLIST (§13.3)`,
      });
    }
    for (const a of args ?? []) {
      const reason = badArg(a);
      if (reason) return reply.code(400).send({ error: `rejected arg (§13.3): ${reason}` });
    }
    startTimes.push(now);
    const child = spawn(cmd, args ?? [], { stdio: 'ignore', detached: false });
    jobs.set(name, child);
    child.on('exit', () => jobs.delete(name));
    deps.audit({ type: 'SCHED_START', name, cmd, ts: Date.now() });
    return { ok: true, pid: child.pid };
  });

  app.post<{ Body: { name: string } }>('/api/sched/stop', async (req, reply) => {
    const child = jobs.get(req.body?.name ?? '');
    if (!child) return reply.code(404).send({ error: 'no such job' });
    child.kill('SIGTERM');
    jobs.delete(req.body.name);
    deps.audit({ type: 'SCHED_STOP', name: req.body.name, ts: Date.now() });
    return { ok: true };
  });

  app.get('/api/sched', async () => ({ jobs: [...jobs.keys()] }));
}
