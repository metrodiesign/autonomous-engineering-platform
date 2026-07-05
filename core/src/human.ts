// Human Interface Plane (§10.3) — Phase 1 slice: approval packages + local HTTP API.
// Vendor-neutral; the operator surface (Console) is just another client of this API.
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EventLog } from './event-log.js';

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
    if (req.method === 'POST' && url.pathname === '/steer') {
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); });
      req.on('end', () => {
        try {
          const { taskId, guidance } = JSON.parse(body || '{}') as { taskId?: string; guidance?: string };
          if (!taskId || !guidance) return send(400, { error: 'taskId + guidance required' });
          if (!deps.onSteer) return send(501, { error: 'steering not wired' });
          const r = deps.onSteer(taskId, guidance);
          deps.log.append({
            ts: Date.now(), taskId, type: r.accepted ? 'STEER_ACCEPTED' : 'STEER_REFUSED',
            principal: 'human', payload: { chars: guidance.length, ...(r.reason ? { reason: r.reason } : {}) },
          });
          return send(r.accepted ? 200 : 409, r);
        } catch {
          return send(400, { error: 'bad json' });
        }
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/kill') {
      deps.log.append({ ts: Date.now(), taskId: '*', type: 'KILL_SWITCH', principal: 'human', payload: {} });
      deps.onKill?.();
      return send(200, { killed: true });
    }
    return send(404, { error: 'unknown endpoint' });
  });

  return new Promise((resolveP) => {
    server.listen(port, '127.0.0.1', () => resolveP({ server, token }));
  });
}
