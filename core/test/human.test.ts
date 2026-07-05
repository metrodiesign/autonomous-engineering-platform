// Human Plane (§10.3): approval package lifecycle, diff budget refusal, token-gated API.
import { describe, it, expect, afterAll } from 'vitest';
import { ApprovalStore, startHumanPlane } from '../src/human.js';
import { makeLog } from './helpers.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

const servers: Server[] = [];
afterAll(() => { for (const s of servers) s.close(); });

const basePkg = {
  taskId: 'T-1',
  riskLevel: 'L3' as const,
  goalExcerpt: 'auth feature',
  diff: '--- a/src/x.ts\n+++ b/src/x.ts\n+ok',
  evidenceRefs: ['ev-1'],
  assumptions: ['single tenant'],
  unresolvedRisks: ['rate limiting untested'],
};

describe('approval store (§10.3)', () => {
  it('creates pending package with risk-generated attestation checklist', () => {
    const store = new ApprovalStore(makeLog());
    const r = store.create(basePkg);
    if (!r.ok) throw new Error(r.reason);
    expect(r.pkg.status).toBe('pending');
    expect(r.pkg.attestationChecklist.length).toBeGreaterThan(1);
    expect(store.listPending()).toHaveLength(1);
  });

  it('refuses oversized diff — split the task, never a huge package', () => {
    const log = makeLog();
    const store = new ApprovalStore(log, { maxDiffBytes: 10 });
    const r = store.create(basePkg);
    expect(r.ok).toBe(false);
    expect(log.eventsFor('T-1').some((e) => e.type === 'APPROVAL_REFUSED_DIFF_BUDGET')).toBe(true);
  });

  it('resolve records human principal + decision time (rubber-stamp metric)', () => {
    const log = makeLog();
    const store = new ApprovalStore(log);
    const r = store.create(basePkg);
    if (!r.ok) throw new Error(r.reason);
    store.resolve(r.pkg.id, 'approved');
    const ev = log.eventsFor('T-1').find((e) => e.type === 'APPROVAL_GRANTED');
    expect(ev?.principal).toBe('human');
    expect(typeof ev?.payload.decisionMs).toBe('number');
  });
});

describe('human plane HTTP API (§10.3)', () => {
  it('rejects without token, serves approvals with token, resolves via POST', async () => {
    const log = makeLog();
    const approvals = new ApprovalStore(log);
    const created = approvals.create(basePkg);
    if (!created.ok) throw new Error(created.reason);

    const tokenFile = join(mkdtempSync(join(tmpdir(), 'hp-')), 'token');
    const { server, token } = await startHumanPlane({ log, approvals, tokenFile }, 0);
    servers.push(server);
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    expect((await fetch(`${base}/approvals`)).status).toBe(401);

    const auth = { authorization: `Bearer ${token}` };
    const list = await (await fetch(`${base}/approvals`, { headers: auth })).json();
    expect(list.approvals).toHaveLength(1);

    const res = await fetch(`${base}/approvals/${created.pkg.id}`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'approved' }),
    });
    expect((await res.json()).pkg.status).toBe('approved');

    const events = await (await fetch(`${base}/events?since=0`, { headers: auth })).json();
    expect(events.events.some((e: { type: string }) => e.type === 'APPROVAL_GRANTED')).toBe(true);
  });
});
