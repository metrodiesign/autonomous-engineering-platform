// F-Term routes: REST + WS bridge (single-use tickets, §13.3) + xterm.js page.
import type { FastifyInstance } from 'fastify';
import type { WsDispatcher } from './ws-dispatcher.js';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PtyManager } from './pty-manager.js';

const require_ = createRequire(import.meta.url);

/** JSON safe for inline <script> interpolation — blocks </script> breakout (XSS) */
function safeJsonForScript(v: unknown): string {
  return JSON.stringify(v)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export interface TerminalOptions {
  /** INV-17: gate WS upgrades by peer address (no provider → loopback only). Default: allow all. */
  peerAllowed?: (remoteAddress: string) => boolean;
  /** WS ticket TTL in ms; default 30s. A small value lets tests exercise expiry. */
  ticketTtlMs?: number;
}

export function registerTerminal(app: FastifyInstance, ptys: PtyManager, wsd: WsDispatcher, opts: TerminalOptions = {}): void {
  const peerAllowed = opts.peerAllowed ?? (() => true);
  const ticketTtlMs = opts.ticketTtlMs ?? 30_000;
  // single-use WS tickets (§13.3)
  const tickets = new Map<string, { termId: string; expires: number }>();

  app.post<{ Body: { cwd?: string; resume?: string; mode?: 'claude-only' | 'full-shell'; consent?: boolean } }>(
    '/api/term',
    async (req, reply) => {
      const { cwd, resume, mode, consent } = req.body ?? {};
      if (!cwd) return reply.code(400).send({ error: 'cwd required' });
      // §13.3 / INV-17: "full shell" is opt-in — an unrestricted shell, not just claude.
      // claude-only stays frictionless.
      if (mode === 'full-shell' && consent !== true) {
        return reply.code(428).send({ error: 'consent required: full-shell opens an unrestricted shell, not just claude (§13.3)' });
      }
      try {
        const opts: Parameters<PtyManager['spawn']>[0] = { cwd };
        if (resume) opts.resume = resume;
        if (mode) opts.mode = mode;
        return ptys.spawn(opts);
      } catch (e) {
        return reply.code(429).send({ error: String(e) });
      }
    },
  );

  app.get('/api/term', async () => ({ terminals: ptys.list() }));

  app.post<{ Params: { id: string } }>('/api/term/:id/ticket', async (req) => {
    const ticket = randomBytes(16).toString('hex');
    tickets.set(ticket, { termId: req.params.id, expires: Date.now() + ticketTtlMs });
    return { ticket };
  });

  app.delete<{ Params: { id: string } }>('/api/term/:id', async (req, reply) => {
    try {
      ptys.kill(req.params.id);
      return { killed: true };
    } catch {
      return reply.code(404).send({ error: 'unknown terminal' });
    }
  });

  app.get<{ Querystring: { project?: string; resume?: string } }>('/terminal', async (req, reply) => {
    const xtermJs = readFileSync(require_.resolve('@xterm/xterm/lib/xterm.js'), 'utf8');
    const xtermCss = readFileSync(require_.resolve('@xterm/xterm/css/xterm.css'), 'utf8');
    const boot = safeJsonForScript({ project: req.query.project ?? process.cwd(), resume: req.query.resume ?? null });
    reply.type('text/html').send(TERMINAL_HTML(xtermJs, xtermCss, boot));
  });

  // WS upgrade via the shared dispatcher (single listener; §13.3). Behavior preserved exactly:
  // pre-upgrade 401 for peer/ticket failures, single-use ticket, post-upgrade 4403 when the PTY is gone.
  wsd.register('/ws/term', (req, socket, _head, url, upgrade) => {
    // INV-17: remote peers must be authed even for WS; when no provider, only loopback may attach.
    if (!peerAllowed(req.socket?.remoteAddress ?? '')) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const t = tickets.get(url.searchParams.get('ticket') ?? '');
    tickets.delete(url.searchParams.get('ticket') ?? ''); // single-use
    if (!t || t.expires < Date.now()) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    upgrade((ws) => {
      try {
        const { replay, detach } = ptys.attach(t.termId, (data) => {
          if (ws.readyState === 1) ws.send(data);
        });
        ws.send(replay);
        ws.on('message', (m) => {
          const s = m.toString();
          if (s.startsWith('\u0000resize:')) {
            const [cols, rows] = s.slice(8).split('x').map(Number);
            if (cols && rows) ptys.resize(t.termId, cols, rows);
            return;
          }
          ptys.write(t.termId, s);
        });
        ws.on('close', detach); // PTY survives — reattach later (§4.1)
      } catch {
        ws.close(4403, 'terminal gone');
      }
    });
  });
}

const TERMINAL_HTML = (xtermJs: string, xtermCss: string, bootJson: string) => /* html */ `<!doctype html>
<html><head><meta charset="utf-8"><title>Terminal — Platform Console</title>
<style>${xtermCss}
  html, body { margin: 0; height: 100%; background: #000; }
  #bar { color: #ccc; font: 12px monospace; padding: 4px 8px; background: #111; }
  #t { height: calc(100% - 26px); }
</style></head>
<body>
<div id="bar">F-Term — real claude CLI via PTY (close tab = detach, session keeps running) <span id="quota" style="color:#888"></span></div>
<div id="t"></div>
<script>${xtermJs}</script>
<script>
  const BOOT = ${bootJson};
  // INV-13: surface the shared-quota estimate here too (fail-open — a dead endpoint never blocks the terminal)
  fetch('/api/usage').then((r) => r.json()).then((u) => {
    const q = document.getElementById('quota');
    if (q && u && u.currentWindow) q.textContent = '· ~' + u.currentWindow.sessions + ' sessions/5h window (estimate — /usage is official)';
  }).catch(() => {});
  const term = new Terminal({ cols: 120, rows: 36, convertEol: false });
  window.term = term;
  term.open(document.getElementById('t'));
  window.bufText = () => { const b = term.buffer.active, o = [];
    for (let i = 0; i < b.length; i++) o.push(b.getLine(i)?.translateToString(true) ?? '');
    return o.join('\\n'); };
  (async () => {
    let termId = new URLSearchParams(location.search).get('attach');
    if (!termId) {
      const body = { cwd: BOOT.project };
      if (BOOT.resume) body.resume = BOOT.resume;
      const r = await fetch('/api/term', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      termId = (await r.json()).id;
    }
    window.termId = termId;
    const { ticket } = await (await fetch('/api/term/' + termId + '/ticket', { method: 'POST' })).json();
    const ws = new WebSocket('ws://' + location.host + '/ws/term?ticket=' + ticket);
    ws.onmessage = (e) => term.write(e.data);
    term.onData((d) => ws.send(d));
    term.onResize(({ cols, rows }) => ws.send('\\u0000resize:' + cols + 'x' + rows));
    window.wsReady = new Promise((res) => { ws.onopen = () => res(true); });
  })();
</script>
</body></html>`;
