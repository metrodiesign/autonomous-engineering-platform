#!/usr/bin/env node
// compare-calibration.mjs (§12 baseline compare — G11 leg): diff two calibration records and
// block on regression. No model calls. Usage:
//   node scripts/compare-calibration.mjs <baseline.json> <current.json>
// Metrics compared (higher is better for all): pass rate from "heldOutPassed" ("N/M"), and any
// shared boolean outcome flag (true -> false is a regression). Exit 1 if ANY metric regressed.
// Per §12, small-n comparisons are indicative, not a rate — the n is printed alongside.
import { readFileSync } from 'node:fs';

const [, , baselinePath, currentPath] = process.argv;
if (!baselinePath || !currentPath) {
  console.error('usage: compare-calibration.mjs <baseline.json> <current.json>');
  process.exit(2);
}

const load = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`cannot read/parse ${p}: ${String(e)}`);
    process.exit(2);
  }
};

/** pull comparable metrics out of a calibration record (higher = better for each). */
function extractMetrics(record) {
  const metrics = {};
  if (typeof record.heldOutPassed === 'string' && /^\d+\/\d+$/.test(record.heldOutPassed)) {
    const [n, d] = record.heldOutPassed.split('/').map(Number);
    if (d > 0) metrics.passRate = { value: n / d, n: d, raw: record.heldOutPassed };
  }
  for (const [k, v] of Object.entries(record)) {
    if (typeof v === 'boolean') metrics[k] = { value: v ? 1 : 0, n: 1, raw: String(v), bool: true };
  }
  return metrics;
}

const baseline = load(baselinePath);
const current = load(currentPath);
const baseM = extractMetrics(baseline);
const curM = extractMetrics(current);

const shared = Object.keys(baseM).filter((k) => k in curM);
console.log(`baseline: ${baselinePath} (systemVersion=${baseline.systemVersion ?? 'n/a'})`);
console.log(`current:  ${currentPath} (systemVersion=${current.systemVersion ?? 'n/a'})`);

if (shared.length === 0) {
  console.log('no shared comparable metrics — nothing to compare (not a regression)');
  process.exit(0);
}

let regressions = 0;
for (const key of shared) {
  const b = baseM[key];
  const c = curM[key];
  const regressed = c.value < b.value;
  if (regressed) regressions++;
  const smallN = c.n <= 5 ? ` [small n=${c.n}: indicative, not a rate]` : '';
  const fmt = (m) => (m.bool ? m.raw : `${(m.value * 100).toFixed(1)}% (${m.raw})`);
  console.log(`${regressed ? 'REGRESSION' : 'OK'}  ${key}: baseline=${fmt(b)} current=${fmt(c)}${smallN}`);
}

console.log(regressions ? `RESULT: ${regressions} regression(s) — upgrade blocked` : 'RESULT: OK — no regression');
process.exit(regressions ? 1 : 0);
