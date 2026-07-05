#!/usr/bin/env node
// Drift canary (§7.3): re-probe a registered adapter against its stored conformance baseline
// and flag regressions (P1 structured output + P6 isolation). Live model calls on the
// subscription — run deliberately/on a schedule, never in CI. Exit non-zero when drift is detected.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { driftCheck } from '../aal/dist/index.js';
import { AnthropicAdapter } from '../adapters/dist/index.js';

for (const k of Object.keys(process.env)) {
  if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDECODE|CLAUDE_)/.test(k)) delete process.env[k];
}

const baselinePath = '.ai/calibration/conformance-baseline.json';
const seedBaseline = {
  probes: [
    { probe: 'P1-echo-schema', pass: true },
    { probe: 'P6-no-execution-authority', pass: true },
  ],
};
const baseline = existsSync(baselinePath)
  ? JSON.parse(readFileSync(baselinePath, 'utf8'))
  : seedBaseline;

const adapter = new AnthropicAdapter({ model: 'haiku' });
const report = await driftCheck(adapter, baseline);

const date = new Date().toISOString().slice(0, 10);
const record = { date, model: 'haiku', baselineSource: existsSync(baselinePath) ? baselinePath : 'seed-default', ...report };
mkdirSync('.ai/calibration', { recursive: true });
writeFileSync(`.ai/calibration/drift-${date}.json`, JSON.stringify(record, null, 2));

// seed the baseline on first run so subsequent runs have something to compare against
if (!existsSync(baselinePath)) {
  writeFileSync(baselinePath, JSON.stringify({ probes: report.current.map((c) => ({ probe: c.probe, pass: c.pass })) }, null, 2));
}

for (const c of report.current) console.log(`${c.pass ? 'PASS' : 'FAIL'} ${c.probe} — ${c.detail}`);
console.log(report.drifted ? `DRIFT DETECTED: ${JSON.stringify(report.changes)}` : 'DRIFT: none');
process.exit(report.drifted ? 1 : 0);
