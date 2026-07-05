// F-Sess ops (§8): rename/tag/fork/export/prune via SDK + FTS5 search. All writes audited.
import type { FastifyInstance } from 'fastify';
import {
  renameSession, tagSession, forkSession, deleteSession, getSessionMessages,
} from '@anthropic-ai/claude-agent-sdk';
import type { SessionSearch } from './search.js';
import type { ActionRegistry } from './actions.js';
import { redactJson } from './redact.js';

export interface SessionOpsDeps {
  renameSession?: typeof renameSession;
  tagSession?: typeof tagSession;
  forkSession?: typeof forkSession;
  deleteSession?: typeof deleteSession;
  getSessionMessages?: typeof getSessionMessages;
  search: SessionSearch;
  actions: ActionRegistry;
  audit: (e: Record<string, unknown>) => void;
}

export function registerSessionOps(app: FastifyInstance, deps: SessionOpsDeps): void {
  const rn = deps.renameSession ?? renameSession;
  const tg = deps.tagSession ?? tagSession;
  const fk = deps.forkSession ?? forkSession;
  const del = deps.deleteSession ?? deleteSession;
  const gsm = deps.getSessionMessages ?? getSessionMessages;
  const { search, actions, audit } = deps;

  app.post<{ Params: { id: string }; Body: { title?: string; dir?: string } }>(
    '/api/sessions/:id/rename',
    async (req, reply) => {
      const title = req.body?.title?.trim();
      if (!title) return reply.code(400).send({ error: 'title required' });
      await rn(req.params.id, title, req.body?.dir ? { dir: req.body.dir } : undefined);
      audit({ type: 'SESSION_RENAME', sessionId: req.params.id, ts: Date.now() });
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string }; Body: { tag?: string | null; dir?: string } }>(
    '/api/sessions/:id/tag',
    async (req) => {
      await tg(req.params.id, req.body?.tag ?? null, req.body?.dir ? { dir: req.body.dir } : undefined);
      audit({ type: 'SESSION_TAG', sessionId: req.params.id, tag: req.body?.tag ?? null, ts: Date.now() });
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string }; Body: { title?: string; dir?: string } }>(
    '/api/sessions/:id/fork',
    async (req) => {
      const r = await fk(req.params.id, {
        ...(req.body?.dir ? { dir: req.body.dir } : {}),
        ...(req.body?.title ? { title: req.body.title } : {}),
      });
      audit({ type: 'SESSION_FORK', sessionId: req.params.id, newSessionId: r.sessionId, ts: Date.now() });
      return { ok: true, sessionId: r.sessionId };
    },
  );

  app.delete<{ Params: { id: string }; Querystring: { dir?: string } }>(
    '/api/sessions/:id',
    async (req) => {
      await del(req.params.id, req.query.dir ? { dir: req.query.dir } : undefined);
      audit({ type: 'SESSION_DELETE', sessionId: req.params.id, ts: Date.now() });
      return { ok: true };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { dir?: string } }>(
    '/api/sessions/:id/export',
    async (req, reply) => {
      const messages = await gsm(req.params.id, req.query.dir ? { dir: req.query.dir } : undefined);
      audit({ type: 'SESSION_EXPORT', sessionId: req.params.id, count: messages.length, ts: Date.now() });
      reply.header('content-disposition', `attachment; filename="${req.params.id}.jsonl"`);
      // INV-14: redact each message before serializing (per-object walk keeps JSONL valid)
      return reply.type('application/jsonl').send(messages.map((m) => JSON.stringify(redactJson(m))).join('\n') + '\n');
    },
  );

  // search index rebuild can exceed 5s on large stores -> background action + poll (§8)
  app.post('/api/sessions/search/index', async () => {
    const rec = actions.start('search-index', async () => search.index());
    return { actionId: rec.id };
  });

  app.get<{ Querystring: { q?: string; limit?: string } }>('/api/sessions/search', async (req) => {
    // INV-14: snippets are raw transcript slices — redact before returning
    return redactJson({ hits: search.query(req.query.q ?? '', Number(req.query.limit ?? 20)) });
  });

  app.get<{ Params: { id: string } }>('/api/actions/:id/status', async (req, reply) => {
    const rec = actions.get(req.params.id);
    if (!rec) return reply.code(404).send({ error: 'unknown action' });
    return rec;
  });
}
