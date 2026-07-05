#!/usr/bin/env node
// Phase 2 DoD: L0/L1 auto-merge path with sampling audit — no human in the loop,
// COMPLETED only after core reproduces gates on the frozen artifact (INV-2).
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EventLog, Executor, Orchestrator, StateMachine, buildContext, writeGoldenManifest,
  decideMerge, runGate, ApprovalStore, startHumanPlane, Steering, EscalationStore, quarantineWorktree,
  parseGoalContract, validateGoalContract, contractToLoopConfig, goalContractHash,
} from '../core/dist/index.js';
import { adapterAgentPort } from '../aal/dist/index.js';
import { AnthropicAdapter } from '../adapters/dist/index.js';

for (const k of Object.keys(process.env)) {
  if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDECODE|CLAUDE_)/.test(k)) delete process.env[k];
}

const wt = mkdtempSync(join(tmpdir(), 'semiauto-'));
mkdirSync(join(wt, 'src'), { recursive: true });
mkdirSync(join(wt, 'test', 'ai-generated'), { recursive: true });
mkdirSync(join(wt, 'test', 'golden'), { recursive: true });
writeFileSync(join(wt, 'test', 'ai-generated', 'visible.test.mjs'),
  `import { clamp } from '../../src/clamp.mjs';\nimport test from 'node:test';\nimport assert from 'node:assert';\ntest('clamp', () => assert.equal(clamp(5, 0, 3), 3));\n`);
writeFileSync(join(wt, 'test', 'golden', 'golden.test.mjs'),
  `import { clamp } from '../../src/clamp.mjs';\nimport test from 'node:test';\nimport assert from 'node:assert';\ntest('golden clamp', () => { assert.equal(clamp(-1, 0, 3), 0); assert.equal(clamp(2, 0, 3), 2); assert.equal(clamp(0, 0, 0), 0); });\n`);
writeGoldenManifest(join(wt, 'test', 'golden'));

const log = new EventLog(join(wt, 'events.db'));
const executor = new Executor(log);
const gates = {
  t0: [{ name: 'visible', cmd: 'node', args: ['--test', 'test/ai-generated/**/*.test.mjs'], cwd: wt }],
  t1: [
    { name: 'visible', cmd: 'node', args: ['--test', 'test/ai-generated/**/*.test.mjs'], cwd: wt },
    { name: 'golden', cmd: 'node', args: ['--test', 'test/golden/**/*.test.mjs'], cwd: wt },
  ],
  goldenDir: join(wt, 'test', 'golden'),
  flakyRetry: true,
};
const orch = new Orchestrator(log, executor, gates);
const goal = 'Create src/clamp.mjs exporting clamp(x, lo, hi) constraining x into [lo, hi].';

// §11.1 Goal Contract: drive goal/AC/budget/approval from .ai/goal.yaml when present, else fallback
const GOAL_PATH = '.ai/goal.yaml';
const fallback = {
  goalExcerpt: goal,
  acceptanceCriteria: ['visible tests pass'],
  budget: { maxIterations: 4, maxCostUnits: 800, maxWallclockMs: 300_000 },
};
let goalHash = null;
let cfg = { ...fallback, requireHumanApproval: false, version: 1 };
if (existsSync(GOAL_PATH)) {
  const raw = readFileSync(GOAL_PATH, 'utf8');
  goalHash = goalContractHash(raw);
  const parsed = parseGoalContract(raw);
  const v = validateGoalContract(parsed);
  if (!v.ok) { console.error('invalid .ai/goal.yaml — missing:', v.missing.join(', ')); process.exit(1); }
  cfg = contractToLoopConfig(parsed, fallback);
  console.log(`goal contract v${cfg.version}: ${cfg.goalExcerpt}`);
}

const built = buildContext({ worktree: wt, seeds: ['test/ai-generated/visible.test.mjs'], docs: [{ id: 'goal', content: cfg.goalExcerpt }] });
const adapter = new AnthropicAdapter({ model: 'haiku' });
const agent = adapterAgentPort(adapter, {
  taskId: 'SEMI-1', goalExcerpt: cfg.goalExcerpt,
  acceptanceCriteria: cfg.acceptanceCriteria, constraints: ['ESM .mjs', 'no dependencies'],
  contextBundle: { pieces: built.pieces, manifestRef: built.manifest.manifestRef },
});

// Human Plane up during the run so kill/steering are live (§10.2/§10.3)
let killed = false;
const approvals = new ApprovalStore(log);
const steering = new Steering(log);
const escalations = new EscalationStore(log);
const { server } = await startHumanPlane({
  log, approvals, steering, escalations, tokenFile: join(wt, 'token'),
  onKill: () => { killed = true; quarantineWorktree(wt, log, 'SEMI-1'); },
}, 0);

const res = await orch.runTask(
  { taskId: 'SEMI-1', role: 'implementer', worktree: wt, budget: cfg.budget },
  agent,
  { shouldAbort: () => killed, steering, escalations },
);
server.close();
console.log('loop:', res.finalState, 'iterations:', res.iterations);
if (res.finalState !== 'REVIEWING') process.exit(1);

// §11.1 frozen: refuse to complete when the contract was amended mid-run
if (goalHash && existsSync(GOAL_PATH) && goalContractHash(readFileSync(GOAL_PATH, 'utf8')) !== goalHash) {
  log.append({ ts: Date.now(), taskId: 'SEMI-1', type: 'GOAL_AMENDED_MID_RUN', principal: 'core',
    payload: { reason: 'goal.yaml changed during the run — amend via a versioned amendment out-of-band' } });
  new StateMachine(log, 'SEMI-1', 'REVIEWING').transition('ESCALATED', 'core', { reason: 'goal_amended_mid_run' });
  console.log('goal amended mid-run — ESCALATED, not completing');
  process.exit(1);
}

// approval_policy (§10.3): contract may require human approval; otherwise L1 auto-merge with sampling
const riskLevel = cfg.requireHumanApproval ? 'L3' : 'L1';
const decision = decideMerge(log, 'SEMI-1', riskLevel, true, { auditSampleRate: 0.2, rng: () => 0.05 });
console.log('merge decision:', JSON.stringify(decision));
if (decision.action === 'needs-human') {
  console.log('contract approval_policy requires human approval — not auto-completing (§10.3)');
  process.exit(0);
}
if (decision.action !== 'auto-merge') process.exit(1);

// walk the machine: REVIEWING -> APPROVED (core, auto for L1) -> MERGE_QUEUED -> AUDITED -> COMPLETED
// reproduce on the frozen artifact before COMPLETED (INV-2): rerun T1 from clean state
const sm = new StateMachine(log, 'SEMI-1', 'REVIEWING');
sm.transition('APPROVED', 'core', { auto: true, risk: riskLevel });
sm.transition('MERGE_QUEUED', 'core');
const reproduce = runGate('T1', gates);
if (reproduce.status !== 'pass') {
  console.log('reproduce failed — no COMPLETED');
  process.exit(1);
}
sm.transition('AUDITED', 'core', { sampledForAudit: decision.sampledForAudit, reproduceHash: reproduce.gateConfigHash });
sm.transition('COMPLETED', 'core', { reproducedOnFrozenArtifact: true });
console.log('final state:', sm.state, '| sampledForAudit:', decision.sampledForAudit);

const kinds = log.eventsFor('SEMI-1').map((e) => e.type);
console.log('has MERGE_DECISION:', kinds.includes('MERGE_DECISION'));
process.exit(sm.state === 'COMPLETED' ? 0 : 1);
