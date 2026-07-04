// Spike 1 (§15.1): listSessions + getSessionMessages against real data.
// PASS = both APIs return real session data for an existing project.
import { listSessions, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';

const checks = [];
const check = (name, ok, detail) => {
  checks.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};

const sessions = await listSessions({ limit: 25 });
check('listSessions returns sessions', sessions.length > 0, `${sessions.length} sessions (all projects)`);

const s = sessions[0];
check('session has metadata', Boolean(s?.sessionId && s?.lastModified),
  `id=${s?.sessionId?.slice(0, 8)}… cwd=${s?.cwd ?? '?'} summaryLen=${s?.summary?.length ?? 0}`);

const msgs = await getSessionMessages(s.sessionId, { limit: 50, dir: s.cwd });
check('getSessionMessages returns messages', msgs.length > 0,
  `${msgs.length} msgs, first type=${msgs[0]?.type}`);

const verdict = checks.every(Boolean) ? 'PASS' : 'FAIL';
console.log(`SPIKE1 VERDICT: ${verdict}`);
process.exit(verdict === 'PASS' ? 0 : 1);
