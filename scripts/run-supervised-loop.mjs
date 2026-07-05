#!/usr/bin/env node
// Supervised loop (§14 Phase 1 DoD) + bootstrap calibration:
// real model proposes, core executes/measures, hidden golden decides truth,
// approval package flows through the Human Plane API.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog, Executor, Orchestrator, StateMachine, buildContext, writeGoldenManifest, ApprovalStore, startHumanPlane, Steering, EscalationStore, quarantineWorktree, parseGoalContract, validateGoalContract, contractToLoopConfig, goalContractHash } from '../core/dist/index.js';
import { adapterAgentPort } from '../aal/dist/index.js';
import { AnthropicAdapter } from '../adapters/dist/index.js';
import { loadSuite, outcomePassed } from './lib/calibration-suite.mjs';

for (const k of Object.keys(process.env)) {
  if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDECODE|CLAUDE_)/.test(k)) delete process.env[k];
}

const MODEL = process.argv[2] ?? 'haiku';

// bootstrap tasks: visible RED test + hidden golden the model never sees.
// Used only when .ai/calibration/suite/ has no authored tasks yet (see below).
const BOOTSTRAP_TASKS = [
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

// Real suite (.ai/calibration/suite/*.json, human-authored per §12) takes over once at least one
// task is authored; until then fall back to the bootstrap tasks so calibrate.sh works out of the box.
const SUITE_DIR = '.ai/calibration/suite';
const suite = loadSuite(SUITE_DIR);
for (const iv of suite.invalid) console.error(`skip invalid calibration task ${iv.file}: ${iv.reason}`);
const usingSuite = suite.authored.length > 0;
const TASKS = usingSuite ? suite.authored : BOOTSTRAP_TASKS;
if (usingSuite) {
  console.log(`calibration suite: ${suite.authored.length} authored, ${suite.stubs.length} unauthored stub(s) skipped`);
  if (suite.stubs.length) console.log(`  unauthored: ${suite.stubs.map((s) => s.id).join(', ')}`);
} else {
  console.log(`no authored tasks in ${SUITE_DIR} — using ${BOOTSTRAP_TASKS.length}-task bootstrap fallback`);
}

const results = [];
const adapter = new AnthropicAdapter({ model: MODEL });

// §11.1 Goal Contract: when .ai/goal.yaml is present it drives goal/AC/budget/approval; else per-task fallback.
const GOAL_PATH = '.ai/goal.yaml';
let contract = null, goalHash = null;
if (existsSync(GOAL_PATH)) {
  const raw = readFileSync(GOAL_PATH, 'utf8');
  goalHash = goalContractHash(raw);
  const parsed = parseGoalContract(raw);
  const v = validateGoalContract(parsed);
  if (!v.ok) { console.error('invalid .ai/goal.yaml — missing:', v.missing.join(', ')); process.exit(1); }
  contract = parsed;
  console.log(`goal contract v${contract.version ?? 1}: ${contract.goal?.objective ?? contract.goal?.title}`);
}

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

  // per-task fallback; a present contract overrides goal/AC/budget/approval (frozen calibration gate stays the golden tests)
  const fallback = {
    goalExcerpt: t.goal,
    acceptanceCriteria: ['node --test test/ai-generated/ passes'],
    budget: { maxIterations: 4, maxCostUnits: 800, maxWallclockMs: 300_000 },
  };
  const cfg = contract ? contractToLoopConfig(contract, fallback) : { ...fallback, requireHumanApproval: false, version: 1 };

  const built = buildContext({
    worktree: wt,
    seeds: ['test/ai-generated/visible.test.mjs'],
    docs: [{ id: 'goal', content: cfg.goalExcerpt }],
  });
  const agent = adapterAgentPort(adapter, {
    taskId: t.id,
    goalExcerpt: cfg.goalExcerpt,
    acceptanceCriteria: cfg.acceptanceCriteria,
    constraints: t.constraints ?? ['ESM .mjs', 'no dependencies'],
    contextBundle: { pieces: built.pieces, manifestRef: built.manifest.manifestRef },
  });

  // Human Plane up for the whole task so kill/steering are live during the run (§10.2/§10.3)
  let killed = false;
  const approvals = new ApprovalStore(log);
  const steering = new Steering(log);
  const escalations = new EscalationStore(log);
  const { server, token } = await startHumanPlane({
    log, approvals, steering, escalations, tokenFile: join(wt, 'token'),
    onKill: () => { killed = true; quarantineWorktree(wt, log, t.id); },
  }, 0);
  const port = server.address().port;

  const started = Date.now();
  const res = await orch.runTask(
    { taskId: t.id, role: 'implementer', worktree: wt, budget: cfg.budget },
    agent,
    { shouldAbort: () => killed, steering, escalations },
  );

  // approval package through the Human Plane (supervised step)
  let approval = 'n/a';
  // §11.1 frozen: refuse the approval when the contract was amended mid-run
  if (res.finalState === 'REVIEWING' && goalHash && existsSync(GOAL_PATH) && goalContractHash(readFileSync(GOAL_PATH, 'utf8')) !== goalHash) {
    log.append({ ts: Date.now(), taskId: t.id, type: 'GOAL_AMENDED_MID_RUN', principal: 'core',
      payload: { reason: 'goal.yaml changed during the run — amend via a versioned amendment out-of-band' } });
    new StateMachine(log, t.id, 'REVIEWING').transition('ESCALATED', 'core', { reason: 'goal_amended_mid_run' });
    approval = 'escalated: goal_amended_mid_run';
  } else if (res.finalState === 'REVIEWING') {
    const writes = log.eventsFor(t.id).filter((e) => e.type === 'ACTION_INTENT' && e.payload.action?.type === 'WRITE_FILE');
    const diff = writes.map((e) => `+++ ${e.payload.action.path}\n${e.payload.action.content}`).join('\n');
    const created = approvals.create({
      taskId: t.id, riskLevel: cfg.requireHumanApproval ? 'L3' : 'L1', goalExcerpt: cfg.goalExcerpt, diff,
      evidenceRefs: [`events:${t.id}`], assumptions: ['bootstrap calibration'], unresolvedRisks: [],
    });
    if (created.ok) {
      const r = await fetch(`http://127.0.0.1:${port}/approvals/${created.pkg.id}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ verdict: 'approved' }),
      });
      approval = (await r.json()).pkg.status;
    } else {
      approval = `refused: ${created.reason}`;
    }
  }
  server.close();

  const entry = {
    task: t.id,
    finalState: res.finalState,
    iterations: res.iterations,
    flaky: res.flaky,
    goldenPassed: outcomePassed(res.finalState, t.expect), // T1 includes hidden golden; refusal tasks compare to t.expect
    approval,
    wallclockMs: Date.now() - started,
    worktree: wt,
  };
  results.push(entry);
  console.log(JSON.stringify(entry));
}

const passed = results.filter((r) => r.goldenPassed).length;
const n = results.length;
const today = new Date().toISOString().slice(0, 10);
const summary = {
  date: today,
  model: MODEL,
  suite: usingSuite ? 'authored' : 'bootstrap',
  systemNote: usingSuite
    ? `calibration suite — authored tasks + hidden golden; n=${n}${n < 10 ? ' (small n → treat as a wide interval, not a rate)' : ''}`
    : 'bootstrap calibration — operator-delegate authored tasks + hidden golden; n=3 so treat as wide interval, not a rate',
  heldOutPassed: `${passed}/${n}`,
  results,
};
mkdirSync('.ai/calibration', { recursive: true });
const outPath = usingSuite
  ? `.ai/calibration/suite-${MODEL}-${today}.json`
  : `.ai/calibration/bootstrap-${MODEL}-2026-07-04.json`;
writeFileSync(outPath, JSON.stringify(summary, null, 2));
console.log(`CALIBRATION_RECORD=${outPath}`);
console.log(`SUPERVISED LOOP: held-out pass ${passed}/${n} (model=${MODEL}, suite=${summary.suite})`);
// exit 0 whenever a record was produced — the regression gate is compare-calibration.mjs, not this run.
process.exit(n > 0 ? 0 : 1);
