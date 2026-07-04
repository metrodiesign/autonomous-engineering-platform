// Deterministic executor (§6.1): policy enforcement, egress default-deny (INV-14),
// idempotency via ACTION_INTENT/ACTION_APPLIED, rejection as structured feedback.
import type { Action, ActionOutcome, TaskContext } from './types.js';
import type { EventLog } from './event-log.js';

export interface ExecutorHooks {
  /** test-only fault injection: crash after INTENT, before APPLIED */
  crashAfterIntent?: (action: Action) => boolean;
}

export class Executor {
  constructor(_log: EventLog, _hooks: ExecutorHooks = {}) {
    throw new Error('NOT_IMPLEMENTED');
  }
  execute(_ctx: TaskContext, _action: Action): ActionOutcome { throw new Error('NOT_IMPLEMENTED'); }
  /** crash recovery (§6.2): resolve dangling INTENT without double-apply */
  recover(_ctx: TaskContext): { resolved: number; applied: number; skipped: number } { throw new Error('NOT_IMPLEMENTED'); }
}
