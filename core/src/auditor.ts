// Out-of-band auditor (§6.5, Phase 3): sample COMPLETED tasks, rebuild a clean checkout
// from the event log's applied writes, re-run the gate — DETECT non-reproducibility, never inject.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { EventLog } from './event-log.js';
import type { Action } from './types.js';
import { runGate, type GateConfig } from './gates.js';
import { commitHash, envHash, writeEvidence } from './evidence.js';

export interface EscapeRate {
  sampled: number;
  escapes: number;
  rate: number;
}

export interface AuditReport {
  taskId: string;
  reproduced: boolean;
  detail: string;
  checkoutDir: string;
  commitHash: string;
  envHash: string;
  evidenceId?: string;
  escapeRate: EscapeRate;
}

export interface AuditDeps {
  /** where to persist the content-addressed audit evidence record (INV-10) */
  evidenceDir?: string;
  /** repo working tree used to fingerprint the environment (lockfile); defaults to the checkout */
  cwd?: string;
}

/**
 * Escape rate (§10.1 residual / §12): of the merges we audited, how many escaped detection at
 * verification — a non-reproducible audit or a later regression. Pure over the event log.
 */
export function computeEscapeRate(log: EventLog): EscapeRate {
  const events = log.all();
  const sampled = events.filter(
    (e) => e.type === 'AUDIT_REPRODUCED' || e.type === 'AUDIT_NON_REPRODUCIBLE',
  ).length;
  const escapes = events.filter(
    (e) => e.type === 'AUDIT_NON_REPRODUCIBLE' || e.type === 'REGRESSION_FOUND',
  ).length;
  return { sampled, escapes, rate: sampled ? escapes / sampled : 0 };
}

/** rebuild the artifact from ACTION_APPLIED WRITE_FILEs only — the frozen evidence trail */
export function cleanCheckout(log: EventLog, taskId: string, staticFiles: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), `audit-${taskId}-`));
  for (const [rel, content] of Object.entries(staticFiles)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  const events = log.eventsFor(taskId);
  const appliedIds = new Set(events.filter((e) => e.type === 'ACTION_APPLIED').map((e) => e.payload.actionId as string));
  for (const e of events.filter((ev) => ev.type === 'ACTION_INTENT')) {
    const action = e.payload.action as unknown as Action;
    if (action.type === 'WRITE_FILE' && appliedIds.has(action.actionId)) {
      mkdirSync(dirname(join(dir, action.path)), { recursive: true });
      writeFileSync(join(dir, action.path), action.content);
    }
  }
  return dir;
}

export function auditTask(
  log: EventLog,
  taskId: string,
  staticFiles: Record<string, string>,
  gatesFor: (checkoutDir: string) => GateConfig,
  deps: AuditDeps = {},
): AuditReport {
  const dir = cleanCheckout(log, taskId, staticFiles);
  // bind the re-run to the frozen artifact + environment (INV-10)
  const binding = { commitHash: commitHash(dir), envHash: envHash(deps.cwd ?? dir) };
  const result = runGate('T1', gatesFor(dir), binding);
  const reproduced = result.status === 'pass';
  const evidenceId = deps.evidenceDir
    ? writeEvidence(deps.evidenceDir, {
        kind: 'audit',
        taskId,
        reproduced,
        gateConfigHash: result.gateConfigHash,
        detail: result.detail,
        ...binding,
      })
    : undefined;
  log.append({
    ts: Date.now(), taskId, type: reproduced ? 'AUDIT_REPRODUCED' : 'AUDIT_NON_REPRODUCIBLE',
    principal: 'core',
    payload: { checkoutDir: dir, gateConfigHash: result.gateConfigHash, detail: result.detail, ...binding, evidenceId },
  });
  const escapeRate = computeEscapeRate(log);
  const report: AuditReport = { taskId, reproduced, detail: result.detail, checkoutDir: dir, ...binding, escapeRate };
  if (evidenceId) report.evidenceId = evidenceId;
  return report;
}
