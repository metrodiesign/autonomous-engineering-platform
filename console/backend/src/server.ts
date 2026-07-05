// Console backend (§8) — Phase 0: F-Status, F-Proj, F-Sess (read), F-Auth, F-Usage card.
// Reads Claude Code state live (INV-11 — no shadow copies). Every UI capability is a REST endpoint.
import Fastify, { type FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, readdirSync, existsSync, realpathSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { listSessions, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { detectAuth } from './auth.js';
import { estimateUsage, usageBreakdown, evaluateAlerts, type SessionStat } from './usage.js';
import { INDEX_HTML } from './web.js';
import { PtyManager } from './pty-manager.js';
import { registerTerminal } from './terminal.js';
import { registerGovernance } from './governance.js';
import { registerExtensions } from './extensions.js';
import { registerLoopConsole } from './loop-console.js';
import { BasicAuthProvider } from './auth-provider.js';
import { SessionSearch } from './search.js';
import { ActionRegistry } from './actions.js';
import { registerSessionOps } from './sessions-ops.js';
import { registerEvents } from './events.js';
import { redactJson, redactText } from './redact.js';
import { computeResets, type QuotaCalibration } from './usage.js';

const pExecFile = promisify(execFile);

export interface ServerDeps {
  env?: Record<string, string | undefined>;
  projectsDir?: string;
  listSessions?: typeof listSessions;
  getSessionMessages?: typeof getSessionMessages;
  cliVersion?: () => Promise<string>;
  auditFile?: string;
  ptyManager?: PtyManager;
  searchDbPath?: string;
  calibrationFile?: string;
  publicPort?: number;
  sessionOps?: Partial<import('./sessions-ops.js').SessionOpsDeps>;
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

  // §10.2 quota-window budget: soft denominator for the utilization estimate. Operator-tunable
  // (default 50) so the "estimate" label still holds on differently-sized accounts (INV-13).
  const quotaWindowBudget = (() => {
    const n = Number(env.PLATFORM_QUOTA_WINDOW_BUDGET);
    return Number.isInteger(n) && n >= 1 && n <= 10_000 ? n : 50;
  })();

  const app = Fastify({ logger: false });

  // audit log (JSON lines, redacted by construction — no payload bodies) per §13.3
  const auditFile = deps.auditFile ?? join('.ai', 'audit', 'console.jsonl');
  mkdirSync(dirname(auditFile), { recursive: true });
  const audit = (e: Record<string, unknown>) => appendFileSync(auditFile, JSON.stringify(e) + '\n');

  // host-header validation (§13.3): block DNS-rebinding — allow loopback names + explicit extra host
  const extraHost = env.PLATFORM_CONSOLE_HOST;
  const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
  app.addHook('onRequest', async (req, reply) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    const allowed = ['127.0.0.1', 'localhost', '::1', '[::1]', ...(extraHost ? [extraHost] : [])];
    if (host && !allowed.includes(host)) {
      return reply.code(403).send({ error: 'host not allowed' });
    }
    // peer-IP guard (§13.3): loopback-only mode also rejects non-loopback peers (defense-in-depth)
    if (!extraHost) {
      const peer = req.socket?.remoteAddress ?? '';
      if (peer && !LOOPBACK_PEERS.has(peer)) {
        return reply.code(403).send({ error: 'remote peer not allowed without PLATFORM_CONSOLE_HOST' });
      }
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
      // Secure flag when TLS terminates in front of us (§13.3) — set PLATFORM_CONSOLE_COOKIE_SECURE=1
      const secure = env.PLATFORM_CONSOLE_COOKIE_SECURE === '1' ? '; Secure' : '';
      reply.header('set-cookie', `session=${r.token}; HttpOnly; SameSite=Lax; Path=/${secure}`);
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

  // INV-17: F-Term is the highest-risk surface — remote peers must pass auth in EVERY mode,
  // including --insecure. When no auth provider is configured, restrict F-Term (REST + WS) to
  // loopback peers; when a provider exists, the auth preHandler / WS ticket already gate it.
  const termPeerAllowed = (peer: string): boolean => !!provider || !peer || LOOPBACK_PEERS.has(peer);
  if (!provider) {
    app.addHook('onRequest', async (req, reply) => {
      const path = req.url.split('?')[0] ?? '';
      const isTerm = path === '/terminal' || path === '/api/term' || path.startsWith('/api/term/');
      if (!isTerm) return;
      const peer = req.socket?.remoteAddress ?? '';
      if (peer && !LOOPBACK_PEERS.has(peer)) {
        return reply.code(401).send({ error: 'F-Term requires auth for remote peers (INV-17)' });
      }
    });
  }

  const ptys = deps.ptyManager ?? new PtyManager(audit);
  registerTerminal(app, ptys, { peerAllowed: termPeerAllowed });
  registerGovernance(app, audit);

  const search = deps.sessionOps?.search
    ?? new SessionSearch(deps.searchDbPath ?? join('.ai', 'console', 'search.db'), projectsDir);
  const actions = deps.sessionOps?.actions ?? new ActionRegistry();
  registerSessionOps(app, { ...deps.sessionOps, search, actions, audit });
  registerEvents(app, audit, deps.publicPort ?? 9119);
  app.addHook('onClose', async () => search.close());
  const utilization = async () => {
    // rough estimate: sessions in current 5h window vs a soft operating budget
    const sessions = await ls({ limit: 500 });
    const est = estimateUsage(sessions.map((s) => ({ lastModified: s.lastModified, fileSize: s.fileSize ?? 0 })), Date.now());
    return Math.min(1, est.currentWindow.sessions / quotaWindowBudget);
  };
  registerExtensions(app, audit, { utilization });
  const humanPlaneUrl = env.PLATFORM_HUMAN_PLANE_URL ?? 'http://127.0.0.1:9210';
  const tokenFile = env.PLATFORM_HUMAN_PLANE_TOKEN_FILE ?? '.ai/human-plane.token';
  registerLoopConsole(app, {
    humanPlaneUrl,
    tokenFile,
    automationGuard: async () => {
      const u = await utilization();
      return { allowed: u < 0.85, utilization: u };
    },
    env,
    audit,
  });
  app.addHook('onClose', async () => ptys.killAll());

  // F-Status (§8): brief doctor summary, cached 60s so /api/status never blocks on the CLI.
  let doctorCache: { text: string; at: number } = { text: '', at: 0 };
  let doctorInflight: Promise<void> | null = null;
  const doctorBrief = (): string => {
    if (Date.now() - doctorCache.at >= 60_000 && !doctorInflight) {
      doctorInflight = pExecFile('claude', ['doctor', '--json'], { timeout: 10_000 })
        .then((r) => { doctorCache = { text: redactText(r.stdout.split('\n').slice(0, 6).join('\n').slice(0, 600)), at: Date.now() }; })
        .catch(() => { doctorCache = { text: 'doctor unavailable — run /doctor inside a terminal (F-Term)', at: Date.now() }; })
        .finally(() => { doctorInflight = null; });
    }
    return doctorCache.text;
  };

  // F-Status (§8): probe the autonomous loop via the Human Plane API (INV-11 — read-only client).
  const probeLoop = async (): Promise<{ running: boolean; pendingApprovals?: number; lastEventSeq?: number; reason?: string }> => {
    if (!existsSync(tokenFile)) return { running: false, reason: 'no token file (loop not started)' };
    try {
      const token = readFileSync(tokenFile, 'utf8').trim();
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 1500);
      const headers = { authorization: `Bearer ${token}` };
      const [aRes, eRes] = await Promise.all([
        fetch(`${humanPlaneUrl}/approvals`, { headers, signal: ctl.signal }),
        fetch(`${humanPlaneUrl}/events?since=0`, { headers, signal: ctl.signal }),
      ]);
      clearTimeout(timer);
      const approvals = (await aRes.json().catch(() => ({}))).approvals ?? [];
      const events = (await eRes.json().catch(() => ({}))).events ?? [];
      return { running: true, pendingApprovals: approvals.length, lastEventSeq: events.length ? events[events.length - 1].seq : 0 };
    } catch (e) {
      return { running: false, reason: e instanceof Error && e.name === 'AbortError' ? 'human plane timeout' : 'human plane unreachable' };
    }
  };

  app.get('/', async (_req, reply) => reply.type('text/html').send(INDEX_HTML));
  app.get('/favicon.ico', async (_req, reply) => reply.code(204).send());

  app.get('/api/status', async () => ({
    disclaimer: DISCLAIMER,
    cli: await cliVersion(),
    auth: detectAuth(env),
    now: Date.now(),
    doctorBrief: doctorBrief(),
    runs: {
      terminals: ptys.list().map((t) => ({ id: t.id, cwd: t.cwd, mode: t.mode })),
      autonomous: await probeLoop(),
    },
  }));

  app.get('/api/projects', async () => {
    if (!existsSync(projectsDir)) return { projects: [] };
    const projects = readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const path = d.name.replace(/^-/, '/').replaceAll('-', '/');
        // loop-managed banner (§8 F-Proj): a .ai/goal.yaml marks the project as loop-owned
        const loopManaged = existsSync(join(path, '.ai', 'goal.yaml'));
        return { key: d.name, path, loopManaged };
      });
    return { projects, note: 'paths are demunged best-effort' };
  });

  app.post<{ Body: { dir?: string } }>('/api/projects/register', async (req, reply) => {
    const dir = req.body?.dir;
    if (!dir || !existsSync(dir)) return reply.code(400).send({ error: 'dir must be an existing directory' });
    // same munge scheme the CLI uses for ~/.claude/projects entries
    const key = realpathSync(dir).replaceAll('/', '-').replaceAll('.', '-');
    mkdirSync(join(projectsDir, key), { recursive: true });
    audit({ type: 'PROJECT_REGISTER', dir, key, ts: Date.now() });
    return { ok: true, key };
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
      return redactJson({ messages }); // INV-14: transcripts can carry leaked secrets
    },
  );

  app.get('/api/auth', async () => detectAuth(env));

  // F-Usage calibration (§5.3): the operator enters real % from `/usage` + weekly reset day/time.
  // No official quota API exists, so this anchors the estimate. Stored outside ~/.claude (INV-11).
  const calibrationFile = deps.calibrationFile ?? join('.ai', 'console', 'usage-calibration.json');
  const readCalibration = (): QuotaCalibration => {
    try { return existsSync(calibrationFile) ? JSON.parse(readFileSync(calibrationFile, 'utf8')) : {}; }
    catch { return {}; }
  };

  app.get('/api/usage', async () => {
    const sessions = await ls({ limit: 500 });
    const stats: SessionStat[] = sessions.map((s) => {
      const st: SessionStat = { lastModified: s.lastModified };
      if (s.fileSize !== undefined) st.fileSize = s.fileSize;
      return st;
    });
    const now = Date.now();
    const est = estimateUsage(stats, now);
    const calibration = readCalibration();
    return { ...est, calibration, resetEstimate: computeResets(est.currentWindow.windowStart, calibration, now) };
  });

  app.get('/api/usage/calibration', async () => ({ calibration: readCalibration(), path: calibrationFile }));

  app.put<{ Body: { actualPct?: number | null; weeklyResetDay?: number | null; weeklyResetHour?: number | null } }>(
    '/api/usage/calibration',
    async (req, reply) => {
      const b = req.body ?? {};
      const numOrNull = (v: unknown, lo: number, hi: number) =>
        v === null || v === undefined ? undefined : (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : NaN);
      const actualPct = numOrNull(b.actualPct, 0, 100);
      const weeklyResetDay = numOrNull(b.weeklyResetDay, 0, 6);
      const weeklyResetHour = numOrNull(b.weeklyResetHour, 0, 23);
      if ([actualPct, weeklyResetDay, weeklyResetHour].some((v) => Number.isNaN(v))) {
        return reply.code(400).send({ error: 'actualPct 0..100, weeklyResetDay 0..6, weeklyResetHour 0..23 (or null)' });
      }
      const cal: QuotaCalibration = { updatedAt: Date.now() };
      if (actualPct !== undefined) cal.actualPct = actualPct;
      if (weeklyResetDay !== undefined) cal.weeklyResetDay = weeklyResetDay;
      if (weeklyResetHour !== undefined) cal.weeklyResetHour = weeklyResetHour;
      mkdirSync(dirname(calibrationFile), { recursive: true });
      const tmp = `${calibrationFile}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(cal, null, 2) + '\n');
      renameSync(tmp, calibrationFile);
      audit({ type: 'USAGE_CALIBRATION_WRITE', ts: Date.now() });
      return { ok: true, calibration: cal };
    },
  );

  // F-Usage Phase 2 (§8): breakdown from the search index (run POST /api/sessions/search/index first)
  app.get<{ Querystring: { days?: string } }>('/api/usage/full', async (req) => {
    const days = Number(req.query.days ?? 14);
    return usageBreakdown(search.aggregates(Date.now() - days * 24 * 3_600_000));
  });

  app.get<{ Querystring: { threshold?: string } }>('/api/usage/alerts', async (req) => {
    const threshold = Number(req.query.threshold ?? 0.85);
    const sessions = await ls({ limit: 500 });
    const est = estimateUsage(sessions.map((s) => ({ lastModified: s.lastModified, fileSize: s.fileSize ?? 0 })), Date.now());
    const utilization = Math.min(1, est.currentWindow.sessions / quotaWindowBudget);
    return { utilization, threshold, alerts: evaluateAlerts(utilization, threshold) };
  });

  return app;
}
