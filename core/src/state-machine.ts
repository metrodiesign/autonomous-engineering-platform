// State machine (§6.3). Every transition is an event; AI can never set COMPLETED (INV-2).
import type { Principal, TaskState } from './types.js';
import type { EventLog } from './event-log.js';

const TRANSITIONS: Record<TaskState, TaskState[]> = {
  PROPOSED: ['ANALYZING', 'CANCELLED'],
  ANALYZING: ['READY', 'BLOCKED', 'CANCELLED'],
  READY: ['IMPLEMENTING', 'CANCELLED'],
  IMPLEMENTING: ['VERIFYING', 'BLOCKED', 'ESCALATED', 'CANCELLED'],
  VERIFYING: ['FAILED', 'REVIEWING', 'ESCALATED'],
  FAILED: ['DIAGNOSING', 'ESCALATED'],
  DIAGNOSING: ['REPAIRING', 'ESCALATED'],
  REPAIRING: ['VERIFYING', 'ESCALATED'],
  REVIEWING: ['CHANGES_REQUESTED', 'APPROVED', 'ESCALATED'],
  CHANGES_REQUESTED: ['REPAIRING'],
  APPROVED: ['MERGE_QUEUED'],
  MERGE_QUEUED: ['AUDITED', 'ROLLED_BACK'],
  AUDITED: ['COMPLETED', 'ROLLED_BACK'],
  COMPLETED: [],
  BLOCKED: ['READY', 'ESCALATED', 'CANCELLED'],
  ESCALATED: ['READY', 'CANCELLED'],
  CANCELLED: [],
  ROLLED_BACK: ['READY'],
  QUARANTINED: ['READY'],
  PAUSED: [], // handled via pausedFrom, not the static map
};

const ACTIVE: TaskState[] = [
  'PROPOSED', 'ANALYZING', 'READY', 'IMPLEMENTING', 'VERIFYING',
  'FAILED', 'DIAGNOSING', 'REPAIRING', 'REVIEWING', 'CHANGES_REQUESTED',
  'APPROVED', 'MERGE_QUEUED', 'AUDITED',
];

export class StateMachine {
  private current: TaskState;
  private pausedFrom: TaskState | null = null;

  constructor(
    private log: EventLog,
    private taskId: string,
    initial: TaskState = 'PROPOSED',
  ) {
    this.current = initial;
  }

  get state(): TaskState {
    return this.current;
  }

  transition(to: TaskState, principal: Principal, evidence: Record<string, unknown> = {}): void {
    // INV-2: only core may declare COMPLETED, and only from AUDITED with evidence
    if (to === 'COMPLETED' && principal !== 'core') {
      throw new Error(`INV-2: principal ${principal} cannot set COMPLETED — only core with reproducible evidence`);
    }
    if (to === 'PAUSED') {
      if (!ACTIVE.includes(this.current)) throw new Error(`cannot pause from ${this.current}`);
      this.pausedFrom = this.current;
    } else if (this.current === 'PAUSED') {
      if (to !== this.pausedFrom) throw new Error(`resume must return to ${this.pausedFrom}`);
      this.pausedFrom = null;
    } else if (!TRANSITIONS[this.current].includes(to)) {
      throw new Error(`illegal transition ${this.current} -> ${to}`);
    }
    const from = this.current;
    this.current = to;
    this.log.append({
      ts: Date.now(), taskId: this.taskId, type: 'STATE_TRANSITION', principal,
      payload: { from, to, ...evidence },
    });
  }
}
