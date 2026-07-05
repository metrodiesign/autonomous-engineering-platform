// Deterministic executor (§6.1): policy enforcement, egress default-deny (INV-14),
// idempotency via ACTION_INTENT/ACTION_APPLIED, rejection as structured feedback.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { platform } from 'node:os';
import type { Action, ActionOutcome, TaskContext } from './types.js';
import type { EventLog } from './event-log.js';
import { checkActionPolicy } from './policy.js';
import { signEvidence } from './evidence.js';
import { checkPackageInstall, type DependencyPolicy } from './security-plane.js';

export interface ExecutorHooks {
  /** test-only fault injection: crash after INTENT, before APPLIED */
  crashAfterIntent?: (action: Action) => boolean;
}

export interface ExecutorDeps {
  /** when set, captured RUN_COMMAND results are HMAC-signed (§10.1 T6 evidence spoofing) */
  evidenceKeyFile?: string;
  /** registry/installer allowlist for the package_install egress lane (§10.1 T4) */
  dependencyPolicy?: DependencyPolicy;
}

/** default dependency policy: the one sanctioned registry + the common installers (§10.1) */
const DEFAULT_DEP_POLICY: DependencyPolicy = {
  allowedRegistries: ['https://registry.npmjs.org'],
  installersAllowed: ['npm', 'pnpm', 'yarn'],
};

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

// ---- minimal dependency-free unified-diff parser + applier (§6.1 APPLY_PATCH) ----

interface DiffLine {
  op: ' ' | '+' | '-';
  text: string;
}
interface Hunk {
  oldStart: number;
  lines: DiffLine[];
}
interface FilePatch {
  path: string;
  hunks: Hunk[];
}

function parseUnifiedDiff(diff: string): FilePatch[] {
  const files: FilePatch[] = [];
  let current: FilePatch | null = null;
  let hunk: Hunk | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('--- ')) {
      hunk = null;
      continue; // target file comes from the +++ header
    }
    if (line.startsWith('+++ ')) {
      let p = line.slice(4).trim();
      const tab = p.indexOf('\t');
      if (tab !== -1) p = p.slice(0, tab);
      if (p.startsWith('b/')) p = p.slice(2);
      current = { path: p, hunks: [] };
      files.push(current);
      hunk = null;
      continue;
    }
    const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hm) {
      if (!current) continue;
      hunk = { oldStart: parseInt(hm[1]!, 10), lines: [] };
      current.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    const op = line[0];
    if (op === ' ' || op === '+' || op === '-') hunk.lines.push({ op, text: line.slice(1) });
    // a bare '' (trailing split artifact) is not a diff body line — ignore
  }
  return files;
}

/** apply hunks by matching context/removed lines exactly; any mismatch is a conflict (no fuzz) */
function applyHunks(content: string, hunks: Hunk[]): { ok: true; result: string } | { ok: false; detail: string } {
  const orig = content.length ? content.split('\n') : [];
  const out: string[] = [];
  let cursor = 0;
  for (const h of hunks) {
    const start = h.oldStart - 1;
    if (start < cursor || start > orig.length) return { ok: false, detail: `hunk position ${h.oldStart} out of range` };
    while (cursor < start) out.push(orig[cursor++]!);
    for (const l of h.lines) {
      if (l.op === '+') {
        out.push(l.text);
        continue;
      }
      if (orig[cursor] !== l.text) return { ok: false, detail: `context mismatch at line ${cursor + 1}` };
      if (l.op === ' ') out.push(orig[cursor]!);
      cursor++;
    }
  }
  while (cursor < orig.length) out.push(orig[cursor++]!);
  return { ok: true, result: out.join('\n') };
}

/** wrap a command so the OS denies all network egress (INV-14). fail-closed when unavailable. */
function egressDenyWrapper(cmd: string, args: string[]): { cmd: string; args: string[] } | null {
  if (platform() === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
    return { cmd: '/usr/bin/sandbox-exec', args: ['-p', '(version 1)(allow default)(deny network*)', cmd, ...args] };
  }
  if (platform() === 'linux') {
    // user+net namespaces: no privileges needed on typical CI kernels
    return { cmd: 'unshare', args: ['-rn', cmd, ...args] };
  }
  return null; // ponytail: windows sandboxing lands with the Windows port; fail-closed until then
}

export class Executor {
  constructor(
    private log: EventLog,
    private hooks: ExecutorHooks = {},
    private deps: ExecutorDeps = {},
  ) {}

  private hasApplied(taskId: string, actionId: string): boolean {
    return this.log
      .eventsFor(taskId)
      .some((e) => e.type === 'ACTION_APPLIED' && e.payload.actionId === actionId);
  }

