// Phase 2 Console extensions (§8): F-MCP, F-Hook (consent gate), F-Sub, F-Skill, F-Sys,
// automation guards (§10.2 / INV-13). All writes validated + audited; reads are live (INV-11).
import type { FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, loadavg, freemem, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const pExecFile = promisify(execFile);

const HOOK_EVENTS = new Set([
  'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Notification', 'Stop', 'SubagentStop',
  'SessionStart', 'SessionEnd', 'PreCompact', 'PermissionRequest',
]);

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export interface GuardDeps {
  utilization: () => Promise<number>; // 0..1 estimate from usage indexer
  threshold?: number;
}

export function registerExtensions(
  app: FastifyInstance,
  audit: (e: Record<string, unknown>) => void,
  guards: GuardDeps,
): void {
  // ---- F-MCP: project .mcp.json CRUD ----
  app.get<{ Querystring: { dir?: string } }>('/api/mcp', async (req) => {
    const p = join(req.query.dir ?? process.cwd(), '.mcp.json');
    return { path: p, servers: existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')).mcpServers ?? {} : {} };
  });

  app.put<{ Querystring: { dir?: string }; Body: { name: string; server: Record<string, unknown> } }>(
    '/api/mcp',
    async (req, reply) => {
      const { name, server } = req.body ?? {};
      if (!name || typeof server !== 'object' || server === null) return reply.code(400).send({ error: 'name + server required' });
      const isStdio = typeof server.command === 'string';
      const isRemote = typeof server.url === 'string' && /^https?:\/\//.test(String(server.url));
      if (!isStdio && !isRemote) return reply.code(400).send({ error: 'server needs command (stdio) or url (http/sse)' });
      const p = join(req.query.dir ?? process.cwd(), '.mcp.json');
      const cur = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
      cur.mcpServers = { ...(cur.mcpServers ?? {}), [name]: server };
      atomicWrite(p, JSON.stringify(cur, null, 2) + '\n');
      audit({ type: 'MCP_WRITE', name, path: p, ts: Date.now() });
      return { ok: true, servers: cur.mcpServers };
    },
  );

  // ---- F-Hook: merged read view across scopes (TUI /hooks is read-only; Console is the editor) ----
  app.get<{ Querystring: { dir?: string } }>('/api/hooks', async (req) => {
    const dir = req.query.dir ?? process.cwd();
    const readHooks = (p: string): Record<string, unknown> => {
      if (!existsSync(p)) return {};
      try {
        const s = JSON.parse(readFileSync(p, 'utf8'));
        return { hooks: s.hooks ?? {}, disableAllHooks: s.disableAllHooks };
      } catch { return { error: 'unreadable settings file' }; }
    };
    return {
      events: [...HOOK_EVENTS],
      scopes: {
        user: readHooks(join(homedir(), '.claude', 'settings.json')),
        project: readHooks(join(dir, '.claude', 'settings.json')),
        local: readHooks(join(dir, '.claude', 'settings.local.json')),
      },
    };
  });

  // ---- F-Hook: builder/validator with consent gate (INV-16) ----
  app.put<{
    Params: { scope: 'user' | 'project' | 'local' };
    Querystring: { dir?: string };
    Body: { event: string; matcher?: string; command: string; consent?: boolean };
  }>('/api/hooks/:scope', async (req, reply) => {
    const { event, matcher, command, consent } = req.body ?? {};
    if (!consent) return reply.code(428).send({ error: 'consent required: hooks execute arbitrary commands on your machine' });
    if (!HOOK_EVENTS.has(event ?? '')) return reply.code(400).send({ error: `event must be one of ${[...HOOK_EVENTS].join(', ')}` });
    if (!command) return reply.code(400).send({ error: 'command required' });
    const dir = req.query.dir ?? process.cwd();
    const p = req.params.scope === 'user'
      ? join(homedir(), '.claude', 'settings.json')
      : join(dir, '.claude', req.params.scope === 'local' ? 'settings.local.json' : 'settings.json');
    const cur = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
    cur.hooks = cur.hooks ?? {};
    cur.hooks[event] = cur.hooks[event] ?? [];
    cur.hooks[event].push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command }] });
    atomicWrite(p, JSON.stringify(cur, null, 2) + '\n');
    audit({ type: 'HOOK_WRITE', event, scope: req.params.scope, path: p, ts: Date.now() });
    return { ok: true, event, count: cur.hooks[event].length };
  });

  // ---- F-Sub: subagent CRUD (.claude/agents/*.md, frontmatter validated) ----
  app.get<{ Querystring: { dir?: string } }>('/api/subagents', async (req) => {
    const d = join(req.query.dir ?? process.cwd(), '.claude', 'agents');
    const items = existsSync(d)
      ? readdirSync(d).filter((f) => f.endsWith('.md')).map((f) => ({ file: f, content: readFileSync(join(d, f), 'utf8') }))
      : [];
    return { dir: d, subagents: items };
  });

  app.put<{ Querystring: { dir?: string }; Body: { name: string; description: string; prompt: string; tools?: string[] } }>(
    '/api/subagents',
    async (req, reply) => {
      const { name, description, prompt, tools } = req.body ?? {};
      if (!name || !/^[a-z0-9-]+$/.test(name)) return reply.code(400).send({ error: 'name must be kebab-case' });
      if (!description || !prompt) return reply.code(400).send({ error: 'description + prompt required' });
      const md = `---\nname: ${name}\ndescription: ${description}\n${tools?.length ? `tools: ${tools.join(', ')}\n` : ''}---\n\n${prompt}\n`;
      const p = join(req.query.dir ?? process.cwd(), '.claude', 'agents', `${name}.md`);
      atomicWrite(p, md);
      audit({ type: 'SUBAGENT_WRITE', name, path: p, ts: Date.now() });
      return { ok: true, path: p };
    },
  );

  // ---- F-Skill: list (user + project) ----
  app.get<{ Querystring: { dir?: string } }>('/api/skills', async (req) => {
    const scan = (base: string) =>
      existsSync(base)
        ? readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
        : [];
    return {
      user: scan(join(homedir(), '.claude', 'skills')),
      project: scan(join(req.query.dir ?? process.cwd(), '.claude', 'skills')),
    };
  });

  // ---- F-Sys: doctor + host stats + retention view ----
  app.get('/api/system', async () => {
    const doctor = await pExecFile('claude', ['doctor', '--json'], { timeout: 30_000 })
      .then((r) => r.stdout.slice(0, 4000))
      .catch(() => 'doctor is interactive-only in this CLI version — run /doctor inside a terminal session (F-Term)');
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
    return {
      doctor,
      host: { loadavg: loadavg(), freemem: freemem(), totalmem: totalmem() },
      retention: {
        // type-guard: settings.json is attacker-editable; never let a string reach the UI
        cleanupPeriodDays: typeof settings.cleanupPeriodDays === 'number' ? settings.cleanupPeriodDays : null,
        warning: 'ลด retention = ลบ transcript ซึ่งเป็นหลักฐาน/ข้อมูลอ่อนไหว — ตั้งใจก่อนแก้',
      },
    };
  });

  // ---- F-Sys: retention write (§8) — explicit warning, atomic, audited ----
  app.put<{ Body: { cleanupPeriodDays?: number | null } }>('/api/system/retention', async (req, reply) => {
    const days = req.body?.cleanupPeriodDays;
    if (days !== null && (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 3650)) {
      return reply.code(400).send({ error: 'cleanupPeriodDays must be an integer 1..3650, or null to unset' });
    }
    const p = join(homedir(), '.claude', 'settings.json');
    const cur = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
    if (days === null) delete cur.cleanupPeriodDays;
    else cur.cleanupPeriodDays = days;
    atomicWrite(p, JSON.stringify(cur, null, 2) + '\n');
    audit({ type: 'RETENTION_WRITE', cleanupPeriodDays: days, ts: Date.now() });
    return {
      ok: true,
      cleanupPeriodDays: days,
      warning: 'lowering retention deletes transcripts (evidence + possibly sensitive data); applies on next CLI cleanup pass',
    };
  });

  // ---- Automation guards (§10.2 / INV-13): yield to interactive ----
  app.get('/api/guards/automation', async () => {
    const threshold = guards.threshold ?? 0.85;
    const utilization = await guards.utilization();
    return {
      allowed: utilization < threshold,
      utilization,
      threshold,
      policy: {
        deferUntilReset: utilization >= threshold,
        defaultAutomationModel: 'sonnet', // keep the larger models for interactive (§10.2)
        note: 'utilization เป็นค่าประมาณจาก transcript — ไม่ใช่ตัวเลขทางการ (INV-13)',
      },
    };
  });
}
