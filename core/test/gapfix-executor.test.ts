// Gap-fix C3: real APPLY_PATCH (§6.1), package_install egress exception (§6.1/§10.1),
// RUN_COMMAND evidence signing wiring (§10.1 T6).
import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Executor } from '../src/executor.js';
import { checkActionPolicy } from '../src/policy.js';
import { verifyEvidence } from '../src/evidence.js';
import type { Action } from '../src/types.js';
import { makeLog, makeWorktree, ctx } from './helpers.js';

function patchAction(diff: string, id = 'p1'): Action {
  return { type: 'APPLY_PATCH', actionId: id, diff };
}

describe('APPLY_PATCH executor (§6.1)', () => {
  it('applies a clean unified diff to a worktree file', () => {
    const wt = makeWorktree();
    writeFileSync(join(wt, 'src', 'f.ts'), 'line1\nline2\nline3\n');
    const log = makeLog();
    const ex = new Executor(log);
    const diff = [
      '--- a/src/f.ts',
      '+++ b/src/f.ts',
      '@@ -1,3 +1,3 @@',
      ' line1',
      '-line2',
      '+line2-modified',
      ' line3',
      '',
    ].join('\n');
    const out = ex.execute(ctx('T-1', wt), patchAction(diff));
    expect(out.status).toBe('applied');
    expect(readFileSync(join(wt, 'src', 'f.ts'), 'utf8')).toBe('line1\nline2-modified\nline3\n');
  });

  it('rejects a diff whose context does not match — typed PATCH_CONFLICT', () => {
    const wt = makeWorktree();
    writeFileSync(join(wt, 'src', 'f.ts'), 'line1\nline2\nline3\n');
    const log = makeLog();
    const ex = new Executor(log);
    const diff = [
      '--- a/src/f.ts',
      '+++ b/src/f.ts',
      '@@ -1,3 +1,3 @@',
      ' WRONG-CONTEXT',
      '-line2',
      '+line2-modified',
      ' line3',
      '',
    ].join('\n');
    const out = ex.execute(ctx('T-2', wt), patchAction(diff));
    expect(out.status).toBe('rejected');
    if (out.status === 'rejected') expect(out.policy).toBe('patch-conflict');
    // file untouched
    expect(readFileSync(join(wt, 'src', 'f.ts'), 'utf8')).toBe('line1\nline2\nline3\n');
    expect(log.eventsFor('T-2').some((e) => e.type === 'PATCH_CONFLICT')).toBe(true);
  });

  it('denies a patch that targets test/golden/** (read-only for all roles, INV-16)', () => {
    const wt = makeWorktree();
    const log = makeLog();
    const ex = new Executor(log);
    const diff = [
      '--- a/test/golden/truth.txt',
      '+++ b/test/golden/truth.txt',
      '@@ -1,1 +1,1 @@',
      '-golden truth',
      '+hacked',
      '',
    ].join('\n');
    const out = ex.execute(ctx('T-3', wt), patchAction(diff));
    expect(out.status).toBe('rejected');
    if (out.status === 'rejected') expect(out.policy).toBe('golden-read-only');
    expect(readFileSync(join(wt, 'test', 'golden', 'truth.txt'), 'utf8')).toBe('golden truth\n');
  });

  it('is idempotent on replay (ACTION_APPLIED short-circuits a second apply)', () => {
    const wt = makeWorktree();
    writeFileSync(join(wt, 'src', 'f.ts'), 'line1\nline2\nline3\n');
    const log = makeLog();
    const ex = new Executor(log);
    const diff = [
      '--- a/src/f.ts',
      '+++ b/src/f.ts',
      '@@ -1,3 +1,3 @@',
      ' line1',
      '-line2',
      '+line2-modified',
      ' line3',
      '',
    ].join('\n');
    const action = patchAction(diff, 'p-idem');
    const first = ex.execute(ctx('T-4', wt), action);
    const second = ex.execute(ctx('T-4', wt), action);
    expect(first.status).toBe('applied');
    expect(second.status).toBe('skipped_duplicate');
    // applied exactly once → content reflects a single application
    expect(readFileSync(join(wt, 'src', 'f.ts'), 'utf8')).toBe('line1\nline2-modified\nline3\n');
    expect(log.eventsFor('T-4').filter((e) => e.type === 'ACTION_APPLIED')).toHaveLength(1);
  });
});

