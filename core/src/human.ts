// Human Interface Plane (§10.3) — Phase 1 slice: approval packages + local HTTP API.
// Vendor-neutral; the operator surface (Console) is just another client of this API.
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EventLog } from './event-log.js';
import type { Steering } from './steering.js';
import type { EscalationStore } from './escalation.js';

/** §10.2 kill quarantine: move a worktree aside so its contents can't be reused, and log it. */
export function quarantineWorktree(dir: string, log: EventLog, taskId = '*'): string | null {
  if (!existsSync(dir)) return null;
  const dest = `${dir}-quarantined-${Date.now()}`;
  renameSync(dir, dest);
  log.append({ ts: Date.now(), taskId, type: 'WORKTREE_QUARANTINED', principal: 'human', payload: { from: dir, to: dest } });
  return dest;
}

export interface ApprovalPackage {
  id: string;
  taskId: string;
  riskLevel: 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
  goalExcerpt: string;
  diff: string;
  evidenceRefs: string[];
  assumptions: string[];
  unresolvedRisks: string[];
  attestationChecklist: string[];
  createdAt: number;
  status: 'pending' | 'approved' | 'rejected';
}

export interface ApprovalPolicy {
  maxDiffBytes: number; // §10.3: over budget → split the task, never build the package
}

const ATTESTATIONS: Record<ApprovalPackage['riskLevel'], string[]> = {
  L0: ['Gates passed on frozen artifact'],
  L1: ['Gates passed on frozen artifact'],
  L2: ['Gates passed on frozen artifact', 'Two independent reviews recorded'],
  L3: ['Gates passed on frozen artifact', 'I reviewed the full diff', 'Rollback path exists'],
  L4: ['NEVER AUTO — human executes manually (INV-4)'],
};

export class ApprovalStore {
  private items = new Map<string, ApprovalPackage>();

  constructor(private log: EventLog, private policy: ApprovalPolicy = { maxDiffBytes: 40_000 }) {}

  create(input: Omit<ApprovalPackage, 'id' | 'createdAt' | 'status' | 'attestationChecklist'>):
    | { ok: true; pkg: ApprovalPackage }
    | { ok: false; reason: string } {
    if (input.diff.length > this.policy.maxDiffBytes) {
      // rubber-stamp prevention at the source (§11.2 / §10.3)
      this.log.append({
        ts: Date.now(), taskId: input.taskId, type: 'APPROVAL_REFUSED_DIFF_BUDGET', principal: 'core',
        payload: { diffBytes: input.diff.length, maxDiffBytes: this.policy.maxDiffBytes },
      });
      return { ok: false, reason: `diff ${input.diff.length}B exceeds budget ${this.policy.maxDiffBytes}B — split the task` };
    }
    const pkg: ApprovalPackage = {
      ...input,
      id: `apr-${randomBytes(6).toString('hex')}`,
      createdAt: Date.now(),
      status: 'pending',
      attestationChecklist: ATTESTATIONS[input.riskLevel],
    };
    this.items.set(pkg.id, pkg);
    this.log.append({
      ts: Date.now(), taskId: pkg.taskId, type: 'APPROVAL_REQUESTED', principal: 'core',
      payload: { approvalId: pkg.id, riskLevel: pkg.riskLevel },
    });
    return { ok: true, pkg };
  }

  listPending(): ApprovalPackage[] {
    return [...this.items.values()].filter((p) => p.status === 'pending');
  }

  resolve(id: string, verdict: 'approved' | 'rejected'): ApprovalPackage | null {
    const pkg = this.items.get(id);
    if (!pkg || pkg.status !== 'pending') return null;
    pkg.status = verdict;
    this.log.append({
      ts: Date.now(), taskId: pkg.taskId, type: verdict === 'approved' ? 'APPROVAL_GRANTED' : 'APPROVAL_REJECTED',
      principal: 'human',
      payload: { approvalId: id, decisionMs: Date.now() - pkg.createdAt }, // rubber-stamp metric input
    });
    return pkg;
  }
}

