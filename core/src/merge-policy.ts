// Risk-level merge policy (§6.6) + sampling audit + meta-governance (INV-16).
import type { EventLog } from './event-log.js';

export type RiskLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';

export interface MergeDecision {
  action: 'auto-merge' | 'needs-review' | 'needs-human' | 'forbidden-auto';
  sampledForAudit: boolean;
  reason: string;
}

export interface MergePolicyOptions {
  auditSampleRate: number; // 0..1 of L0/L1 auto-merges pulled for out-of-band audit
  rng?: () => number;
}

export function decideMerge(
  log: EventLog,
  taskId: string,
  risk: RiskLevel,
  gatesPassed: boolean,
  opts: MergePolicyOptions = { auditSampleRate: 0.2 },
): MergeDecision {
  const rng = opts.rng ?? Math.random;
  let d: MergeDecision;
  if (!gatesPassed) {
    d = { action: 'needs-review', sampledForAudit: false, reason: 'gates not green — nothing merges' };
  } else if (risk === 'L0' || risk === 'L1') {
    d = { action: 'auto-merge', sampledForAudit: rng() < opts.auditSampleRate, reason: `${risk} auto-merge with sampling audit` };
  } else if (risk === 'L2') {
    d = { action: 'needs-review', sampledForAudit: false, reason: 'L2 requires 2-lineage AI review + CI' };
  } else if (risk === 'L3') {
    d = { action: 'needs-human', sampledForAudit: false, reason: 'L3 requires human approval package (INV-4 family)' };
  } else {
    d = { action: 'forbidden-auto', sampledForAudit: false, reason: 'L4 never automated (INV-4)' };
  }
  log.append({ ts: Date.now(), taskId, type: 'MERGE_DECISION', principal: 'core', payload: { risk, ...d } });
  return d;
}

// ---- meta-governance (INV-16): loosening changes demand human approval, versioned in the log ----

export interface PolicyChange {
  key: string;
  from: number;
  to: number;
  /** true when the change makes a gate weaker (higher threshold, lower sample rate, ...) */
  loosens: boolean;
}

export function applyPolicyChange(
  log: EventLog,
  change: PolicyChange,
  approvedByHuman: boolean,
): { applied: boolean; reason: string } {
  if (change.loosens && !approvedByHuman) {
    log.append({
      ts: Date.now(), taskId: '*', type: 'POLICY_CHANGE_REFUSED', principal: 'core',
      payload: { ...change, reason: 'loosening change without human approval (INV-16)' },
    });
    return { applied: false, reason: 'gate-loosening requires human approval (INV-16)' };
  }
  log.append({
    ts: Date.now(), taskId: '*', type: 'POLICY_CHANGED', principal: approvedByHuman ? 'human' : 'core',
    payload: { ...change },
  });
  return { applied: true, reason: 'versioned in event log' };
}
