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

export interface ExecutorHooks {
  /** test-only fault injection: crash after INTENT, before APPLIED */
  crashAfterIntent?: (action: Action) => boolean;
}

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

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
      this.log.append({
        ts: Date.now(), taskId: ctx.taskId, type: 'ACTION_APPLIED', principal: 'core',
        payload: { actionId: action.actionId, resultHash: outcome.resultHash, exitCode: outcome.exitCode ?? null },
      });
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
      case 'APPLY_PATCH':
        // ponytail: diff application lands with Phase 1 agents; WRITE_FILE covers Phase 0
        return { status: 'rejected', actionId: action.actionId, reason: 'APPLY_PATCH not enabled in this phase', policy: 'tool-handlers' };
      case 'REQUEST_TOOL':
        return { status: 'rejected', actionId: action.actionId, reason: 'tools not enabled in this phase', policy: 'tool-handlers' };
    }
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
