// Phase 2 Console extensions (§8): F-MCP, F-Hook (consent gate), F-Sub, F-Skill, F-Sys,
// automation guards (§10.2 / INV-13). All writes validated + audited; reads are live (INV-11).
import type { FastifyInstance } from 'fastify';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { homedir, loadavg, freemem, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { redactText } from './redact.js';

const pExecFile = promisify(execFile);

const HOOK_EVENTS = new Set([
  'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Notification', 'Stop', 'SubagentStop',
  'SessionStart', 'SessionEnd', 'PreCompact', 'PermissionRequest',
]);

// Hook handler types Claude Code accepts (§8 "5 handler types"). Do not hardcode 'command'.
const HOOK_HANDLER_TYPES = new Set(['command', 'prompt', 'agent', 'output', 'decision']);

// Managed (admin) config candidates — read-only third layer (§8 F-MCP).
const MANAGED_CONFIG_PATHS = [
  '/Library/Application Support/ClaudeCode/managed-settings.json',
  '/etc/claude-code/managed-settings.json',
];

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
  // ---- F-MCP: 3-layer view (user ~/.claude.json / project .mcp.json / managed read-only) ----
  const readMcp = (p: string): Record<string, unknown> => {
    try { return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')).mcpServers ?? {}) : {}; }
    catch { return {}; }
  };
  const userSettingsPath = () => join(homedir(), '.claude', 'settings.json');
  const readUserSettings = (): Record<string, unknown> => {
    const p = userSettingsPath();
    try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}; } catch { return {}; }
  };

  app.get<{ Querystring: { dir?: string } }>('/api/mcp', async (req) => {
    const projectPath = join(req.query.dir ?? process.cwd(), '.mcp.json');
    const userPath = join(homedir(), '.claude.json');
    const managedPath = MANAGED_CONFIG_PATHS.find((p) => existsSync(p));
    const disabled = (readUserSettings().disabledMcpServers as string[]) ?? [];
    return {
      user: { path: userPath, servers: readMcp(userPath) },
      project: { path: projectPath, servers: readMcp(projectPath) },
      managed: managedPath ? { path: managedPath, servers: readMcp(managedPath), readOnly: true } : null,
      disabled,
    };
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

  // enable/disable via disabledMcpServers in user settings.json (atomic + audit)
  app.post<{ Body: { name: string; disabled: boolean } }>('/api/mcp/disable', async (req, reply) => {
    const { name, disabled } = req.body ?? {};
    if (!name || typeof disabled !== 'boolean') return reply.code(400).send({ error: 'name + disabled(boolean) required' });
    const cur = readUserSettings();
    const set = new Set((cur.disabledMcpServers as string[]) ?? []);
    if (disabled) set.add(name); else set.delete(name);
    cur.disabledMcpServers = [...set];
    atomicWrite(userSettingsPath(), JSON.stringify(cur, null, 2) + '\n');
    audit({ type: 'MCP_DISABLE_TOGGLE', name, disabled, ts: Date.now() });
    return { ok: true, disabled: cur.disabledMcpServers };
  });

  // stdio start-check (§8): spawn the command with a 5s timeout and see whether the process starts.
  // This is NOT a full MCP handshake. Security: it RUNS a command from .mcp.json on this host, so
  // it is consent-gated (428) and the dir is validated to be a real directory that owns the .mcp.json.
  const RAN_LABEL = 'start-check — ran the configured command from .mcp.json on THIS host (not a full MCP handshake)';
  app.post<{ Querystring: { dir?: string }; Body: { name: string; consent?: boolean } }>('/api/mcp/test', async (req, reply) => {
    const name = req.body?.name;
    if (!name) return reply.code(400).send({ error: 'name required' });
    if (req.body?.consent !== true) {
      return reply.code(428).send({ error: 'consent required: this spawns the server command from .mcp.json on this host' });
    }
    if (/[/\\]|\.\./.test(name)) return reply.code(400).send({ error: 'invalid server name' }); // no traversal via name
    const dir = resolve(req.query.dir ?? process.cwd()); // resolve collapses any ../ so .mcp.json stays inside dir
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return reply.code(400).send({ error: 'dir must be an existing directory' });
    const projectPath = join(dir, '.mcp.json');
    if (!existsSync(projectPath)) return reply.code(400).send({ error: 'no .mcp.json in dir' });
    const server = readMcp(projectPath)[name] as { command?: string; args?: string[]; url?: string } | undefined;
    if (!server) return reply.code(404).send({ error: `no MCP server named ${name} in ${projectPath}` });
    if (typeof server.command !== 'string') {
      return { ok: null, check: 'start-check', label: RAN_LABEL, note: 'remote/HTTP server — start-check only supports stdio servers' };
    }
    const result = await new Promise<{ ok: boolean; note: string }>((res) => {
      let settled = false;
      const done = (r: { ok: boolean; note: string }) => { if (!settled) { settled = true; res(r); } };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(server.command!, server.args ?? [], { stdio: 'ignore' });
      } catch (e) {
        return done({ ok: false, note: `spawn failed: ${String(e)}` });
      }
      const timer = setTimeout(() => { try { child.kill(); } catch { /* noop */ } done({ ok: true, note: 'process still running after 5s — start OK' }); }, 5000);
      child.on('error', (e) => { clearTimeout(timer); done({ ok: false, note: `process error: ${e.message}` }); });
      child.on('exit', (code) => { clearTimeout(timer); done({ ok: code === 0, note: `process exited early with code ${code}` }); });
    });
    audit({ type: 'MCP_TEST', name, ok: result.ok, ts: Date.now() });
    return { check: 'start-check', label: RAN_LABEL, ...result };
  });

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
      handlerTypes: [...HOOK_HANDLER_TYPES],
      scopes: {
        user: readHooks(join(homedir(), '.claude', 'settings.json')),
        project: readHooks(join(dir, '.claude', 'settings.json')),
        local: readHooks(join(dir, '.claude', 'settings.local.json')),
      },
    };
  });

  const hookSettingsPath = (scope: 'user' | 'project' | 'local', dir: string) =>
    scope === 'user'
      ? join(homedir(), '.claude', 'settings.json')
      : join(dir, '.claude', scope === 'local' ? 'settings.local.json' : 'settings.json');

  // ---- F-Hook: builder/validator with consent gate (INV-16), any handler type ----
  app.put<{
    Params: { scope: 'user' | 'project' | 'local' };
    Querystring: { dir?: string };
    Body: { event: string; matcher?: string; command?: string; type?: string; handler?: Record<string, unknown>; consent?: boolean };
  }>('/api/hooks/:scope', async (req, reply) => {
    const { event, matcher, command, type, handler, consent } = req.body ?? {};
    if (!consent) return reply.code(428).send({ error: 'consent required: hooks execute on your machine on every matching event' });
    if (!HOOK_EVENTS.has(event ?? '')) return reply.code(400).send({ error: `event must be one of ${[...HOOK_EVENTS].join(', ')}` });
    const handlerType = type ?? 'command';
    if (!HOOK_HANDLER_TYPES.has(handlerType)) return reply.code(400).send({ error: `type must be one of ${[...HOOK_HANDLER_TYPES].join(', ')}` });
    // 'command' still requires a command string; other types accept a free-form handler object.
    if (handlerType === 'command' && !command) return reply.code(400).send({ error: 'command required for type=command' });
    const entry = handler && typeof handler === 'object'
      ? { type: handlerType, ...handler }
      : { type: handlerType, ...(command ? { command } : {}) };
    const dir = req.query.dir ?? process.cwd();
    const p = hookSettingsPath(req.params.scope, dir);
    const cur = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
    cur.hooks = cur.hooks ?? {};
    cur.hooks[event] = cur.hooks[event] ?? [];
    cur.hooks[event].push({ ...(matcher ? { matcher } : {}), hooks: [entry] });
    atomicWrite(p, JSON.stringify(cur, null, 2) + '\n');
    audit({ type: 'HOOK_WRITE', event, handlerType, scope: req.params.scope, path: p, ts: Date.now() });
    return { ok: true, event, type: handlerType, count: cur.hooks[event].length };
  });

  // ---- F-Hook: master switch (§8) — disableAllHooks turns every hook off; consent-gated ----
  app.put<{
    Params: { scope: 'user' | 'project' | 'local' };
    Querystring: { dir?: string };
    Body: { disableAllHooks: boolean; consent?: boolean };
  }>('/api/hooks/:scope/disable-all', async (req, reply) => {
    const { disableAllHooks, consent } = req.body ?? {};
    if (typeof disableAllHooks !== 'boolean') return reply.code(400).send({ error: 'disableAllHooks(boolean) required' });
    // Disabling all hooks can silence security/governance hooks — treat as a gate change (INV-16).
    if (disableAllHooks && consent !== true) return reply.code(428).send({ error: 'consent required: disabling all hooks can silence security hooks (INV-16)' });
    const dir = req.query.dir ?? process.cwd();
    const p = hookSettingsPath(req.params.scope, dir);
    const cur = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
    if (disableAllHooks) cur.disableAllHooks = true; else delete cur.disableAllHooks;
    atomicWrite(p, JSON.stringify(cur, null, 2) + '\n');
    audit({ type: 'HOOK_DISABLE_ALL', scope: req.params.scope, disableAllHooks, consented: disableAllHooks, path: p, ts: Date.now() });
    return { ok: true, disableAllHooks: !!cur.disableAllHooks };
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

  const subagentPath = (dir: string, name: string) => join(dir, '.claude', 'agents', `${name}.md`);
  const validName = (name: string) => /^[a-z0-9-]+$/.test(name);

  app.delete<{ Params: { name: string }; Querystring: { dir?: string } }>('/api/subagents/:name', async (req, reply) => {
    if (!validName(req.params.name)) return reply.code(400).send({ error: 'invalid name' });
    const p = subagentPath(req.query.dir ?? process.cwd(), req.params.name);
    if (!existsSync(p)) return reply.code(404).send({ error: 'no such subagent' });
    unlinkSync(p);
    audit({ type: 'SUBAGENT_DELETE', name: req.params.name, path: p, ts: Date.now() });
    return { ok: true };
  });

  // dry test-run (§8): validate frontmatter and report whether the CLI would load it.
  // NEVER invokes a model — purely a static validation of the Markdown/frontmatter.
  app.post<{ Params: { name: string }; Querystring: { dir?: string } }>('/api/subagents/:name/test-run', async (req, reply) => {
    if (!validName(req.params.name)) return reply.code(400).send({ error: 'invalid name' });
    const p = subagentPath(req.query.dir ?? process.cwd(), req.params.name);
    if (!existsSync(p)) return reply.code(404).send({ error: 'no such subagent' });
    const content = readFileSync(p, 'utf8');
    const fm = /^---\n([\s\S]*?)\n---/.exec(content);
    const issues: string[] = [];
    if (!fm) issues.push('missing YAML frontmatter block (--- … ---)');
    const body = fm ? (fm[1] ?? '') : '';
    const has = (k: string) => new RegExp(`^${k}\\s*:`, 'm').test(body);
    if (!has('name')) issues.push('frontmatter missing "name"');
    if (!has('description')) issues.push('frontmatter missing "description"');
    if (fm && content.slice(fm[0].length).trim().length === 0) issues.push('empty system prompt after frontmatter');
    return {
      dryValidation: true,
      note: 'static frontmatter validation only — no model was called',
      wouldLoad: issues.length === 0,
      issues,
    };
  });

  // ---- F-Skill: list (user + project) + plugins (enabledPlugins in user settings) ----
  app.get<{ Querystring: { dir?: string } }>('/api/skills', async (req) => {
    const scan = (base: string) =>
      existsSync(base)
        ? readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
        : [];
    const enabledPlugins = (readUserSettings().enabledPlugins as Record<string, unknown>) ?? {};
    return {
      user: scan(join(homedir(), '.claude', 'skills')),
      project: scan(join(req.query.dir ?? process.cwd(), '.claude', 'skills')),
      plugins: enabledPlugins,
    };
  });

  // F-Skill: toggle a plugin in enabledPlugins (user settings.json); enabling runs 3rd-party code → consent.
  app.put<{ Body: { name: string; enabled: boolean; consent?: boolean } }>('/api/skills/plugins', async (req, reply) => {
    const { name, enabled, consent } = req.body ?? {};
    if (!name || typeof enabled !== 'boolean') return reply.code(400).send({ error: 'name + enabled(boolean) required' });
    if (enabled && consent !== true) return reply.code(428).send({ error: 'consent required: enabling a plugin runs third-party code' });
    const cur = readUserSettings();
    const plugins = (cur.enabledPlugins as Record<string, boolean>) ?? {};
    plugins[name] = enabled;
    cur.enabledPlugins = plugins;
    atomicWrite(userSettingsPath(), JSON.stringify(cur, null, 2) + '\n');
    audit({ type: 'PLUGIN_TOGGLE', name, enabled, ts: Date.now() });
    return { ok: true, enabledPlugins: plugins };
  });

  // ---- F-Sys: doctor + host stats + retention view + update check ----
  app.get('/api/system', async () => {
    const doctor = await pExecFile('claude', ['doctor', '--json'], { timeout: 30_000 })
      .then((r) => redactText(r.stdout.slice(0, 4000))) // INV-14: doctor output can echo config/paths
      .catch(() => 'doctor is interactive-only in this CLI version — run /doctor inside a terminal session (F-Term)');
    // update hint (§8): fail-open — a CLI without `update --check` must not break the page
    const updateHint = await pExecFile('claude', ['update', '--check'], { timeout: 10_000 })
      .then((r) => redactText(r.stdout.slice(0, 300)).trim() || 'up to date')
      .catch(() => 'update check unavailable — run `claude update` in a terminal');
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
    return {
      doctor,
      updateHint,
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
