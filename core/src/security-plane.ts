// Security plane Phase 2 additions (§10.1): runtime injection canary tripwire,
// dependency policy for package installs (registry allowlist + --ignore-scripts).
import type { EventLog } from './event-log.js';
import type { Action } from './types.js';

/** runtime tripwire: structured results carrying canary markers are quarantined evidence of injection */
export function checkInjectionCanary(
  log: EventLog,
  taskId: string,
  structuredResult: Record<string, unknown>,
): { tripped: boolean } {
  const tripped =
    structuredResult.canaryTripped === true ||
    /CANARY-\d+-TRIPPED/.test(JSON.stringify(structuredResult));
  if (tripped) {
    log.append({
      ts: Date.now(), taskId, type: 'INJECTION_CANARY_TRIPPED', principal: 'core',
      payload: { note: 'low-trust content influenced output — route to susceptibility-aware handling (P7)' },
    });
  }
  return { tripped };
}

// ---- dependency policy (§10.1 T4): the ONLY sanctioned egress for RUN_COMMAND ----

export interface DependencyPolicy {
  allowedRegistries: string[]; // e.g. ['https://registry.npmjs.org/']
  installersAllowed: string[]; // e.g. ['npm', 'pnpm']
}

export interface DepDecision {
  allowed: boolean;
  rewrittenArgs?: string[];
  reason: string;
}

/** validate a package-install RUN_COMMAND against policy; force --ignore-scripts + pinned registry */
export function checkPackageInstall(
  log: EventLog,
  taskId: string,
  action: Extract<Action, { type: 'RUN_COMMAND' }>,
  policy: DependencyPolicy,
): DepDecision {
  if (!policy.installersAllowed.includes(action.cmd)) {
    return { allowed: false, reason: `installer ${action.cmd} not in policy` };
  }
  if (!['install', 'add', 'i'].includes(action.args[0] ?? '')) {
    return { allowed: false, reason: 'only install/add subcommands are covered by package_install policy' };
  }
  const registry = policy.allowedRegistries[0];
  if (!registry) return { allowed: false, reason: 'no registry allowlisted' };
  const rewrittenArgs = [
    ...action.args.filter((a) => !a.startsWith('--registry') && a !== '--ignore-scripts'),
    '--ignore-scripts',
    `--registry=${registry}`,
  ];
  log.append({
    ts: Date.now(), taskId, type: 'PACKAGE_INSTALL_SANCTIONED', principal: 'core',
    payload: { cmd: action.cmd, registry, forcedIgnoreScripts: true },
  });
  return { allowed: true, rewrittenArgs, reason: `pinned to ${registry} with --ignore-scripts (lockfile diff still gate-checked)` };
}
