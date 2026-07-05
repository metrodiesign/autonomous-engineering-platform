// Planning gate (§11.2, Phase 4 issue intake): task graph must trace to ACs
// and keep every task under the diff budget before the loop may use it.
export interface GoalContractLite {
  acceptanceCriteria: { id: string }[];
}

export interface PlannedTask {
  taskId: string;
  mapsToAc: string[];
  enabling?: boolean; // infra tasks with no direct AC — must be tagged
  estimatedDiffBytes: number;
}

export interface PlanningGateResult {
  ok: boolean;
  uncoveredAcs: string[];
  orphanTasks: string[];
  overBudgetTasks: string[];
}

export function checkPlanningGate(
  goal: GoalContractLite,
  tasks: PlannedTask[],
  maxDiffBudgetPerTask = 400 * 100, // bytes ~ 400 lines
): PlanningGateResult {
  const covered = new Set(tasks.flatMap((t) => t.mapsToAc));
  const uncoveredAcs = goal.acceptanceCriteria.map((a) => a.id).filter((id) => !covered.has(id));
  const orphanTasks = tasks.filter((t) => t.mapsToAc.length === 0 && !t.enabling).map((t) => t.taskId);
  const overBudgetTasks = tasks.filter((t) => t.estimatedDiffBytes > maxDiffBudgetPerTask).map((t) => t.taskId);
  return {
    ok: uncoveredAcs.length === 0 && orphanTasks.length === 0 && overBudgetTasks.length === 0,
    uncoveredAcs,
    orphanTasks,
    overBudgetTasks,
  };
}
