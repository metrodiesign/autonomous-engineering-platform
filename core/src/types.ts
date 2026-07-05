// Ring 0 domain types (§6). Vendor-neutral (INV-7).

export type Role = 'planner' | 'test_designer' | 'implementer' | 'reviewer';

export type NetworkPolicy = 'none' | `allowlist:${string}` | 'package_install';

export type Action =
  | { type: 'WRITE_FILE'; actionId: string; path: string; content: string }
  | { type: 'APPLY_PATCH'; actionId: string; diff: string }
  | { type: 'RUN_COMMAND'; actionId: string; cmd: string; args: string[]; cwd?: string; network?: NetworkPolicy }
  | { type: 'READ_FILE'; actionId: string; path: string }
  | { type: 'REQUEST_TOOL'; actionId: string; name: string; args: Record<string, unknown> };

export type ActionOutcome =
  | { status: 'applied'; actionId: string; resultHash: string; stdout?: string; stderr?: string; exitCode?: number; resultSig?: string }
  | { status: 'skipped_duplicate'; actionId: string }
  | { status: 'rejected'; actionId: string; reason: string; policy: string };

export interface Proposal {
  actions: Action[];
  /** agent's own claim about the work; NEVER trusted by core (INV-1/INV-2) */
  claim?: 'GREEN' | 'READY_FOR_VERIFICATION' | 'BLOCKED';
  note?: string;
  /** normalized cost of producing this proposal; core defaults to 1 when absent (§6.6 budget) */
  costUnits?: number;
}

export interface AgentRequest {
  taskId: string;
  role: Role;
  iteration: number;
  feedback: ActionOutcome[];
  /** confirmed repair patch plan carried into the next proposal after DIAGNOSING (§9.3) */
  repairPlan?: string;
}

/** The only surface core uses to talk to a model (Ring 1 implements this). */
export interface AgentPort {
  propose(req: AgentRequest): Promise<Proposal>;
}

export type TaskState =
  | 'PROPOSED' | 'ANALYZING' | 'READY' | 'WRITING_TESTS' | 'IMPLEMENTING' | 'VERIFYING'
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
  /** evidence binding (INV-10): what commit + environment produced this result */
  commitHash?: string;
  envHash?: string;
  /** §6.5: trust extends only as far as golden coverage — carried alongside every T1 pass */
  goldenCoverage?: { coveredAcs: string[]; uncoveredAcs: string[]; ratio: number };
  /** §6.4 convention leg — explicit skipped is never a fake green */
  convention?: 'pass' | 'fail' | 'skipped';
}

export interface TaskContext {
  taskId: string;
  role: Role;
  worktree: string;
  budget: Budget;
}
