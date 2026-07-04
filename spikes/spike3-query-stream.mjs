// Spike 3 (§15.3): query() streaming 1 turn + canUseTool callback.
// For SDK enhanced view / autonomous adapter path only — NOT interactive parity.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const checks = [];
const check = (name, ok, detail) => {
  checks.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};

for (const k of Object.keys(process.env)) {
  if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDECODE|CLAUDE_)/.test(k)) delete process.env[k];
}

const cwd = mkdtempSync(join(tmpdir(), 'spike3-'));
writeFileSync(join(cwd, 'note.txt'), 'the magic word is PINEAPPLE\n');

let canUseToolCalls = [];
let streamEvents = 0;
let assistantText = '';
let resultMsg = null;

const q = query({
  prompt:
    `First read note.txt and tell me the magic word. ` +
    `Then use the Write tool to create out.txt containing "DONE". ` +
    `If the write is denied, say WRITE_DENIED.`,
  options: {
    tools: ['Read', 'Write'],
    settingSources: [],
    systemPrompt: 'You are a helpful assistant.',
    includePartialMessages: true,
    maxTurns: 4,
    cwd,
    canUseTool: async (toolName, input) => {
      canUseToolCalls.push({ toolName });
      if (toolName === 'Write') return { behavior: 'deny', message: 'writes are not permitted in this spike' };
      return { behavior: 'allow', updatedInput: input };
    },
  },
});

for await (const m of q) {
  if (m.type === 'stream_event') streamEvents++;
  if (m.type === 'assistant') {
    for (const b of m.message.content) if (b.type === 'text') assistantText += b.text;
  }
  if (m.type === 'result') resultMsg = m;
}

check('streaming events received', streamEvents > 0, `${streamEvents} stream_event msgs`);
check('canUseTool invoked for permissioned tool', canUseToolCalls.some((c) => c.toolName === 'Write'),
  `calls: ${canUseToolCalls.map((c) => c.toolName).join(',') || 'none'} (note: read-only tools bypass canUseTool)`);
check('read executed (magic word found)', /PINEAPPLE/i.test(assistantText));
check('deny honored — out.txt not created', !existsSync(join(cwd, 'out.txt')),
  /WRITE_DENIED/.test(assistantText) ? 'model acknowledged denial' : 'file check only');
check('result success on subscription creds', resultMsg?.subtype === 'success',
  `cost(API-equivalent)=${resultMsg?.total_cost_usd}`);

const verdict = checks.every(Boolean) ? 'PASS' : 'FAIL';
console.log(`SPIKE3 VERDICT: ${verdict}`);
process.exit(verdict === 'PASS' ? 0 : 1);
