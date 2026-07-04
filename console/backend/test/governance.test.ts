// F-Set/F-Perm/F-Mem: scoped writes with CAS, merged permission view + simulator, golden protection.
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
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

describe('governance endpoints (Phase 1)', () => {
  it('PUT settings at project scope, GET returns them, CAS blocks stale writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gov-'));
    const app = makeApp(dir);
    const put = await app.inject({
      method: 'PUT', url: `/api/settings/project?dir=${dir}`,
      payload: { settings: { model: 'sonnet' } },
    });
    expect(put.statusCode).toBe(200);
    const get = await app.inject({ url: `/api/settings/project?dir=${dir}` });
    expect(get.json().settings.model).toBe('sonnet');

    const stale = await app.inject({
      method: 'PUT', url: `/api/settings/project?dir=${dir}`,
      payload: { settings: { model: 'opus' }, expectedHash: 'deadbeef00000000' },
    });
    expect(stale.statusCode).toBe(409);
  });

  it('permissions write lands in the right scope and merged view + simulator work', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gov-'));
    const app = makeApp(dir);
    await app.inject({
      method: 'PUT', url: `/api/permissions/project?dir=${dir}`,
      payload: { deny: ['Write(test/golden/**)'], allow: ['Bash(echo *)'] },
    });
    const view = await app.inject({ url: `/api/permissions/merged/view?dir=${dir}&tool=Write&arg=test/golden/x.txt` });
    const body = view.json();
    expect(body.merged.some((m: { rule: string; scope: string }) => m.scope === 'project' && m.rule.includes('golden'))).toBe(true);
    expect(body.simulation.decision).toBe('deny');
  });

  it('protect-golden installer adds deny rules for golden + worktrees', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gov-'));
    const app = makeApp(dir);
    const r = await app.inject({ method: 'POST', url: `/api/permissions/protect-golden?dir=${dir}` });
    expect(r.json().deny).toContain('Write(test/golden/**)');
    expect(r.json().deny).toContain('Edit(worktrees/**)');
  });

  it('memory editor round-trips project CLAUDE.md', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gov-'));
    const app = makeApp(dir);
    await app.inject({ method: 'PUT', url: `/api/memory/project?dir=${dir}`, payload: { content: '# rules\n' } });
    const get = await app.inject({ url: `/api/memory/project?dir=${dir}` });
    expect(get.json().content).toBe('# rules\n');
    expect(get.json().note).toMatch(/guidance/);
  });

  it('effective view returns provenance for all scopes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gov-'));
    const app = makeApp(dir);
    const r = await app.inject({ url: `/api/settings/effective/view?dir=${dir}` });
    expect(r.json().provenance).toHaveLength(3);
  });
});
