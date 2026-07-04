// F-Set / F-Perm / F-Mem (§8, Phase 1): multi-scope editors over live files (INV-11),
// forced scope picker (scope is in the path), write safety (validate -> mtime CAS -> atomic rename).
import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveSettings } from '@anthropic-ai/claude-agent-sdk';

type Scope = 'user' | 'project' | 'local';

function settingsPath(scope: Scope, projectDir: string): string {
  switch (scope) {
    case 'user': return join(homedir(), '.claude', 'settings.json');
    case 'project': return join(projectDir, '.claude', 'settings.json');
    case 'local': return join(projectDir, '.claude', 'settings.local.json');
  }
}

function memoryPath(scope: 'user' | 'project', projectDir: string): string {
  return scope === 'user' ? join(homedir(), '.claude', 'CLAUDE.md') : join(projectDir, 'CLAUDE.md');
}

const fileHash = (p: string) => (existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16) : 'absent');

/** atomic write with optimistic concurrency (§8 write safety) */
function safeWrite(path: string, content: string, expectedHash?: string): { ok: boolean; reason?: string; hash?: string } {
  if (expectedHash !== undefined && fileHash(path) !== expectedHash) {
    return { ok: false, reason: `concurrent modification: file hash changed (expected ${expectedHash})` };
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
  return { ok: true, hash: fileHash(path) };
}

export function registerGovernance(app: FastifyInstance, audit: (e: Record<string, unknown>) => void): void {
  // ---- F-Set ----
  app.get<{ Params: { scope: Scope }; Querystring: { dir?: string } }>(
    '/api/settings/:scope',
    async (req, reply) => {
      const { scope } = req.params;
      if (!['user', 'project', 'local'].includes(scope)) return reply.code(400).send({ error: 'scope must be user|project|local' });
      const p = settingsPath(scope, req.query.dir ?? process.cwd());
      const raw = existsSync(p) ? readFileSync(p, 'utf8') : '{}';
      return { scope, path: p, hash: fileHash(p), settings: JSON.parse(raw), applyTiming: 'next session start (running sessions keep old settings)' };
    },
  );

  app.put<{ Params: { scope: Scope }; Querystring: { dir?: string }; Body: { settings: unknown; expectedHash?: string } }>(
    '/api/settings/:scope',
    async (req, reply) => {
      const { scope } = req.params;
      if (!['user', 'project', 'local'].includes(scope)) return reply.code(400).send({ error: 'scope must be user|project|local' });
      if (typeof req.body?.settings !== 'object' || req.body.settings === null || Array.isArray(req.body.settings)) {
        return reply.code(400).send({ error: 'settings must be a JSON object' }); // schema validation, minimal tier
      }
      const p = settingsPath(scope, req.query.dir ?? process.cwd());
      const r = safeWrite(p, JSON.stringify(req.body.settings, null, 2) + '\n', req.body.expectedHash);
      if (!r.ok) return reply.code(409).send({ error: r.reason });
      audit({ type: 'SETTINGS_WRITE', scope, path: p, ts: Date.now() });
      return { ok: true, hash: r.hash, applyTiming: 'next session start' };
    },
  );

  // Effective View (§8 F-Set): resolveSettings + provenance per scope file
  app.get<{ Querystring: { dir?: string } }>('/api/settings/effective/view', async (req) => {
    const dir = req.query.dir ?? process.cwd();
    const effective = await resolveSettings({ cwd: dir } as never).catch((e: unknown) => ({ error: String(e) }));
    const provenance = (['user', 'project', 'local'] as Scope[]).map((scope) => {
      const p = settingsPath(scope, dir);
      return { scope, path: p, present: existsSync(p), hash: fileHash(p) };
    });
    return { effective, provenance };
  });

  // ---- F-Perm ----
  app.put<{ Params: { scope: Scope }; Querystring: { dir?: string }; Body: { allow?: string[]; deny?: string[]; ask?: string[]; expectedHash?: string } }>(
    '/api/permissions/:scope',
    async (req, reply) => {
      const { scope } = req.params;
      const p = settingsPath(scope, req.query.dir ?? process.cwd());
      const cur = existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>) : {};
      const perms = (cur.permissions as Record<string, unknown>) ?? {};
      for (const k of ['allow', 'deny', 'ask'] as const) {
        const v = req.body?.[k];
        if (v !== undefined) {
          if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return reply.code(400).send({ error: `${k} must be string[]` });
          perms[k] = v;
        }
      }
      cur.permissions = perms;
      const r = safeWrite(p, JSON.stringify(cur, null, 2) + '\n', req.body?.expectedHash);
      if (!r.ok) return reply.code(409).send({ error: r.reason });
      audit({ type: 'PERMISSIONS_WRITE', scope, path: p, ts: Date.now() });
      return { ok: true, hash: r.hash, permissions: perms };
    },
  );

  // merged view across scopes + naive simulator (first-match precedence deny > ask > allow)
  app.get<{ Querystring: { dir?: string; tool?: string; arg?: string } }>('/api/permissions/merged/view', async (req) => {
    const dir = req.query.dir ?? process.cwd();
    const merged: { scope: Scope; rule: string; kind: 'allow' | 'deny' | 'ask' }[] = [];
    for (const scope of ['local', 'project', 'user'] as Scope[]) {
      const p = settingsPath(scope, dir);
      if (!existsSync(p)) continue;
      const perms = (JSON.parse(readFileSync(p, 'utf8')).permissions ?? {}) as Record<string, string[]>;
      for (const kind of ['deny', 'ask', 'allow'] as const) {
        for (const rule of perms[kind] ?? []) merged.push({ scope, rule, kind });
      }
    }
    let simulation: { decision: string; matchedRule?: string } | null = null;
    if (req.query.tool) {
      const target = `${req.query.tool}(${req.query.arg ?? ''})`;
      const match = merged.find((m) => {
        const re = new RegExp('^' + m.rule.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
        return re.test(target) || re.test(req.query.tool ?? '');
      });
      simulation = match ? { decision: match.kind, matchedRule: `${match.scope}:${match.rule}` } : { decision: 'default (ask)' };
    }
    return { merged, simulation };
  });

  // one-click installer: deny rules protecting golden tests + worktrees from interactive sessions (§4)
  app.post<{ Querystring: { dir?: string } }>('/api/permissions/protect-golden', async (req) => {
    const dir = req.query.dir ?? process.cwd();
    const p = settingsPath('project', dir);
    const cur = existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>) : {};
    const perms = (cur.permissions as Record<string, string[]>) ?? {};
    const needed = ['Write(test/golden/**)', 'Edit(test/golden/**)', 'Write(worktrees/**)', 'Edit(worktrees/**)'];
    perms.deny = [...new Set([...(perms.deny ?? []), ...needed])];
    cur.permissions = perms;
    const r = safeWrite(p, JSON.stringify(cur, null, 2) + '\n');
    audit({ type: 'GOLDEN_PROTECTION_INSTALLED', path: p, ts: Date.now() });
    return { ok: r.ok, deny: perms.deny };
  });

  // ---- F-Mem ----
  app.get<{ Params: { scope: 'user' | 'project' }; Querystring: { dir?: string } }>(
    '/api/memory/:scope',
    async (req, reply) => {
      if (!['user', 'project'].includes(req.params.scope)) return reply.code(400).send({ error: 'scope must be user|project' });
      const p = memoryPath(req.params.scope, req.query.dir ?? process.cwd());
      return {
        path: p, hash: fileHash(p), content: existsSync(p) ? readFileSync(p, 'utf8') : '',
        note: 'memory is guidance for sessions, not enforcement — use permissions for enforcement',
      };
    },
  );

  app.put<{ Params: { scope: 'user' | 'project' }; Querystring: { dir?: string }; Body: { content: string; expectedHash?: string } }>(
    '/api/memory/:scope',
    async (req, reply) => {
      if (!['user', 'project'].includes(req.params.scope)) return reply.code(400).send({ error: 'scope must be user|project' });
      if (typeof req.body?.content !== 'string') return reply.code(400).send({ error: 'content must be string' });
      const p = memoryPath(req.params.scope, req.query.dir ?? process.cwd());
      const r = safeWrite(p, req.body.content, req.body.expectedHash);
      if (!r.ok) return reply.code(409).send({ error: r.reason });
      audit({ type: 'MEMORY_WRITE', scope: req.params.scope, path: p, ts: Date.now() });
      return { ok: true, hash: r.hash };
    },
  );
}
