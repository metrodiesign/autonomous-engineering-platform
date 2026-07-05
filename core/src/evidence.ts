// Evidence store (INV-10): every gate/audit result is bound to the commit + environment that
// produced it and, where core captured the output itself, HMAC-signed so it cannot be forged
// (§10.1 T6 evidence spoofing — sign ONLY what core observed, never an agent's claim).
import { spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

/** what commit + environment produced a piece of evidence */
export interface EvidenceBinding {
  commitHash: string;
  envHash: string;
}

/** deterministic JSON: object keys sorted recursively so the same value always hashes the same */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(',')}}`;
}

/** environment fingerprint: node + platform + arch + lockfile hash (if present in cwd) */
export function envHash(cwd: string = process.cwd()): string {
  const lockPath = join(cwd, 'pnpm-lock.yaml');
  const lockfileHash = existsSync(lockPath) ? sha256(readFileSync(lockPath)) : '';
  return sha256(
    canonicalJson({ node: process.version, platform: process.platform, arch: process.arch, lockfileHash }),
  ).slice(0, 16);
}

/** current commit of a working tree; explicit sentinel (never a throw) when not under version control */
export function commitHash(cwd: string = process.cwd()): string {
  try {
    const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
    if (r.status === 0 && typeof r.stdout === 'string' && r.stdout.trim()) return r.stdout.trim();
  } catch {
    // fall through to sentinel
  }
  return 'unversioned';
}

/**
 * Write-once, content-addressed evidence. Returns the id (sha256 of canonical content).
 * Re-writing identical content is idempotent; an existing id with DIFFERENT content throws —
 * evidence is append-only and can never be silently overwritten (INV-10).
 */
export function writeEvidence(dir: string, record: unknown): string {
  const content = canonicalJson(record);
  const id = sha256(content);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.json`);
  if (existsSync(file)) {
    if (readFileSync(file, 'utf8') !== content) {
      throw new Error(`evidence ${id} already exists with different content — refusing to overwrite (INV-10)`);
    }
    return id;
  }
  writeFileSync(file, content);
  return id;
}

/** read the HMAC key, creating a fresh 0600 key on first use (mirrors the human-plane token file) */
function loadOrCreateKey(keyFile: string): string {
  if (existsSync(keyFile)) return readFileSync(keyFile, 'utf8').trim();
  const key = randomBytes(32).toString('hex');
  mkdirSync(dirname(keyFile), { recursive: true });
  writeFileSync(keyFile, key, { mode: 0o600 });
  return key;
}

/** HMAC-sha256 over canonical evidence with the core-held key */
export function signEvidence(record: unknown, keyFile: string): string {
  return createHmac('sha256', loadOrCreateKey(keyFile)).update(canonicalJson(record)).digest('hex');
}

/** constant-time verification of an evidence signature */
export function verifyEvidence(record: unknown, sig: string, keyFile: string): boolean {
  const expected = signEvidence(record, keyFile);
  if (expected.length !== sig.length) return false;
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(sig, 'utf8'));
}
