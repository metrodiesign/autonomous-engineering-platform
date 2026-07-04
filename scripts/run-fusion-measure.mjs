#!/usr/bin/env node
// Fusion measurement (§7.5 DoD): self-panel N=2 vs single run, evidence-tournament resolve.
// Honest numbers only — fusion stays OFF unless calibration proves uplift.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog, Executor, buildContext, runGate, writeGoldenManifest } from '../core/dist/index.js';
import { fusePanel } from '../aal/dist/index.js';
import { AnthropicAdapter } from '../adapters/dist/index.js';

for (const k of Object.keys(process.env)) {
  if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDECODE|CLAUDE_)/.test(k)) delete process.env[k];
}

// deliberately trickier task (edge cases hidden in golden) so single-shot can plausibly miss
const TASK = {
  id: 'FUS-rom',
  goal: 'Create src/roman.mjs exporting toRoman(n) converting integer 1..3999 to Roman numerals. Throw RangeError outside that range.',
  visible: `import { toRoman } from '../../src/roman.mjs';\nimport test from 'node:test';\nimport assert from 'node:assert';\ntest('basic', () => { assert.equal(toRoman(3), 'III'); assert.equal(toRoman(58), 'LVIII'); });\n`,
  golden: `import { toRoman } from '../../src/roman.mjs';\nimport test from 'node:test';\nimport assert from 'node:assert';\ntest('golden', () => { assert.equal(toRoman(1994), 'MCMXCIV'); assert.equal(toRoman(3999), 'MMMCMXCIX'); assert.throws(() => toRoman(0), RangeError); assert.throws(() => toRoman(4000), RangeError); });\n`,
};

function makeWt() {
  const wt = mkdtempSync(join(tmpdir(), 'fus-'));
  mkdirSync(join(wt, 'src'), { recursive: true });
  mkdirSync(join(wt, 'test', 'ai-generated'), { recursive: true });
  mkdirSync(join(wt, 'test', 'golden'), { recursive: true });
  writeFileSync(join(wt, 'test', 'ai-generated', 'v.test.mjs'), TASK.visible);
  writeFileSync(join(wt, 'test', 'golden', 'g.test.mjs'), TASK.golden);
  writeGoldenManifest(join(wt, 'test', 'golden'));
  return wt;
}

const gatesFor = (wt) => ({
  t0: [{ name: 'v', cmd: 'node', args: ['--test', 'test/ai-generated/**/*.test.mjs'], cwd: wt }],
  t1: [
    { name: 'v', cmd: 'node', args: ['--test', 'test/ai-generated/**/*.test.mjs'], cwd: wt },
    { name: 'g', cmd: 'node', args: ['--test', 'test/golden/**/*.test.mjs'], cwd: wt },
  ],
  goldenDir: join(wt, 'test', 'golden'),
  flakyRetry: false,
});

const seedWt = makeWt();
const built = buildContext({ worktree: seedWt, seeds: ['test/ai-generated/v.test.mjs'], docs: [{ id: 'goal', content: TASK.goal }] });
const adapter = new AnthropicAdapter({ model: 'haiku' });

const baseRequest = {
  requestId: `fus-${TASK.id}`,
  agentRole: 'implementer',
  taskContract: { taskId: TASK.id, goalExcerpt: TASK.goal, acceptanceCriteria: ['visible tests pass'], constraints: ['ESM .mjs'] },
  contextBundle: { pieces: built.pieces, manifestRef: built.manifest.manifestRef },
  outputSchema: { type: 'object', properties: { claim: { type: 'string' } }, required: ['claim'] },
  budget: { costUnits: 200 },
};

// EVIDENCE runner: apply candidate actions in an isolated worktree, run T1 (core-owned)
const runEvidence = (candidate) => {
  const wt = makeWt();
  const log = new EventLog(join(wt, 'events.db'));
  const executor = new Executor(log);
  for (const a of candidate.actions) {
    executor.execute({ taskId: `${TASK.id}-p${candidate.panelIndex}`, role: 'implementer', worktree: wt, budget: { maxIterations: 1, maxCostUnits: 1, maxWallclockMs: 60_000 } }, a);
  }
  const r = runGate('T1', gatesFor(wt));
  return { gatePassed: r.status === 'pass', detail: r.detail };
};

const outcome = await fusePanel(adapter, baseRequest, 2, runEvidence);
const singlePass = outcome.evidence.find((e) => e.panelIndex === 0)?.gatePassed ?? false;
const fusionPass = outcome.winner !== null;
const record = {
  date: '2026-07-05',
  model: 'haiku',
  panel: 2,
  task: TASK.id,
  singleRunPass: singlePass,
  fusionPass,
  upliftObserved: fusionPass && !singlePass,
  costMultiplier: outcome.costMultiplier,
  dissent: outcome.dissent,
  policyNote: 'fusion default OFF — enable per policy only where calibration proves uplift (§7.5); n=1 here, evidence not a rate',
};
mkdirSync('.ai/calibration', { recursive: true });
writeFileSync('.ai/calibration/fusion-measure-2026-07-05.json', JSON.stringify(record, null, 2));
console.log(JSON.stringify(record, null, 1));
