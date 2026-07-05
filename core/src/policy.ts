// Path allowlist by role (§6.1, least privilege). test/golden/** read-only for every role.
import { resolve, sep } from 'node:path';
import type { Action, Role } from './types.js';

export interface PolicyDecision {
  allowed: boolean;
  policy: string;
  reason?: string;
}

const WRITE_PREFIXES: Record<Role, string[]> = {
  planner: [], // read-only
  test_designer: ['test/ai-generated'],
  implementer: ['src', 'test/ai-generated'],
  reviewer: [], // read-only
};

const deny = (policy: string, reason: string): PolicyDecision => ({ allowed: false, policy, reason });
const allow = (policy: string): PolicyDecision => ({ allowed: true, policy });

/** package managers whose install/add is the ONLY sanctioned RUN_COMMAND egress (§10.1) */
const PACKAGE_INSTALLERS = ['npm', 'pnpm', 'yarn'];

function isPackageInstall(action: Extract<Action, { type: 'RUN_COMMAND' }>): boolean {
  return PACKAGE_INSTALLERS.includes(action.cmd) && ['install', 'add', 'i'].includes(action.args[0] ?? '');
}

/** resolve a task-relative path and require it to stay inside the worktree */
function confine(worktree: string, p: string): string | null {
  const abs = resolve(worktree, p);
  const root = resolve(worktree);
  if (abs === root || abs.startsWith(root + sep)) return abs.slice(root.length + 1);
  return null;
}

/** golden read-only (INV-16) + per-role write allowlist — shared by WRITE_FILE and APPLY_PATCH */
function writePathDecision(role: Role, rel: string): PolicyDecision {
  if (rel.startsWith('test/golden')) return deny('golden-read-only', 'test/golden/** is read-only for all roles (INV-16)');
  const prefixes = WRITE_PREFIXES[role];
  if (!prefixes.some((pre) => rel === pre || rel.startsWith(pre + '/'))) {
    return deny('role-allowlist', `role ${role} may not write ${rel}`);
  }
  return allow('role-allowlist');
}

/** the b/ target paths a unified diff writes to (headers only — the executor does the real parse) */
function patchTargets(diff: string): string[] {
  const targets: string[] = [];
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+++ ')) continue;
    let p = line.slice(4).trim();
    const tab = p.indexOf('\t');
    if (tab !== -1) p = p.slice(0, tab);
    if (p === '/dev/null') continue;
    if (p.startsWith('b/')) p = p.slice(2);
    targets.push(p);
  }
  return targets;
}

export function checkActionPolicy(role: Role, action: Action, worktree: string): PolicyDecision {
  switch (action.type) {
    case 'WRITE_FILE': {
      const rel = confine(worktree, action.path);
      if (rel === null) return deny('worktree-confinement', 'path escapes worktree');
      return writePathDecision(role, rel);
    }
    case 'APPLY_PATCH': {
      const targets = patchTargets(action.diff);
      if (targets.length === 0) return deny('patch-parse', 'diff has no file headers');
      for (const t of targets) {
        const rel = confine(worktree, t);
        if (rel === null) return deny('worktree-confinement', 'patch path escapes worktree');
        const d = writePathDecision(role, rel);
        if (!d.allowed) return d;
      }
      return allow('role-allowlist');
    }
    case 'READ_FILE': {
      const rel = confine(worktree, action.path);
      if (rel === null) return deny('worktree-confinement', 'path escapes worktree');
      return allow('read-allowed');
    }
    case 'RUN_COMMAND': {
      if (role === 'planner' || role === 'reviewer') return deny('role-allowlist', `role ${role} may not run commands`);
      const cwdRel = action.cwd ? confine(worktree, action.cwd) : '';
      if (cwdRel === null) return deny('worktree-confinement', 'cwd escapes worktree');
      const network = action.network ?? 'none';
      if (network === 'none') return allow('egress-default-deny');
      if (network === 'package_install') {
        // the single sanctioned egress: registry pin + --ignore-scripts enforced by the executor
        return isPackageInstall(action)
          ? allow('package-install')
          : deny('package-install', 'network package_install declared but command is not a sanctioned package install');
      }
      // named egress allowlists arrive with dependency policy (later phase); until then everything is deny
      return deny('egress-default-deny', `network policy ${network} not enabled in this phase (INV-14)`);
    }
    case 'REQUEST_TOOL':
      return deny('tool-handlers', `tool ${action.name} not enabled in this phase`);
  }
}
