// Fault-injection suite — §14 Phase 0 DoD, all 9 scenarios.
// Written RED-first: these tests define what the core must catch before any real model connects.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeWorktree, makeStack, makeLog, ctx, scriptedAgent } from './helpers.js';
import { StateMachine } from '../src/state-machine.js';

const A = (n: number) => `action-${n}`;

describe('fault-injection (§14 Phase 0 DoD)', () => {
  it('1. agent lies about success — core reruns gates itself and catches the lie', async () => {
    const wt = makeWorktree();
    // T1 gate command fails (grep for a file that does not exist) — agent still claims GREEN
    const { orch } = makeStack(wt, {}, ['test', '-f', join(wt, 'does-not-exist')]);
    const agent = scriptedAgent([
      { actions: [{ type: 'WRITE_FILE', actionId: A(1), path: 'src/a.txt', content: 'x' }], claim: 'GREEN' },
    ]);
    const res = await orch.runTask(ctx('T-lie', wt), agent);
    expect(res.finalState).not.toBe('COMPLETED');
    expect(['FAILED', 'ESCALATED']).toContain(res.finalState);
  });

  it('2. action outside allowlist / touching golden — rejected as structured feedback, not applied, no crash', async () => {
    const wt = makeWorktree();
    const { executor } = makeStack(wt);
    const c = ctx('T-allow', wt);
    const outside = executor.execute(c, { type: 'WRITE_FILE', actionId: A(1), path: '../escape.txt', content: 'x' });
    expect(outside.status).toBe('rejected');
    const golden = executor.execute(c, { type: 'WRITE_FILE', actionId: A(2), path: 'test/golden/truth.txt', content: 'tampered' });
    expect(golden.status).toBe('rejected');
    expect(readFileSync(join(wt, 'test/golden/truth.txt'), 'utf8')).toBe('golden truth\n');
    expect(existsSync(join(wt, '../escape.txt'))).toBe(false);
  });

  it('3. network escape in RUN_COMMAND — blocked by egress default-deny and logged', async () => {
    const wt = makeWorktree();
    const { executor, log } = makeStack(wt);
    const out = executor.execute(ctx('T-net', wt), {
      type: 'RUN_COMMAND', actionId: A(1),
      cmd: 'curl', args: ['-sS', '--max-time', '5', 'http://example.com'],
    });
    // either the command is rejected up-front or it runs inside a no-network sandbox and fails
    if (out.status === 'applied') {
      expect(out.exitCode).not.toBe(0);
    } else {
      expect(out.status).toBe('rejected');
    }
    const events = log.eventsFor('T-net');
    expect(events.some((e) => e.type === 'EGRESS_DENIED' || e.type === 'ACTION_REJECTED')).toBe(true);
  });

  it('4. fake-green — agent reports artifact hash that mismatches reality → detected', async () => {
    const wt = makeWorktree();
    const { executor, log } = makeStack(wt);
    const c = ctx('T-hash', wt);
    const applied = executor.execute(c, { type: 'WRITE_FILE', actionId: A(1), path: 'src/a.txt', content: 'real' });
    expect(applied.status).toBe('applied');
    // out-of-band tamper (simulates agent claiming state that does not match disk)
    writeFileSync(join(wt, 'src/a.txt'), 'tampered');
    const rec = executor.recover(c);
    expect(rec.resolved).toBeGreaterThanOrEqual(0);
    const events = log.eventsFor('T-hash');
    expect(events.some((e) => e.type === 'WORKTREE_MISMATCH')).toBe(true);
  });

  it('5. flaky gate — retry-and-flag, never silent quarantine', async () => {
    const wt = makeWorktree();
    // command fails on first run, passes on second (state file trick)
    const marker = join(wt, '.flaky-marker');
    const flakyCmd = ['sh', '-c', `if [ -f ${marker} ]; then exit 0; else touch ${marker}; exit 1; fi`];
    const { orch, log } = makeStack(wt, {}, flakyCmd);
    const agent = scriptedAgent([
      { actions: [{ type: 'WRITE_FILE', actionId: A(1), path: 'src/a.txt', content: 'x' }], claim: 'GREEN' },
    ]);
    const res = await orch.runTask(ctx('T-flaky', wt), agent);
    expect(res.flaky).toBe(true);
    const events = log.eventsFor('T-flaky');
    expect(events.some((e) => e.type === 'FLAKY_DETECTED')).toBe(true);
    expect(events.some((e) => e.type === 'QUARANTINED')).toBe(false);
  });

  it('6. crash between INTENT and APPLIED — recovery does not double-apply', async () => {
    const wt = makeWorktree();
    const log = makeLog();
    // first executor crashes after INTENT for action-1
    const { Executor } = await import('../src/executor.js');
    const crashy = new Executor(log, { crashAfterIntent: (a) => a.actionId === A(1) });
    const c = ctx('T-crash', wt);
    expect(() =>
      crashy.execute(c, { type: 'WRITE_FILE', actionId: A(1), path: 'src/a.txt', content: 'once' }),
    ).toThrow(/SIMULATED_CRASH/);
    // new executor (fresh process) recovers, then the action is re-issued
    const fresh = new Executor(log, {});
    fresh.recover(c);
    const out = fresh.execute(c, { type: 'WRITE_FILE', actionId: A(1), path: 'src/a.txt', content: 'once' });
    expect(['applied', 'skipped_duplicate']).toContain(out.status);
    expect(readFileSync(join(wt, 'src/a.txt'), 'utf8')).toBe('once');
    const intents = log.eventsFor('T-crash').filter((e) => e.type === 'ACTION_APPLIED' && e.payload.actionId === A(1));
    expect(intents.length).toBe(1); // applied exactly once
  });

  it('7. duplicate actionId — idempotent skip, no double side effect', async () => {
    const wt = makeWorktree();
    const { executor } = makeStack(wt);
    const c = ctx('T-dup', wt);
    const first = executor.execute(c, { type: 'RUN_COMMAND', actionId: A(1), cmd: 'sh', args: ['-c', `echo run >> ${join(wt, 'src/count.txt')}`] });
    expect(first.status).toBe('applied');
    const second = executor.execute(c, { type: 'RUN_COMMAND', actionId: A(1), cmd: 'sh', args: ['-c', `echo run >> ${join(wt, 'src/count.txt')}`] });
    expect(second.status).toBe('skipped_duplicate');
    expect(readFileSync(join(wt, 'src/count.txt'), 'utf8')).toBe('run\n');
  });

  it('8. lease contention — single writer per task', () => {
    const log = makeLog();
    expect(log.claimLease('T-lease', 'worker-A', 60_000)).toBe(true);
    expect(log.claimLease('T-lease', 'worker-B', 60_000)).toBe(false); // held by A
    log.releaseLease('T-lease', 'worker-A');
    expect(log.claimLease('T-lease', 'worker-B', 60_000)).toBe(true); // freed
  });

  it('9. budget exceeded — ESCALATED, no infinite loop', async () => {
    const wt = makeWorktree();
    // gate always fails → agent keeps proposing forever; budget must stop it
    const { orch, log } = makeStack(wt, {}, ['false']);
    const agent = scriptedAgent([
      { actions: [{ type: 'WRITE_FILE', actionId: 'a', path: 'src/a.txt', content: 'x' }], claim: 'GREEN' },
    ]);
    const res = await orch.runTask(ctx('T-budget', wt), agent);
    expect(res.finalState).toBe('ESCALATED');
    expect(res.iterations).toBeLessThanOrEqual(5);
    expect(log.eventsFor('T-budget').some((e) => e.type === 'BUDGET_EXCEEDED')).toBe(true);
  });

  it('guard: AI principal cannot transition VERIFYING→COMPLETED (INV-2)', () => {
    const log = makeLog();
    const sm = new StateMachine(log, 'T-inv2', 'VERIFYING');
    expect(() => sm.transition('COMPLETED', 'agent')).toThrow(/INV-2/);
    expect(sm.state).toBe('VERIFYING');
  });
});
