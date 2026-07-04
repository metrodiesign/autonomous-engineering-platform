// Phase 2 console extensions: valid files written, consent gate enforced, guards yield.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/server.js';

function makeApp(dir: string) {
  return buildServer({
    env: {},
    listSessions: (async () => []) as never,
    getSessionMessages: (async () => []) as never,
    cliVersion: async () => 'test',
    auditFile: join(dir, 'audit.jsonl'),
  });
}

describe('phase 2 extensions', () => {
  it('F-MCP writes valid .mcp.json (stdio + remote), rejects malformed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ext-'));
    const app = makeApp(dir);
    const ok = await app.inject({
      method: 'PUT', url: `/api/mcp?dir=${dir}`,
      payload: { name: 'files', server: { command: 'npx', args: ['-y', 'mcp-files'] } },
    });
    expect(ok.statusCode).toBe(200);
    const parsed = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'));
    expect(parsed.mcpServers.files.command).toBe('npx');

    const bad = await app.inject({ method: 'PUT', url: `/api/mcp?dir=${dir}`, payload: { name: 'x', server: {} } });
    expect(bad.statusCode).toBe(400);
  });

  it('F-Hook demands consent (428) then writes valid hook config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ext-'));
    const app = makeApp(dir);
    const noConsent = await app.inject({
      method: 'PUT', url: `/api/hooks/project?dir=${dir}`,
      payload: { event: 'PostToolUse', command: 'echo done' },
    });
    expect(noConsent.statusCode).toBe(428);

    const ok = await app.inject({
      method: 'PUT', url: `/api/hooks/project?dir=${dir}`,
      payload: { event: 'PostToolUse', matcher: 'Bash', command: 'echo done', consent: true },
    });
    expect(ok.statusCode).toBe(200);
    const settings = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'));
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toBe('echo done');

    const badEvent = await app.inject({
      method: 'PUT', url: `/api/hooks/project?dir=${dir}`,
      payload: { event: 'NotAnEvent', command: 'x', consent: true },
    });
    expect(badEvent.statusCode).toBe(400);
  });

  it('F-Sub writes valid frontmatter subagent file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ext-'));
    const app = makeApp(dir);
    const r = await app.inject({
      method: 'PUT', url: `/api/subagents?dir=${dir}`,
      payload: { name: 'test-runner', description: 'Runs tests', prompt: 'You run tests.', tools: ['Bash'] },
    });
    expect(r.statusCode).toBe(200);
    const md = readFileSync(join(dir, '.claude', 'agents', 'test-runner.md'), 'utf8');
    expect(md).toMatch(/^---\nname: test-runner\ndescription: Runs tests\ntools: Bash\n---/);
    expect(existsSync(join(dir, '.claude', 'agents', 'test-runner.md'))).toBe(true);

    const bad = await app.inject({
      method: 'PUT', url: `/api/subagents?dir=${dir}`,
      payload: { name: 'Bad Name!', description: 'x', prompt: 'y' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('automation guard yields when utilization over threshold', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ext-'));
    // 60 sessions in window -> utilization 60/50 > 0.85 threshold
    const now = Date.now();
    const app = buildServer({
      env: {},
      listSessions: (async () => Array.from({ length: 60 }, () => ({ sessionId: 'x', summary: '', lastModified: now - 1000, fileSize: 10 }))) as never,
      getSessionMessages: (async () => []) as never,
      cliVersion: async () => 'test',
      auditFile: join(dir, 'audit.jsonl'),
    });
    const r = (await app.inject({ url: '/api/guards/automation' })).json();
    expect(r.allowed).toBe(false);
    expect(r.policy.deferUntilReset).toBe(true);
    expect(r.policy.defaultAutomationModel).toBe('sonnet');
  });
});
