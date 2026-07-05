// Human Plane gap-fix: §10.3 steering endpoints (pause/inject/resume) + decidable escalation
// endpoints, §10.2 kill switch (abort flag + worktree quarantine + credential-revoke advisory)
// distinct from PAUSE. HTTP is exercised against a real loopback server on a random port.
// Vendor-neutral (INV-7).
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { ApprovalStore, startHumanPlane, quarantineWorktree, type HumanPlaneDeps } from '../src/human.js';
import { Steering } from '../src/steering.js';
import { EscalationStore, buildEscalationPackage } from '../src/escalation.js';
import { makeLog, makeWorktree, makeStack, ctx } from './helpers.js';
import type { EventLog } from '../src/event-log.js';
import type { AgentPort } from '../src/types.js';

const servers: Server[] = [];
afterAll(() => { for (const s of servers) s.close(); });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function boot(log: EventLog, extra: Partial<HumanPlaneDeps> = {}) {
  const approvals = extra.approvals ?? new ApprovalStore(log);
  const tokenFile = join(mkdtempSync(join(tmpdir(), 'hp-')), 'token');
  const { server, token } = await startHumanPlane({ log, approvals, tokenFile, ...extra }, 0);
  servers.push(server);
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const post = (path: string, body?: unknown) =>
    fetch(`${base}${path}`, { method: 'POST', headers: auth, body: body === undefined ? undefined : JSON.stringify(body) });
  const get = (path: string) => fetch(`${base}${path}`, { headers: auth });
  return { base, auth, post, get };
}

describe('§10.3 steering endpoints', () => {
  it('inject requires pause; pause -> inject -> resume flows through the event log', async () => {
    const log = makeLog();
    const steering = new Steering(log);
    const { post } = await boot(log, { steering });

    expect((await post('/steering/inject', { taskId: 'T-s', guidance: 'try x' })).status).toBe(409);
    expect((await post('/steering/pause', { taskId: 'T-s' })).status).toBe(200);
    // AC/scope guidance must be a contract amendment, not advisory
    expect((await post('/steering/inject', { taskId: 'T-s', guidance: 'drop AC-2', touchesAcOrScope: true })).status).toBe(409);
    const inj = await post('/steering/inject', { taskId: 'T-s', guidance: 'prefer smaller diff' });
    expect(inj.status).toBe(200);
    expect((await inj.json()).asDataPiece.content).toMatch(/data, advisory/);
    expect((await post('/steering/resume', { taskId: 'T-s' })).status).toBe(200);

    const types = log.eventsFor('T-s').map((e) => e.type);
    expect(types).toContain('PAUSE_REQUESTED');
    expect(types).toContain('GUIDANCE_REFUSED_NEEDS_AMENDMENT');
    expect(types).toContain('GUIDANCE_INJECTED');
    expect(types).toContain('RESUMED');
  });

  it('returns 501 when no steering controller is wired', async () => {
    const { post } = await boot(makeLog());
    expect((await post('/steering/pause', { taskId: 'T' })).status).toBe(501);
  });

  it('/steer stays compatible and delegates to inject', async () => {
    const log = makeLog();
    const steering = new Steering(log);
    const { post } = await boot(log, { steering });
    expect((await post('/steer', { taskId: 'T-c', guidance: 'no pause yet' })).status).toBe(409); // inject requires pause
    await post('/steering/pause', { taskId: 'T-c' });
    expect((await post('/steer', { taskId: 'T-c', guidance: 'advisory' })).status).toBe(200);
  });
});

describe('§10.3 decidable escalation endpoints', () => {
  it('lists pending escalations and resolves one by option label (audited to human)', async () => {
    const log = makeLog();
    const escalations = new EscalationStore(log);
    const pkg = escalations.create(buildEscalationPackage({ taskId: 'T-e', reason: 'budget_exceeded', fingerprint: 'abc', refutedHypotheses: [] }));
    const { get, post } = await boot(log, { escalations });

    const list = await (await get('/escalations')).json();
    expect(list.escalations).toHaveLength(1);

    const res = await post(`/escalations/${pkg.id}`, { optionLabel: pkg.options[0]!.label });
    expect(res.status).toBe(200);
    expect((await res.json()).pkg.status).toBe('resolved');
    const ev = log.eventsFor('T-e').find((e) => e.type === 'ESCALATION_RESOLVED');
    expect(ev?.principal).toBe('human');
    expect(ev?.payload.chosenOptionIndex).toBe(0);
  });

  it('rejects an unknown option label and 501s when not wired', async () => {
    const log = makeLog();
    const escalations = new EscalationStore(log);
    const pkg = escalations.create(buildEscalationPackage({ taskId: 'T-e2', reason: 'budget_exceeded' }));
    const { post } = await boot(log, { escalations });
    expect((await post(`/escalations/${pkg.id}`, { optionLabel: 'nope' })).status).toBe(400);

    const { get } = await boot(makeLog());
    expect((await get('/escalations')).status).toBe(501);
  });
});

