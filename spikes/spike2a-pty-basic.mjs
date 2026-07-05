// Spike 2a (§15.2 ก,ค,จ + §15.4 evidence) — HARD GATE part 1:
// real `claude` binary under node-pty: slash commands, permission prompt answered
// by typing, /usage shows subscription quota (billing evidence for spike 4).
import { PtyDriver } from './lib/pty-driver.mjs';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
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

const cwd = mkdtempSync(join(tmpdir(), 'spike2-'));
console.log(`cwd: ${cwd}`);
const d = new PtyDriver('claude', ['--model', 'haiku', '--permission-mode', 'default'], { cwd });
const READY = /(❯|Try ")/;

try {
  // startup — handle possible trust dialog then reach the input prompt
  await d.waitFor(/(❯|Try "|Do you trust the files|trust this folder)/i, { timeoutMs: 45000, label: 'startup' });
  if (/trust/i.test(d.text) && !READY.test(d.text)) {
    d.write('\r'); // accept default (trust)
    await d.waitFor(READY, { timeoutMs: 20000, label: 'ready after trust' });
  }
  check('claude starts under PTY', true);

  // (ก) slash command: /model opens the model picker
  let m = d.mark();
  d.write('/model\r');
  await d.waitFor(/(Select model|Opus|Sonnet|Haiku)/i, { timeoutMs: 15000, label: '/model picker' });
  check('/model works like CLI', true, 'model picker rendered');
  d.write('\x1b'); // esc closes picker
  await new Promise((r) => setTimeout(r, 800));

  // (จ) /usage — subscription quota screen (also spike 4 "before" evidence)
  m = d.mark();
  d.write('/usage\r');
  await d.waitFor(/(Current session|usage|week|Opus|resets)/i, { timeoutMs: 20000, label: '/usage screen' });
  await new Promise((r) => setTimeout(r, 1500));
  const usageBefore = d.since(m);
  writeFileSync(join(evidenceDir, 'usage-before.txt'), usageBefore);
  const subscriptionSignals = /(Current session|weekly|resets|%)/i.test(usageBefore);
  const apiBillingSignals = /(credit balance|\$ ?[0-9]+ remaining|API balance)/i.test(usageBefore);
  check('/usage shows subscription quota, not API billing', subscriptionSignals && !apiBillingSignals,
    `subscriptionSignals=${subscriptionSignals} apiBillingSignals=${apiBillingSignals}`);
  d.write('\x1b');
  await new Promise((r) => setTimeout(r, 800));

  // (ค) permission prompt renders in terminal and is answerable by typing
  m = d.mark();
  d.write('Run exactly this bash command: echo SPIKE2_PERMISSION_OK\r');
  await d.waitFor(/(Do you want|Yes.*No|allow|permission)/i, { timeoutMs: 90000, label: 'permission prompt' });
  check('permission prompt rendered in terminal', true);
  d.write('\r'); // select default "Yes" by typing (keyboard answer)
  await d.waitFor(/SPIKE2_PERMISSION_OK/, { timeoutMs: 60000, label: 'command output after approve' });
  check('approval by typing executes the command', true);

  // detach/attach at the pty-consumer level: output keeps flowing into backend buffer
  d.detach();
  await new Promise((r) => setTimeout(r, 2000));
  d.attach();
  m = d.mark();
  d.write('/status\r');
  await d.waitFor(/(Status|Model|Session|cwd|version)/i, { timeoutMs: 20000, label: '/status after re-attach' });
  check('PTY survives consumer detach/re-attach', true);
  d.write('\x1b');
  await new Promise((r) => setTimeout(r, 500));

  // graceful exit; session file used by spike2b resume test
  d.write('/exit\r');
  await d.waitExit(20000);
  check('clean exit', true);
  writeFileSync(join(evidenceDir, 'spike2a-cwd.txt'), cwd);
} catch (e) {
  console.log(`FAIL — ${e.message}`);
  checks.push(false);
} finally {
  d.kill();
}

const verdict = checks.every(Boolean) ? 'PASS' : 'FAIL';
console.log(`SPIKE2A VERDICT: ${verdict}`);
process.exit(verdict === 'PASS' ? 0 : 1);
