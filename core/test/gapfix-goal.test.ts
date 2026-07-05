// Goal Contract → loop wiring (§11.1): parse/validate the example contract, map it to loop
// parameters (budget/AC/goal/approval), fall back when fields are absent, and detect a frozen
// contract amended mid-run via its content hash. Vendor-neutral (INV-7).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseGoalContract, validateGoalContract } from '../src/goal-contract.js';
import { contractToLoopConfig, goalContractHash } from '../src/goal-loop.js';
import type { Budget } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const examplePath = join(here, '..', '..', '.ai', 'goal.yaml.example');
const exampleRaw = readFileSync(examplePath, 'utf8');

const fallbackBudget: Budget = { maxIterations: 4, maxCostUnits: 800, maxWallclockMs: 300_000 };
const fallback = { goalExcerpt: 'FALLBACK GOAL', acceptanceCriteria: ['fallback AC'], budget: fallbackBudget };

describe('goal contract → loop config (§11.1)', () => {
  it('parses and validates the shipped example contract', () => {
    const c = parseGoalContract(exampleRaw);
    expect(validateGoalContract(c).ok).toBe(true);
    expect(c.version).toBe(1);
    expect(c.acceptance_criteria).toHaveLength(3);
  });

  it('maps the contract onto budget, ACs, goal excerpt, and approval policy', () => {
    const cfg = contractToLoopConfig(parseGoalContract(exampleRaw), fallback);
    expect(cfg.budget.maxIterations).toBe(8);
    expect(cfg.budget.maxCostUnits).toBe(500);
    expect(cfg.budget.maxWallclockMs).toBe(30 * 60_000);
    expect(cfg.acceptanceCriteria).toEqual([
      'Valid users can log in',
      'Invalid credentials return 401',
      'E2E auth scenarios pass',
    ]);
    expect(cfg.goalExcerpt).toBe('Email/password auth for web+API');
    expect(cfg.requireHumanApproval).toBe(true); // approval_policy lists categories
    expect(cfg.version).toBe(1);
  });

  it('falls back for every field a contract omits', () => {
    const cfg = contractToLoopConfig({}, fallback);
    expect(cfg.budget).toEqual(fallbackBudget);
    expect(cfg.acceptanceCriteria).toEqual(['fallback AC']);
    expect(cfg.goalExcerpt).toBe('FALLBACK GOAL');
    expect(cfg.requireHumanApproval).toBe(false);
    expect(cfg.version).toBe(1);
  });

  it('hash is stable and changes when the contract text is amended (frozen detection)', () => {
    const h1 = goalContractHash(exampleRaw);
    expect(goalContractHash(exampleRaw)).toBe(h1); // deterministic
    const amended = exampleRaw.replace('version: 1', 'version: 2');
    expect(goalContractHash(amended)).not.toBe(h1); // mid-run edit is detectable
  });
});
