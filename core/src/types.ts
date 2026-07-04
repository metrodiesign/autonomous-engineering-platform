// Ring 0 domain types (§6). Vendor-neutral (INV-7).

export type Role = 'planner' | 'test_designer' | 'implementer' | 'reviewer';

export type NetworkPolicy = 'none' | `allowlist:${string}`;

export type Action =
  | { type: 'WRITE_FILE'; actionId: string; path: string; content: string }
  | { type: 'APPLY_PATCH'; actionId: string; diff: string }
  | { type: 'RUN_COMMAND'; actionId: string; cmd: string; args: string[]; cwd?: string; network?: NetworkPolicy }
  | { type: 'READ_FILE'; actionId: string; path: string }
  | { type: 'REQUEST_TOOL'; actionId: string; name: string; args: Record<string, unknown> };

export type ActionOutcome =
  | { status: 'applied'; actionId: string; resultHash: string; stdout?: string; stderr?: string; exitCode?: number }
  | { status: 'skipped_duplicate'; actionId: string }
  | { status: 'rejected'; actionId: string; reason: string; policy: string };

export interface Proposal {
  actions: Action[];
  /** agent's own claim about the work; NEVER trusted by core (INV-1/INV-2) */
  claim?: 'GREEN' | 'READY_FOR_VERIFICATION' | 'BLOCKED';
  note?: string;
}

export interface AgentRequest {
  taskId: string;
  role: Role;
  iteration: number;
  feedback: ActionOutcome[];
}

/** The only surface core uses to talk to a model (Ring 1 implements this). */
export interface AgentPort {
  propose(req: AgentRequest): Promise<Proposal>;
}

export type TaskState =
  | 'PROPOSED' | 'ANALYZING' | 'READY' | 'IMPLEMENTING' | 'VERIFYING'
  | 'FAILED' | 'DIAGNOSING' | 'REPAIRING' | 'REVIEWING' | 'CHANGES_REQUESTED'
  | 'APPROVED' | 'MERGE_QUEUED' | 'AUDITED' | 'COMPLETED'
  | 'BLOCKED' | 'ESCALATED' | 'CANCELLED' | 'ROLLED_BACK' | 'QUARANTINED' | 'PAUSED';

export type Principal = 'core' | 'agent' | 'human';

export interface PlatformEvent {
  seq?: number;
  ts: number;
  taskId: string;
  type: string;
  principal: Principal;
  payload: Record<string, unknown>;
}

export interface Budget {
  maxIterations: number;
  maxCostUnits: number;
  maxWallclockMs: number;
}

export interface GateResult {
  tier: 'T0' | 'T1' | 'T2' | 'T3';
  status: 'pass' | 'fail' | 'not_enabled';
  gateConfigHash: string;
  detail: string;
  flaky?: boolean;
}

export interface TaskContext {
  taskId: string;
  role: Role;
  worktree: string;
  budget: Budget;
}
