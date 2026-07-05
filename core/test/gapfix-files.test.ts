// Gap-fix files (§11 contracts/templates, §12 systemVersion, §14 tree, Phase 4 intake/lessons).
// Verifies the parser, the shipped .ai/ artifacts, systemVersion hashing, and lessons persistence.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseGoalContract, parseYaml, validateGoalContract } from '../src/goal-contract.js';
import { computeSystemVersion } from '../src/system-version.js';
import { LessonStore, loadLessons } from '../src/lessons.js';
import { checkPlanningGate } from '../src/planning-gate.js';
import { runHypothesisProbes } from '../src/repair.js';
import { makeLog, makeWorktree } from './helpers.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const ai = (p: string) => join(repoRoot, '.ai', p);
const scripts = (p: string) => join(repoRoot, 'scripts', p);

// ---- minimal hand-rolled JSON-Schema validator (required keys + typeof) — no new deps ----
interface JsonSchema {
  type?: string;
  required?: string[];
  properties?: Record<string, { type?: string }>;
}
function typeMatches(v: unknown, t: string): boolean {
  switch (t) {
    case 'object': return typeof v === 'object' && v !== null && !Array.isArray(v);
    case 'array': return Array.isArray(v);
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number';
    case 'integer': return typeof v === 'number' && Number.isInteger(v);
    case 'boolean': return typeof v === 'boolean';
    default: return true;
  }
}
function loadSchema(name: string): JsonSchema {
  return JSON.parse(readFileSync(ai(`schemas/${name}.schema.json`), 'utf8')) as JsonSchema;
}
function validateAgainst(schema: JsonSchema, obj: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const k of schema.required ?? []) if (!(k in obj)) errors.push(`missing:${k}`);
  const props = schema.properties ?? {};
  for (const [k, v] of Object.entries(obj)) {
    const p = props[k];
    if (p?.type && !typeMatches(v, p.type)) errors.push(`type:${k}`);
  }
  return errors;
}

