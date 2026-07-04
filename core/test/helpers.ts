// Shared fixtures for fault-injection suite (§14 Phase 0 DoD).
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog } from '../src/event-log.js';
import { Executor, type ExecutorHooks } from '../src/executor.js';
import { Orchestrator } from '../src/orchestrator.js';
import type { GateConfig } from '../src/gates.js';
import type { AgentPort, Budget, Proposal, TaskContext } from '../src/types.js';

export function makeWorktree(): string {
  const wt = mkdtempSync(join(tmpdir(), 'fi-wt-'));
  mkdirSync(join(wt, 'src'), { recursive: true });
  mkdirSync(join(wt, 'test', 'ai-generated'), { recursive: true });
  mkdirSync(join(wt, 'test', 'golden'), { recursive: true });
  writeFileSync(join(wt, 'test', 'golden', 'truth.txt'), 'golden truth\n');
  return wt;
}

export function makeLog(): EventLog {
  return new EventLog(join(mkdtempSync(join(tmpdir(), 'fi-db-')), 'events.db'));
}

export const budget: Budget = { maxIterations: 5, maxCostUnits: 1000, maxWallclockMs: 60_000 };

export function ctx(taskId: string, worktree: string, over: Partial<TaskContext> = {}): TaskContext {
  return { taskId, role: 'implementer', worktree, budget, ...over };
}

/** stub agent that replays a fixed script of proposals (vendor-free by construction) */
export function scriptedAgent(script: Proposal[]): AgentPort {
  let i = 0;
  return {
    async propose() {
      const p = script[Math.min(i, script.length - 1)];
      i++;
      return p!;
    },
  };
}

/** gate config whose commands are plain shell probes inside the worktree */
export function fakeGates(worktree: string, t1Cmd: string[] = ['true']): GateConfig {
  return {
    t0: [{ name: 'probe-t0', cmd: t1Cmd[0]!, args: t1Cmd.slice(1), cwd: worktree }],
    t1: [{ name: 'probe-t1', cmd: t1Cmd[0]!, args: t1Cmd.slice(1), cwd: worktree }],
    goldenDir: join(worktree, 'test', 'golden'),
    flakyRetry: true,
  };
}

export function makeStack(worktree: string, hooks: ExecutorHooks = {}, t1Cmd?: string[]) {
  const log = makeLog();
  const executor = new Executor(log, hooks);
  const orch = new Orchestrator(log, executor, fakeGates(worktree, t1Cmd));
  return { log, executor, orch };
}
