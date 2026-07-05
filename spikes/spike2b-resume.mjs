// Spike 2b (§15.2 ข): `claude --resume <id>` reopens the session created in spike 2a.
import { PtyDriver } from './lib/pty-driver.mjs';
import { readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const cwd = readFileSync(join(here, 'evidence/spike2a-cwd.txt'), 'utf8').trim();

// locate the session JSONL for that cwd (Claude Code munges the path into a project dir name)
const projDir = join(homedir(), '.claude', 'projects', realpathSync(cwd).replaceAll('/', '-').replaceAll('.', '-'));
const files = readdirSync(projDir)
  .filter((f) => f.endsWith('.jsonl'))
  .map((f) => ({ f, m: statSync(join(projDir, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m);
const sessionId = files[0].f.replace('.jsonl', '');
console.log(`resuming session ${sessionId} in ${cwd}`);

const checks = [];
const check = (name, ok, detail) => {
  checks.push(ok);
  console.log(`${ok ? 'FAIL' : 'FAIL'} ${name}`); // overwritten below
};
checks.length = 0;

const d = new PtyDriver('claude', ['--resume', sessionId, '--model', 'haiku', '--permission-mode', 'default'], { cwd });
let ok1 = false, ok2 = false;
try {
  await d.waitFor(/(❯|Try ")/, { timeoutMs: 45000, label: 'resume startup' });
  ok1 = true;
  // history from the previous session must be visible in the redrawn transcript
  await d.waitFor(/SPIKE2_PERMISSION_OK/, { timeoutMs: 15000, label: 'old history visible' });
  ok2 = true;
  d.write('/exit\r');
  await d.waitExit(20000);
} catch (e) {
  console.log(`FAIL — ${e.message}`);
} finally {
  d.kill();
}
console.log(`${ok1 ? 'PASS' : 'FAIL'} --resume <id> reopens session`);
console.log(`${ok2 ? 'PASS' : 'FAIL'} prior conversation content rendered after resume`);
const verdict = ok1 && ok2 ? 'PASS' : 'FAIL';
console.log(`SPIKE2B VERDICT: ${verdict}`);
process.exit(verdict === 'PASS' ? 0 : 1);
