// Gap-fix C2: evidence binding (INV-10), evidence signing (§10.1 T6), golden coverage (§6.5),
// escape rate (§10.1/§12), gate convention leg (§6.4), context metrics (§9.4), event-log export.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  envHash,
  commitHash,
  writeEvidence,
  signEvidence,
  verifyEvidence,
  canonicalJson,
} from '../src/evidence.js';
import { measureGoldenCoverage } from '../src/golden.js';
import { runGate, type GateConfig } from '../src/gates.js';
import { computeEscapeRate } from '../src/auditor.js';
import {
  buildContext,
  buildContextManifest,
  evaluateProposalReferences,
  contextMetrics,
} from '../src/context-builder.js';
import { EventLog } from '../src/event-log.js';

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
function log(): EventLog {
  return new EventLog(join(tmp('gfx-db-'), 'events.db'));
}

describe('evidence binding + canonical JSON (INV-10)', () => {
  it('canonicalJson sorts keys deterministically regardless of insertion order', () => {
    const a = canonicalJson({ b: 1, a: { d: 2, c: 3 } });
    const b = canonicalJson({ a: { c: 3, d: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('envHash is a stable 16-char digest for a fixed environment', () => {
    const h1 = envHash();
    const h2 = envHash();
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
  });

  it('commitHash returns a sha or the explicit unversioned sentinel', () => {
    const nonGit = tmp('gfx-nogit-');
    expect(commitHash(nonGit)).toBe('unversioned');
    // repo root is a git repo — expect a real sha
    const repoRoot = join(__dirname, '..', '..');
    expect(commitHash(repoRoot)).toMatch(/^[0-9a-f]{7,40}$|^unversioned$/);
  });

  it('writeEvidence is content-addressed and write-once (same content = idempotent)', () => {
    const dir = tmp('gfx-ev-');
    const rec = { taskId: 'T-1', gate: 'T1', status: 'pass' };
    const id1 = writeEvidence(dir, rec);
    const id2 = writeEvidence(dir, { status: 'pass', taskId: 'T-1', gate: 'T1' }); // reordered keys
    expect(id1).toBe(id2); // canonical id independent of key order
    expect(existsSync(join(dir, `${id1}.json`))).toBe(true);
  });

  it('writeEvidence throws on id collision with different content (append-only evidence)', () => {
    const dir = tmp('gfx-ev2-');
    const id = writeEvidence(dir, { a: 1 });
    // forge a colliding file with different content
    writeFileSync(join(dir, `${id}.json`), '{"a":2}');
    expect(() => writeEvidence(dir, { a: 1 })).toThrow();
  });
});

describe('evidence signing (§10.1 T6 evidence spoofing)', () => {
  it('signs and verifies with a 0600 key file, creating the key if missing', () => {
    const keyFile = join(tmp('gfx-key-'), 'sub', 'evidence.key');
    const rec = { actionId: 'a1', resultHash: 'deadbeef', exitCode: 0 };
    const sig = signEvidence(rec, keyFile);
    expect(existsSync(keyFile)).toBe(true);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyEvidence(rec, sig, keyFile)).toBe(true);
    // tamper detection
    expect(verifyEvidence({ ...rec, resultHash: 'tampered' }, sig, keyFile)).toBe(false);
  });
});

describe('golden coverage (§6.5 — trust extends only as far as coverage)', () => {
  it('counts an AC covered when a golden file mentions its id', () => {
    const gdir = tmp('gfx-golden-');
    writeFileSync(join(gdir, 'login.golden.txt'), 'scenario for AC-001 valid login\n');
    writeFileSync(join(gdir, 'invalid.golden.txt'), 'AC-002 rejects bad creds\n');
    const cov = measureGoldenCoverage(gdir, ['AC-001', 'AC-002', 'AC-003']);
    expect(cov.coveredAcs.sort()).toEqual(['AC-001', 'AC-002']);
    expect(cov.uncoveredAcs).toEqual(['AC-003']);
    expect(cov.ratio).toBeCloseTo(2 / 3);
  });

  it('reports zero coverage cleanly when no ACs are given', () => {
    const gdir = tmp('gfx-golden2-');
    writeFileSync(join(gdir, 'x.txt'), 'nothing\n');
    const cov = measureGoldenCoverage(gdir, []);
    expect(cov.ratio).toBe(0);
    expect(cov.coveredAcs).toEqual([]);
  });
});

describe('gate evidence binding + convention leg (§6.4)', () => {
  function cfg(worktree: string, extra: Partial<GateConfig> = {}): GateConfig {
    return {
      t0: [{ name: 't0', cmd: 'true', args: [], cwd: worktree }],
      t1: [{ name: 't1', cmd: 'true', args: [], cwd: worktree }],
      flakyRetry: false,
      ...extra,
    };
  }

  it('attaches an explicitly supplied binding to the result', () => {
    const wt = tmp('gfx-gate-');
    const r = runGate('T0', cfg(wt), { commitHash: 'abc123', envHash: 'deadbeefdeadbeef' });
    expect(r.commitHash).toBe('abc123');
    expect(r.envHash).toBe('deadbeefdeadbeef');
  });

  it('computes a binding when none is supplied', () => {
    const wt = tmp('gfx-gate2-');
    const r = runGate('T0', cfg(wt));
    expect(typeof r.commitHash).toBe('string');
    expect(r.envHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('records convention as skipped when no convention command is configured', () => {
    const wt = tmp('gfx-gate3-');
    const r = runGate('T1', cfg(wt));
    expect(r.status).toBe('pass');
    expect(r.convention).toBe('skipped'); // no fake green — skipped is explicit
  });

  it('records convention pass/fail and fails the gate on a failing convention check', () => {
    const wt = tmp('gfx-gate4-');
    const pass = runGate('T1', cfg(wt, { conventionCmd: { name: 'conv', cmd: 'true', args: [], cwd: wt } }));
    expect(pass.convention).toBe('pass');
    expect(pass.status).toBe('pass');
    const fail = runGate('T1', cfg(wt, { conventionCmd: { name: 'conv', cmd: 'false', args: [], cwd: wt } }));
    expect(fail.convention).toBe('fail');
    expect(fail.status).toBe('fail');
  });

  it('includes golden coverage in T1 evidence when goldenDir + ACs are provided', () => {
    const wt = tmp('gfx-gate5-');
    const gdir = join(wt, 'golden');
    mkdirSync(gdir, { recursive: true });
    writeFileSync(join(gdir, 'g.txt'), 'covers AC-001\n');
    const r = runGate('T1', cfg(wt, { goldenDir: gdir, acceptanceCriteria: ['AC-001', 'AC-002'] }));
    expect(r.goldenCoverage?.coveredAcs).toEqual(['AC-001']);
    expect(r.goldenCoverage?.ratio).toBeCloseTo(0.5);
  });
});

describe('escape rate (§10.1 residual / §12 metric)', () => {
  it('rate = escapes / sampled over audit + regression events', () => {
    const l = log();
    const ev = (type: string, taskId: string) =>
      l.append({ ts: Date.now(), taskId, type, principal: 'core', payload: {} });
    ev('AUDIT_REPRODUCED', 'T-1');
    ev('AUDIT_REPRODUCED', 'T-2');
    ev('AUDIT_NON_REPRODUCIBLE', 'T-3');
    ev('REGRESSION_FOUND', 'T-4');
    const r = computeEscapeRate(l);
    expect(r.sampled).toBe(3); // three audited merges
    expect(r.escapes).toBe(2); // one non-reproducible + one regression
    expect(r.rate).toBeCloseTo(2 / 3);
  });

  it('rate is 0 when nothing has been audited', () => {
    const r = computeEscapeRate(log());
    expect(r).toEqual({ sampled: 0, escapes: 0, rate: 0 });
  });
});

describe('context metrics + dependency expansion (§9.4)', () => {
  function seedTree(): string {
    const d = tmp('gfx-cb-');
    mkdirSync(join(d, 'src'), { recursive: true });
    writeFileSync(join(d, 'src', 'a.ts'), "import { b } from './b.js';\nexport const a = b + 1;\n");
    writeFileSync(join(d, 'src', 'b.ts'), "import './c.js';\nexport const b = 2;\n");
    writeFileSync(join(d, 'src', 'c.ts'), 'export const c = 3;\n');
    return d;
  }

  it('EXPAND pulls in direct imports up to the depth budget (default 1)', () => {
    const d = seedTree();
    const bundle = buildContext({ worktree: d, seeds: ['src/a.ts'], docs: [] });
    const manifest = buildContextManifest(bundle);
    expect(manifest).toContain('src/a.ts'); // seed
    expect(manifest).toContain('src/b.ts'); // depth 1 — included
    expect(manifest).not.toContain('src/c.ts'); // depth 2 — beyond default budget
  });

  it('respects the total byte budget across the expanded bundle', () => {
    const d = seedTree();
    const seedBytes = readFileSync(join(d, 'src', 'a.ts')).length;
    const bundle = buildContext({ worktree: d, seeds: ['src/a.ts'], docs: [], totalByteBudget: seedBytes });
    const manifest = buildContextManifest(bundle);
    expect(manifest).toContain('src/a.ts');
    expect(manifest).not.toContain('src/b.ts'); // budget exhausted by the seed
  });

  it('evaluateProposalReferences rejects references outside manifest + requested (reject-unrequested)', () => {
    const manifest = ['src/a.ts'];
    const requested = ['src/req.ts'];
    const ok = evaluateProposalReferences('touch src/a.ts and src/req.ts', manifest, requested);
    expect(ok.ok).toBe(true);
    const bad = evaluateProposalReferences('also edit src/evil.ts here', manifest, requested);
    expect(bad.ok).toBe(false);
    expect(bad.violations).toContain('src/evil.ts');
  });

  it('contextMetrics reports misses, recall and waste', () => {
    const d = seedTree();
    const bundle = buildContext({ worktree: d, seeds: ['src/a.ts'], docs: [] });
    // proposal references only src/a.ts — src/b.ts bytes are wasted
    const m = contextMetrics(bundle, ['src/gone.ts'], 'work happens in src/a.ts');
    expect(m.misses).toBe(1); // src/gone.ts requested but not in manifest
    expect(m.recall).toBeGreaterThan(0);
    expect(m.recall).toBeLessThan(1);
    expect(m.waste).toBeGreaterThan(0); // src/b.ts included but never referenced
    expect(m.waste).toBeLessThanOrEqual(1);
  });
});

describe('event log JSONL export (§6.2 audit trail)', () => {
  it('exports every event as one JSONL line (roundtrip count)', () => {
    const l = log();
    for (let i = 0; i < 5; i++) {
      l.append({ ts: Date.now(), taskId: `T-${i}`, type: 'X', principal: 'core', payload: { i } });
    }
    const out = join(tmp('gfx-jsonl-'), 'events.jsonl');
    const n = l.exportJsonl(out);
    const lines = readFileSync(out, 'utf8').trim().split('\n');
    expect(n).toBe(5);
    expect(lines).toHaveLength(5);
    expect(JSON.parse(lines[0]!).type).toBe('X');
  });
});
