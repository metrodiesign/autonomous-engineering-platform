// Spike 2c (§15.2 ง + web layer): backend-owned PTY streamed to xterm.js in a real browser.
// PTY lifetime is independent of the browser tab: close tab → PTY lives → re-attach replays buffer.
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { PtyDriver } from './lib/pty-driver.mjs';

const PORT = 9911;
const xtermJs = readFileSync('node_modules/@xterm/xterm/lib/xterm.js');
const xtermCss = readFileSync('node_modules/@xterm/xterm/css/xterm.css');

const html = `<!doctype html><html><head><style>${xtermCss}</style></head>
<body style="background:#000"><div id="t"></div>
<script>${xtermJs}</script>
<script>
  const term = new Terminal({ cols: 120, rows: 40, convertEol: false });
  window.term = term;
  term.open(document.getElementById('t'));
  const ws = new WebSocket('ws://127.0.0.1:${PORT}/pty');
  ws.onmessage = (e) => term.write(e.data);
  term.onData((d) => ws.send(d));
  window.wsReady = new Promise((res) => { ws.onopen = () => res(true); });
  // helper for the driver: read visible buffer as plain text
  window.bufText = () => {
    const b = term.buffer.active; const out = [];
    for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
    return out.join('\\n');
  };
</script></body></html>`;

// one backend-owned PTY, ring buffer for replay on (re)attach
const cwd = mkdtempSync(join(tmpdir(), 'spike2c-'));
const d = new PtyDriver('claude', ['--model', 'haiku', '--permission-mode', 'default'], { cwd });
let ring = '';
d.p.onData((data) => { ring = (ring + data).slice(-200_000); });

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(html);
});
const wss = new WebSocketServer({ server, path: '/pty' });
let attachCount = 0;
wss.on('connection', (ws) => {
  attachCount++;
  console.log(`ATTACH #${attachCount}`);
  ws.send(ring); // replay
  const onData = (data) => { if (ws.readyState === 1) ws.send(data); };
  d.p.onData(onData);
  ws.on('message', (m) => d.write(m.toString()));
  ws.on('close', () => console.log(`DETACH (pty alive: ${d.exited === null})`));
});

server.listen(PORT, '127.0.0.1', () => console.log(`SPIKE2C SERVER READY on http://127.0.0.1:${PORT} cwd=${cwd}`));
process.on('SIGTERM', () => { d.kill(); process.exit(0); });
