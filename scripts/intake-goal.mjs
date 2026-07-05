#!/usr/bin/env node
// intake-goal.mjs (§11.1/§11.2, Phase 4 "issue intake"): read a Goal Contract, validate it,
// and emit a task-graph skeleton (one task per acceptance criterion, ac -> task traceability),
// then print the planning-gate result. Deterministic, no model calls.
// Usage: node scripts/intake-goal.mjs [path-to-goal.yaml]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseGoalContract, validateGoalContract, checkPlanningGate } from '../core/dist/index.js';

const argPath = process.argv[2];
const path =
  argPath ??
  (existsSync('.ai/goal.yaml') ? '.ai/goal.yaml' : '.ai/goal.yaml.example');

if (!existsSync(path)) {
  console.error(`no goal contract at ${path} (create .ai/goal.yaml or copy .ai/goal.yaml.example)`);
  process.exit(1);
}

const contract = parseGoalContract(readFileSync(path, 'utf8'));
const validation = validateGoalContract(contract);
if (!validation.ok) {
  console.error(`invalid goal contract (${path}) — missing: ${validation.missing.join(', ')}`);
  process.exit(1);
}

const goalId = contract.goal.id;
const acs = contract.acceptance_criteria;

// skeleton: exactly one task per acceptance criterion, each tracing back to its AC
const tasks = acs.map((ac, i) => ({
  taskId: `${goalId}-T${String(i + 1).padStart(2, '0')}`,
  mapsToAc: [ac.id],
  verification: ac.verification ?? null,
  estimatedDiffBytes: 100,
  status: 'PENDING',
}));

const taskGraph = {
  goalId,
  goalTitle: contract.goal.title ?? null,
  version: contract.version ?? 1,
  generatedAt: new Date().toISOString(),
  source: path,
  traceability: Object.fromEntries(acs.map((ac, i) => [ac.id, tasks[i].taskId])),
  tasks,
};

const outDir = join('.ai', 'runs', goalId);
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'task-graph.json');
writeFileSync(outFile, JSON.stringify(taskGraph, null, 2));

// planning gate (§11.2): every AC covered, no orphan tasks, every task under diff budget
const gate = checkPlanningGate(
  { acceptanceCriteria: acs.map((ac) => ({ id: ac.id })) },
  tasks.map((t) => ({ taskId: t.taskId, mapsToAc: t.mapsToAc, estimatedDiffBytes: t.estimatedDiffBytes })),
);

console.log(`intake: ${goalId} — ${tasks.length} task(s) from ${acs.length} acceptance criteria`);
console.log(`task graph: ${outFile}`);
console.log(`planning gate (§11.2): ${JSON.stringify(gate)}`);
process.exit(gate.ok ? 0 : 1);
