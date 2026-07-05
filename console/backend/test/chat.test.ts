// F-Chat Phase 3a — backend chat plumbing, exercised with an injected fake query engine (no claude
// binary, no network). Covers guards, streaming redaction, per-session lock, and abort lifecycle.
import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { createWsDispatcher } from '../src/ws-dispatcher.js';
import { registerChat, type ChatQueryFn } from '../src/chat.js';

// Fake engine: echoes each user turn into one assistant message; records close().
function fakeQueryFn(opts: { onClose?: () => void } = {}): ChatQueryFn {
  return ({ input, signal }) => {
    let closed = false;
    async function* gen(): AsyncGenerator<unknown> {
      for await (const turn of input) {
        if (closed || signal.aborted) return;
        yield { type: 'assistant', message: { role: 'assistant', content: `echo: ${turn.content}` } };
      }
    }
    return { messages: gen(), close: () => { closed = true; opts.onClose?.(); } };
  };
}

const apps: FastifyInstance[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) { try { s.close(); } catch { /* */ } }
  for (const a of apps.splice(0)) await a.close();
});

async function makeChatApp(opts: { queryFn?: ChatQueryFn; utilization?: () => Promise<number>; maxConcurrent?: number } = {}) {
  const app = Fastify();
  const wsd = createWsDispatcher(app.server);
  registerChat(app, wsd, {
    queryFn: opts.queryFn ?? fakeQueryFn(),
    audit: () => {},
    maxConcurrent: opts.maxConcurrent ?? 3,
    ...(opts.utilization ? { utilization: opts.utilization } : {}),
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  apps.push(app);
  return { port: (app.server.address() as AddressInfo).port };
}

const base = (port: number) => `http://127.0.0.1:${port}`;
async function newChat(port: number): Promise<{ status: number; id?: string }> {
  const r = await fetch(`${base(port)}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd: '/tmp' }) });
  if (r.status !== 200) return { status: r.status };
  return { status: 200, id: (await r.json() as { id: string }).id };
}
async function ticket(port: number, id: string): Promise<string> {
  return (await (await fetch(`${base(port)}/api/chat/${id}/ticket`, { method: 'POST' })).json() as { ticket: string }).ticket;
}
async function listChats(port: number): Promise<{ id: string }[]> {
  return (await (await fetch(`${base(port)}/api/chat`)).json() as { chats: { id: string }[] }).chats;
}

function openChat(port: number, tk: string): Promise<{ ws: WebSocket; open: boolean }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/chat?ticket=${encodeURIComponent(tk)}`);
    sockets.push(ws);
    ws.on('open', () => resolve({ ws, open: true }));
    ws.on('close', () => resolve({ ws, open: false }));
    ws.on('error', () => { /* rejected handshake resolves via close */ });
  });
}

// send one user turn, collect frames until the assistant reply, then close from the client
function exchange(port: number, tk: string, userText: string): Promise<{ open: boolean; frames: Array<Record<string, unknown>> }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/chat?ticket=${encodeURIComponent(tk)}`);
    sockets.push(ws);
    const frames: Array<Record<string, unknown>> = [];
    let opened = false;
    ws.on('open', () => { opened = true; ws.send(JSON.stringify({ content: userText })); });
    ws.on('message', (m) => {
      const f = JSON.parse(m.toString()) as Record<string, unknown>;
      frames.push(f);
      if (f.type === 'assistant') setTimeout(() => { try { ws.close(); } catch { /* */ } }, 10);
    });
    ws.on('close', () => resolve({ open: opened, frames }));
    ws.on('error', () => {});
  });
}

describe('F-Chat backend (Phase 3a)', () => {
  it('creates and lists a chat session', async () => {
    const { port } = await makeChatApp();
    const c = await newChat(port);
    expect(c.status).toBe(200);
    expect((await listChats(port)).map((x) => x.id)).toContain(c.id);
  });

  it('rejects over the concurrency cap', async () => {
    const { port } = await makeChatApp({ maxConcurrent: 1 });
    expect((await newChat(port)).status).toBe(200);
    expect((await newChat(port)).status).toBe(429);
  });

  it('yields (429) when the window is near quota', async () => {
    const { port } = await makeChatApp({ utilization: async () => 0.9 });
    expect((await newChat(port)).status).toBe(429);
  });

  it('streams an assistant reply with secrets redacted (INV-14)', async () => {
    const { port } = await makeChatApp();
    const { id } = await newChat(port);
    const r = await exchange(port, await ticket(port, id!), 'my key sk-ant-ABCDEFGH12345678 done');
    const assistant = r.frames.find((f) => f.type === 'assistant');
    expect(assistant).toBeDefined();
    const wire = JSON.stringify(assistant);
    expect(wire).toContain('***REDACTED***');
    expect(wire).not.toContain('sk-ant-ABCDEFGH');
  });

  it('closing the WS aborts the session (close() called, session removed)', async () => {
    let closed = false;
    const { port } = await makeChatApp({ queryFn: fakeQueryFn({ onClose: () => { closed = true; } }) });
    const { id } = await newChat(port);
    await exchange(port, await ticket(port, id!), 'hi');
    await new Promise((r) => setTimeout(r, 20));
    expect(closed).toBe(true);
    expect((await listChats(port)).length).toBe(0);
  });

  it('per-session lock: a second WS attach is rejected while one is live', async () => {
    const { port } = await makeChatApp();
    const { id } = await newChat(port);
    const first = await openChat(port, await ticket(port, id!));
    expect(first.open).toBe(true);
    const second = await openChat(port, await ticket(port, id!));
    expect(second.open).toBe(false);
    first.ws.close();
  });

  it('rejects an unknown/expired ticket', async () => {
    const { port } = await makeChatApp();
    await newChat(port);
    expect((await openChat(port, 'bogus-ticket')).open).toBe(false);
  });

  it('serves the standalone /chat page', async () => {
    const { port } = await makeChatApp();
    const r = await fetch(`${base(port)}/chat?project=/tmp`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('F-Chat');
    expect(html).toContain('/ws/chat');
  });
});
