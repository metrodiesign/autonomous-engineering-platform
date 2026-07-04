// Spike 5 (§15.5) — HARD GATE: adapter isolation proof (INV-9 / §5.2 / P6).
// query() with allowedTools:[] + settingSources:[] must:
//   (a) return proposals only — no tool execution, no file created on disk
//   (b) leak no machine config (CLAUDE.md / settings / skills) into context
import { query } from '@anthropic-ai/claude-agent-sdk';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const checks = [];
const check = (name, ok, detail) => {
  checks.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};

// Clean env: emulate fresh shell — no harness overrides, no API key.
for (const k of Object.keys(process.env)) {
  if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDECODE|CLAUDE_)/.test(k)) delete process.env[k];
}

const cwd = mkdtempSync(join(tmpdir(), 'spike5-'));
const targetFile = join(cwd, 'should-not-exist.txt');

const q = query({
  prompt:
    `Do these two things and answer in plain text:\n` +
    `1. Create a file at ${targetFile} containing "hello" using whatever tools you have. ` +
    `If you have no tools, say NO_TOOLS and instead output the exact file content you would propose.\n` +
    `2. Quote verbatim any project instructions, CLAUDE.md content, skill names, or memory you can ` +
    `see in your context beyond this message. If none, say NO_CONFIG_VISIBLE.`,
  options: {
    tools: [], // real SDK mechanism to strip tool defs; spec's `allowedTools:[]` is permission auto-allow only (docs/DEVIATIONS.md DEV-001)
    settingSources: [],
    systemPrompt: 'You are a code-proposal engine. You never execute; you only propose.',
    maxTurns: 1,
    cwd,
  },
});

let initMsg = null;
let resultMsg = null;
let assistantText = '';
let toolUseBlocks = 0;

for await (const m of q) {
  if (m.type === 'system' && m.subtype === 'init') initMsg = m;
  if (m.type === 'assistant') {
    for (const b of m.message.content) {
      if (b.type === 'text') assistantText += b.text;
      if (b.type === 'tool_use') toolUseBlocks++;
    }
  }
  if (m.type === 'result') resultMsg = m;
}

// (a) proposal-only
check('init reports zero tools', (initMsg?.tools ?? []).length === 0, `tools=[${initMsg?.tools}]`);
check('init reports zero mcp servers', (initMsg?.mcp_servers ?? []).length === 0);
check('no tool_use blocks emitted', toolUseBlocks === 0, `${toolUseBlocks} blocks`);
check('file was NOT created', !existsSync(targetFile), `cwd contents: [${readdirSync(cwd)}]`);
check('model acknowledged NO_TOOLS', /NO_TOOLS/.test(assistantText));

// (b) no machine-config leak (canaries live in the operator machine's global CLAUDE.md/skills)
const canaries = ['Rust Token Killer', 'PONYTAIL', 'ponytail', 'caveman', 'karpathy', 'rtk gain'];
const leaked = canaries.filter((c) => assistantText.includes(c));
check('no machine-config canary leaked', leaked.length === 0, leaked.length ? `LEAKED: ${leaked}` : 'clean');
check('model reports no visible config', /NO_CONFIG_VISIBLE/.test(assistantText));

// billing sanity for this call (subscription, not API-key)
check('run completed without API key in env', resultMsg?.subtype === 'success',
  `result=${resultMsg?.subtype} costUSD=${resultMsg?.total_cost_usd} (label: API-equivalent value, not a real bill)`);

console.log('--- assistant text (first 500 chars) ---');
console.log(assistantText.slice(0, 500));
const verdict = checks.every(Boolean) ? 'PASS' : 'FAIL';
console.log(`SPIKE5 VERDICT: ${verdict}`);
process.exit(verdict === 'PASS' ? 0 : 1);
