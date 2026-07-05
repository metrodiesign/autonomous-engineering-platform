// Phase 3 core: out-of-band auditor detects non-repro; merge queue attributes failures.
import { describe, it, expect } from 'vitest';
import { makeLog, makeWorktree, makeStack, ctx } from './helpers.js';
import { auditTask } from '../src/auditor.js';
import { MergeQueue } from '../src/merge-queue.js';

const gatesFor = (passCmd: string[]) => (dir: string) => ({
  t0: [{ name: 'probe', cmd: passCmd[0]!, args: passCmd.slice(1), cwd: dir }],
  t1: [{ name: 'probe', cmd: passCmd[0]!, args: passCmd.slice(1), cwd: dir }],
  flakyRetry: false,
});

describe('out-of-band auditor (§6.5)', () => {
  it('reproduces a healthy task from clean checkout', () => {
    const wt = makeWorktree();
    const { executor, log } = makeStack(wt);
    executor.execute(ctx('T-a', wt), { type: 'WRITE_FILE', actionId: 'w1', path: 'src/ok.txt', content: 'fine' });
    const report = auditTask(log, 'T-a', {}, gatesFor(['test', '-f', 'src/ok.txt']));
    expect(report.reproduced).toBe(true);
    expect(log.eventsFor('T-a').some((e) => e.type === 'AUDIT_REPRODUCED')).toBe(true);
  });

  it('detects non-reproducibility when evidence trail cannot pass gates', () => {
    const wt = makeWorktree();
    const { executor, log } = makeStack(wt);
    executor.execute(ctx('T-b', wt), { type: 'WRITE_FILE', actionId: 'w1', path: 'src/present.txt', content: 'x' });
    // gate demands a file that was never in the applied evidence -> clean checkout lacks it
    const report = auditTask(log, 'T-b', {}, gatesFor(['test', '-f', 'src/tampered-in-later.txt']));
    expect(report.reproduced).toBe(false);
    expect(log.eventsFor('T-b').some((e) => e.type === 'AUDIT_NON_REPRODUCIBLE')).toBe(true);
  });
});

describe('merge queue (§6.5)', () => {
  it('serializes, lands passing items, attributes failure to exactly one item', () => {
    const log = makeLog();
    const q = new MergeQueue(log);
    const landed: string[] = [];
    q.enqueue({ taskId: 'T-1', verify: () => true, land: () => landed.push('T-1') });
    q.enqueue({ taskId: 'T-2', verify: () => false, land: () => landed.push('T-2') });
    q.enqueue({ taskId: 'T-3', verify: () => true, land: () => landed.push('T-3') });
    const results = q.drain();
    expect(landed).toEqual(['T-1', 'T-3']);
    expect(results[1]).toEqual({ taskId: 'T-2', landed: false, attribution: 'T-2' });
    expect(log.eventsFor('T-2').some((e) => e.type === 'MERGE_REJECTED')).toBe(true);
  });
});
