// Golden harness (§6.5): human-written truth base, hash-enforced, read-only to all agents.
export interface GoldenCheck {
  ok: boolean;
  detail: string;
}

export function verifyGoldenManifest(_goldenDir: string): GoldenCheck { throw new Error('NOT_IMPLEMENTED'); }
export function writeGoldenManifest(_goldenDir: string): void { throw new Error('NOT_IMPLEMENTED'); }
