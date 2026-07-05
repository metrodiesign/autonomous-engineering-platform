// F-Chat Phase 3a — backend: sandboxed SDK query() chat sessions over the shared WS dispatcher.
//
// The query() engine is INJECTABLE (deps.queryFn). The default wraps the real SDK. It was verified live
// against the real claude binary on 2026-07-05 via scripts/chat-smoke.mjs (system -> assistant -> result,
// sandboxed Read); CI still injects a fake (deterministic, no network). Security posture is Phase 1's
// makeChatSandbox (Read-only, fail-closed broker).
// Outbound is redacted per message (INV-14). A closed WS aborts the session (terminates the subprocess).
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { WsDispatcher } from './ws-dispatcher.js';
import { makeChatSandbox } from './chat-permission.js';
import { redactJson } from './redact.js';
import { safeJsonForScript } from './terminal.js';

export interface ChatUserTurn { content: string }

export interface ChatSessionQuery {
  /** outbound assistant/tool/result messages */
  messages: AsyncIterable<unknown>;
  /** abort + terminate the underlying process */
  close(): void;
}

export type ChatQueryFn = (args: { input: AsyncIterable<ChatUserTurn>; cwd: string; resume?: string; signal: AbortSignal }) => ChatSessionQuery;

/** A pushable async iterable of user turns fed into query()'s streaming input. */
interface InputQueue extends AsyncIterable<ChatUserTurn> {
  push(t: ChatUserTurn): void;
  close(): void;
}
function makeInputQueue(): InputQueue {
  const items: ChatUserTurn[] = [];
  let waiting: ((r: IteratorResult<ChatUserTurn>) => void) | null = null;
  let done = false;
  return {
    push(t) {
      if (done) return;
      if (waiting) { waiting({ value: t, done: false }); waiting = null; } else items.push(t);
    },
    close() {
      done = true;
      if (waiting) { waiting({ value: undefined as unknown as ChatUserTurn, done: true }); waiting = null; }
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (items.length) { yield items.shift()!; continue; }
        if (done) return;
        const r = await new Promise<IteratorResult<ChatUserTurn>>((res) => { waiting = res; });
        if (r.done) return;
        yield r.value;
      }
    },
  };
}

// Default engine: the real SDK query(), sandboxed by makeChatSandbox.
// Verified live via scripts/chat-smoke.mjs (2026-07-05, claude 2.1.201, OAuth); CI injects a fake.
export const sdkQueryFn: ChatQueryFn = ({ input, cwd, resume, signal }) => {
  const sandbox = makeChatSandbox(cwd, resume);
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    for await (const turn of input) {
      yield { type: 'user', message: { role: 'user', content: turn.content }, parent_tool_use_id: null };
    }
  }
  const q = query({ prompt: prompt(), options: sandbox });
  signal.addEventListener('abort', () => { try { q.close(); } catch { /* already closed */ } });
  return { messages: q, close: () => { try { q.close(); } catch { /* already closed */ } } };
};

interface ChatSession {
  id: string;
  cwd: string;
  resume?: string;
  controller: AbortController;
  input: InputQueue;
  attached: boolean;
  query?: ChatSessionQuery;
  createdAt: number;
}

export interface ChatDeps {
  queryFn?: ChatQueryFn;
  audit: (e: Record<string, unknown>) => void;
  peerAllowed?: (peer: string) => boolean;
  utilization?: () => Promise<number>;
  maxConcurrent?: number;
  ticketTtlMs?: number;
  now?: () => number;
}

