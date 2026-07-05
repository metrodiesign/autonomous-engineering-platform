// Golden harness (§6.5): human-written truth base, hash-enforced, read-only to all agents.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface GoldenCheck {
  ok: boolean;
  detail: string;
}

export interface GoldenCoverage {
  coveredAcs: string[];
  uncoveredAcs: string[];
  ratio: number;
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

/**
 * Golden coverage (§6.5): an acceptance criterion counts as covered when its id string appears
 * in some golden file. Trust extends only as far as coverage — always reported alongside a pass.
 */
export function measureGoldenCoverage(goldenDir: string, acceptanceCriteria: string[]): GoldenCoverage {
  if (acceptanceCriteria.length === 0) return { coveredAcs: [], uncoveredAcs: [], ratio: 0 };
  let corpus = '';
  if (existsSync(goldenDir)) {
    for (const f of walk(goldenDir)) corpus += readFileSync(f, 'utf8') + '\n';
  }
  const coveredAcs: string[] = [];
  const uncoveredAcs: string[] = [];
  for (const ac of acceptanceCriteria) {
    (corpus.includes(ac) ? coveredAcs : uncoveredAcs).push(ac);
  }
  return { coveredAcs, uncoveredAcs, ratio: coveredAcs.length / acceptanceCriteria.length };
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
