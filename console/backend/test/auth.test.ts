// F-Auth (§5.1): detect env vars that silently shadow subscription auth → red warning,
// never silently unset (spec: "ห้ามลบให้เองเงียบ ๆ").
import { describe, it, expect } from 'vitest';
import { detectAuth } from '../src/auth.js';

describe('auth detection (§5.1 / INV-12)', () => {
  it('clean env → subscription credential chain, no warnings', () => {
    const a = detectAuth({});
    expect(a.warnings).toHaveLength(0);
    expect(a.method).toBe('subscription (credential chain)');
  });

  it('ANTHROPIC_API_KEY present → red warning naming the exact variable to unset', () => {
    const a = detectAuth({ ANTHROPIC_API_KEY: 'sk-xxx' });
    expect(a.warnings.length).toBeGreaterThan(0);
    expect(a.warnings[0]!.severity).toBe('red');
    expect(a.warnings[0]!.variable).toBe('ANTHROPIC_API_KEY');
    expect(a.warnings[0]!.message).toMatch(/unset/i);
    expect(a.method).toBe('api-key (shadowing subscription)');
  });

  it('never returns the secret value itself (redaction, INV-14)', () => {
    const a = detectAuth({ ANTHROPIC_API_KEY: 'sk-super-secret' });
    expect(JSON.stringify(a)).not.toContain('sk-super-secret');
  });

  it('ANTHROPIC_AUTH_TOKEN and CLAUDE_CODE_OAUTH_TOKEN also flagged', () => {
    expect(detectAuth({ ANTHROPIC_AUTH_TOKEN: 't' }).warnings.length).toBe(1);
    expect(detectAuth({ CLAUDE_CODE_OAUTH_TOKEN: 't' }).warnings[0]!.severity).toBe('yellow');
  });
});
