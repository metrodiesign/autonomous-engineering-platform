// F-Chat Phase 3a — backend: sandboxed SDK query() chat sessions over the shared WS dispatcher.
//
// The query() engine is INJECTABLE (deps.queryFn). The default wraps the real SDK and is marked
// unverified — it needs the `claude` binary + auth to exercise, like the D-007 adapters — so every tested
// path injects a fake. Security posture is Phase 1's makeChatSandbox (Read-only, fail-closed broker).
// Outbound is redacted per message (INV-14). A closed WS aborts the session (terminates the subprocess).
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { WsDispatcher } from './ws-dispatcher.js';
import { makeChatSandbox } from './chat-permission.js';
import { redactJson } from './redact.js';

export interface ChatUserTurn { content: string }

export interface ChatSessionQuery {
  /** outbound assistant/tool/result messages */
  messages: AsyncIterable<unknown>;
  /** abort + terminate the underlying process */
  close(): void;
}

export type ChatQueryFn = (args: { input: AsyncIterable<ChatUserTurn>; cwd: string; signal: AbortSignal }) => ChatSessionQuery;

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
// ponytail: unverified against the real claude binary (needs auth) — the tested path injects a fake.
// Real run gated like D-007.
const sdkQueryFn: ChatQueryFn = ({ input, cwd, signal }) => {
  const sandbox = makeChatSandbox(cwd);
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

  app.post<{ Body: { cwd?: string } }>('/api/chat', async (req, reply) => {
    const cwd = req.body?.cwd;
    if (!cwd) return reply.code(400).send({ error: 'cwd required' });
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
    sessions.set(id, { id, cwd, controller: new AbortController(), input: makeInputQueue(), attached: false, createdAt: t });
    deps.audit({ type: 'CHAT_SPAWN', chatId: id, cwd, ts: t });
    return { id };
  });

  app.get('/api/chat', async () => ({ chats: [...sessions.values()].map((s) => ({ id: s.id, cwd: s.cwd, attached: s.attached, createdAt: s.createdAt })) }));

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
      const q = queryFn({ input: session.input, cwd: session.cwd, signal: session.controller.signal });
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
