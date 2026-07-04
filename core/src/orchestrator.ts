// Propose/dispose loop (§9, Phase 0 slice): agent proposes, core executes and measures.
// Never trusts agent claims (INV-1/INV-2); budget backstop always on (§6.6).
import type { ActionOutcome, AgentPort, TaskContext } from './types.js';
import type { EventLog } from './event-log.js';
import type { Executor } from './executor.js';
import { runGate, type GateConfig } from './gates.js';
import { StateMachine } from './state-machine.js';

export interface RunResult {
  finalState: string;
  iterations: number;
  flaky: boolean;
}

export class Orchestrator {
  constructor(
    private log: EventLog,
    private executor: Executor,
    private gates: GateConfig,
  ) {}

  async runTask(ctx: TaskContext, agent: AgentPort): Promise<RunResult> {
    const sm = new StateMachine(this.log, ctx.taskId, 'READY');
    sm.transition('IMPLEMENTING', 'core');
    const started = Date.now();
    let flaky = false;
    let feedback: ActionOutcome[] = [];
    let iteration = 0;

    while (true) {
      iteration++;
      if (iteration > ctx.budget.maxIterations || Date.now() - started > ctx.budget.maxWallclockMs) {
        this.log.append({
          ts: Date.now(), taskId: ctx.taskId, type: 'BUDGET_EXCEEDED', principal: 'core',
          payload: { iteration, elapsedMs: Date.now() - started, budget: { ...ctx.budget } },
        });
        sm.transition('ESCALATED', 'core'); // legal from IMPLEMENTING and REPAIRING
        return { finalState: sm.state, iterations: iteration - 1, flaky };
      }

      const proposal = await agent.propose({ taskId: ctx.taskId, role: ctx.role, iteration, feedback });
      feedback = proposal.actions.map((a) => this.executor.execute(ctx, a));

      // agent claim is recorded but NEVER trusted (INV-1) — core runs the gates itself
      if (proposal.claim) {
        this.log.append({
          ts: Date.now(), taskId: ctx.taskId, type: 'AGENT_CLAIM', principal: 'agent',
          payload: { claim: proposal.claim, iteration },
        });
      }
      if (proposal.claim !== 'GREEN' && proposal.claim !== 'READY_FOR_VERIFICATION') continue;

      sm.transition('VERIFYING', 'core');
      const t0 = runGate('T0', this.gates);
      const t1 = t0.status === 'pass' ? runGate('T1', this.gates) : t0;
      flaky = flaky || Boolean(t0.flaky) || Boolean(t1.flaky);
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
        sm.transition('REVIEWING', 'core', { gateConfigHash: t1.gateConfigHash });
        return { finalState: sm.state, iterations: iteration, flaky };
      }

      // repair loop (§6.3): next proposal is treated as the repair
      sm.transition('FAILED', 'core', { detail: t1.detail });
      sm.transition('DIAGNOSING', 'core');
      sm.transition('REPAIRING', 'core');
    }
  }
}
