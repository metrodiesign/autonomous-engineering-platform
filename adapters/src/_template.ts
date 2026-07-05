// adapters/_template.ts — copy me to add a model (INV-8: wire translation ONLY).
// Checklist: 1) implement manifest() honestly 2) never send tool definitions (INV-9)
// 3) idempotency cache on requestId (P8) 4) 429 -> throw name QuotaLimitError, never self-retry
// 5) label usage.interactionMode 6) run conformance P1-P8 before registering (§7.3).
import type { Adapter, AgentRequest, AgentResponse, CapabilityManifest } from '@platform/aal';

export class TemplateAdapter implements Adapter {
  manifest(): CapabilityManifest {
    return {
      adapterId: 'template',
      structuredOutput: false,
      toolCalling: false,
      contextWindowTokens: 0,
      executionBackend: false,
      seedDeterminism: false,
    };
  }

  async invoke(_req: AgentRequest): Promise<AgentResponse> {
    throw new Error('template adapter — implement invoke() and pass conformance P1-P8 first');
  }
}