describe('goal contract parser (§11.1)', () => {
  const text = readFileSync(ai('goal.yaml.example'), 'utf8');

  it('parses the shipped example into the §11.1 shape', () => {
    const c = parseGoalContract(text);
    expect(c.goal?.id).toBeTruthy();
    expect(c.goal?.title).toBeTruthy();
    expect(Array.isArray(c.acceptance_criteria)).toBe(true);
    expect(c.acceptance_criteria!.length).toBeGreaterThan(0);
    // list-of-maps parsing: each AC carries an id
    expect(c.acceptance_criteria!.every((a) => typeof a.id === 'string')).toBe(true);
    // nested maps + string lists
    expect(c.scope?.include?.length).toBeGreaterThan(0);
    expect(c.approval_policy?.require_human_approval?.length).toBeGreaterThan(0);
    expect(typeof c.budget?.max_iterations_per_task).toBe('number');
  });

  it('validates the shipped example as complete', () => {
    const r = validateGoalContract(parseGoalContract(text));
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it('lists every missing required field', () => {
    const r = validateGoalContract(parseGoalContract('business_outcomes:\n  - x\n'));
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(
      expect.arrayContaining(['goal.id', 'goal.title', 'acceptance_criteria', 'budget', 'approval_policy']),
    );
  });

  it('feeds checkPlanningGate one-task-per-AC without orphans', () => {
    const c = parseGoalContract(text);
    const tasks = c.acceptance_criteria!.map((a) => ({ taskId: `T-${a.id}`, mapsToAc: [a.id], estimatedDiffBytes: 100 }));
    const gate = checkPlanningGate({ acceptanceCriteria: c.acceptance_criteria!.map((a) => ({ id: a.id })) }, tasks);
    expect(gate.ok).toBe(true);
  });
});

describe('structured I/O schemas (§11.3)', () => {
  const names = [
    'plan', 'task-result', 'review', 'failure', 'hypothesis', 'deliberation-analysis', 'approval-package',
  ];
  const samples: Record<string, Record<string, unknown>> = {
    plan: { planId: 'PLAN-1', goalId: 'G-1', tasks: [{ taskId: 'T-1', mapsToAc: ['AC-1'], estimatedDiffBytes: 100 }] },
    'task-result': { claim: 'GREEN', note: 'implemented', actions: [] },
    review: { verdict: 'approve', reason: 'gates green, two lineages agree', findings: [] },
    failure: { detail: 'gate command failed: t1', tier: 'T1', flaky: false },
    hypothesis: { statement: 'off-by-one in loop bound', probes: [{ cmd: 'node', args: ['--test'], expectExitCode: 0 }], ifConfirmed: { patchPlan: 'clamp index', estimatedBlastRadius: 'one function' } },
    'deliberation-analysis': { evidence: [{ panelIndex: 0, gatePassed: true, detail: 'ok' }], dissent: [], costMultiplier: 3 },
    'approval-package': { id: 'apr-1', taskId: 'T-1', riskLevel: 'L1', goalExcerpt: 'auth', diff: '+++ a', evidenceRefs: [], assumptions: [], unresolvedRisks: [], status: 'pending' },
  };

  it('all seven schema files exist, parse, and accept a matching sample', () => {
    for (const n of names) {
      const schema = loadSchema(n);
      expect(schema.type).toBe('object');
      expect(Array.isArray(schema.required)).toBe(true);
      expect(validateAgainst(schema, samples[n]!)).toEqual([]);
    }
  });

  it('rejects a sample missing a required field', () => {
    for (const n of names) {
      const schema = loadSchema(n);
      const req = schema.required![0]!;
      const broken = { ...samples[n]! };
      delete broken[req];
      expect(validateAgainst(schema, broken)).toContain(`missing:${req}`);
    }
  });
});

describe('policy files (§14)', () => {
  it('gate-ladder.yaml parses and covers T0..T3', () => {
    interface Tier { tier: string; enabled: boolean }
    const g = parseYaml(readFileSync(ai('policies/gate-ladder.yaml'), 'utf8')) as unknown as { tiers: Tier[] };
    const tiers = g.tiers.map((t) => t.tier);
    expect(tiers).toEqual(expect.arrayContaining(['T0', 'T1', 'T2', 'T3']));
    // mirrors gates.ts: T0/T1 enabled, T2/T3 not enabled in this phase
    const byTier = Object.fromEntries(g.tiers.map((t) => [t.tier, t.enabled]));
    expect(byTier.T0).toBe(true);
    expect(byTier.T1).toBe(true);
    expect(byTier.T2).toBe(false);
    expect(byTier.T3).toBe(false);
  });

  it('models.yaml.example maps roles to capability profiles (no model ids in core)', () => {
    interface RoleEntry { role: string; requires?: unknown }
    const m = parseYaml(readFileSync(ai('policies/models.yaml.example'), 'utf8')) as unknown as { roles: RoleEntry[] };
    expect(Array.isArray(m.roles)).toBe(true);
    expect(m.roles.length).toBeGreaterThan(0);
    expect(m.roles.every((r) => typeof r.role === 'string' && Boolean(r.requires))).toBe(true);
  });
});

describe('systemVersion (§12)', () => {
  function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), 'sysver-'));
    mkdirSync(join(root, 'core', 'src'), { recursive: true });
    mkdirSync(join(root, '.ai', 'policies'), { recursive: true });
    writeFileSync(join(root, 'core', 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, '.ai', 'policies', 'p.yaml'), 'x: 1\n');
    return root;
  }

  it('is a 16-char hex string', () => {
    expect(computeSystemVersion(fixture())).toMatch(/^[0-9a-f]{16}$/);
  });

  it('changes when a policy file changes', () => {
    const root = fixture();
    const v1 = computeSystemVersion(root);
    writeFileSync(join(root, '.ai', 'policies', 'p.yaml'), 'x: 2\n');
    expect(computeSystemVersion(root)).not.toBe(v1);
  });

  it('ignores files outside core/src and .ai/policies', () => {
    const root = fixture();
    const v1 = computeSystemVersion(root);
    writeFileSync(join(root, 'core', 'src', 'note.md'), 'not a ts file\n');
    writeFileSync(join(root, 'unrelated.txt'), 'irrelevant\n');
    expect(computeSystemVersion(root)).toBe(v1);
  });
});

