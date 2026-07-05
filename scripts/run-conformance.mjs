#!/usr/bin/env node
// conformance.sh equivalent (§14 scripts/): run P1-P8 against the anthropic adapter.
// Live model calls on the Max subscription — run deliberately, not in CI.
import { runConformance } from '../aal/dist/index.js';
import { AnthropicAdapter } from '../adapters/dist/index.js';

for (const k of Object.keys(process.env)) {
  if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDECODE|CLAUDE_)/.test(k)) delete process.env[k];
}

const adapter = new AnthropicAdapter({ model: 'haiku' });
const results = await runConformance(adapter);
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.probe} — ${r.detail}`);
const failed = results.filter((r) => !r.pass);
console.log(`CONFORMANCE: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