export function registerChat(app: FastifyInstance, wsd: WsDispatcher, deps: ChatDeps): void {
  const queryFn = deps.queryFn ?? sdkQueryFn;
  const peerAllowed = deps.peerAllowed ?? (() => true);
  const maxConcurrent = deps.maxConcurrent ?? 3;
  const ticketTtlMs = deps.ticketTtlMs ?? 30_000;
  const now = deps.now ?? Date.now;

  const sessions = new Map<string, ChatSession>();
  const tickets = new Map<string, { chatId: string; expires: number }>();
  let spawnTimes: number[] = [];

  function closeSession(id: string, reason: string): void {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    s.controller.abort();
    s.input.close();
    try { s.query?.close(); } catch { /* already closed */ }
    deps.audit({ type: 'CHAT_CLOSE', chatId: id, reason, ts: now() });
  }

  app.post<{ Body: { cwd?: string; resume?: string } }>('/api/chat', async (req, reply) => {
    const cwd = req.body?.cwd;
    if (!cwd) return reply.code(400).send({ error: 'cwd required' });
    const resume = req.body?.resume;
    if (resume !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(resume)) {
      return reply.code(400).send({ error: 'resume must be a session UUID' });
    }
    const t = now();
    spawnTimes = spawnTimes.filter((x) => t - x < 10_000);
    if (spawnTimes.length >= 5) return reply.code(429).send({ error: 'chat spawn rate limit (5/10s)' });
    if (sessions.size >= maxConcurrent) return reply.code(429).send({ error: `max concurrent chat sessions (${maxConcurrent})` });
    if (deps.utilization) {
      const u = await deps.utilization();
      if (u >= 0.85) return reply.code(429).send({ error: 'chat yields to interactive/scheduled work — window near quota (INV-13)' });
    }
    spawnTimes.push(t);
    const id = `chat-${randomBytes(5).toString('hex')}`;
    sessions.set(id, { id, cwd, controller: new AbortController(), input: makeInputQueue(), attached: false, createdAt: t, ...(resume ? { resume } : {}) });
    deps.audit({ type: 'CHAT_SPAWN', chatId: id, cwd, resume, ts: t });
    return { id };
  });

  app.get('/api/chat', async () => ({ chats: [...sessions.values()].map((s) => ({ id: s.id, cwd: s.cwd, attached: s.attached, createdAt: s.createdAt })) }));

  // Standalone chat page (like /terminal): owns its own WS lifecycle in a dedicated tab.
  app.get<{ Querystring: { project?: string; resume?: string } }>('/chat', async (req, reply) => {
    reply.type('text/html').send(CHAT_HTML(safeJsonForScript({ project: req.query.project ?? process.cwd(), resume: req.query.resume ?? null })));
  });

  app.post<{ Params: { id: string } }>('/api/chat/:id/ticket', async (req, reply) => {
    if (!sessions.has(req.params.id)) return reply.code(404).send({ error: 'unknown chat session' });
    const ticket = randomBytes(16).toString('hex');
    tickets.set(ticket, { chatId: req.params.id, expires: now() + ticketTtlMs });
    return { ticket };
  });

  app.delete<{ Params: { id: string } }>('/api/chat/:id', async (req, reply) => {
    if (!sessions.has(req.params.id)) return reply.code(404).send({ error: 'unknown chat session' });
    closeSession(req.params.id, 'deleted');
    return { closed: true };
  });

  wsd.register('/ws/chat', (req, socket, _head, url, upgrade) => {
    if (!peerAllowed(req.socket?.remoteAddress ?? '')) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = url.searchParams.get('ticket') ?? '';
    const t = tickets.get(key);
    tickets.delete(key); // single-use
    if (!t || t.expires < now()) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const session = sessions.get(t.chatId);
    if (!session || session.attached) {
      socket.write('HTTP/1.1 409 Conflict\r\n\r\n'); // gone, or already has a live socket (per-session lock)
      socket.destroy();
      return;
    }
    session.attached = true;
    upgrade((ws) => {
      const q = queryFn({ input: session.input, cwd: session.cwd, signal: session.controller.signal, ...(session.resume ? { resume: session.resume } : {}) });
      session.query = q;
      ws.on('message', (m) => {
        try {
          const parsed = JSON.parse(m.toString()) as { content?: unknown };
          if (typeof parsed.content === 'string' && parsed.content.length) session.input.push({ content: parsed.content });
        } catch { /* ignore malformed frames */ }
      });
      ws.on('close', () => closeSession(session.id, 'ws_close'));
      void (async () => {
        try {
          for await (const msg of q.messages) {
            if (ws.readyState !== 1) break;
            ws.send(JSON.stringify(redactJson(msg))); // INV-14: redact every outbound message
          }
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'chat_end' }));
        } catch (e) {
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'chat_error', message: redactJson(String(e)) }));
        } finally {
          closeSession(session.id, 'stream_end');
          try { ws.close(); } catch { /* already closed */ }
        }
      })();
    });
  });
}