describe('lessons persistence (§14 lessons/, Phase 4)', () => {
  function confirmedStore(dir: string) {
    const log = makeLog();
    const store = new LessonStore(log, dir);
    const wt = makeWorktree();
    runHypothesisProbes(log, 'T-lesson', wt, [
      { statement: 'true passes', probes: [{ cmd: 'true', args: [], expectExitCode: 0 }], ifConfirmed: { patchPlan: 'p', estimatedBlastRadius: 'r' } },
    ]);
    return { log, store };
  }

  it('persists an approved lesson and reloads it as marked data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lessons-'));
    const { store } = confirmedStore(dir);
    const proposed = store.proposeFromHypothesis('T-lesson', 'true passes', 'prefer smaller diffs');
    expect(proposed.ok).toBe(true);
    expect(readdirSync(dir).filter((f) => f.endsWith('.json'))).toHaveLength(0); // not yet approved
    store.approve(proposed.id!);
    expect(readdirSync(dir).filter((f) => f.endsWith('.json'))).toHaveLength(1);

    const reloaded = loadLessons(dir);
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]!.kind).toBe('guidance');
    expect(reloaded[0]!.content).toMatch(/data, advisory, human-approved/);
  });

  it('survives restart: a fresh store on the same dir injects approved lessons', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lessons-'));
    const { store } = confirmedStore(dir);
    const proposed = store.proposeFromHypothesis('T-lesson', 'true passes', 'keep tasks small');
    store.approve(proposed.id!);

    const fresh = new LessonStore(makeLog(), dir);
    expect(fresh.injectable()).toHaveLength(1);
  });
});

describe('scripts (§14)', () => {
  it('create-worktree.sh creates a branch+dir and rollback cleans it', () => {
    const repo = mkdtempSync(join(tmpdir(), 'wt-repo-'));
    const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: repo, encoding: 'utf8' });
    run('git', ['init', '-q']);
    run('git', ['config', 'user.email', 'test@example.com']);
    run('git', ['config', 'user.name', 'test']);
    writeFileSync(join(repo, 'README'), 'seed\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-qm', 'seed']);

    const out = run('sh', [scripts('create-worktree.sh'), 'demo-1']).trim();
    expect(existsSync(join(repo, 'worktrees', 'demo-1'))).toBe(true);
    expect(out).toContain('worktrees/demo-1');
    const branches = run('git', ['branch', '--list', 'task/demo-1']);
    expect(branches).toContain('task/demo-1');

    // dirty the worktree, then roll it back
    writeFileSync(join(repo, 'worktrees', 'demo-1', 'scratch.txt'), 'dirty\n');
    run('sh', [scripts('rollback-worktree.sh'), join(repo, 'worktrees', 'demo-1')]);
    expect(existsSync(join(repo, 'worktrees', 'demo-1', 'scratch.txt'))).toBe(false);
  });

  it('refuses to recreate an existing worktree', () => {
    const repo = mkdtempSync(join(tmpdir(), 'wt-repo-'));
    const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: repo, encoding: 'utf8' });
    run('git', ['init', '-q']);
    run('git', ['config', 'user.email', 'test@example.com']);
    run('git', ['config', 'user.name', 'test']);
    writeFileSync(join(repo, 'README'), 'seed\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-qm', 'seed']);
    run('sh', [scripts('create-worktree.sh'), 'dup']);
    expect(() => run('sh', [scripts('create-worktree.sh'), 'dup'])).toThrow();
  });
});
