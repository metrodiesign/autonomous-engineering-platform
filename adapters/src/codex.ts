// adapters/codex.ts (Ring 2, §7.6) — vendor adapter skeleton for the Codex CLI/API family.
// UNVERIFIED: no Codex credentials on this host — conformance P1-P8 MUST pass before this
// adapter is routed to (docs/DECISIONS.md D-007 pattern). Wire-format translation only (INV-8):
// proposal-only, sends NO tool definitions (INV-9), and its invoke() shells nothing.
// structuredOutput is false on purpose — the AAL bridge supplies the schema-in-prompt +
// validate + bounded-repair fallback (§7.2), so no JSON coercion lives here.
import type { Adapter, AgentRequest, AgentResponse, CapabilityManifest } from '@platform/aal';
import { UnverifiedAdapterError, enforceProviderDataPolicy } from './errors.js';

export interface CodexAdapterOptions {
  /** env var NAME holding the key — the value is never read or stored until the adapter is verified */
  apiKeyEnv?: string;
  /** base URL of a Codex-compatible endpoint; absent = unconfigured skeleton */
  baseUrl?: string;
  model?: string;
  /** provider_data_policy (§7.6): the only base URL paths this adapter may talk to */
  providerDataPolicy?: { allowedPaths: string[] };
}

export class CodexAdapter implements Adapter {
  readonly apiKeyEnv: string;
  readonly providerDataPolicy: { allowedPaths: string[] };
  private opts: CodexAdapterOptions;

  constructor(opts: CodexAdapterOptions = {}) {
    this.opts = opts;
    this.apiKeyEnv = opts.apiKeyEnv ?? 'CODEX_API_KEY';
    this.providerDataPolicy = opts.providerDataPolicy ?? { allowedPaths: ['/v1/responses'] };
  }

  manifest(): CapabilityManifest {
    return {
      adapterId: `codex:${this.opts.model ?? 'codex'}`,
      structuredOutput: false, // relies on AAL bridge fallback (§7.2)
      toolCalling: false, // proposals only (INV-9)
      contextWindowTokens: 128_000,
      executionBackend: false, // core executor is default; Codex sandbox is an optional backend (§7.6)
      seedDeterminism: false,
      lineage: { family: 'codex' },
    };
  }

  async invoke(_req: AgentRequest): Promise<AgentResponse> {
    // provider_data_policy guard (§7.6): refuse any configured endpoint outside the allowlist
    // (endpoint is version-less; the base URL carries the /v1 prefix, mirroring openai-compatible)
    if (this.opts.baseUrl) {
      enforceProviderDataPolicy(this.opts.baseUrl, '/responses', this.providerDataPolicy.allowedPaths);
    }
    // UNVERIFIED skeleton (D-007): no credentials, shells nothing, self-retries nothing (INV-5).
    throw new UnverifiedAdapterError('unverified: credentials required');
  }
}
