// Gap-fix loop wiring: §6.2 lease, §6.4 T0-every-iteration, §6.6 cost budget + failure
// fingerprint, §9.2 RED-first + REFACTOR, §9.3 hypothesis repair, §10.3 decidable escalation,
// §11.2 planning gate. All exercised through optional deps only — the no-deps path keeps the
// Phase 0 behavior asserted in fault-injection.test.ts. Vendor-neutral (INV-7).
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { makeWorktree, makeStack, ctx, scriptedAgent } from './helpers.js';
import { EscalationStore } from '../src/escalation.js';
import { buildContext } from '../src/context-builder.js';
import type { Action, AgentPort, AgentRequest, Budget } from '../src/types.js';

const w = (actionId: string, path: string, content = 'x'): Action =>
  ({ type: 'WRITE_FILE', actionId, path, content });

describe('§6.2 lease — single writer', () => {
  it('refuses to run when another owner holds the lease', async () => {
    const wt = makeWorktree();
    const { log, orch } = makeStack(wt);
    expect(log.claimLease('T-lease', 'other-owner', 60_000)).toBe(true);
    let proposed = false;
    const agent: AgentPort = { async propose() { proposed = true; return { actions: [] }; } };
    const res = await orch.runTask(ctx('T-lease', wt), agent);
    expect(res.leaseRefused).toBe(true);
    expect(proposed).toBe(false);
    expect(log.eventsFor('T-lease').some((e) => e.type === 'LEASE_REFUSED')).toBe(true);
  });

  it('claims then releases the lease around a normal run', async () => {
    const wt = makeWorktree();
    const { log, orch } = makeStack(wt);
    const res = await orch.runTask(ctx('T-lease-ok', wt), scriptedAgent([{ actions: [w('a1', 'src/a.txt')], claim: 'GREEN' }]));
    expect(res.finalState).toBe('REVIEWING');
    expect(log.claimLease('T-lease-ok', 'next', 1000)).toBe(true); // freed after the run
    const types = log.eventsFor('T-lease-ok').map((e) => e.type);
    expect(types).toContain('LEASE_CLAIMED');
    expect(types).toContain('LEASE_RELEASED');
  });
});

describe('§6.4 T0 runs every iteration', () => {
  it('emits a T0 gate event each iteration even without a GREEN claim', async () => {
    const wt = makeWorktree();
    const { log, orch } = makeStack(wt);
    const budget: Budget = { maxIterations: 2, maxCostUnits: 1000, maxWallclockMs: 60_000 };
    const agent = scriptedAgent([{ actions: [] }]); // never claims GREEN
    const res = await orch.runTask(ctx('T-t0', wt, { budget }), agent);
    expect(res.finalState).toBe('ESCALATED');
    expect(log.eventsFor('T-t0').filter((e) => e.type === 'T0_GATE')).toHaveLength(2);
  });
});

describe('§6.6 cost-unit budget', () => {
  it('escalates when a single proposal already exceeds maxCostUnits', async () => {
    const wt = makeWorktree();
    const { log, orch } = makeStack(wt);
    const budget: Budget = { maxIterations: 100, maxCostUnits: 4, maxWallclockMs: 60_000 };
    const agent = scriptedAgent([{ actions: [], costUnits: 5 }]);
    const res = await orch.runTask(ctx('T-cost', wt, { budget }), agent);
    expect(res.finalState).toBe('ESCALATED');
    expect(log.eventsFor('T-cost').some((e) => e.type === 'BUDGET_EXCEEDED' && e.payload.cause === 'cost_units')).toBe(true);
  });

  it('defaults to 1 cost unit per proposal and accumulates', async () => {
    const wt = makeWorktree();
    const { log, orch } = makeStack(wt);
    const budget: Budget = { maxIterations: 100, maxCostUnits: 2, maxWallclockMs: 60_000 };
    const agent = scriptedAgent([{ actions: [] }]); // default cost 1, never GREEN
    const res = await orch.runTask(ctx('T-cost2', wt, { budget }), agent);
    expect(res.finalState).toBe('ESCALATED');
    expect(log.eventsFor('T-cost2').some((e) => e.type === 'BUDGET_EXCEEDED' && e.payload.cause === 'cost_units')).toBe(true);
  });
});

describe('§6.6 failure fingerprint', () => {
  it('emits FINGERPRINT_REPEAT (advisory) when the same failure recurs consecutively', async () => {
    const wt = makeWorktree();
    const { log, orch } = makeStack(wt, {}, ['false']); // gate always fails
    const budget: Budget = { maxIterations: 3, maxCostUnits: 1000, maxWallclockMs: 60_000 };
    const agent = scriptedAgent([{ actions: [w('a1', 'src/a.txt')], claim: 'GREEN' }]);
    const res = await orch.runTask(ctx('T-fp', wt, { budget }), agent);
    const repeats = log.eventsFor('T-fp').filter((e) => e.type === 'FINGERPRINT_REPEAT');
    expect(repeats.length).toBeGreaterThanOrEqual(1);
    expect(repeats[0]!.payload.advice).toMatch(/switch/);
    expect(res.finalState).toBe('ESCALATED');
  });
});

