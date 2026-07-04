// Out-of-band auditor (§6.5, Phase 3): sample COMPLETED tasks, rebuild a clean checkout
// from the event log's applied writes, re-run the gate — DETECT non-reproducibility, never inject.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { EventLog } from './event-log.js';
import type { Action } from './types.js';
import { runGate, type GateConfig } from './gates.js';

export interface AuditReport {
  taskId: string;
  reproduced: boolean;
  detail: string;
  checkoutDir: string;
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
): AuditReport {
  const dir = cleanCheckout(log, taskId, staticFiles);
  const result = runGate('T1', gatesFor(dir));
  const reproduced = result.status === 'pass';
  log.append({
    ts: Date.now(), taskId, type: reproduced ? 'AUDIT_REPRODUCED' : 'AUDIT_NON_REPRODUCIBLE',
    principal: 'core',
    payload: { checkoutDir: dir, gateConfigHash: result.gateConfigHash, detail: result.detail },
  });
  return { taskId, reproduced, detail: result.detail, checkoutDir: dir };
}
