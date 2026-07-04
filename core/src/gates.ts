// Gate ladder (§6.4). T0/T1 real in Phase 0, T2/T3 explicit stubs.
import type { GateResult } from './types.js';

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

export function gateConfigHash(_config: GateConfig): string { throw new Error('NOT_IMPLEMENTED'); }
export function runGate(_tier: 'T0' | 'T1' | 'T2' | 'T3', _config: GateConfig): GateResult { throw new Error('NOT_IMPLEMENTED'); }
