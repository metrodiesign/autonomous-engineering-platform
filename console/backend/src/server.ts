// Console backend (§8) — Phase 0: F-Status, F-Proj, F-Sess (read), F-Auth, F-Usage card.
// Reads Claude Code state live (INV-11 — no shadow copies). Every UI capability is a REST endpoint.
import Fastify, { type FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { listSessions, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { detectAuth } from './auth.js';
import { estimateUsage, type SessionStat } from './usage.js';
import { INDEX_HTML } from './web.js';
import { PtyManager } from './pty-manager.js';
import { registerTerminal } from './terminal.js';

const pExecFile = promisify(execFile);

export interface ServerDeps {
  env?: Record<string, string | undefined>;
  projectsDir?: string;
  listSessions?: typeof listSessions;
  getSessionMessages?: typeof getSessionMessages;
  cliVersion?: () => Promise<string>;
  auditFile?: string;
  ptyManager?: PtyManager;
}

const DISCLAIMER = 'Third-party operator console for Claude Code — not an Anthropic product.';

export function buildServer(deps: ServerDeps = {}): FastifyInstance {
  const env = deps.env ?? process.env;
  const projectsDir = deps.projectsDir ?? join(homedir(), '.claude', 'projects');
  const ls = deps.listSessions ?? listSessions;
  const gsm = deps.getSessionMessages ?? getSessionMessages;
  const cliVersion =
    deps.cliVersion ??
    (async () => {
      try {
        const { stdout } = await pExecFile('claude', ['--version'], { timeout: 15_000 });
        return stdout.trim();
      } catch {
        return 'claude CLI not found';
      }
    });

  const app = Fastify({ logger: false });

  // audit log (JSON lines, redacted by construction — no payload bodies) per §13.3
  const auditFile = deps.auditFile ?? join('.ai', 'audit', 'console.jsonl');
  mkdirSync(dirname(auditFile), { recursive: true });
  const audit = (e: Record<string, unknown>) => appendFileSync(auditFile, JSON.stringify(e) + '\n');
  const ptys = deps.ptyManager ?? new PtyManager(audit);
  registerTerminal(app, ptys);
  app.addHook('onClose', async () => ptys.killAll());

  app.get('/', async (_req, reply) => reply.type('text/html').send(INDEX_HTML));

  app.get('/api/status', async () => ({
    disclaimer: DISCLAIMER,
    cli: await cliVersion(),
    auth: detectAuth(env),
    now: Date.now(),
  }));

  app.get('/api/projects', async () => {
    if (!existsSync(projectsDir)) return { projects: [] };
    const projects = readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ key: d.name, path: d.name.replace(/^-/, '/').replaceAll('-', '/') }));
    return { projects, note: 'paths are demunged best-effort; register-cwd arrives Phase 1' };
  });

  app.get<{ Querystring: { dir?: string; limit?: string } }>('/api/sessions', async (req) => {
    const opts: Parameters<typeof ls>[0] = { limit: Number(req.query.limit ?? 50) };
    if (req.query.dir) opts.dir = req.query.dir;
    const sessions = await ls(opts);
    return { sessions };
  });

  app.get<{ Params: { id: string }; Querystring: { dir?: string; limit?: string } }>(
    '/api/sessions/:id/messages',
    async (req) => {
      const opts: Parameters<typeof gsm>[1] = { limit: Number(req.query.limit ?? 100) };
      if (req.query.dir) opts.dir = req.query.dir;
      const messages = await gsm(req.params.id, opts);
      return { messages };
    },
  );

  app.get('/api/auth', async () => detectAuth(env));

  app.get('/api/usage', async () => {
    const sessions = await ls({ limit: 500 });
    const stats: SessionStat[] = sessions.map((s) => {
      const st: SessionStat = { lastModified: s.lastModified };
      if (s.fileSize !== undefined) st.fileSize = s.fileSize;
      return st;
    });
    return estimateUsage(stats, Date.now());
  });

  return app;
}
