// Path allowlist by role (§6.1, least privilege). test/golden/** read-only for every role.
import type { Action, Role } from './types.js';

export interface PolicyDecision {
  allowed: boolean;
  policy: string;
  reason?: string;
}

export function checkActionPolicy(_role: Role, _action: Action, _worktree: string): PolicyDecision {
  throw new Error('NOT_IMPLEMENTED');
}
