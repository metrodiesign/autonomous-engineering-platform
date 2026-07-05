// C9 adapter gaps: §7.6 codex skeleton (UNVERIFIED) + provider_data_policy path allowlist.
// No network, no credentials — every path here throws or validates before egress.
import { describe, it, expect } from 'vitest';
import type { AgentRequest } from '../src/index.js';
import {
  CodexAdapter,
  OpenAICompatAdapter,
  ProviderDataPolicyError,
  UnverifiedAdapterError,
} from '../src/index.js';

const req: AgentRequest = {
  requestId: 'r1',
  agentRole: 'implementer',
  taskContract: { taskId: 'T', goalExcerpt: 'g', acceptanceCriteria: [], constraints: [] },
  contextBundle: { pieces: [], manifestRef: 'm' },
  outputSchema: { type: 'object' },
  budget: { costUnits: 10 },
};

describe('§7.6 codex adapter (UNVERIFIED skeleton)', () => {
  it('declares an honest capability manifest with codex lineage', () => {
    const m = new CodexAdapter().manifest();
    expect(m.structuredOutput).toBe(false); // leans on AAL bridge fallback (§7.2)
    expect(m.toolCalling).toBe(false); // proposals only (INV-9)
    expect(m.executionBackend).toBe(false);
    expect(m.lineage).toEqual({ family: 'codex' });
  });

  it('reads no credential value at construction — only the env var name', () => {
    const a = new CodexAdapter({ apiKeyEnv: 'CODEX_API_KEY' });
    expect(a.apiKeyEnv).toBe('CODEX_API_KEY');
  });

  it('throws a typed unverified error when invoked without configuration', async () => {
    await expect(new CodexAdapter().invoke(req)).rejects.toBeInstanceOf(UnverifiedAdapterError);
    await expect(new CodexAdapter().invoke(req)).rejects.toThrow('unverified: credentials required');
  });

  it('still throws unverified even when the base URL path is allowed (no creds present)', async () => {
    const a = new CodexAdapter({ baseUrl: 'https://codex.example.com/v1', model: 'codex' });
    await expect(a.invoke(req)).rejects.toBeInstanceOf(UnverifiedAdapterError);
  });

  it('refuses a configured base URL whose path is outside provider_data_policy', async () => {
    const a = new CodexAdapter({ baseUrl: 'https://aggregator.example.com/proxy/v9', model: 'codex' });
    await expect(a.invoke(req)).rejects.toBeInstanceOf(ProviderDataPolicyError);
  });

  it('declares a non-empty provider_data_policy allowlist', () => {
    expect(new CodexAdapter().providerDataPolicy.allowedPaths.length).toBeGreaterThan(0);
  });
});

describe('§7.6 provider_data_policy on openai-compatible', () => {
  it('defaults to the /v1/chat/completions allowlist', () => {
    const a = new OpenAICompatAdapter({ baseUrl: 'https://api.example.com/v1', apiKeyEnv: 'K', model: 'm' });
    expect(a.providerDataPolicy.allowedPaths).toContain('/v1/chat/completions');
  });

  it('refuses a base URL whose resolved path is not in the allowlist (before any egress)', async () => {
    const a = new OpenAICompatAdapter({ baseUrl: 'https://aggregator.example.com/proxy/v9', apiKeyEnv: 'K', model: 'm' });
    await expect(a.invoke(req)).rejects.toBeInstanceOf(ProviderDataPolicyError);
  });

  it('passes the policy check for an allowed path, then fails only on missing credentials', async () => {
    const a = new OpenAICompatAdapter({ baseUrl: 'https://api.example.com/v1', apiKeyEnv: 'DEFINITELY_UNSET_ENV_XYZ', model: 'm' });
    await expect(a.invoke(req)).rejects.not.toBeInstanceOf(ProviderDataPolicyError);
    await expect(a.invoke(req)).rejects.toThrow(/missing credentials/);
  });

  it('honors a custom allowlist', async () => {
    const a = new OpenAICompatAdapter({
      baseUrl: 'https://api.example.com/v2',
      apiKeyEnv: 'K',
      model: 'm',
      providerDataPolicy: { allowedPaths: ['/v2/chat/completions'] },
    });
    await expect(a.invoke(req)).rejects.toThrow(/missing credentials/); // allowed -> proceeds past policy
  });
});
