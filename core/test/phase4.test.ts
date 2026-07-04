// Phase 4: planning gate traceability, lessons governance, rollback state path.
import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { makeLog, makeWorktree, makeStack, ctx } from './helpers.js';
import { checkPlanningGate } from '../src/planning-gate.js';
import { LessonStore } from '../src/lessons.js';
import { runHypothesisProbes } from '../src/repair.js';
import { StateMachine } from '../src/state-machine.js';

describe('planning gate (§11.2)', () => {
  const goal = { acceptanceCriteria: [{ id: 'AC-1' }, { id: 'AC-2' }] };

  it('blocks uncovered ACs, orphan tasks, and over-budget tasks', () => {
    const r = checkPlanningGate(goal, [
      { taskId: 'T-1', mapsToAc: ['AC-1'], estimatedDiffBytes: 100 },
      { taskId: 'T-orphan', mapsToAc: [], estimatedDiffBytes: 100 },
      { taskId: 'T-big', mapsToAc: ['AC-2'], estimatedDiffBytes: 999_999 },
    ]);
    expect(r.ok).toBe(false);
    expect(r.orphanTasks).toEqual(['T-orphan']);
    expect(r.overBudgetTasks).toEqual(['T-big']);
  });

  it('passes a fully traced plan; enabling tasks allowed without AC', () => {
    const r = checkPlanningGate(goal, [
      { taskId: 'T-1', mapsToAc: ['AC-1'], estimatedDiffBytes: 100 },
      { taskId: 'T-2', mapsToAc: ['AC-2'], estimatedDiffBytes: 100 },
      { taskId: 'T-infra', mapsToAc: [], enabling: true, estimatedDiffBytes: 50 },
    ]);
    expect(r.ok).toBe(true);
  });
});

describe('lessons governance (§10.4 / INV-16)', () => {
  it('refuses lessons without confirmed hypothesis; injectable only after human approval, marked as data', () => {
    const log = makeLog();
    const store = new LessonStore(log);
    expect(store.proposeFromHypothesis('T-l', 'never happened', 'x').ok).toBe(false);

    const wt = makeWorktree();
    runHypothesisProbes(log, 'T-l', wt, [
      { statement: 'true works', probes: [{ cmd: 'true', args: [], expectExitCode: 0 }], ifConfirmed: { patchPlan: 'p', estimatedBlastRadius: 'r' } },
    ]);
    const proposed = store.proposeFromHypothesis('T-l', 'true works', 'prefer smaller diffs');
    expect(proposed.ok).toBe(true);
    expect(store.injectable()).toHaveLength(0); // not yet approved
    store.approve(proposed.id!);
    const inj = store.injectable();
    expect(inj).toHaveLength(1);
    expect(inj[0]!.content).toMatch(/data, advisory, human-approved/);
  });
});

describe('rollback path (§6.3, Phase 4 continuous)', () => {
  it('MERGE_QUEUED -> ROLLED_BACK -> READY is legal and evented', () => {
    const log = makeLog();
    const sm = new StateMachine(log, 'T-rb', 'MERGE_QUEUED');
    sm.transition('ROLLED_BACK', 'core', { reason: 'canary regression' });
    sm.transition('READY', 'core');
    expect(sm.state).toBe('READY');
    const types = log.eventsFor('T-rb').map((e) => e.type);
    expect(types.filter((t) => t === 'STATE_TRANSITION')).toHaveLength(2);
  });

  it('worktree rollback discards uncommitted damage deterministically', () => {
    const wt = makeWorktree();
    const { executor, log } = makeStack(wt);
    executor.execute(ctx('T-rb2', wt), { type: 'WRITE_FILE', actionId: 'w1', path: 'src/a.txt', content: 'good' });
    // out-of-band damage, then recovery detects drift
    writeFileSync(`${wt}/src/a.txt`, 'damaged');
    executor.recover(ctx('T-rb2', wt));
    expect(log.eventsFor('T-rb2').some((e) => e.type === 'WORKTREE_MISMATCH')).toBe(true);
  });
});
