// Wire a §11.1 Goal Contract into the autonomous loops: derive the per-task Budget,
// acceptance-criteria list, goal excerpt, and human-approval requirement — falling back to
// caller-supplied defaults when the contract omits a field. Also a content hash so a loop can
// refuse to complete when the frozen contract is amended mid-run. Vendor-neutral (INV-7).
import { createHash } from 'node:crypto';
import type { Budget } from './types.js';
import type { GoalContract } from './goal-contract.js';

export interface LoopConfig {
  goalExcerpt: string;
  acceptanceCriteria: string[];
  budget: Budget;
  requireHumanApproval: boolean;
  version: number;
}

const MINUTE_MS = 60_000;

/** Map a validated Goal Contract onto loop parameters, using `fallback` for anything absent. */
export function contractToLoopConfig(
  contract: GoalContract,
  fallback: { goalExcerpt: string; acceptanceCriteria: string[]; budget: Budget },
): LoopConfig {
  const b = contract.budget ?? {};
  const acs = contract.acceptance_criteria ?? [];
  return {
    goalExcerpt: contract.goal?.objective ?? contract.goal?.title ?? fallback.goalExcerpt,
    acceptanceCriteria: acs.length > 0
      ? acs.map((a) => a.description ?? a.verification ?? a.id)
      : fallback.acceptanceCriteria,
    budget: {
      maxIterations: b.max_iterations_per_task ?? fallback.budget.maxIterations,
      maxCostUnits: b.max_cost_units_per_task ?? fallback.budget.maxCostUnits,
      maxWallclockMs: b.max_wallclock_per_task_min != null
        ? b.max_wallclock_per_task_min * MINUTE_MS
        : fallback.budget.maxWallclockMs,
    },
    requireHumanApproval: (contract.approval_policy?.require_human_approval?.length ?? 0) > 0,
    version: contract.version ?? 1,
  };
}

/** sha256 of the raw contract text — used to detect a frozen contract amended mid-run (§11.1). */
export function goalContractHash(rawText: string): string {
  return createHash('sha256').update(rawText).digest('hex');
}
