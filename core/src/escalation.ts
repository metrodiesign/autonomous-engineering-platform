// Decidable escalation (§10.3): every ESCALATED transition ends with a question +
// priced/risked options derived from the hypothesis log or budget cause — never a raw
// log dump. Vendor-neutral (INV-7). Mirrors ApprovalStore so the Human Plane can list/resolve.
import { randomBytes } from 'node:crypto';
import type { EventLog } from './event-log.js';
import type { Budget } from './types.js';

export type EscalationReason = 'budget_exceeded' | 'hypotheses_exhausted' | 'weak_tests_exhausted';

export interface EscalationOption {
  label: string;
  action: 'retry' | 'split' | 'cancel' | 'continue-diagnosis';
  expectedCost: string;
  risk: string;
}

export interface EscalationPackage {
  id: string;
  taskId: string;
  reason: EscalationReason;
  question: string;
  options: EscalationOption[];
  fingerprint: string | null;
  refutedHypotheses: string[];
  createdAt: number;
  status: 'pending' | 'resolved';
  chosenOptionIndex?: number;
}

export interface BuildEscalationInput {
  taskId: string;
  reason: EscalationReason;
  fingerprint?: string | null;
  refutedHypotheses?: string[];
  budget?: Budget;
}

const QUESTIONS: Record<EscalationReason, (taskId: string) => string> = {
  budget_exceeded: (t) => `Task ${t} exhausted its budget without passing the gates — how should the platform proceed?`,
  hypotheses_exhausted: (t) => `Task ${t} refuted every repair hypothesis — how should the platform proceed?`,
  weak_tests_exhausted: (t) => `Task ${t} could not produce a failing (RED) test after retries — how should the platform proceed?`,
};

/** deterministic package builder — reads only the summarized inputs, no event array (§10.3). */
export function buildEscalationPackage(input: BuildEscalationInput): EscalationPackage {
  const refutedHypotheses = input.refutedHypotheses ?? [];
  const options: EscalationOption[] = [
    { label: 'Retry with a larger budget', action: 'retry', expectedCost: 'more iterations / cost units', risk: 'consumes additional quota' },
    { label: 'Split the task into smaller units', action: 'split', expectedCost: 'replanning effort', risk: 'low' },
    { label: 'Cancel the task', action: 'cancel', expectedCost: 'work done so far is discarded', risk: 'none' },
  ];
  if (refutedHypotheses.length > 0) {
    options.push({
      label: 'Continue diagnosis with fresh hypotheses',
      action: 'continue-diagnosis',
      expectedCost: 'more probe runs',
      risk: 'bounded by remaining budget',
    });
  }
  return {
    id: `esc-${randomBytes(6).toString('hex')}`,
    taskId: input.taskId,
    reason: input.reason,
    question: QUESTIONS[input.reason](input.taskId),
    options,
    fingerprint: input.fingerprint ?? null,
    refutedHypotheses,
    createdAt: Date.now(),
    status: 'pending',
  };
}

/** Human-facing store for decidable escalations (mirror of ApprovalStore). */
export class EscalationStore {
  private items = new Map<string, EscalationPackage>();

  constructor(private log: EventLog) {}

  create(pkg: EscalationPackage): EscalationPackage {
    this.items.set(pkg.id, pkg);
    this.log.append({
      ts: Date.now(), taskId: pkg.taskId, type: 'ESCALATION_RAISED', principal: 'core',
      payload: { escalationId: pkg.id, reason: pkg.reason, options: pkg.options.length },
    });
    return pkg;
  }

  listPending(): EscalationPackage[] {
    return [...this.items.values()].filter((p) => p.status === 'pending');
  }

  resolve(id: string, chosenOptionIndex: number): EscalationPackage | null {
    const pkg = this.items.get(id);
    if (!pkg || pkg.status !== 'pending') return null;
    if (chosenOptionIndex < 0 || chosenOptionIndex >= pkg.options.length) return null;
    pkg.status = 'resolved';
    pkg.chosenOptionIndex = chosenOptionIndex;
    this.log.append({
      ts: Date.now(), taskId: pkg.taskId, type: 'ESCALATION_RESOLVED', principal: 'human',
      payload: { escalationId: id, chosenOptionIndex, action: pkg.options[chosenOptionIndex]!.action },
    });
    return pkg;
  }
}
