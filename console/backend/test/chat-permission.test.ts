// F-Chat Phase 1 — fail-closed proofs for the chat permission core (no model, no network).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makeChatPermission, makeChatSandbox, confineExistingRealPath, isCredentialPath, READ_ALLOWLIST,
} from '../src/chat-permission.js';

// minimal canUseTool options; the broker only reads options.signal
const opts = (aborted = false): Parameters<ReturnType<typeof makeChatPermission>>[2] => {
  const ac = new AbortController();
  if (aborted) ac.abort();
  return { signal: ac.signal, toolUseID: 'tu', requestId: 'rq' } as unknown as Parameters<ReturnType<typeof makeChatPermission>>[2];
};

describe('chat permission — fail-closed (Phase 1)', () => {
  const root = mkdtempSync(join(tmpdir(), 'chat-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'chat-outside-'));
  writeFileSync(join(root, 'ok.txt'), 'inside');
  writeFileSync(join(root, '.env'), 'SECRET=1');
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'sub', 'deep.txt'), 'deep');
  writeFileSync(join(outside, 'secret.txt'), 'exfil');
  symlinkSync(join(outside, 'secret.txt'), join(root, 'link-out.txt')); // symlink inside root -> outside

  const canUse = makeChatPermission([root]);

  it('allows Read of a file inside the sandbox', async () => {
    expect((await canUse('Read', { file_path: join(root, 'ok.txt') }, opts()))?.behavior).toBe('allow');
  });

  it('allows Read of a nested file inside the sandbox', async () => {
    expect((await canUse('Read', { file_path: join(root, 'sub', 'deep.txt') }, opts()))?.behavior).toBe('allow');
  });

  it.each(['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Grep', 'Glob', 'mcp__x__y', 'Unknown'])(
    'denies non-Read tool: %s',
    async (tool) => {
      expect((await canUse(tool, { file_path: join(root, 'ok.txt') }, opts()))?.behavior).toBe('deny');
    },
  );

  it('denies Read outside the sandbox (absolute path)', async () => {
    expect((await canUse('Read', { file_path: join(outside, 'secret.txt') }, opts()))?.behavior).toBe('deny');
  });

  it('denies Read via ../ traversal', async () => {
    expect((await canUse('Read', { file_path: join(root, '..', '..', 'etc', 'hosts') }, opts()))?.behavior).toBe('deny');
  });

  it('denies Read through a symlink that escapes the sandbox', async () => {
    expect((await canUse('Read', { file_path: join(root, 'link-out.txt') }, opts()))?.behavior).toBe('deny');
  });

  it('denies Read of a credential file (.env) even inside the sandbox', async () => {
    expect((await canUse('Read', { file_path: join(root, '.env') }, opts()))?.behavior).toBe('deny');
  });

  it('denies Read of a non-existent file', async () => {
    expect((await canUse('Read', { file_path: join(root, 'nope.txt') }, opts()))?.behavior).toBe('deny');
  });

  it('denies Read with a missing file_path', async () => {
    expect((await canUse('Read', {}, opts()))?.behavior).toBe('deny');
  });

  it('denies when the abort signal is already aborted', async () => {
    expect((await canUse('Read', { file_path: join(root, 'ok.txt') }, opts(true)))?.behavior).toBe('deny');
  });
});

describe('confineExistingRealPath', () => {
  const root = mkdtempSync(join(tmpdir(), 'confine-'));
  const outside = mkdtempSync(join(tmpdir(), 'confine-out-'));
  writeFileSync(join(root, 'a.txt'), 'a');
  writeFileSync(join(outside, 'b.txt'), 'b');
  symlinkSync(join(outside, 'b.txt'), join(root, 'esc'));

  it('returns a real path for a file inside root', () => {
    expect(confineExistingRealPath(root, 'a.txt')).not.toBeNull();
  });
  it('null for a path outside root', () => {
    expect(confineExistingRealPath(root, join(outside, 'b.txt'))).toBeNull();
  });
  it('null for a symlink that escapes root', () => {
    expect(confineExistingRealPath(root, 'esc')).toBeNull();
  });
  it('null for a missing file', () => {
    expect(confineExistingRealPath(root, 'missing.txt')).toBeNull();
  });
});

describe('isCredentialPath', () => {
  it.each(['/x/.env', '/x/.env.local', '/home/u/.ssh/id_rsa', '/x/key.pem', '/x/.aws/credentials', '/x/.git-credentials'])(
    'flags %s',
    (p) => expect(isCredentialPath(p)).toBe(true),
  );
  it.each(['/x/ok.txt', '/x/readme.md', '/x/env.ts'])(
    'allows %s',
    (p) => expect(isCredentialPath(p)).toBe(false),
  );
});

describe('makeChatSandbox config', () => {
  const c = makeChatSandbox('/tmp/session');
  it('exposes only Read as a built-in tool', () => expect(c.tools).toEqual(['Read']));
  it('permissionMode is default so canUseTool fires', () => expect(c.permissionMode).toBe('default'));
  it('loads no settings sources', () => expect(c.settingSources).toEqual([]));
  it('registers no MCP servers', () => expect(c.mcpServers).toEqual({}));
  it('disallows execution/mutation/network/search tools', () => {
    for (const t of ['Bash', 'Write', 'Edit', 'WebFetch', 'Task', 'Grep', 'Glob']) expect(c.disallowedTools).toContain(t);
  });
  it('wires a canUseTool broker', () => expect(typeof c.canUseTool).toBe('function'));
  it('READ_ALLOWLIST is Read-only', () => expect([...READ_ALLOWLIST]).toEqual(['Read']));
  it('has no resume/forkSession by default', () => {
    expect(c.resume).toBeUndefined();
    expect(c.forkSession).toBeUndefined();
  });
  it('a resume id forks to a new session (never mutates the original transcript, INV-11)', () => {
    const r = makeChatSandbox('/tmp/session', '0199aa11-2233-4455-6677-8899aabbccdd');
    expect(r.resume).toBe('0199aa11-2233-4455-6677-8899aabbccdd');
    expect(r.forkSession).toBe(true);
  });
  it('a resumed session still keeps the Read-only tool policy', () => {
    const r = makeChatSandbox('/tmp/session', '0199aa11-2233-4455-6677-8899aabbccdd');
    expect(r.tools).toEqual(['Read']);
    expect(r.permissionMode).toBe('default');
  });
});
