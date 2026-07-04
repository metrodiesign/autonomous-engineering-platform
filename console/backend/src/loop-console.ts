// F-Loop + F-Sched (§8, Phase 3). F-Loop is a CLIENT of the Human Plane API (INV-11 —
// no core state owned here); F-Sched only starts/stops opaque processes, never task-schedules.
import type { FastifyInstance } from 'fastify';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

export interface LoopConsoleDeps {
  humanPlaneUrl: string; // e.g. http://127.0.0.1:9210
  tokenFile: string;
  automationGuard: () => Promise<{ allowed: boolean; utilization: number }>;
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
    return reply.code(status).send(body);
  });

  app.post('/api/loop/kill', async (_req, reply) => {
    const { status, body } = await proxy('/kill', { method: 'POST', body: '{}' });
    deps.audit({ type: 'LOOP_KILL', ts: Date.now() });
    return reply.code(status).send(body);
  });

  // ---- F-Sched: opaque process start/stop ONLY (§8 F-Sched B-rule) ----
  const jobs = new Map<string, ChildProcess>();

  app.post<{ Body: { name: string; cmd: string; args?: string[] } }>('/api/sched/start', async (req, reply) => {
    const { name, cmd, args } = req.body ?? {};
    if (!name || !cmd) return reply.code(400).send({ error: 'name + cmd required' });
    if (jobs.has(name)) return reply.code(409).send({ error: `job ${name} already running` });
    const guard = await deps.automationGuard();
    if (!guard.allowed) {
      return reply.code(429).send({
        error: `automation guard: quota utilization ${(guard.utilization * 100).toFixed(0)}% over threshold — yield to interactive (INV-13)`,
        deferUntilReset: true,
      });
    }
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
