// F-Act Activity Feed (§8): one-click HTTP hooks -> POST /api/events/ingest -> SSE feed.
// Installed hooks are fail-open (|| true) with a short timeout so a dead console never blocks the CLI.
import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { redactJson } from './redact.js';

const RING_SIZE = 500;
const MARKER = 'platform-console-activity'; // identifies our hook entries for one-click uninstall
const FEED_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd'];

interface FeedEvent { seq: number; ts: number; body: unknown }

export function registerEvents(
  app: FastifyInstance,
  audit: (e: Record<string, unknown>) => void,
  port: number,
): void {
  const ring: FeedEvent[] = [];
  let seq = 0;
  const listeners = new Set<ServerResponse>();

  app.post('/api/events/ingest', async (req) => {
    // INV-14: hook payloads (tool args, env) can carry secrets — redact before store + SSE
    const ev: FeedEvent = { seq: ++seq, ts: Date.now(), body: redactJson(req.body ?? null) };
    ring.push(ev);
    if (ring.length > RING_SIZE) ring.shift();
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of listeners) res.write(line);
    return { ok: true, seq: ev.seq };
  });

  app.get<{ Querystring: { since?: string } }>('/api/events/recent', async (req) => {
    const since = Number(req.query.since ?? 0);
    return { events: ring.filter((e) => e.seq > since) };
  });

  app.get('/api/events/feed', (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    reply.raw.write(':ok\n\n');
    listeners.add(reply.raw);
    req.raw.on('close', () => listeners.delete(reply.raw));
  });

  // ---- one-click install/uninstall of activity hooks (fail-open, short timeout) ----
  const hookCommand = `curl -m 2 -s -X POST http://127.0.0.1:${port}/api/events/ingest -H 'content-type: application/json' --data-binary @- >/dev/null 2>&1 || true # ${MARKER}`;

  const settingsPathFor = (scope: 'user' | 'project', dir: string) =>
    scope === 'user' ? join(homedir(), '.claude', 'settings.json') : join(dir, '.claude', 'settings.json');

  const atomicWrite = (path: string, content: string) => {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, content);
    renameSync(tmp, path);
  };

  app.post<{ Body: { scope?: 'user' | 'project'; dir?: string; consent?: boolean } }>(
    '/api/activity/hooks/install',
    async (req, reply) => {
      if (!req.body?.consent) return reply.code(428).send({ error: 'consent required: installs hooks into settings.json' });
      const scope = req.body?.scope ?? 'project';
      const p = settingsPathFor(scope, req.body?.dir ?? process.cwd());
      const cur = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
      cur.hooks = cur.hooks ?? {};
      for (const ev of FEED_EVENTS) {
        const arr: { hooks: { type: string; command: string }[] }[] = (cur.hooks[ev] = cur.hooks[ev] ?? []);
        if (!arr.some((h) => h.hooks?.some((x) => x.command?.includes(MARKER)))) {
          arr.push({ hooks: [{ type: 'command', command: hookCommand }] });
        }
      }
      atomicWrite(p, JSON.stringify(cur, null, 2) + '\n');
      audit({ type: 'ACTIVITY_HOOKS_INSTALL', scope, path: p, ts: Date.now() });
      return { ok: true, path: p, events: FEED_EVENTS };
    },
  );

  app.post<{ Body: { scope?: 'user' | 'project'; dir?: string } }>(
    '/api/activity/hooks/uninstall',
    async (req) => {
      const scope = req.body?.scope ?? 'project';
      const p = settingsPathFor(scope, req.body?.dir ?? process.cwd());
      if (!existsSync(p)) return { ok: true, removed: 0 };
      const cur = JSON.parse(readFileSync(p, 'utf8'));
      let removed = 0;
      for (const ev of Object.keys(cur.hooks ?? {})) {
        const arr: { hooks?: { command?: string }[] }[] = cur.hooks[ev];
        const kept = arr.filter((h) => !h.hooks?.some((x) => x.command?.includes(MARKER)));
        removed += arr.length - kept.length;
        if (kept.length) cur.hooks[ev] = kept;
        else delete cur.hooks[ev];
      }
      atomicWrite(p, JSON.stringify(cur, null, 2) + '\n');
      audit({ type: 'ACTIVITY_HOOKS_UNINSTALL', scope, path: p, removed, ts: Date.now() });
      return { ok: true, removed };
    },
  );
}