describe('§9.2 rule 1 RED-first', () => {
  it('bounces weak (immediately passing) tests, then escalates', async () => {
    const wt = makeWorktree();
    const { log, orch } = makeStack(wt); // gate 'true' — a test passes at once = weak
    const proposeTests = async (req: AgentRequest) => ({
      actions: [w(`t-${req.iteration}`, 'test/ai-generated/x.test.ts', 'weak')],
      note: 'expects failure',
    });
    const res = await orch.runTask(
      ctx('T-red-weak', wt),
      scriptedAgent([{ actions: [], claim: 'GREEN' }]),
      { proposeTests, maxWeakTestRetries: 1 },
    );
    expect(res.finalState).toBe('ESCALATED');
    expect(res.escalation?.reason).toBe('weak_tests_exhausted');
    expect(log.eventsFor('T-red-weak').filter((e) => e.type === 'WEAK_TEST_REJECTED')).toHaveLength(2);
  });

  it('proceeds to implementation once a test fails as expected (RED)', async () => {
    const wt = makeWorktree();
    const impl = join(wt, 'src', 'impl.txt');
    const { log, orch } = makeStack(wt, {}, ['test', '-f', impl]); // fails until impl.txt exists
    const proposeTests = async () => ({
      actions: [w('t1', 'test/ai-generated/x.test.ts', 'red test')],
      note: 'implementation missing',
    });
    const agent = scriptedAgent([{ actions: [w('i1', 'src/impl.txt', 'done')], claim: 'GREEN' }]);
    const res = await orch.runTask(ctx('T-red-ok', wt), agent, { proposeTests });
    expect(log.eventsFor('T-red-ok').some((e) => e.type === 'TEST_RED_CONFIRMED')).toBe(true);
    expect(res.finalState).toBe('REVIEWING');
  });
});

describe('§9.2 rule 3 REFACTOR', () => {
  it('reverts a refactor that regresses the full suite', async () => {
    const wt = makeWorktree();
    const impl = join(wt, 'src', 'impl.txt');
    const { log, orch } = makeStack(wt, {}, ['grep', '-q', 'GOOD', 'src/impl.txt']);
    const agent = scriptedAgent([{ actions: [w('i1', 'src/impl.txt', 'GOOD')], claim: 'GREEN' }]);
    const proposeRefactor = async () => ({ actions: [w('r1', 'src/impl.txt', 'BAD')] });
    const res = await orch.runTask(ctx('T-ref', wt), agent, { proposeRefactor });
    expect(log.eventsFor('T-ref').some((e) => e.type === 'REFACTOR_REVERTED')).toBe(true);
    expect(readFileSync(impl, 'utf8')).toBe('GOOD'); // reverted to the green content
    expect(res.finalState).toBe('REVIEWING');
  });

  it('keeps a refactor that preserves green', async () => {
    const wt = makeWorktree();
    const impl = join(wt, 'src', 'impl.txt');
    const { log, orch } = makeStack(wt, {}, ['grep', '-q', 'GOOD', 'src/impl.txt']);
    const agent = scriptedAgent([{ actions: [w('i1', 'src/impl.txt', 'GOOD one')], claim: 'GREEN' }]);
    const proposeRefactor = async () => ({ actions: [w('r1', 'src/impl.txt', 'GOOD two')] });
    const res = await orch.runTask(ctx('T-ref2', wt), agent, { proposeRefactor });
    expect(log.eventsFor('T-ref2').some((e) => e.type === 'REFACTOR_APPLIED')).toBe(true);
    expect(readFileSync(impl, 'utf8')).toBe('GOOD two'); // refactor kept
    expect(res.finalState).toBe('REVIEWING');
  });

  it('refuses a refactor path that escapes the worktree (snapshot + revert)', async () => {
    const wt = makeWorktree();
    const outsideName = `gapfix-escape-${Date.now()}.txt`;
    const outside = join(wt, '..', outsideName);
    writeFileSync(outside, 'SAFE');
    const { log, orch } = makeStack(wt, {}, ['grep', '-q', 'GOOD', 'src/impl.txt']);
    const agent = scriptedAgent([{ actions: [w('i1', 'src/impl.txt', 'GOOD')], claim: 'GREEN' }]);
    // refactor regresses the suite AND tries to reach outside the worktree
    const proposeRefactor = async () => ({ actions: [w('r-esc', `../${outsideName}`, 'HACKED'), w('r1', 'src/impl.txt', 'BAD')] });
    const res = await orch.runTask(ctx('T-esc-path', wt), agent, { proposeRefactor });
    expect(readFileSync(outside, 'utf8')).toBe('SAFE'); // never read/written outside the worktree
    expect(existsSync(join(wt, '..', outsideName))).toBe(true);
    const types = log.eventsFor('T-esc-path').map((e) => e.type);
    expect(types).toContain('PATH_REJECTED');
    expect(types).toContain('REFACTOR_REVERTED');
    expect(readFileSync(join(wt, 'src', 'impl.txt'), 'utf8')).toBe('GOOD'); // in-worktree revert still works
    expect(res.finalState).toBe('REVIEWING');
  });
});

