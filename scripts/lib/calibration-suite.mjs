// Pure helpers for the §12 calibration suite. No side effects on import, no model calls,
// no network — so run-supervised-loop.mjs and the offline self-check can both import it.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Marker written into a task's visible/golden until a human authors the real tests.
export const UNAUTHORED = 'TODO_AUTHOR';

/** A task is authored once both its visible RED test and its hidden golden carry real content. */
export function isAuthored(task) {
  const filled = (s) => typeof s === 'string' && s.trim() !== '' && !s.includes(UNAUTHORED);
  return filled(task.visible) && filled(task.golden);
}

/** §12 scoring: a run is correct when its final state matches the task's expected outcome. */
export function outcomePassed(finalState, expect) {
  return finalState === (expect ?? 'REVIEWING');
}

/**
 * Load calibration task files from a suite directory.
 * Returns { authored, stubs, invalid } — authored tasks run, stubs are skipped (not yet filled),
 * invalid are reported and skipped. Deterministic order (filename sort).
 */
export function loadSuite(dir) {
  const authored = [], stubs = [], invalid = [];
  if (!existsSync(dir)) return { authored, stubs, invalid };
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'task.schema.json').sort();
  for (const f of files) {
    let task;
    try {
      task = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    } catch (e) {
      invalid.push({ file: f, reason: `parse: ${String(e)}` });
      continue;
    }
    const missing = ['id', 'goal', 'visible', 'golden'].filter((k) => task[k] === undefined);
    if (missing.length) {
      invalid.push({ file: f, reason: `missing: ${missing.join(',')}` });
      continue;
    }
    (isAuthored(task) ? authored : stubs).push(task);
  }
  return { authored, stubs, invalid };
}