  execute(ctx: TaskContext, action: Action): ActionOutcome {
    if (this.hasApplied(ctx.taskId, action.actionId)) {
      return { status: 'skipped_duplicate', actionId: action.actionId };
    }

    const decision = checkActionPolicy(ctx.role, action, ctx.worktree);
    if (!decision.allowed) {
      this.log.append({
        ts: Date.now(), taskId: ctx.taskId, principal: 'core',
        type: decision.policy === 'egress-default-deny' ? 'EGRESS_DENIED' : 'ACTION_REJECTED',
        payload: { actionId: action.actionId, policy: decision.policy, reason: decision.reason ?? '' },
      });
      return { status: 'rejected', actionId: action.actionId, reason: decision.reason ?? '', policy: decision.policy };
    }

    this.log.append({
      ts: Date.now(), taskId: ctx.taskId, type: 'ACTION_INTENT', principal: 'core',
      payload: { actionId: action.actionId, action: JSON.parse(JSON.stringify(action)) as Record<string, unknown> },
    });

    if (this.hooks.crashAfterIntent?.(action)) {
      throw new Error(`SIMULATED_CRASH after INTENT ${action.actionId}`);
    }

    const outcome = this.apply(ctx, action);
    if (outcome.status === 'applied') {
      const payload: Record<string, unknown> = {
        actionId: action.actionId, resultHash: outcome.resultHash, exitCode: outcome.exitCode ?? null,
      };
      // sign ONLY what core captured itself (§10.1 T6) — command output, not an agent's claim
      if (action.type === 'RUN_COMMAND' && this.deps.evidenceKeyFile) {
        const sig = signEvidence(
          { actionId: action.actionId, resultHash: outcome.resultHash, exitCode: outcome.exitCode ?? null },
          this.deps.evidenceKeyFile,
        );
        payload.resultSig = sig;
        outcome.resultSig = sig;
      }
      this.log.append({ ts: Date.now(), taskId: ctx.taskId, type: 'ACTION_APPLIED', principal: 'core', payload });
    }
    return outcome;
  }

  private apply(ctx: TaskContext, action: Action): ActionOutcome {
    switch (action.type) {
      case 'WRITE_FILE': {
        const abs = resolve(ctx.worktree, action.path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, action.content);
        return { status: 'applied', actionId: action.actionId, resultHash: sha256(action.content) };
      }
      case 'READ_FILE': {
        const abs = resolve(ctx.worktree, action.path);
        if (!existsSync(abs)) {
          return { status: 'rejected', actionId: action.actionId, reason: 'file not found', policy: 'read-allowed' };
        }
        const content = readFileSync(abs, 'utf8');
        return { status: 'applied', actionId: action.actionId, resultHash: sha256(content), stdout: content };
      }
      case 'RUN_COMMAND': {
        if (action.network === 'package_install') return this.runPackageInstall(ctx, action);
        const wrapped = egressDenyWrapper(action.cmd, action.args);
        if (!wrapped) {
          this.log.append({
            ts: Date.now(), taskId: ctx.taskId, type: 'EGRESS_DENIED', principal: 'core',
            payload: { actionId: action.actionId, reason: 'no egress-deny mechanism on this platform (fail-closed)' },
          });
          return { status: 'rejected', actionId: action.actionId, reason: 'egress-deny sandbox unavailable — fail-closed (INV-14)', policy: 'egress-default-deny' };
        }
        this.log.append({
          ts: Date.now(), taskId: ctx.taskId, type: 'EGRESS_DENIED', principal: 'core',
          payload: { actionId: action.actionId, mode: 'sandbox', network: action.network ?? 'none' },
        });
        const cwd = action.cwd ? resolve(ctx.worktree, action.cwd) : ctx.worktree;
        const r = spawnSync(wrapped.cmd, wrapped.args, {
          cwd,
          env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
          encoding: 'utf8',
          timeout: 120_000,
        });
        const stdout = r.stdout ?? '';
        const stderr = r.stderr ?? '';
        const exitCode = r.status ?? -1;
        return {
          status: 'applied', actionId: action.actionId,
          resultHash: sha256(stdout + stderr + String(exitCode)),
          stdout, stderr, exitCode,
        };
      }
      case 'APPLY_PATCH': {
        const files = parseUnifiedDiff(action.diff);
        if (files.length === 0) {
          return { status: 'rejected', actionId: action.actionId, reason: 'empty or unparseable diff', policy: 'patch-parse' };
        }
        // all-or-nothing: stage every file, only commit if every hunk matched (§6.1)
        const staged: { abs: string; path: string; content: string }[] = [];
        for (const f of files) {
          const abs = resolve(ctx.worktree, f.path);
          const before = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
          const res = applyHunks(before, f.hunks);
          if (!res.ok) {
            this.log.append({
              ts: Date.now(), taskId: ctx.taskId, type: 'PATCH_CONFLICT', principal: 'core',
              payload: { actionId: action.actionId, path: f.path, detail: res.detail },
            });
            return { status: 'rejected', actionId: action.actionId, reason: `patch conflict in ${f.path}: ${res.detail}`, policy: 'patch-conflict' };
          }
          staged.push({ abs, path: f.path, content: res.result });
        }
        for (const s of staged) {
          mkdirSync(dirname(s.abs), { recursive: true });
          writeFileSync(s.abs, s.content);
        }
        return { status: 'applied', actionId: action.actionId, resultHash: sha256(staged.map((s) => `${s.path}\n${s.content}`).join('\n')) };
      }
      case 'REQUEST_TOOL':
        return { status: 'rejected', actionId: action.actionId, reason: 'tools not enabled in this phase', policy: 'tool-handlers' };
    }
  }