describe('§9.3 hypothesis-driven repair', () => {
  it('confirms a hypothesis, repairs, and threads the patch plan into the next proposal', async () => {
    const wt = makeWorktree();
    const { log, orch } = makeStack(wt, {}, ['test', '-f', 'src/fixed.txt']); // fails until fixed.txt exists
    const seen: (string | undefined)[] = [];
    let call = 0;
    const agent: AgentPort = {
      async propose(req) {
        seen.push(req.repairPlan);
        call++;
        return call === 1
          ? { actions: [w('i1', 'src/other.txt')], claim: 'GREEN' }  // does not fix
          : { actions: [w('i2', 'src/fixed.txt')], claim: 'GREEN' }; // applies the fix
      },
    };
    const proposeHypotheses = async () => ([
      {
        statement: 'fixed.txt is missing',
        probes: [{ cmd: 'true', args: [], expectExitCode: 0 }],
        ifConfirmed: { patchPlan: 'create src/fixed.txt', estimatedBlastRadius: '1 file' },
      },
    ]);
    const res = await orch.runTask(ctx('T-rep', wt), agent, { proposeHypotheses });
    expect(log.eventsFor('T-rep').some((e) => e.type === 'HYPOTHESIS_CONFIRMED')).toBe(true);
    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toBe('create src/fixed.txt');
    expect(res.finalState).toBe('REVIEWING');
  });

  it('escalates with a decidable package when every hypothesis is refuted', async () => {
    const wt = makeWorktree();
    const { log, orch } = makeStack(wt, {}, ['false']);
    const agent = scriptedAgent([{ actions: [w('a1', 'src/a.txt')], claim: 'GREEN' }]);
    const proposeHypotheses = async () => ([
      {
        statement: 'bad guess',
        probes: [{ cmd: 'false', args: [], expectExitCode: 0 }],
        ifConfirmed: { patchPlan: 'x', estimatedBlastRadius: 'y' },
      },
    ]);
    const res = await orch.runTask(ctx('T-rep-esc', wt), agent, { proposeHypotheses });
    expect(res.finalState).toBe('ESCALATED');
    expect(res.escalation?.reason).toBe('hypotheses_exhausted');
    expect(res.escalation?.refutedHypotheses).toContain('bad guess');
    expect(log.eventsFor('T-rep-esc').some((e) => e.type === 'HYPOTHESIS_REFUTED')).toBe(true);
  });
});

describe('§10.3 decidable escalation package', () => {
  it('ends with a question and priced/risked options, never a raw log dump', async () => {
    const wt = makeWorktree();
    const { orch } = makeStack(wt, {}, ['false']);
    const budget: Budget = { maxIterations: 2, maxCostUnits: 1000, maxWallclockMs: 60_000 };
    const agent = scriptedAgent([{ actions: [w('a1', 'src/a.txt')], claim: 'GREEN' }]);
    const res = await orch.runTask(ctx('T-esc', wt, { budget }), agent);
    const pkg = res.escalation!;
    expect(pkg).toBeDefined();
    expect(pkg.question.endsWith('?')).toBe(true);
    expect(pkg.options.length).toBeGreaterThan(0);
    for (const o of pkg.options) {
      expect(o.label.length).toBeGreaterThan(0);
      expect(o.expectedCost.length).toBeGreaterThan(0);
      expect(o.risk.length).toBeGreaterThan(0);
    }
    expect(Object.keys(pkg)).not.toContain('events'); // no raw event array
  });

  it('registers in the EscalationStore when provided and can be resolved', async () => {
    const wt = makeWorktree();
    const { log, orch } = makeStack(wt, {}, ['false']);
    const escalations = new EscalationStore(log);
    const budget: Budget = { maxIterations: 1, maxCostUnits: 1000, maxWallclockMs: 60_000 };
    const agent = scriptedAgent([{ actions: [w('a1', 'src/a.txt')], claim: 'GREEN' }]);
    await orch.runTask(ctx('T-esc2', wt, { budget }), agent, { escalations });
    const pending = escalations.listPending();
    expect(pending).toHaveLength(1);
    const resolved = escalations.resolve(pending[0]!.id, 0);
    expect(resolved?.status).toBe('resolved');
    expect(resolved?.chosenOptionIndex).toBe(0);
    const types = log.eventsFor('T-esc2').map((e) => e.type);
    expect(types).toContain('ESCALATION_PACKAGE');
    expect(types).toContain('ESCALATION_RAISED');
    expect(types).toContain('ESCALATION_RESOLVED');
  });
});

