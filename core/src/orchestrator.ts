// Propose/dispose loop (§9, Phase 0 slice): agent proposes, core executes and measures.
// Never trusts agent claims (INV-1/INV-2); budget backstop always on (§6.6).
import type { AgentPort, TaskContext } from './types.js';
import type { EventLog } from './event-log.js';
import type { Executor } from './executor.js';
import type { GateConfig } from './gates.js';

export interface RunResult {
  finalState: string;
  iterations: number;
  flaky: boolean;
}

export class Orchestrator {
  constructor(_log: EventLog, _executor: Executor, _gates: GateConfig) {
    throw new Error('NOT_IMPLEMENTED');
  }
  runTask(_ctx: TaskContext, _agent: AgentPort): Promise<RunResult> { throw new Error('NOT_IMPLEMENTED'); }
}