export interface HumanPlaneDeps {
  log: EventLog;
  approvals: ApprovalStore;
  onKill?: () => void;
  /** steering hook (§10.3): inject human guidance into a running task as marked data */
  onSteer?: (taskId: string, guidance: string) => { accepted: boolean; reason?: string };
  /** §10.3 steering controller — enables POST /steering/{pause,inject,resume} and /pause */
  steering?: Steering;
  /** §10.3 decidable escalations — enables GET /escalations and POST /escalations/:id */
  escalations?: EscalationStore;
  tokenFile: string;
}

/** local Human Plane API (§10.3): loopback only, token-file auth, rate-limited. */
export function startHumanPlane(deps: HumanPlaneDeps, port: number): Promise<{ server: Server; token: string }> {
  const token = randomBytes(24).toString('hex');
  mkdirSync(dirname(deps.tokenFile), { recursive: true });
  writeFileSync(deps.tokenFile, token, { mode: 0o600 });

  let hits = 0;
  setInterval(() => { hits = 0; }, 10_000).unref();

  const server = createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const readJson = (handler: (body: Record<string, unknown>) => void): void => {
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); });
      req.on('end', () => {
        try { handler(JSON.parse(body || '{}') as Record<string, unknown>); }
        catch { send(400, { error: 'bad json' }); }
      });
    };
    if (++hits > 200) return send(429, { error: 'rate limited' });
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'unauthorized' });

    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/approvals') {
      return send(200, { approvals: deps.approvals.listPending() });
    }
    if (req.method === 'POST' && /^\/approvals\/[^/]+$/.test(url.pathname)) {
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); });
      req.on('end', () => {
        try {
          const { verdict } = JSON.parse(body || '{}') as { verdict?: 'approved' | 'rejected' };
          if (verdict !== 'approved' && verdict !== 'rejected') return send(400, { error: 'verdict required' });
          const pkg = deps.approvals.resolve(url.pathname.split('/')[2]!, verdict);
          return pkg ? send(200, { pkg }) : send(404, { error: 'not found or already resolved' });
        } catch {
          return send(400, { error: 'bad json' });
        }
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      const since = Number(url.searchParams.get('since') ?? 0);
      return send(200, { events: deps.log.all().filter((e) => (e.seq ?? 0) > since) });
    }
    // §10.3 decidable escalations — list pending, resolve by chosen option label
    if (req.method === 'GET' && url.pathname === '/escalations') {
      if (!deps.escalations) return send(501, { error: 'escalations not wired' });
      return send(200, { escalations: deps.escalations.listPending() });
    }
    if (req.method === 'POST' && /^\/escalations\/[^/]+$/.test(url.pathname)) {
      const id = url.pathname.split('/')[2]!;
      return readJson((b) => {
        if (!deps.escalations) return send(501, { error: 'escalations not wired' });
        const { optionLabel } = b as { optionLabel?: string };
        if (!optionLabel) return send(400, { error: 'optionLabel required' });
        const pending = deps.escalations.listPending().find((p) => p.id === id);
        if (!pending) return send(404, { error: 'not found or already resolved' });
        const optionIndex = pending.options.findIndex((o) => o.label === optionLabel);
        if (optionIndex < 0) return send(400, { error: 'optionLabel does not match any option' });
        const pkg = deps.escalations.resolve(id, optionIndex); // logs ESCALATION_RESOLVED (human, chosen)
        return pkg ? send(200, { pkg }) : send(404, { error: 'not found or already resolved' });
      });
    }
    // §10.3 steering endpoints — PAUSE_REQUESTED -> GUIDANCE_INJECTED -> RESUMED
    if (req.method === 'POST' && url.pathname === '/steering/pause') {
      return readJson((b) => {
        const { taskId } = b as { taskId?: string };
        if (!taskId) return send(400, { error: 'taskId required' });
        if (!deps.steering) return send(501, { error: 'steering not wired' });
        deps.steering.requestPause(taskId); // logs PAUSE_REQUESTED
        return send(200, { paused: true, taskId, note: 'resume with POST /steering/resume' });
      });
    }
    if (req.method === 'POST' && url.pathname === '/steering/inject') {
      return readJson((b) => {
        const { taskId, guidance, touchesAcOrScope } = b as { taskId?: string; guidance?: string; touchesAcOrScope?: boolean };
        if (!taskId || !guidance) return send(400, { error: 'taskId + guidance required' });
        if (!deps.steering) return send(501, { error: 'steering not wired' });
        // inject requires a prior pause; AC/scope guidance is refused (needs a contract amendment)
        const r = deps.steering.inject(taskId, { text: guidance, touchesAcOrScope: Boolean(touchesAcOrScope) });
        return send(r.accepted ? 200 : 409, r); // logs GUIDANCE_INJECTED or GUIDANCE_REFUSED_NEEDS_AMENDMENT
      });
    }
    if (req.method === 'POST' && url.pathname === '/steering/resume') {
      return readJson((b) => {
        const { taskId } = b as { taskId?: string };
        if (!taskId) return send(400, { error: 'taskId required' });
        if (!deps.steering) return send(501, { error: 'steering not wired' });
        deps.steering.resume(taskId); // logs RESUMED
        return send(200, { resumed: true, taskId });
      });
    }
    // §10.2 PAUSE (distinct from KILL): finishes the current atomic action then holds; resumable
    if (req.method === 'POST' && url.pathname === '/pause') {
      return readJson((b) => {
        const { taskId } = b as { taskId?: string };
        if (!taskId) return send(400, { error: 'taskId required' });
        if (!deps.steering) return send(501, { error: 'steering not wired' });
        deps.steering.requestPause(taskId); // logs PAUSE_REQUESTED
        return send(200, {
          paused: true, taskId,
          semantics: 'finishes the current atomic action then holds; resume with POST /steering/resume',
          differsFromKill: 'kill stops everything, requests credential revocation, and quarantines the worktree',
        });
      });
    }
    // /steer kept for compatibility: delegate to steering.inject when a controller is wired
    if (req.method === 'POST' && url.pathname === '/steer') {
      return readJson((b) => {
        const { taskId, guidance } = b as { taskId?: string; guidance?: string };
        if (!taskId || !guidance) return send(400, { error: 'taskId + guidance required' });
        if (deps.steering) {
          const r = deps.steering.inject(taskId, { text: guidance, touchesAcOrScope: false });
          return send(r.accepted ? 200 : 409, r);
        }
        if (!deps.onSteer) return send(501, { error: 'steering not wired' });
        const r = deps.onSteer(taskId, guidance);
        deps.log.append({
          ts: Date.now(), taskId, type: r.accepted ? 'STEER_ACCEPTED' : 'STEER_REFUSED',
          principal: 'human', payload: { chars: guidance.length, ...(r.reason ? { reason: r.reason } : {}) },
        });
        return send(r.accepted ? 200 : 409, r);
      });
    }
    if (req.method === 'POST' && url.pathname === '/kill') {
      deps.log.append({ ts: Date.now(), taskId: '*', type: 'KILL_SWITCH', principal: 'human', payload: {} });
      // §10.2: the platform cannot revoke a vendor subscription credential programmatically;
      // emit an advisory so the operator rotates/revokes it manually.
      deps.log.append({
        ts: Date.now(), taskId: '*', type: 'CREDENTIAL_REVOKE_REQUIRED', principal: 'core',
        payload: { reason: 'kill switch — rotate/revoke vendor credentials manually (§10.2)' },
      });
      deps.onKill?.(); // stops the loop via the abort flag + quarantines the worktree
      return send(200, { killed: true, credentialRevokeRequired: true, note: 'loop aborting; worktree quarantined via onKill; rotate vendor credentials manually' });
    }
    return send(404, { error: 'unknown endpoint' });
  });

  return new Promise((resolveP) => {
    server.listen(port, '127.0.0.1', () => resolveP({ server, token }));
  });
}