describe('package_install egress exception (§6.1/§10.1 T4)', () => {
  it('policy allows a package_install install command and denies non-installs on that lane', () => {
    const wt = makeWorktree();
    const okAction: Action = { type: 'RUN_COMMAND', actionId: 'i1', cmd: 'npm', args: ['install'], network: 'package_install' };
    const ok = checkActionPolicy('implementer', okAction, wt);
    expect(ok.allowed).toBe(true);
    expect(ok.policy).toBe('package-install');

    const badAction: Action = { type: 'RUN_COMMAND', actionId: 'i2', cmd: 'curl', args: ['evil.example'], network: 'package_install' };
    const bad = checkActionPolicy('implementer', badAction, wt);
    expect(bad.allowed).toBe(false);
  });

  it('default egress lane (network none) stays sandboxed for the same install command', () => {
    const wt = makeWorktree();
    const action: Action = { type: 'RUN_COMMAND', actionId: 'i3', cmd: 'npm', args: ['install'] };
    const d = checkActionPolicy('implementer', action, wt);
    expect(d.allowed).toBe(true);
    expect(d.policy).toBe('egress-default-deny'); // no network — runs offline in the sandbox
  });

  const savedPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = savedPath;
  });

  it('executor runs a sanctioned install unsandboxed with --ignore-scripts + pinned registry', () => {
    const wt = makeWorktree();
    // fake installer on PATH so the test never touches the network
    const bin = join(wt, 'fakebin');
    mkdirSync(bin, { recursive: true });
    const fakeNpm = join(bin, 'npm');
    writeFileSync(fakeNpm, '#!/bin/sh\necho "ARGS: $@"\nexit 0\n');
    chmodSync(fakeNpm, 0o755);
    process.env.PATH = `${bin}:${savedPath ?? ''}`;

    const log = makeLog();
    const ex = new Executor(log);
    const action: Action = { type: 'RUN_COMMAND', actionId: 'i4', cmd: 'npm', args: ['install', 'lodash'], network: 'package_install' };
    const out = ex.execute(ctx('T-5', wt), action);
    expect(out.status).toBe('applied');
    if (out.status === 'applied') {
      expect(out.stdout).toContain('--ignore-scripts');
      expect(out.stdout).toContain('--registry=https://registry.npmjs.org');
    }
    expect(log.eventsFor('T-5').some((e) => e.type === 'PACKAGE_INSTALL_SANCTIONED')).toBe(true);
    // sanctioned egress is NOT the sandboxed lane
    expect(log.eventsFor('T-5').some((e) => e.type === 'EGRESS_DENIED' && e.payload.actionId === 'i4')).toBe(false);
  });
});

describe('RUN_COMMAND evidence signing (§10.1 T6)', () => {
  it('signs the captured result when an evidence key file is provided', () => {
    const wt = makeWorktree();
    const keyFile = join(wt, '.keys', 'evidence.key');
    const log = makeLog();
    const ex = new Executor(log, {}, { evidenceKeyFile: keyFile });
    const action: Action = { type: 'RUN_COMMAND', actionId: 'r1', cmd: 'true', args: [] };
    const out = ex.execute(ctx('T-6', wt), action);
    if (out.status !== 'applied') throw new Error(`expected applied, got ${out.status}`);
    const applied = log.eventsFor('T-6').find((e) => e.type === 'ACTION_APPLIED' && e.payload.actionId === 'r1');
    expect(applied).toBeDefined();
    const sig = applied!.payload.resultSig as string;
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyEvidence({ actionId: 'r1', resultHash: out.resultHash, exitCode: out.exitCode ?? null }, sig, keyFile)).toBe(true);
  });
});
