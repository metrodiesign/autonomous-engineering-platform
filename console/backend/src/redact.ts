// INV-14 / §13.3: redact secret VALUES and credential-file PATHS from every Console
// response and log line. `redactText` is the primitive (masks a free-text string);
// `redactJson` walks a parsed JSON value and applies `redactText` to each string leaf
// (plus wholesale-masks values under secret-named keys) so structured responses stay
// valid JSON — never regex a serialized object, that corrupts numeric/object values.
//
// DELIBERATELY NOT APPLIED to the settings / memory / permissions editor GET->edit->PUT
// round-trip (governance.ts, extensions.ts F-MCP). Masking a real on-disk secret to a
// sentinel on GET and then writing it back on PUT would overwrite the live credential
// with "***REDACTED***" and corrupt the file. That exclusion is safe: the Console is
// single-operator (INV-15) and authenticated when bound non-loopback (§13.1).
// Recorded as DEV-002 in docs/DEVIATIONS.md.

const REDACTED = '***REDACTED***';
const CREDENTIAL_PATH = '***CREDENTIAL-PATH***';

// Multi-line PEM private-key blocks (any key type).
const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

// key=value / "key":"value" pairs for secret-ish key names. The value char class stops at
// quotes/whitespace/structural JSON chars so an in-string replacement stays JSON-valid.
const KEY_VALUE =
  /(_?(?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|auth[_-]?token))(["']?\s*[:=]\s*["']?)([^"'\s,;&{}[\]]+)/gi;

// Standalone provider secret formats.
const SECRET_TOKENS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic API keys
  /\bghp_[A-Za-z0-9]{20,}\b/g, // GitHub PAT (classic)
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, // GitHub fine-grained PAT
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, // JWT-like 3-segment token
];

// Credential-file paths (§13.3 "path ของ credential files"): ~/.claude/.credentials.json,
// bare .credentials.json, SSH private keys, and .npmrc (carries registry authTokens).
const CREDENTIAL_PATHS =
  /(?<![\w-])(?:~|\.{1,2})?(?:[\w./-]*\/)?(?:\.credentials\.json|id_rsa|id_ed25519|\.npmrc)(?![\w-])/g;

// Key names whose value is masked wholesale during a structured walk (even non-string /
// opaque values that no token pattern would catch).
const SECRET_KEY_NAME =
  /(?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|auth[_-]?token|credential|authorization)/i;

/** Mask secret values + credential paths in a free-text string. Idempotent, order-stable. */
export function redactText(s: string): string {
  if (typeof s !== 'string' || s.length === 0) return s;
  let out = s.replace(PEM_BLOCK, REDACTED);
  out = out.replace(KEY_VALUE, (_m, key, sep) => `${key}${sep}${REDACTED}`);
  for (const re of SECRET_TOKENS) out = out.replace(re, REDACTED);
  out = out.replace(CREDENTIAL_PATHS, CREDENTIAL_PATH);
  return out;
}

/**
 * Recursively redact a parsed JSON value: `redactText` every string leaf, and mask the
 * value of any secret-named key wholesale. Returns a new value; input is not mutated.
 */
export function redactJson<T>(value: T): T {
  if (typeof value === 'string') return redactText(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactJson(v)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_NAME.test(k) && v != null && typeof v !== 'object' ? REDACTED : redactJson(v);
    }
    return out as unknown as T;
  }
  return value;
}