  /** sanctioned dependency-install egress (§10.1 T4): pinned registry + --ignore-scripts, no sandbox */
  private runPackageInstall(ctx: TaskContext, action: Extract<Action, { type: 'RUN_COMMAND' }>): ActionOutcome {
    const dep = checkPackageInstall(this.log, ctx.taskId, action, this.deps.dependencyPolicy ?? DEFAULT_DEP_POLICY);
    if (!dep.allowed) {
      return { status: 'rejected', actionId: action.actionId, reason: dep.reason, policy: 'package-install' };
    }
    const cwd = action.cwd ? resolve(ctx.worktree, action.cwd) : ctx.worktree;
    // egress is allowed ONLY for this pinned command — everything else stays sandboxed
    const r = spawnSync(action.cmd, dep.rewrittenArgs!, {
      cwd,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
      encoding: 'utf8',
      timeout: 300_000,
    });
    const stdout = r.stdout ?? '';
    const stderr = r.stderr ?? '';
    const exitCode = r.status ?? -1;
    return {
      status: 'applied', actionId: action.actionId,
      resultHash: sha256(stdout + stderr + String(exitCode)),
      stdout, stderr, exitCode,
    };
  }

  /** crash recovery (§6.2): resolve dangling INTENT without double-apply; detect worktree drift. */
  recover(ctx: TaskContext): { resolved: number; applied: number; skipped: number } {
    const events = this.log.eventsFor(ctx.taskId);
    const appliedIds = new Set(
      events.filter((e) => e.type === 'ACTION_APPLIED').map((e) => e.payload.actionId as string),
    );
    let resolved = 0, applied = 0, skipped = 0;

    // dangling INTENTs: applied on disk already? record it. otherwise leave for re-issue.
    for (const e of events.filter((ev) => ev.type === 'ACTION_INTENT')) {
      const actionId = e.payload.actionId as string;
      if (appliedIds.has(actionId)) continue;
      resolved++;
      const action = e.payload.action as unknown as Action;
      if (action.type === 'WRITE_FILE') {
        const abs = resolve(ctx.worktree, action.path);
        if (existsSync(abs) && sha256(readFileSync(abs)) === sha256(action.content)) {
          this.log.append({
            ts: Date.now(), taskId: ctx.taskId, type: 'ACTION_APPLIED', principal: 'core',
            payload: { actionId, resultHash: sha256(action.content), recovered: true },
          });
          appliedIds.add(actionId);
          applied++;
          continue;
        }
      }
      skipped++; // not on disk (or non-replayable type) — safe to re-issue
    }

    // drift detection (scenario 4): last APPLIED WRITE_FILE must still match disk
    const lastWriteByPath = new Map<string, { actionId: string; contentHash: string }>();
    for (const e of events.filter((ev) => ev.type === 'ACTION_INTENT')) {
      const action = e.payload.action as unknown as Action;
      const actionId = e.payload.actionId as string;
      if (action.type === 'WRITE_FILE' && appliedIds.has(actionId)) {
        lastWriteByPath.set(action.path, { actionId, contentHash: sha256(action.content) });
      }
    }
    for (const [path, w] of lastWriteByPath) {
      const abs = resolve(ctx.worktree, path);
      const diskHash = existsSync(abs) ? sha256(readFileSync(abs)) : 'missing';
      if (diskHash !== w.contentHash) {
        this.log.append({
          ts: Date.now(), taskId: ctx.taskId, type: 'WORKTREE_MISMATCH', principal: 'core',
          payload: { path, expected: w.contentHash, actual: diskHash, actionId: w.actionId },
        });
      }
    }
    return { resolved, applied, skipped };
  }
}
