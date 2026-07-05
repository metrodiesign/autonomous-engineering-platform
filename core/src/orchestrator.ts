// Propose/dispose loop (§6, §9): agent proposes, core executes and measures.
// Never trusts agent claims (INV-1/INV-2); budget backstop always on (§6.6).
// Optional stages (planning gate §11.2, RED-first §9.2.1, hypothesis repair §9.3,
// REFACTOR §9.2.3, decidable escalation §10.3) activate only when the matching dep is
// supplied — callers that pass none keep the Phase 0 behavior unchanged.
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { resolve, sep } from 'node:path';
import type { Action, ActionOutcome, AgentPort, AgentRequest, Proposal, TaskContext } from './types.js';
import type { EventLog } from './event-log.js';
import type { Executor } from './executor.js';
import { runGate, type GateConfig } from './gates.js';
import { commitHash, envHash, type EvidenceBinding } from './evidence.js';
import { buildContextManifest, contextMetrics, evaluateProposalReferences, type BuiltContext } from './context-builder.js';
import { StateMachine } from './state-machine.js';
import { checkPlanningGate, type GoalContractLite, type PlannedTask, type PlanningGateResult } from './planning-gate.js';
import { runHypothesisProbes, type Hypothesis } from './repair.js';
import {
  buildEscalationPackage,
  type EscalationPackage,
  type EscalationReason,
  type EscalationStore,
} from './escalation.js';

export interface RunResult {
  finalState: string;
  iterations: number;
  flaky: boolean;
  leaseRefused?: boolean;
  planningBlocked?: PlanningGateResult;
  escalation?: EscalationPackage;
  aborted?: boolean;
}

export interface RunDeps {
  /** single-writer lease owner id (§6.2); defaults to a per-run random id */
  ownerId?: string;
  leaseTtlMs?: number;
  /** §11.2 planning gate: refuse to run a graph that fails traceability / budget */
  taskGraph?: { goal: GoalContractLite; tasks: PlannedTask[] };
  /** §9.2 rule 1 RED-first: require a failing test before implementation begins */
  proposeTests?: (req: AgentRequest) => Promise<Proposal>;
  /** §9.2 rule 3 REFACTOR: refactor after first GREEN, revert on regression */
  proposeRefactor?: (req: AgentRequest) => Promise<Proposal>;
  /** §9.3 hypothesis-driven repair on FAILED */
  proposeHypotheses?: (req: AgentRequest) => Promise<Hypothesis[]>;
  /** §10.3 decidable escalation store (Human Plane surface) */
  escalations?: EscalationStore;
  /** §10.2 kill switch — human abort flag, polled at the top of every iteration */
  shouldAbort?: () => boolean;
  /** §10.3 steering — when paused, the loop holds at the iteration boundary until resumed */
  steering?: { isPaused: (taskId: string) => boolean };
  /** §10.3 pause hold poll interval in ms (default 200) */
  pausePollMs?: number;
  /** §9.4 context bundle: enables reject-unrequested + context miss/recall/waste metrics */
  contextBundle?: BuiltContext;
  maxHypotheses?: number;
  maxWeakTestRetries?: number;
}

