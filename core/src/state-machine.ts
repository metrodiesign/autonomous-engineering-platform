// State machine (§6.3). Every transition is an event; AI can never set COMPLETED (INV-2).
import type { Principal, TaskState } from './types.js';
import type { EventLog } from './event-log.js';

export class StateMachine {
  constructor(_log: EventLog, _taskId: string, _initial?: TaskState) {
    throw new Error('NOT_IMPLEMENTED');
  }
  get state(): TaskState { throw new Error('NOT_IMPLEMENTED'); }
  transition(_to: TaskState, _principal: Principal, _evidence?: Record<string, unknown>): void {
    throw new Error('NOT_IMPLEMENTED');
  }
}
