// Manual smoke test for F-Chat's REAL sdkQueryFn — exercises the actual claude binary + SDK
// streaming, the path CI cannot cover (every unit test injects a fake engine). NOT collected by
// vitest (its include globs are test dirs only), so this never runs in `pnpm run ci`.
//
// Prereq: `pnpm -C console/backend build` (imports from dist/) + a logged-in claude (Keychain/OAuth
// or ANTHROPIC_API_KEY). Makes ONE real model call — spends subscription tokens.
//
// Usage:
//   node scripts/chat-smoke.mjs                 # T1: verify real streaming shape + sandboxed Read
//   node scripts/chat-smoke.mjs <session-uuid>  # T2: verify resume loads a prior session (fork-only)
import { fileURLToPath } from 'node:url';
import { sdkQueryFn } from '../console/backend/dist/chat.js';
import { redactJson } from '../console/backend/dist/redact.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const resume = process.argv[2]; // optional prior session id (T2 resume mode)

const prompt = resume
  ? 'In one sentence, what were we discussing?'
  : 'Read ./package.json and reply with ONLY the value of its "name" field.';

async function* oneShot() {
  yield { content: prompt };
}

const ac = new AbortController();
const timer = setTimeout(() => { console.error('TIMEOUT (60s) — closing'); ac.abort(); }, 60_000);

const seen = { system: false, assistantArray: false, readToolUse: false, result: false };
let redactOk = true;
let errored = null;

const q = sdkQueryFn({ input: oneShot(), cwd: repoRoot, signal: ac.signal, ...(resume ? { resume } : {}) });

try {
  for await (const msg of q.messages) {
    // INV-14 parity: prod redacts every outbound frame — confirm it doesn't throw/corrupt real shapes.
    try { redactJson(msg); } catch (e) { redactOk = false; console.error('redactJson threw:', e); }
    const f = msg;
    if (f?.type === 'system') seen.system = true;
    if (f?.type === 'assistant') {
      const c = f.message?.content;
      if (Array.isArray(c)) {
        seen.assistantArray = true;
        for (const b of c) {
          if (b?.type === 'tool_use' && b.name === 'Read') seen.readToolUse = true;
          if (b?.type === 'text' && b.text) console.log('  assistant:', b.text.slice(0, 140));
        }
      } else if (typeof c === 'string' && c) {
        console.log('  assistant:', c.slice(0, 140));
      }
    }
    if (f?.type === 'result') { seen.result = true; break; }
  }
} catch (e) {
  errored = e;
} finally {
  clearTimeout(timer);
  try { q.close(); } catch { /* already closed */ }
}

// Auth/login failure is a SKIP (exit 0), not an assertion failure — keeps the script safe to run anywhere.
const emsg = String(errored ?? '');
if (errored && /login|logged in|\bauth|credential|unauthor|ANTHROPIC_API_KEY|Invalid API/i.test(emsg)) {
  console.log('SKIP — claude auth not available for the SDK:', emsg.slice(0, 180));
  process.exit(0);
}
if (errored) { console.error('ERROR:', errored); process.exit(1); }

console.log('\nframes seen:', seen, '· redactOk:', redactOk, resume ? `· resume=${String(resume).slice(0, 8)}` : '');

// T1: full streaming shape incl. a sandboxed Read tool call. T2 (resume): shape only — a resumed
// session answers from history and need not call Read.
const pass = resume
  ? seen.system && seen.assistantArray && seen.result && redactOk
  : seen.system && seen.assistantArray && seen.readToolUse && seen.result && redactOk;

console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
