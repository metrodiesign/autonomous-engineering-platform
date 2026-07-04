// Endpoint tests over injected fakes — no live SDK, no listening socket.
import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server.js';

const fakeSessions = [
  { sessionId: 's1', summary: 'fix bug', lastModified: Date.now() - 60_000, fileSize: 1234 },
  { sessionId: 's2', summary: 'add tests', lastModified: Date.now() - 120_000, fileSize: 999 },
];

function makeApp(env: Record<string, string | undefined> = {}) {
  return buildServer({
    env,
    listSessions: (async () => fakeSessions) as never,
    getSessionMessages: (async () => [{ type: 'user', text: 'hi' }]) as never,
    cliVersion: async () => '2.1.201 (Claude Code)',
  });
}

describe('console REST surface (Phase 0)', () => {
  it('GET /api/status carries disclaimer + cli version + auth', async () => {
    const r = await makeApp().inject({ url: '/api/status' });
    const body = r.json();
    expect(body.disclaimer).toMatch(/not an Anthropic product/);
    expect(body.cli).toContain('Claude Code');
    expect(body.auth.method).toBeDefined();
  });

  it('GET /api/sessions returns live session list', async () => {
    const r = await makeApp().inject({ url: '/api/sessions' });
    expect(r.json().sessions).toHaveLength(2);
  });

  it('GET /api/sessions/:id/messages streams history', async () => {
    const r = await makeApp().inject({ url: '/api/sessions/s1/messages' });
    expect(r.json().messages).toHaveLength(1);
  });

  it('GET /api/usage is labeled estimate (INV-13)', async () => {
    const body = (await makeApp().inject({ url: '/api/usage' })).json();
    expect(body.label).toMatch(/ประมาณ|estimate/i);
    expect(body.currentWindow.sessions).toBeGreaterThan(0);
  });

  it('GET /api/auth flags ANTHROPIC_API_KEY red without leaking the value', async () => {
    const r = await makeApp({ ANTHROPIC_API_KEY: 'sk-secret-value' }).inject({ url: '/api/auth' });
    expect(r.body).toContain('ANTHROPIC_API_KEY');
    expect(r.body).not.toContain('sk-secret-value');
    expect(r.json().warnings[0].severity).toBe('red');
  });

  it('GET / serves the Phase 0 page', async () => {
    const r = await makeApp().inject({ url: '/' });
    expect(r.body).toContain('Platform Console');
  });
});
