// Golden harness (§6.5): human-written truth base, hash-enforced, read-only to all agents.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface GoldenCheck {
  ok: boolean;
  detail: string;
}

const MANIFEST = '_MANIFEST.sha256';

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (name !== MANIFEST) yield p;
  }
}

function computeLines(goldenDir: string): string[] {
  const lines: string[] = [];
  for (const f of walk(goldenDir)) {
    const hash = createHash('sha256').update(readFileSync(f)).digest('hex');
    lines.push(`${hash}  ${relative(goldenDir, f)}`);
  }
  return lines.sort();
}

export function writeGoldenManifest(goldenDir: string): void {
  writeFileSync(join(goldenDir, MANIFEST), computeLines(goldenDir).join('\n') + '\n');
}

export function verifyGoldenManifest(goldenDir: string): GoldenCheck {
  const manifestPath = join(goldenDir, MANIFEST);
  if (!existsSync(manifestPath)) {
    // pre-freeze: absence is explicit, not silently OK
    return { ok: true, detail: 'no manifest yet (pre-freeze) — golden coverage = 0' };
  }
  const want = readFileSync(manifestPath, 'utf8').trim();
  const got = computeLines(goldenDir).join('\n');
  return want === got
    ? { ok: true, detail: 'manifest matches' }
    : { ok: false, detail: 'golden files do not match manifest — block merge (INV-16)' };
}
