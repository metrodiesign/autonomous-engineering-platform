#!/usr/bin/env node
// Supervised loop (§14 Phase 1 DoD) + bootstrap calibration:
// real model proposes, core executes/measures, hidden golden decides truth,
// approval package flows through the Human Plane API.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog, Executor, Orchestrator, buildContext, writeGoldenManifest, ApprovalStore, startHumanPlane } from '../core/dist/index.js';
import { adapterAgentPort } from '../aal/dist/index.js';
import { AnthropicAdapter } from '../adapters/dist/index.js';

for (const k of Object.keys(process.env)) {
  if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDECODE|CLAUDE_)/.test(k)) delete process.env[k];
}

const MODEL = process.argv[2] ?? 'haiku';

// calibration tasks: visible RED test + hidden golden the model never sees
const TASKS = [
  {
    id: 'CAL-add',
    goal: 'Create src/calc.mjs exporting function add(a, b) returning the numeric sum.',
    visible: `import { add } from '../../src/calc.mjs';\nimport test from 'node:test';\nimport assert from 'node:assert';\ntest('adds', () => assert.equal(add(1, 2), 3));\n`,
    golden: `import { add } from '../../src/calc.mjs';\nimport test from 'node:test';\nimport assert from 'node:assert';\ntest('golden add', () => { assert.equal(add(2, 3), 5); assert.equal(add(-1, 1), 0); assert.equal(add(0.1, 0.2) > 0.29, true); });\n`,
  },
  {
    id: 'CAL-cap',
    goal: 'Create src/text.mjs exporting function capitalize(s) that uppercases the first character and lowercases the rest. Empty string returns empty string.',
    visible: `import { capitalize } from '../../src/text.mjs';\nimport test from 'node:test';\nimport assert from 'node:assert';\ntest('cap', () => assert.equal(capitalize('hello'), 'Hello'));\n`,
    golden: `import { capitalize } from '../../src/text.mjs';\nimport test from 'node:test';\nimport assert from 'node:assert';\ntest('golden cap', () => { assert.equal(capitalize('wORLD'), 'World'); assert.equal(capitalize(''), ''); assert.equal(capitalize('a'), 'A'); });\n`,
  },
  {
    id: 'CAL-prime',
    goal: 'Create src/prime.mjs exporting function isPrime(n) returning true when integer n >= 2 is prime, false otherwise (including negatives, 0, 1, non-integers).',
    visible: `import { isPrime } from '../../src/prime.mjs';\nimport test from 'node:test';\nimport assert from 'node:assert';\ntest('prime', () => { assert.equal(isPrime(7), true); assert.equal(isPrime(8), false); });\n`,
    golden: `import { isPrime } from '../../src/prime.mjs';\nimport test from 'node:test';\nimport assert from 'node:assert';\ntest('golden prime', () => { assert.equal(isPrime(2), true); assert.equal(isPrime(1), false); assert.equal(isPrime(0), false); assert.equal(isPrime(-7), false); assert.equal(isPrime(97), true); assert.equal(isPrime(2.5), false); });\n`,
  },
];

const results = [];
const adapter = new AnthropicAdapter({ model: MODEL });

for (const t of TASKS) {
  const wt = mkdtempSync(join(tmpdir(), `sl-${t.id}-`));
  mkdirSync(join(wt, 'src'), { recursive: true });
  mkdirSync(join(wt, 'test', 'ai-generated'), { recursive: true });
  mkdirSync(join(wt, 'test', 'golden'), { recursive: true });
  writeFileSync(join(wt, 'test', 'ai-generated', 'visible.test.mjs'), t.visible);
  writeFileSync(join(wt, 'test', 'golden', 'golden.test.mjs'), t.golden);
  writeGoldenManifest(join(wt, 'test', 'golden'));

  const log = new EventLog(join(wt, 'events.db'));
  const executor = new Executor(log);
  const gates = {
    t0: [{ name: 'visible-tests', cmd: 'node', args: ['--test', 'test/ai-generated/**/*.test.mjs'], cwd: wt }],
    t1: [
      { name: 'visible-tests', cmd: 'node', args: ['--test', 'test/ai-generated/**/*.test.mjs'], cwd: wt },
      { name: 'golden-tests', cmd: 'node', args: ['--test', 'test/golden/**/*.test.mjs'], cwd: wt }, // held-out truth
    ],
    goldenDir: join(wt, 'test', 'golden'),
    flakyRetry: true,
  };
  const orch = new Orchestrator(log, executor, gates);

  const built = buildContext({
    worktree: wt,
    seeds: ['test/ai-generated/visible.test.mjs'],
    docs: [{ id: 'goal', content: t.goal }],
  });
  const agent = adapterAgentPort(adapter, {
    taskId: t.id,
    goalExcerpt: t.goal,
    acceptanceCriteria: ['node --test test/ai-generated/ passes'],
    constraints: ['ESM .mjs', 'no dependencies'],
    contextBundle: { pieces: built.pieces, manifestRef: built.manifest.manifestRef },
  });

  const started = Date.now();
  const res = await orch.runTask(
    { taskId: t.id, role: 'implementer', worktree: wt, budget: { maxIterations: 4, maxCostUnits: 800, maxWallclockMs: 300_000 } },
    agent,
  );

  // approval package through the Human Plane (supervised step)
  let approval = 'n/a';
  if (res.finalState === 'REVIEWING') {
    const writes = log.eventsFor(t.id).filter((e) => e.type === 'ACTION_INTENT' && e.payload.action?.type === 'WRITE_FILE');
    const diff = writes.map((e) => `+++ ${e.payload.action.path}\n${e.payload.action.content}`).join('\n');
    const approvals = new ApprovalStore(log);
    const created = approvals.create({
      taskId: t.id, riskLevel: 'L1', goalExcerpt: t.goal, diff,
      evidenceRefs: [`events:${t.id}`], assumptions: ['bootstrap calibration'], unresolvedRisks: [],
    });
    if (created.ok) {
      const { server, token } = await startHumanPlane({ log, approvals, tokenFile: join(wt, 'token') }, 0);
      const port = server.address().port;
      const r = await fetch(`http://127.0.0.1:${port}/approvals/${created.pkg.id}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ verdict: 'approved' }),
      });
      approval = (await r.json()).pkg.status;
      server.close();
    } else {
      approval = `refused: ${created.reason}`;
    }
  }

  const entry = {
    task: t.id,
    finalState: res.finalState,
    iterations: res.iterations,
    flaky: res.flaky,
    goldenPassed: res.finalState === 'REVIEWING', // T1 includes hidden golden
    approval,
    wallclockMs: Date.now() - started,
    worktree: wt,
  };
  results.push(entry);
  console.log(JSON.stringify(entry));
}

const passed = results.filter((r) => r.goldenPassed).length;
const summary = {
  date: '2026-07-04',
  model: MODEL,
  systemNote: 'bootstrap calibration — operator-delegate authored tasks + hidden golden; n=3 so treat as wide interval, not a rate',
  heldOutPassed: `${passed}/${results.length}`,
  results,
};
mkdirSync('.ai/calibration', { recursive: true });
writeFileSync(`.ai/calibration/bootstrap-${MODEL}-2026-07-04.json`, JSON.stringify(summary, null, 2));
console.log(`SUPERVISED LOOP: held-out pass ${passed}/${results.length} (model=${MODEL})`);
process.exit(passed > 0 ? 0 : 1);
