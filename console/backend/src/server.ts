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
import { registerGovernance } from './governance.js';
import { registerExtensions } from './extensions.js';
import { registerLoopConsole } from './loop-console.js';
import { BasicAuthProvider } from './auth-provider.js';

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

  // host-header validation (§13.3): block DNS-rebinding — allow loopback names + explicit extra host
  const extraHost = env.PLATFORM_CONSOLE_HOST;
  app.addHook('onRequest', async (req, reply) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    const allowed = ['127.0.0.1', 'localhost', '::1', '[::1]', ...(extraHost ? [extraHost] : [])];
    if (host && !allowed.includes(host)) {
      return reply.code(403).send({ error: 'host not allowed' });
    }
  });

  // ---- remote auth (§13, Phase 3): Basic provider active when operator configured it ----
  const passwordRecord = env.PLATFORM_CONSOLE_PASSWORD_RECORD;
  const signingSecret = env.PLATFORM_CONSOLE_SIGNING_SECRET;
  const provider = passwordRecord && signingSecret
    ? new BasicAuthProvider({ passwordRecord, signingSecret, sessionTtlMs: 12 * 3_600_000 })
    : null;
  if (provider) {
    app.post<{ Body: { password?: string } }>('/api/auth/login', async (req, reply) => {
      const r = provider.login(req.body?.password ?? '');
      audit({ type: 'AUTH_LOGIN', ok: r.ok, ip: req.ip, ts: Date.now() }); // §13.3: auth events audited
      if (!r.ok) return reply.code(r.error === 'rate_limited' ? 429 : 401).send({ error: 'unauthorized' }); // generic
      reply.header('set-cookie', `session=${r.token}; HttpOnly; SameSite=Lax; Path=/`);
      return { ok: true, token: r.token };
    });
    app.addHook('preHandler', async (req, reply) => {
      if (req.url === '/api/auth/login') return;
      const cookieToken = /(?:^|;\s*)session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
      const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
      if (!provider.verify(cookieToken ?? bearer)) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
    });
  }

  const ptys = deps.ptyManager ?? new PtyManager(audit);
  registerTerminal(app, ptys);
  registerGovernance(app, audit);
  const utilization = async () => {
    // rough estimate: sessions in current 5h window vs a soft operating budget
    const sessions = await ls({ limit: 500 });
    const est = estimateUsage(sessions.map((s) => ({ lastModified: s.lastModified, fileSize: s.fileSize ?? 0 })), Date.now());
    return Math.min(1, est.currentWindow.sessions / 50);
  };
  registerExtensions(app, audit, { utilization });
  registerLoopConsole(app, {
    humanPlaneUrl: env.PLATFORM_HUMAN_PLANE_URL ?? 'http://127.0.0.1:9210',
    tokenFile: env.PLATFORM_HUMAN_PLANE_TOKEN_FILE ?? '.ai/human-plane.token',
    automationGuard: async () => {
      const u = await utilization();
      return { allowed: u < 0.85, utilization: u };
    },
    audit,
  });
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
