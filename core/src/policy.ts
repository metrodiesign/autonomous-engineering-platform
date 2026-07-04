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

/** resolve a task-relative path and require it to stay inside the worktree */
function confine(worktree: string, p: string): string | null {
  const abs = resolve(worktree, p);
  const root = resolve(worktree);
  if (abs === root || abs.startsWith(root + sep)) return abs.slice(root.length + 1);
  return null;
}

export function checkActionPolicy(role: Role, action: Action, worktree: string): PolicyDecision {
  switch (action.type) {
    case 'WRITE_FILE':
    case 'APPLY_PATCH': {
      const rel = action.type === 'WRITE_FILE' ? confine(worktree, action.path) : '';
      if (rel === null) return deny('worktree-confinement', 'path escapes worktree');
      if (action.type === 'WRITE_FILE') {
        if (rel.startsWith('test/golden')) return deny('golden-read-only', 'test/golden/** is read-only for all roles (INV-16)');
        const prefixes = WRITE_PREFIXES[role];
        if (!prefixes.some((pre) => rel === pre || rel.startsWith(pre + '/'))) {
          return deny('role-allowlist', `role ${role} may not write ${rel}`);
        }
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
      if (network !== 'none') {
        // named egress allowlists arrive with dependency policy (Phase 2); until then everything is deny
        return deny('egress-default-deny', `network policy ${network} not enabled in this phase (INV-14)`);
      }
      return allow('egress-default-deny');
    }
    case 'REQUEST_TOOL':
      return deny('tool-handlers', `tool ${action.name} not enabled in this phase`);
  }
}
