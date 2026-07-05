// F-Term WS dispatcher — regression guard for the Phase 2 refactor (terminal.ts moved from its own
// app.server.on('upgrade') to the shared createWsDispatcher). These assert the observable /ws/term
// contract stays exact: single-use ticket, peer-guard, expired ticket, unknown path, close code 4403.
import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { PtyManager, type SpawnOptions, type TermSession } from '../src/pty-manager.js';
import { registerTerminal } from '../src/terminal.js';
import { createWsDispatcher } from '../src/ws-dispatcher.js';

// In-memory PtyManager: never spawns the real `claude` binary. attach() throws for a killed/unknown id
// (mirroring the real mustGet), which is how the 4403 path is exercised.
class FakePtyManager extends PtyManager {
  private live = new Map<string, TermSession>();
  private n = 0;
  constructor() { super(() => {}); }
  override spawn(opts: SpawnOptions): TermSession {
    const meta: TermSession = { id: `term-fake-${++this.n}`, cwd: opts.cwd, mode: opts.mode ?? 'claude-only', createdAt: 1, alive: true };
    this.live.set(meta.id, meta);
    return meta;
  }
  override list(): TermSession[] { return [...this.live.values()]; }
  override attach(id: string, _onData: (d: string) => void): { replay: string; detach: () => void } {
    if (!this.live.has(id)) throw new Error(`unknown terminal ${id}`);
    return { replay: 'SEED', detach: () => {} };
  }
  override write(): void {}
  override resize(): void {}
  override kill(id: string): void { this.live.delete(id); }
}

const apps: FastifyInstance[] = [];
afterEach(async () => { for (const a of apps.splice(0)) await a.close(); });

async function makeTermApp(opts: { peerAllowed?: (p: string) => boolean; ticketTtlMs?: number } = {}) {
  const app = Fastify();
  const ptys = new FakePtyManager();
  const wsd = createWsDispatcher(app.server);
  registerTerminal(app, ptys, wsd, {
    peerAllowed: opts.peerAllowed ?? (() => true),
    ...(opts.ticketTtlMs !== undefined ? { ticketTtlMs: opts.ticketTtlMs } : {}),
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  apps.push(app);
  return { app, ptys, port: (app.server.address() as AddressInfo).port };
}

async function newTicket(port: number): Promise<{ id: string; ticket: string }> {
  const base = `http://127.0.0.1:${port}`;
  const created = await (await fetch(`${base}/api/term`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd: '/tmp' }),
  })).json() as { id: string };
  const t = await (await fetch(`${base}/api/term/${created.id}/ticket`, { method: 'POST' })).json() as { ticket: string };
  return { id: created.id, ticket: t.ticket };
}

interface Probe { open: boolean; closeCode?: number; firstMsg?: string }
function probe(port: number, ticket: string, path = '/ws/term'): Promise<Probe> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}?ticket=${encodeURIComponent(ticket)}`);
    let firstMsg: string | undefined;
    let opened = false;
    ws.on('message', (m) => { if (firstMsg === undefined) firstMsg = m.toString(); });
    ws.on('open', () => {
      opened = true;
      setTimeout(() => { try { ws.close(); } catch { /* already closed */ } resolve({ open: true, firstMsg }); }, 40);
    });
    ws.on('close', (code) => resolve({ open: opened, closeCode: code, firstMsg }));
    ws.on('error', () => { /* a failed handshake resolves through the close event */ });
  });
}

describe('F-Term WS dispatcher — regression (Phase 2)', () => {
  it('valid ticket opens the WS and replays the buffer', async () => {
    const { port } = await makeTermApp();
    const { ticket } = await newTicket(port);
    const r = await probe(port, ticket);
    expect(r.open).toBe(true);
    expect(r.firstMsg).toBe('SEED');
  });

  it('ticket is single-use — reuse is rejected', async () => {
    const { port } = await makeTermApp();
    const { ticket } = await newTicket(port);
    expect((await probe(port, ticket)).open).toBe(true);
    expect((await probe(port, ticket)).open).toBe(false);
  });

  it('unknown ticket is rejected', async () => {
    const { port } = await makeTermApp();
    expect((await probe(port, 'not-a-real-ticket')).open).toBe(false);
  });

  it('expired ticket is rejected', async () => {
    const { port } = await makeTermApp({ ticketTtlMs: 10 });
    const { ticket } = await newTicket(port);
    await new Promise((r) => setTimeout(r, 30));
    expect((await probe(port, ticket)).open).toBe(false);
  });

  it('peer-guard rejects a disallowed peer before upgrade', async () => {
    const { port } = await makeTermApp({ peerAllowed: () => false });
    const { ticket } = await newTicket(port);
    expect((await probe(port, ticket)).open).toBe(false);
  });

  it('unknown WS path is destroyed by the dispatcher', async () => {
    const { port } = await makeTermApp();
    expect((await probe(port, 'x', '/ws/nope')).open).toBe(false);
  });

  it('closes with 4403 when the PTY is gone', async () => {
    const { port, ptys } = await makeTermApp();
    const { id, ticket } = await newTicket(port);
    ptys.kill(id); // remove the term so attach() throws
    expect((await probe(port, ticket)).closeCode).toBe(4403);
  });
});