describe('§11.2 planning gate', () => {
  it('blocks and does not run when the task graph fails traceability', async () => {
    const wt = makeWorktree();
    const { log, orch } = makeStack(wt);
    let proposed = false;
    const agent: AgentPort = { async propose() { proposed = true; return { actions: [] }; } };
    const taskGraph = {
      goal: { acceptanceCriteria: [{ id: 'AC-1' }] },
      tasks: [{ taskId: 'T-orphan', mapsToAc: [], estimatedDiffBytes: 10 }], // orphan + AC-1 uncovered
    };
    const res = await orch.runTask(ctx('T-plan', wt), agent, { taskGraph });
    expect(res.planningBlocked?.ok).toBe(false);
    expect(proposed).toBe(false);
    expect(log.eventsFor('T-plan').some((e) => e.type === 'PLANNING_GATE_BLOCKED')).toBe(true);
  });

  it('runs when the task graph passes the gate', async () => {
    const wt = makeWorktree();
    const { orch } = makeStack(wt);
    const taskGraph = {
      goal: { acceptanceCriteria: [{ id: 'AC-1' }] },
      tasks: [{ taskId: 'T-plan2', mapsToAc: ['AC-1'], estimatedDiffBytes: 10 }],
    };
    const res = await orch.runTask(
      ctx('T-plan2', wt),
      scriptedAgent([{ actions: [w('a1', 'src/a.txt')], claim: 'GREEN' }]),
      { taskGraph },
    );
    expect(res.finalState).toBe('REVIEWING');
  });
});

describe('§9.4 context governance', () => {
  it('rejects a proposal that references a path outside its context, then accepts a clean one', async () => {
    const wt = makeWorktree();
    writeFileSync(join(wt, 'src', 'seed.ts'), 'export const x = 1;\n');
    const bundle = buildContext({ worktree: wt, seeds: ['src/seed.ts'], docs: [] });
    const { log, orch } = makeStack(wt); // gate 'true'
    let call = 0;
    const agent: AgentPort = {
      async propose() {
        call++;
        return call === 1
          ? { actions: [w('a1', 'src/seed.ts', 'import "lib/unrequested.ts";')], claim: 'GREEN' } // unrequested ref
          : { actions: [w('a2', 'src/seed.ts', 'export const x = 2;')], claim: 'GREEN' };
      },
    };
    const res = await orch.runTask(ctx('T-ctx', wt), agent, { contextBundle: bundle });
    const rej = log.eventsFor('T-ctx').find((e) => e.type === 'CONTEXT_REFERENCE_REJECTED');
    expect(rej?.payload.violations).toContain('lib/unrequested.ts');
    expect(res.finalState).toBe('REVIEWING'); // clean re-proposal succeeded
    expect(readFileSync(join(wt, 'src', 'seed.ts'), 'utf8')).toBe('export const x = 2;'); // rejected write not applied
  });

  it('counts a READ_FILE outside the manifest as a miss and emits run context metrics', async () => {
    const wt = makeWorktree();
    writeFileSync(join(wt, 'src', 'seed.ts'), 'export const x = 1;\n');
    writeFileSync(join(wt, 'src', 'extra.ts'), 'export const y = 2;\n');
    const bundle = buildContext({ worktree: wt, seeds: ['src/seed.ts'], docs: [] });
    const { log, orch } = makeStack(wt);
    let call = 0;
    const agent: AgentPort = {
      async propose() {
        call++;
        return call === 1
          ? { actions: [{ type: 'READ_FILE', actionId: 'r1', path: 'src/extra.ts' }] } // request more context (miss)
          : { actions: [w('a1', 'src/seed.ts', 'export const x = 3;')], claim: 'GREEN' };
      },
    };
    const res = await orch.runTask(ctx('T-miss', wt), agent, { contextBundle: bundle });
    const types = log.eventsFor('T-miss').map((e) => e.type);
    expect(types).toContain('CONTEXT_MISS');
    const metrics = log.eventsFor('T-miss').find((e) => e.type === 'RUN_CONTEXT_METRICS');
    expect(metrics?.payload.misses).toBeGreaterThanOrEqual(1);
    expect(typeof metrics?.payload.recall).toBe('number');
    expect(typeof metrics?.payload.waste).toBe('number');
    expect(res.finalState).toBe('REVIEWING');
  });
});
