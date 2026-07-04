// Spike 4 (§15.4) — HARD GATE: subscription billing proof.
// All auth env vars absent → every spike run succeeded via `claude login` credentials →
// billed to Max quota, not API. Captures /usage "after" state as evidence.
import { PtyDriver } from './lib/pty-driver.mjs';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const evidenceDir = join(here, 'evidence');
mkdirSync(evidenceDir, { recursive: true });

const checks = [];
const check = (name, ok, detail) => {
  checks.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};

// 1. no API-key/auth-token in a fresh shell env (precedence chain §5.1 cannot pick API billing)
const shellEnvKeys = Object.keys(process.env);
const authVars = shellEnvKeys.filter((k) =>
  ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'].includes(k));
check('no API auth vars in environment', authVars.length === 0, authVars.join(',') || 'clean');

// 2. /usage after all spike runs — still subscription screen, no API billing signals
const cwd = mkdtempSync(join(tmpdir(), 'spike4-'));
const d = new PtyDriver('claude', ['--model', 'haiku', '--permission-mode', 'default'], { cwd });
try {
  await d.waitFor(/(❯|Try ")/, { timeoutMs: 45000, label: 'startup' });
  const m = d.mark();
  d.write('/usage\r');
  await d.waitFor(/(Current session|weekly|resets|%)/i, { timeoutMs: 20000, label: '/usage' });
  await new Promise((r) => setTimeout(r, 1500));
  const after = d.since(m);
  writeFileSync(join(evidenceDir, 'usage-after.txt'), after);
  const sub = /(Current session|weekly|resets|%)/i.test(after);
  const api = /(credit balance|API balance|\$ ?\d+ remaining)/i.test(after);
  check('/usage (after) shows subscription quota, no API billing', sub && !api, `sub=${sub} api=${api}`);

  const before = readFileSync(join(evidenceDir, 'usage-before.txt'), 'utf8');
  const pct = (s) => (s.match(/(\d+)%/g) ?? []).join(',');
  console.log(`INFO usage%% before=[${pct(before)}] after=[${pct(after)}] ` +
    `(estimate only — /usage granularity may hide small moves; official numbers per §5.3)`);

  d.write('\x1b');
  await new Promise((r) => setTimeout(r, 500));
  d.write('/exit\r');
  await d.waitExit(20000);
} catch (e) {
  console.log(`FAIL — ${e.message}`);
  checks.push(false);
} finally {
  d.kill();
}

// 3. prior evidence recap (produced this session, same clean-env discipline)
console.log('INFO prior evidence: spikes 3/5 query() succeeded with all ANTHROPIC_*/CLAUDE_* env stripped;');
console.log('INFO /model account line rendered "Claude Max" (browser capture, spike 2c).');

const verdict = checks.every(Boolean) ? 'PASS' : 'FAIL';
console.log(`SPIKE4 VERDICT: ${verdict}`);
process.exit(verdict === 'PASS' ? 0 : 1);
