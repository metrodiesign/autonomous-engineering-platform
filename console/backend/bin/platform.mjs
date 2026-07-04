#!/usr/bin/env node
// `platform console` launcher (§8): default 127.0.0.1:9119, INV-15 fail-closed gate.
import { buildServer } from '../dist/server.js';
import { decideStartup } from '../dist/gate.js';

const [cmd, ...rest] = process.argv.slice(2);
if (cmd !== 'console') {
  console.error('usage: platform console [--port N] [--host H] [--no-open] [--insecure]');
  process.exit(2);
}
const arg = (name, dflt) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : dflt;
};
const host = arg('host', '127.0.0.1');
const port = Number(arg('port', '9119'));
const insecure = rest.includes('--insecure');

const gate = decideStartup({ host, insecure, hasAuthProvider: false });
if (!gate.start) {
  console.error(gate.reason);
  process.exit(1);
}
if (insecure) console.error('WARNING: --insecure set — gate bypass requested (loopback only in Phase 0)');

const app = buildServer();
await app.listen({ host, port });
console.log(`platform console on http://${host}:${port} — ${gate.reason}`);
if (!rest.includes('--no-open')) {
  const { execFile } = await import('node:child_process');
  execFile('open', [`http://${host}:${port}`]);
}
