// Gate ladder (§6.4). T0/T1 real in Phase 0, T2/T3 explicit stubs.
// Gate-config hash goes into evidence on every run (INV-10).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { GateResult } from './types.js';
import { verifyGoldenManifest } from './golden.js';

export interface GateCommand {
  name: string;
  cmd: string;
  args: string[];
  cwd: string;
}

export interface GateConfig {
  t0: GateCommand[];
  t1: GateCommand[];
  goldenDir?: string;
  /** retries for flaky detection: rerun failed command once, flag if it then passes */
  flakyRetry: boolean;
}

export function gateConfigHash(config: GateConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
}

function runCommands(cmds: GateCommand[], flakyRetry: boolean): { pass: boolean; flaky: boolean; detail: string } {
  let flaky = false;
  for (const c of cmds) {
    const run = () =>
      spawnSync(c.cmd, c.args, { cwd: c.cwd, encoding: 'utf8', timeout: 300_000 }).status === 0;
    if (!run()) {
      if (flakyRetry && run()) {
        flaky = true; // failed then passed — flag, never silently quarantine (INV-16)
        continue;
      }
      return { pass: false, flaky, detail: `gate command failed: ${c.name}` };
    }
  }
  return { pass: true, flaky, detail: 'all commands passed' };
}

export function runGate(tier: 'T0' | 'T1' | 'T2' | 'T3', config: GateConfig): GateResult {
  const hash = gateConfigHash(config);
  if (tier === 'T2' || tier === 'T3') {
    return { tier, status: 'not_enabled', gateConfigHash: hash, detail: `${tier} not enabled in this phase` };
  }
  const cmds = tier === 'T0' ? config.t0 : config.t1;
  const r = runCommands(cmds, config.flakyRetry);
  if (tier === 'T1' && r.pass && config.goldenDir) {
    const golden = verifyGoldenManifest(config.goldenDir);
    if (!golden.ok) {
      return { tier, status: 'fail', gateConfigHash: hash, detail: `golden integrity: ${golden.detail}`, flaky: r.flaky };
    }
  }
  return { tier, status: r.pass ? 'pass' : 'fail', gateConfigHash: hash, detail: r.detail, flaky: r.flaky };
}
