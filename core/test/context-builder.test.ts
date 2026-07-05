// Context Builder (§9.4): govern blocks secrets, machine config never enters, manifest is deterministic.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildContext } from '../src/context-builder.js';

function wt(): string {
  const d = mkdtempSync(join(tmpdir(), 'cb-'));
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'src/ok.ts'), 'export const x = 1;\n');
  writeFileSync(join(d, 'src/leaky.ts'), 'const key = "sk-abcdefghijklmnop1234";\n');
  writeFileSync(join(d, '.env'), 'DB_PASSWORD=hunter2\n');
  return d;
}

describe('context builder (§9.4)', () => {
  it('includes clean files, blocks secret-bearing files entirely (block ≠ redact, INV-14)', () => {
    const b = buildContext({ worktree: wt(), seeds: ['src/ok.ts', 'src/leaky.ts'], docs: [] });
    expect(b.pieces.some((p) => p.id === 'file:src/ok.ts')).toBe(true);
    expect(b.pieces.some((p) => p.id === 'file:src/leaky.ts')).toBe(false);
    expect(b.manifest.blocked.some((x) => x.path === 'src/leaky.ts' && /secret/.test(x.reason))).toBe(true);
    expect(JSON.stringify(b.pieces)).not.toContain('sk-abcdefghijklmnop1234');
  });

  it('bars machine/agent config from the pipeline (§5.2.3)', () => {
    const d = wt();
    writeFileSync(join(d, 'AGENT_MEMORY.md'), 'machine memory\n');
    const b = buildContext({
      worktree: d,
      seeds: ['.env', 'AGENT_MEMORY.md'],
      docs: [],
      agentConfigFiles: ['AGENT_MEMORY.md'], // vendor names injected by outer rings (INV-7)
    });
    expect(b.pieces.filter((p) => p.kind === 'file')).toHaveLength(0);
    expect(b.manifest.blocked).toHaveLength(2);
  });

  it('blocks path escapes and emits deterministic manifest with hashes', () => {
    const d = wt();
    const b1 = buildContext({ worktree: d, seeds: ['../etc/passwd', 'src/ok.ts'], docs: [{ id: 'goal', content: 'do x' }] });
    const b2 = buildContext({ worktree: d, seeds: ['../etc/passwd', 'src/ok.ts'], docs: [{ id: 'goal', content: 'do x' }] });
    expect(b1.manifest.blocked[0]!.reason).toBe('outside worktree');
    expect(b1.manifest.manifestRef).toBe(b2.manifest.manifestRef);
    expect(b1.manifest.entries.every((e) => e.sha256.length === 64)).toBe(true);
  });

  it('always appends the injection canary guidance piece', () => {
    const b = buildContext({ worktree: wt(), seeds: [], docs: [] });
    expect(b.pieces.at(-1)?.id).toBe('canary');
  });
});
