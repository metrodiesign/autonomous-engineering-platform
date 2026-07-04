// AAL protocol (§7.1): the envelope between core and any model adapter.
// Vendor-neutral on this side; adapters (Ring 2) translate wire formats only (INV-8).
import type { Action } from '@platform/core';

export interface TaskContract {
  taskId: string;
  goalExcerpt: string;
  acceptanceCriteria: string[];
  constraints: string[];
}

export interface ContextBundle {
  /** ordered, marked-as-data context pieces (§9.4 MARK) */
  pieces: { id: string; kind: 'file' | 'diff' | 'doc' | 'guidance'; path?: string; content: string }[];
  manifestRef: string;
}

export interface AgentRequest {
  requestId: string;
  agentRole: 'planner' | 'test_designer' | 'implementer' | 'reviewer' | 'diagnostician';
  taskContract: TaskContract;
  contextBundle: ContextBundle;
  outputSchema: Record<string, unknown>;
  budget: { costUnits: number };
  determinismHint?: { seed?: number; temperature?: number };
}

export interface AgentUsage {
  costUnits: number;
  raw?: Record<string, unknown>;
  /** §5.3: every run is labeled from day one */
  interactionMode: 'interactive' | 'non-interactive';
}

export interface AgentResponse {
  requestId: string;
  structuredResult: Record<string, unknown>;
  actionRequests: Action[];
  usage: AgentUsage;
  rawTranscriptRef: string;
  adapterMeta: {
    adapterId: string;
    modelVersion: string;
    /** tool definitions observed on the wire at session init — deterministic P6 evidence */
    observedTools?: number;
  };
}

export interface CapabilityManifest {
  adapterId: string;
  structuredOutput: boolean;
  toolCalling: boolean;
  contextWindowTokens: number;
  executionBackend: boolean; // core executor is default regardless (§7.2)
  seedDeterminism: boolean;
}

/** Ring 2 adapter surface — wire-format translation only (INV-8). */
export interface Adapter {
  manifest(): CapabilityManifest;
  invoke(req: AgentRequest): Promise<AgentResponse>;
}
