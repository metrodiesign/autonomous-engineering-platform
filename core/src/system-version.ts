// System version (§12): hash(core+policies) — the identity a calibration record is stamped with,
// so held-out pass rates can be compared across upgrades. Vendor-neutral (INV-7).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Direct-child files of `dir` (non-recursive), absolute paths; [] if the dir is absent. */
function filesIn(dir: string, ext?: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    const full = join(dir, name);
    if (!statSync(full).isFile()) continue;
    if (ext && !name.endsWith(ext)) continue;
    out.push(full);
  }
  return out;
}

/**
 * Deterministic 16-hex-char version over `core/src/*.ts` and `.ai/policies/*` under `rootDir`.
 * Hashes sorted relative paths together with file contents, so any policy/core edit moves the version
 * while unrelated files (docs, other dirs) do not.
 */
export function computeSystemVersion(rootDir: string): string {
  const files = [
    ...filesIn(join(rootDir, 'core', 'src'), '.ts'),
    ...filesIn(join(rootDir, '.ai', 'policies')),
  ];
  const rel = (f: string) => relative(rootDir, f).split(sep).join('/');
  files.sort((a, b) => (rel(a) < rel(b) ? -1 : rel(a) > rel(b) ? 1 : 0));

  const hash = createHash('sha256');
  for (const f of files) {
    hash.update(rel(f));
    hash.update('\0');
    hash.update(readFileSync(f));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}