describe('§10.2 kill switch', () => {
  it('fires onKill, emits KILL_SWITCH + CREDENTIAL_REVOKE_REQUIRED, flags credential revoke', async () => {
    const log = makeLog();
    let killed = false;
    const { post } = await boot(log, { onKill: () => { killed = true; } });
    const res = await post('/kill');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.killed).toBe(true);
    expect(body.credentialRevokeRequired).toBe(true);
    expect(killed).toBe(true);
    const types = log.all().map((e) => e.type);
    expect(types).toContain('KILL_SWITCH');
    expect(types).toContain('CREDENTIAL_REVOKE_REQUIRED');
  });

  it('quarantineWorktree renames an existing dir and logs it; returns null for a missing dir', () => {
    const log = makeLog();
    const dir = mkdtempSync(join(tmpdir(), 'qt-'));
    const dest = quarantineWorktree(dir, log, 'T-q');
    expect(dest).toMatch(/-quarantined-/);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(dest!)).toBe(true);
    expect(log.eventsFor('T-q').some((e) => e.type === 'WORKTREE_QUARANTINED')).toBe(true);
    expect(quarantineWorktree(join(dir, 'nope'), log)).toBeNull();
  });

  it('shouldAbort stops the orchestrator loop with RUN_ABORTED before proposing', async () => {
    const wt = makeWorktree();
    const { log, orch } = makeStack(wt);
    let proposed = false;
    const agent: AgentPort = { async propose() { proposed = true; return { actions: [] }; } };
    const res = await orch.runTask(ctx('T-kill', wt), agent, { shouldAbort: () => true });
    expect(res.finalState).toBe('CANCELLED');
    expect(res.aborted).toBe(true);
    expect(proposed).toBe(false);
    expect(log.eventsFor('T-kill').some((e) => e.type === 'RUN_ABORTED')).toBe(true);
  });
});

describe('§10.2 PAUSE distinct from KILL', () => {
  it('/pause holds the task (resumable) and states how it differs from kill', async () => {
    const log = makeLog();
    const steering = new Steering(log);
    const { post } = await boot(log, { steering });
    const res = await post('/pause', { taskId: 'T-p' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.paused).toBe(true);
    expect(body.semantics).toMatch(/atomic action/);
    expect(body.differsFromKill).toMatch(/quarantine/);
    expect(log.eventsFor('T-p').some((e) => e.type === 'PAUSE_REQUESTED')).toBe(true);
  });
});

describe('§10.3 pause holds the orchestrator loop', () => {
  it('holds before proposing while paused, then resumes to completion', async () => {
    const wt = makeWorktree();
    const { log, orch } = makeStack(wt); // gate 'true'
    const steering = new Steering(log);
    let proposeCount = 0;
    const agent: AgentPort = {
      async propose() {
        proposeCount++;
        return { actions: [{ type: 'WRITE_FILE', actionId: 'a1', path: 'src/a.txt', content: 'x' }], claim: 'GREEN' };
      },
    };
    steering.requestPause('T-hold');
    const p = orch.runTask(ctx('T-hold', wt), agent, { steering, pausePollMs: 10 });
    await sleep(40);
    expect(proposeCount).toBe(0); // held at the iteration boundary — nothing proposed yet
    expect(log.eventsFor('T-hold').some((e) => e.type === 'PAUSED_HOLD')).toBe(true);

    steering.resume('T-hold');
    const res = await p;
    expect(res.finalState).toBe('REVIEWING');
    expect(proposeCount).toBeGreaterThan(0);
    expect(log.eventsFor('T-hold').some((e) => e.type === 'RESUMED_CONTINUE')).toBe(true);
  });

  it('a kill during a pause wins — CANCELLED, work never resumes', async () => {
    const wt = makeWorktree();
    const { log, orch } = makeStack(wt);
    const steering = new Steering(log);
    let killed = false;
    let proposeCount = 0;
    const agent: AgentPort = { async propose() { proposeCount++; return { actions: [], claim: 'GREEN' }; } };
    steering.requestPause('T-pk');
    const p = orch.runTask(ctx('T-pk', wt), agent, { steering, shouldAbort: () => killed, pausePollMs: 10 });
    await sleep(40);
    expect(proposeCount).toBe(0);
    killed = true;
    const res = await p;
    expect(res.finalState).toBe('CANCELLED');
    expect(res.aborted).toBe(true);
    expect(proposeCount).toBe(0);
    const types = log.eventsFor('T-pk').map((e) => e.type);
    expect(types).toContain('PAUSED_HOLD');
    expect(types).toContain('RUN_ABORTED');
    expect(types).not.toContain('RESUMED_CONTINUE');
  });
});
