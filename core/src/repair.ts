// Hypothesis-driven repair (§9.3): agent returns testable hypotheses,
// core runs the probes (cheaper than patch+verify). Refuted hypotheses are always recorded.
import { spawnSync } from 'node:child_process';
import type { EventLog } from './event-log.js';

export interface Hypothesis {
  statement: string;
  probes: { cmd: string; args: string[]; expectExitCode: number }[];
  ifConfirmed: { patchPlan: string; estimatedBlastRadius: string };
}

export interface RepairOutcome {
  confirmed: Hypothesis | null;
  refuted: string[];
  escalate: boolean;
}

export function runHypothesisProbes(
  log: EventLog,
  taskId: string,
  worktree: string,
  hypotheses: Hypothesis[],
  maxHypotheses = 3,
): RepairOutcome {
  const refuted: string[] = [];
  for (const h of hypotheses.slice(0, maxHypotheses)) {
    const allProbesPass = h.probes.every((p) => {
      const r = spawnSync(p.cmd, p.args, { cwd: worktree, encoding: 'utf8', timeout: 60_000 });
      return (r.status ?? -1) === p.expectExitCode;
    });
    log.append({
      ts: Date.now(), taskId, type: allProbesPass ? 'HYPOTHESIS_CONFIRMED' : 'HYPOTHESIS_REFUTED',
      principal: 'core',
      payload: { statement: h.statement, probes: h.probes.length, patchPlan: allProbesPass ? h.ifConfirmed.patchPlan : null },
    });
    if (allProbesPass) return { confirmed: h, refuted, escalate: false };
    refuted.push(h.statement); // recorded — never re-guessed silently
  }
  if (hypotheses.length > maxHypotheses) {
    log.append({
      ts: Date.now(), taskId, type: 'HYPOTHESES_TRUNCATED', principal: 'core',
      payload: { offered: hypotheses.length, max: maxHypotheses },
    });
  }
  return { confirmed: null, refuted, escalate: true }; // ESCALATED with hypothesis log (§9.3)
}