// Standalone chat UI. Model content is rendered via textContent (never innerHTML) so a crafted
// assistant/tool string cannot inject markup (Codex review). Responsive + theme-aware.
const CHAT_HTML = (bootJson: string): string => /* html */ `<!doctype html>
<html><head><meta charset="utf-8"><title>Chat — Platform Console</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark;
    --bg:#f6f7f9; --surface:#fff; --fg:#1a1d21; --muted:#6b7280; --line:#e5e7eb;
    --accent:#4f46e5; --accent-fg:#fff; --tool:#0f766e; --err:#b91c1c; }
  @media (prefers-color-scheme: dark) { :root {
    --bg:#0d0f12; --surface:#16191d; --fg:#e6e8eb; --muted:#8b94a0; --line:#262b31;
    --accent:#7c7bff; --accent-fg:#0d0f12; --tool:#2dd4bf; --err:#f87171; } }
  * { box-sizing:border-box; }
  html,body { margin:0; height:100%; }
  body { display:flex; flex-direction:column; background:var(--bg); color:var(--fg);
    font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  #bar { padding:8px 14px; font-size:12px; color:var(--muted); background:var(--surface);
    border-bottom:1px solid var(--line); flex-shrink:0; }
  #bar b { color:var(--fg); }
  #log { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:10px;
    max-width:820px; width:100%; margin:0 auto; }
  .msg { padding:9px 13px; border-radius:12px; white-space:pre-wrap; word-break:break-word; max-width:88%; }
  .msg.user { align-self:flex-end; background:var(--accent); color:var(--accent-fg); border-bottom-right-radius:4px; }
  .msg.assistant { align-self:flex-start; background:var(--surface); border:1px solid var(--line); border-bottom-left-radius:4px; }
  .msg.tool { align-self:flex-start; font:12px/1.5 ui-monospace,Menlo,monospace; color:var(--tool);
    background:transparent; border:1px dashed var(--line); }
  .msg.error { align-self:flex-start; color:var(--err); border:1px solid var(--err); background:transparent; }
  #composer { display:flex; gap:8px; padding:12px 16px; border-top:1px solid var(--line); background:var(--surface);
    max-width:820px; width:100%; margin:0 auto; }
  #msg { flex:1; resize:none; font:inherit; color:var(--fg); background:var(--bg);
    border:1px solid var(--line); border-radius:10px; padding:9px 12px; max-height:140px; }
  #msg:focus { outline:none; border-color:var(--accent); }
  #send { font:inherit; font-weight:600; padding:0 18px; border-radius:10px; border:none;
    background:var(--accent); color:var(--accent-fg); cursor:pointer; }
  #send:disabled { opacity:.5; cursor:default; }
  @media (max-width:600px) { #log,#composer { max-width:100%; } .msg { max-width:94%; } }
</style></head>
<body>
<div id="bar"><b>F-Chat</b> — sandboxed read-only claude (Read files + reason; no exec — use Terminal for that) <span id="status">· starting…</span></div>
<div id="log"></div>
<form id="composer">
  <textarea id="msg" rows="1" placeholder="Ask about the code… (Enter to send, Shift+Enter for newline)" aria-label="message"></textarea>
  <button id="send" type="submit" disabled>Send</button>
</form>
<script>
  const BOOT = ${bootJson};
  const log = document.getElementById('log');
  const statusEl = document.getElementById('status');
  const sendBtn = document.getElementById('send');
  const msg = document.getElementById('msg');
  if (BOOT.resume) document.getElementById('bar').insertAdjacentText('beforeend', ' · resuming ' + String(BOOT.resume).slice(0, 8));
  function bubble(cls) { const d = document.createElement('div'); d.className = 'msg ' + cls; log.appendChild(d); return d; }
  function addText(cls, text) { const d = bubble(cls); d.textContent = text; log.scrollTop = log.scrollHeight; return d; }
  function renderAssistant(message) {
    const content = message && message.content;
    if (typeof content === 'string') { if (content) addText('assistant', content); return; }
    if (Array.isArray(content)) for (const b of content) {
      if (b && b.type === 'text') addText('assistant', b.text || '');
      else if (b && b.type === 'tool_use') addText('tool', '→ ' + b.name + ' ' + JSON.stringify(b.input || {}));
    }
  }
  function setSend(on) { sendBtn.disabled = !on; }
  function handleFrame(f) {
    if (!f || !f.type) return;
    if (f.type === 'assistant') renderAssistant(f.message);
    else if (f.type === 'result') statusEl.textContent = '· ready';
    else if (f.type === 'chat_end') { statusEl.textContent = '· session ended'; setSend(false); }
    else if (f.type === 'chat_error') addText('error', 'error: ' + (f.message || ''));
  }
  let ws = null;
  (async () => {
    try {
      const body = { cwd: BOOT.project };
      if (BOOT.resume) body.resume = BOOT.resume;
      const created = await (await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
      if (!created.id) { statusEl.textContent = '· ' + (created.error || 'could not start'); return; }
      const t = await (await fetch('/api/chat/' + created.id + '/ticket', { method: 'POST' })).json();
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(proto + '//' + location.host + '/ws/chat?ticket=' + t.ticket);
      ws.onopen = () => { statusEl.textContent = '· connected · cwd ' + BOOT.project; setSend(true); msg.focus(); };
      ws.onmessage = (e) => { try { handleFrame(JSON.parse(e.data)); } catch (_) { /* ignore */ } };
      ws.onclose = () => { statusEl.textContent = '· disconnected'; setSend(false); };
      ws.onerror = () => { statusEl.textContent = '· connection error'; };
    } catch (e) { statusEl.textContent = '· ' + e; }
  })();
  const form = document.getElementById('composer');
  form.onsubmit = (e) => {
    e.preventDefault();
    const text = msg.value.trim();
    if (!text || !ws || ws.readyState !== 1) return;
    addText('user', text);
    ws.send(JSON.stringify({ content: text }));
    msg.value = ''; msg.style.height = 'auto';
  };
  msg.addEventListener('input', () => { msg.style.height = 'auto'; msg.style.height = Math.min(msg.scrollHeight, 140) + 'px'; });
  msg.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
</script>
</body></html>`;