/** sha256 of the normalized failing detail, first 16 hex — advisory strategy-switch signal (§6.6). */
function failureFingerprint(detail: string): string {
  const normalized = detail.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

const sleep = (ms: number) => new Promise<void>((resolveP) => setTimeout(resolveP, ms));

export class Orchestrator {
  constructor(
    private log: EventLog,
    private executor: Executor,
    private gates: GateConfig,
  ) {}

  async runTask(ctx: TaskContext, agent: AgentPort, deps: RunDeps = {}): Promise<RunResult> {
    // §11.2 planning gate — refuse before touching the lease or the loop
    if (deps.taskGraph) {
      const gate = checkPlanningGate(deps.taskGraph.goal, deps.taskGraph.tasks);
      if (!gate.ok) {
        this.log.append({
          ts: Date.now(), taskId: ctx.taskId, type: 'PLANNING_GATE_BLOCKED', principal: 'core',
          payload: { uncoveredAcs: gate.uncoveredAcs, orphanTasks: gate.orphanTasks, overBudgetTasks: gate.overBudgetTasks },
        });
        return { finalState: 'BLOCKED', iterations: 0, flaky: false, planningBlocked: gate };
      }
    }

    // §6.2 single-writer lease — refuse to run when another owner already holds it
    const ownerId = deps.ownerId ?? `orch-${randomBytes(6).toString('hex')}`;
    const ttlMs = deps.leaseTtlMs ?? 30_000;
    if (!this.log.claimLease(ctx.taskId, ownerId, ttlMs)) {
      this.log.append({
        ts: Date.now(), taskId: ctx.taskId, type: 'LEASE_REFUSED', principal: 'core', payload: { ownerId },
      });
      return { finalState: 'BLOCKED', iterations: 0, flaky: false, leaseRefused: true };
    }

    try {
      return await this.runLoop(ctx, agent, deps, ownerId, ttlMs);
    } finally {
      this.log.releaseLease(ctx.taskId, ownerId);
    }
  }

  private async runLoop(
    ctx: TaskContext,
    agent: AgentPort,
    deps: RunDeps,
    ownerId: string,
    ttlMs: number,
  ): Promise<RunResult> {
    const sm = new StateMachine(this.log, ctx.taskId, 'READY');
    const started = Date.now();
    let flaky = false;
    let feedback: ActionOutcome[] = [];
    let iteration = 0;
    let costUnits = 0;
    let lastFingerprint: string | null = null;
    const refutedHypotheses: string[] = [];
    let repairPlan: string | undefined;

    // §6.4 optimization: bind evidence once per run (commit + env), reused by every gate call
    const gateCwd = this.gates.t0[0]?.cwd ?? this.gates.t1[0]?.cwd ?? ctx.worktree;
    const evidenceBinding: EvidenceBinding = { commitHash: commitHash(gateCwd), envHash: envHash(gateCwd) };
    // §9.4 context governance state (active only when a context bundle is supplied)
    const contextManifest = deps.contextBundle ? buildContextManifest(deps.contextBundle) : null;
    const requestedPaths: string[] = [];
    let contextProposalText = '';

    try {
    // §9.2 rule 1: RED-first stage (optional) — a failing test must exist before GREEN work
    if (deps.proposeTests) {
      if (!(await this.runRedStage(sm, ctx, deps, evidenceBinding))) {
        return this.raiseEscalation(sm, ctx, deps, 'weak_tests_exhausted', lastFingerprint, refutedHypotheses, 0, flaky);
      }
      sm.transition('IMPLEMENTING', 'core'); // WRITING_TESTS -> IMPLEMENTING
    } else {
      sm.transition('IMPLEMENTING', 'core'); // READY -> IMPLEMENTING
    }

    while (true) {
      // §10.2 kill switch — human abort flag stops the loop at the next iteration boundary
      // (current atomic action already finished). Records RUN_ABORTED; no SM edge is forced
      // because a kill can land mid-REPAIRING where CANCELLED is not a legal transition.
      if (deps.shouldAbort?.()) {
        this.log.append({
          ts: Date.now(), taskId: ctx.taskId, type: 'RUN_ABORTED', principal: 'core',
          payload: { reason: 'kill_switch', iteration },
        });
        return { finalState: 'CANCELLED', iterations: iteration, flaky, aborted: true };
      }

      // §10.3 PAUSE — finish the current atomic action then hold at the iteration boundary,
      // resumable via steering.resume(). A kill (shouldAbort) always wins over a pause.
      if (deps.steering?.isPaused(ctx.taskId)) {
        this.log.append({ ts: Date.now(), taskId: ctx.taskId, type: 'PAUSED_HOLD', principal: 'core', payload: { iteration } });
        while (deps.steering.isPaused(ctx.taskId) && !deps.shouldAbort?.()) {
          await sleep(deps.pausePollMs ?? 200);
        }
        if (deps.shouldAbort?.()) {
          this.log.append({
            ts: Date.now(), taskId: ctx.taskId, type: 'RUN_ABORTED', principal: 'core',
            payload: { reason: 'kill_switch', iteration },
          });
          return { finalState: 'CANCELLED', iterations: iteration, flaky, aborted: true };
        }
        this.log.append({ ts: Date.now(), taskId: ctx.taskId, type: 'RESUMED_CONTINUE', principal: 'core', payload: { iteration } });
      }
      iteration++;
      // budget backstop — iterations / wallclock always enforced (§6.6)
      if (iteration > ctx.budget.maxIterations || Date.now() - started > ctx.budget.maxWallclockMs) {
        this.log.append({
          ts: Date.now(), taskId: ctx.taskId, type: 'BUDGET_EXCEEDED', principal: 'core',
          payload: { iteration, elapsedMs: Date.now() - started, budget: { ...ctx.budget }, cause: 'iterations_or_wallclock' },
        });
        return this.raiseEscalation(sm, ctx, deps, 'budget_exceeded', lastFingerprint, refutedHypotheses, iteration - 1, flaky);
      }

      // §6.2 heartbeat — refresh the lease each iteration; stop cleanly if another owner took it
      if (!this.log.claimLease(ctx.taskId, ownerId, ttlMs)) {
        this.log.append({ ts: Date.now(), taskId: ctx.taskId, type: 'LEASE_LOST', principal: 'core', payload: { ownerId, iteration } });
        return { finalState: 'BLOCKED', iterations: iteration - 1, flaky, leaseRefused: true };
      }

      const proposal = await agent.propose({
        taskId: ctx.taskId, role: ctx.role, iteration, feedback, ...(repairPlan ? { repairPlan } : {}),
      });
      repairPlan = undefined; // consumed by this proposal
      costUnits += proposal.costUnits ?? 1;

      // §6.6 cost-unit budget backstop (before executing this proposal)
      if (costUnits > ctx.budget.maxCostUnits) {
        this.log.append({
          ts: Date.now(), taskId: ctx.taskId, type: 'BUDGET_EXCEEDED', principal: 'core',
          payload: { iteration, costUnits, budget: { ...ctx.budget }, cause: 'cost_units' },
        });
        return this.raiseEscalation(sm, ctx, deps, 'budget_exceeded', lastFingerprint, refutedHypotheses, iteration, flaky);
      }

      // §9.4 context governance: count READ_FILE misses, then reject unrequested path references
      if (contextManifest) {
        for (const a of proposal.actions) {
          if (a.type === 'READ_FILE' && !contextManifest.includes(a.path)) {
            if (!requestedPaths.includes(a.path)) requestedPaths.push(a.path);
            this.log.append({
              ts: Date.now(), taskId: ctx.taskId, type: 'CONTEXT_MISS', principal: 'core',
              payload: { path: a.path, iteration },
            });
          }
        }
        const proposalText = JSON.stringify(proposal);
        const refs = evaluateProposalReferences(proposalText, contextManifest, requestedPaths);
        if (!refs.ok) {
          this.log.append({
            ts: Date.now(), taskId: ctx.taskId, type: 'CONTEXT_REFERENCE_REJECTED', principal: 'core',
            payload: { violations: refs.violations, iteration },
          });
          feedback = []; // bounce — do not execute; re-propose next iteration (budget advances)
          continue;
        }
        contextProposalText += proposalText;
      }

      feedback = proposal.actions.map((a) => this.executor.execute(ctx, a));

      // agent claim is recorded but NEVER trusted (INV-1) — core runs the gates itself
      if (proposal.claim) {
        this.log.append({
          ts: Date.now(), taskId: ctx.taskId, type: 'AGENT_CLAIM', principal: 'agent',
          payload: { claim: proposal.claim, iteration },
        });
      }

      // §6.4: T0 (cheap tier) runs every iteration, not only when GREEN is claimed
      const t0 = runGate('T0', this.gates, evidenceBinding);
      flaky = flaky || Boolean(t0.flaky);
      this.log.append({
        ts: Date.now(), taskId: ctx.taskId, type: 'T0_GATE', principal: 'core',
        payload: { t0: { ...t0 }, iteration },
      });

      if (proposal.claim !== 'GREEN' && proposal.claim !== 'READY_FOR_VERIFICATION') continue;

      sm.transition('VERIFYING', 'core');
      const t1 = t0.status === 'pass' ? runGate('T1', this.gates, evidenceBinding) : t0; // reuse this iteration's T0
      flaky = flaky || Boolean(t1.flaky);
      if (flaky) {
        this.log.append({
          ts: Date.now(), taskId: ctx.taskId, type: 'FLAKY_DETECTED', principal: 'core',
          payload: { iteration, note: 'failed-then-passed on retry; quarantine requires governance (INV-16)' },
        });
      }
      this.log.append({
        ts: Date.now(), taskId: ctx.taskId, type: 'GATES_RUN', principal: 'core',
        payload: { t0: { ...t0 }, t1: { ...t1 }, iteration },
      });

      if (t1.status === 'pass') {
        // §9.2 rule 3: optional REFACTOR after first GREEN; regression reverts to the green state
        if (deps.proposeRefactor) await this.runRefactorStage(ctx, deps, iteration, evidenceBinding);
        sm.transition('REVIEWING', 'core', { gateConfigHash: t1.gateConfigHash });
        return { finalState: sm.state, iterations: iteration, flaky };
      }

      // FAILED — advisory failure fingerprint (§6.6) then repair (§9.3)
      sm.transition('FAILED', 'core', { detail: t1.detail });
      const fp = failureFingerprint(t1.detail);
      if (fp === lastFingerprint) {
        this.log.append({
          ts: Date.now(), taskId: ctx.taskId, type: 'FINGERPRINT_REPEAT', principal: 'core',
          payload: { fingerprint: fp, iteration, advice: 'switch strategy or model' },
        });
      }
      lastFingerprint = fp;

      sm.transition('DIAGNOSING', 'core');
      if (deps.proposeHypotheses) {
        const hyps = await deps.proposeHypotheses({ taskId: ctx.taskId, role: ctx.role, iteration, feedback });
        const outcome = runHypothesisProbes(this.log, ctx.taskId, ctx.worktree, hyps, deps.maxHypotheses ?? 3);
        refutedHypotheses.push(...outcome.refuted);
        if (outcome.confirmed) {
          repairPlan = outcome.confirmed.ifConfirmed.patchPlan; // small patch plan into the next proposal
          sm.transition('REPAIRING', 'core', { patchPlan: repairPlan });
        } else {
          return this.raiseEscalation(sm, ctx, deps, 'hypotheses_exhausted', lastFingerprint, refutedHypotheses, iteration, flaky);
        }
      } else {
        sm.transition('REPAIRING', 'core'); // Phase 0 blind repair path (next proposal is the repair)
      }
    }
    } finally {
      // §9.4 run-level context metrics (misses / recall / waste) — only when a bundle was supplied
      if (deps.contextBundle) {
        const m = contextMetrics(deps.contextBundle, requestedPaths, contextProposalText);
        this.log.append({
          ts: Date.now(), taskId: ctx.taskId, type: 'RUN_CONTEXT_METRICS', principal: 'core',
          payload: { misses: m.misses, recall: m.recall, waste: m.waste, requested: requestedPaths.length },
        });
      }
    }
  }

  /** §9.2 rule 1: apply proposed tests, require a RED failure; weak (passing) tests bounce back. */
  private async runRedStage(sm: StateMachine, ctx: TaskContext, deps: RunDeps, binding: EvidenceBinding): Promise<boolean> {
    sm.transition('WRITING_TESTS', 'core');
    const testCtx: TaskContext = { ...ctx, role: 'test_designer' }; // least privilege: test/ai-generated only
    const maxRetries = deps.maxWeakTestRetries ?? 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const proposal = await deps.proposeTests!({ taskId: ctx.taskId, role: 'test_designer', iteration: attempt, feedback: [] });
      for (const a of proposal.actions) this.executor.execute(testCtx, a);
      const t0 = runGate('T0', this.gates, binding);
      const suite = t0.status === 'pass' ? runGate('T1', this.gates, binding) : t0;
      if (suite.status === 'fail') {
        this.log.append({
          ts: Date.now(), taskId: ctx.taskId, type: 'TEST_RED_CONFIRMED', principal: 'core',
          payload: { attempt, expectedReason: proposal.note ?? null, detail: suite.detail },
        });
        return true;
      }
      // passing immediately = weak test (§9.2 rule 1) — reject and ask for a real one
      this.log.append({
        ts: Date.now(), taskId: ctx.taskId, type: 'WEAK_TEST_REJECTED', principal: 'core',
        payload: { attempt, note: proposal.note ?? null },
      });
    }
    return false;
  }

  /** §9.2 rule 3: apply refactor, re-run the FULL suite; on regression revert the touched files. */
  private async runRefactorStage(ctx: TaskContext, deps: RunDeps, iteration: number, binding: EvidenceBinding): Promise<void> {
    const proposal = await deps.proposeRefactor!({ taskId: ctx.taskId, role: ctx.role, iteration, feedback: [] });
    const writePaths = proposal.actions
      .filter((a): a is Extract<Action, { type: 'WRITE_FILE' }> => a.type === 'WRITE_FILE')
      .map((a) => a.path);
    const snapshot = this.snapshotPaths(ctx.worktree, ctx.taskId, writePaths); // revert is best-effort at file level
    for (const a of proposal.actions) this.executor.execute(ctx, a);
    const t0 = runGate('T0', this.gates, binding);
    const t1 = t0.status === 'pass' ? runGate('T1', this.gates, binding) : t0;
    if (t1.status !== 'pass') {
      const reverted = this.restorePaths(ctx.worktree, ctx.taskId, snapshot);
      this.log.append({
        ts: Date.now(), taskId: ctx.taskId, type: 'REFACTOR_REVERTED', principal: 'core',
        payload: { iteration, reverted, detail: t1.detail },
      });
    } else {
      this.log.append({
        ts: Date.now(), taskId: ctx.taskId, type: 'REFACTOR_APPLIED', principal: 'core',
        payload: { iteration },
      });
    }
  }

  /** Confine a proposal-supplied path to the worktree (symlink-resolved root). A path that
   *  escapes is logged PATH_REJECTED and refused — never read or written (prevents refactor
   *  snapshot/revert path traversal, INV-14). */
  private confinePath(worktree: string, taskId: string, p: string): string | null {
    const root = realpathSync(worktree);
    const abs = resolve(root, p);
    if (abs === root || abs.startsWith(root + sep)) return abs;
    this.log.append({
      ts: Date.now(), taskId, type: 'PATH_REJECTED', principal: 'core',
      payload: { path: p, reason: 'path escapes worktree — refused for refactor snapshot/revert (INV-14)' },
    });
    return null;
  }

  private snapshotPaths(worktree: string, taskId: string, paths: string[]): Map<string, string | null> {
    const snap = new Map<string, string | null>();
    for (const p of paths) {
      const abs = this.confinePath(worktree, taskId, p);
      if (abs === null) continue; // escapes worktree — do not read
      snap.set(p, existsSync(abs) ? readFileSync(abs, 'utf8') : null);
    }
    return snap;
  }

  private restorePaths(worktree: string, taskId: string, snap: Map<string, string | null>): string[] {
    const reverted: string[] = [];
    for (const [p, content] of snap) {
      const abs = this.confinePath(worktree, taskId, p);
      if (abs === null) continue; // escapes worktree — do not write
      if (content === null) {
        if (existsSync(abs)) rmSync(abs);
      } else {
        writeFileSync(abs, content);
      }
      reverted.push(p);
    }
    return reverted;
  }

  /** §10.3: transition to ESCALATED with a decidable package (question + priced options). */
  private raiseEscalation(
    sm: StateMachine,
    ctx: TaskContext,
    deps: RunDeps,
    reason: EscalationReason,
    fingerprint: string | null,
    refutedHypotheses: string[],
    iterations: number,
    flaky: boolean,
  ): RunResult {
    sm.transition('ESCALATED', 'core', { reason });
    const pkg = buildEscalationPackage({ taskId: ctx.taskId, reason, fingerprint, refutedHypotheses, budget: ctx.budget });
    this.log.append({
      ts: Date.now(), taskId: ctx.taskId, type: 'ESCALATION_PACKAGE', principal: 'core',
      payload: { escalation: pkg },
    });
    deps.escalations?.create(pkg);
    return { finalState: sm.state, iterations, flaky, escalation: pkg };
  }
}
