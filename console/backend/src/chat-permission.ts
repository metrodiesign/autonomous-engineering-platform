// F-Chat Phase 1 — the fail-closed permission core for the SDK query() chat sandbox.
// No Fastify, no WS, no model calls: pure policy + path guard, so it is fully unit-testable.
//
// Posture (PLAN.md §B, hardened via Codex review):
//   - The chat agent's built-in tool set is Read only. Grep/Glob are dropped: they tree-walk and
//     canUseTool only sees the top-level path arg, so a symlink inside the root that points outside
//     could leak file contents that a per-file guard never inspected. Search comes from the console's
//     own FTS5 endpoint instead (a later phase), not from an SDK tree-walker.
//   - Execution/mutation/network/task tools are denied at three layers: not in `tools`, listed in
//     `disallowedTools`, and default-denied by canUseTool. Any unclassified tool → DENY.
//   - Read is allowed only when its target realpath (root and target both canonicalized) stays under
//     the session root AND is not a credential file. Non-existent target, traversal, symlink escape,
//     or an aborted signal all → DENY.
import type { CanUseTool, PermissionMode, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/** The only built-in tool the chat agent may call. */
export const READ_ALLOWLIST = new Set(['Read']);

/** Denied explicitly (defense in depth beyond `tools: ['Read']`). */
const DENIED_TOOLS = [
  'Bash', 'BashOutput', 'KillShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'WebFetch', 'WebSearch', 'Task', 'Grep', 'Glob',
];

const CREDENTIAL_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\.[^/]+)?$/, // .env, .env.local
  /(^|\/)\.ssh\//,
  /(^|\/)\.aws\//,
  /(^|\/)\.gnupg\//,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/,
  /\.(pem|key|p12|pfx)$/,
  /(^|\/)(credentials|\.netrc|\.git-credentials)$/,
];

/** True if the (already canonicalized) path looks like a credential file. */
export function isCredentialPath(p: string): boolean {
  return CREDENTIAL_PATTERNS.some((re) => re.test(p));
}

/**
 * Canonicalize `root` and `candidate` (resolving symlinks on BOTH, and requiring the target to exist),
 * returning the real target path only if it stays under the real root — else null.
 *
 * Unlike core's private `orchestrator.confinePath`, this realpaths the TARGET, not just the root, so a
 * symlink living inside the root but pointing outside is caught (it resolves outside → rejected).
 */
export function confineExistingRealPath(root: string, candidate: string): string | null {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return null;
  }
  const resolved = resolve(realRoot, candidate);
  let realTarget: string;
  try {
    realTarget = realpathSync(resolved); // must exist; follows every symlink in the chain
  } catch {
    return null;
  }
  return realTarget === realRoot || realTarget.startsWith(realRoot + sep) ? realTarget : null;
}

const deny = (message: string): PermissionResult => ({ behavior: 'deny', message });
const ALLOW: PermissionResult = { behavior: 'allow' };

/**
 * Build the canUseTool broker for a chat session confined to `roots` (usually one session cwd).
 * Every decision is synchronous and fail-closed — there is no human-ask path (chat cannot approve
 * execution), so no pending promise, no timeout, and no hang.
 */
export function makeChatPermission(roots: string[]): CanUseTool {
  return async (toolName, input, options) => {
    if (options.signal.aborted) return deny('request aborted');
    if (!READ_ALLOWLIST.has(toolName)) {
      return deny(`tool "${toolName}" is not permitted in the chat sandbox (read-only)`);
    }
    const fp = input.file_path;
    if (typeof fp !== 'string' || fp === '') return deny('Read requires a file_path');
    let real: string | null = null;
    for (const r of roots) {
      real = confineExistingRealPath(r, fp);
      if (real) break;
    }
    if (!real) return deny(`path escapes the chat sandbox or does not exist: ${fp}`);
    if (isCredentialPath(real)) return deny(`credential path denied: ${fp}`);
    return ALLOW;
  };
}

/** The subset of SDK query() options that isolates a chat session. Spread into query() in a later phase. */
export interface SandboxedQueryConfig {
  cwd: string;
  tools: string[];
  disallowedTools: string[];
  settingSources: [];
  mcpServers: Record<string, never>;
  permissionMode: PermissionMode;
  canUseTool: CanUseTool;
}

/** Assemble the fail-closed sandbox config for a chat session rooted at `cwd`. */
export function makeChatSandbox(cwd: string): SandboxedQueryConfig {
  return {
    cwd,
    tools: ['Read'],
    disallowedTools: DENIED_TOOLS,
    settingSources: [], // do not load user/project/local settings (no bypassPermissions/hooks/skills widening)
    mcpServers: {}, // no MCP tools
    permissionMode: 'default', // so canUseTool is consulted
    canUseTool: makeChatPermission([cwd]),
  };
}
