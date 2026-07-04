// Fusion plane slice (§7.5, Phase 3): PANEL -> EVIDENCE -> RESOLVE for code diffs.
// Code resolution is EVIDENCE-TOURNAMENT only: gates decide, judges never overrule (rule: judge overrule = 0).
// Cheap diversity first: self-panel = N independent runs of one adapter (§7.5 guidance).
import type { Action } from '@platform/core';
import type { Adapter, AgentRequest } from './protocol.js';

export interface Candidate {
  panelIndex: number;
  actions: Action[];
  structuredResult: Record<string, unknown>;
}

export interface FusionEvidence {
  panelIndex: number;
  gatePassed: boolean;
  detail: string;
}

export interface FusionOutcome {
  winner: Candidate | null;
  evidence: FusionEvidence[];
  dissent: string[];
  costMultiplier: number;
}

export async function fusePanel(
  adapter: Adapter,
  baseRequest: AgentRequest,
  panelSize: number,
  runEvidence: (candidate: Candidate) => { gatePassed: boolean; detail: string },
): Promise<FusionOutcome> {
  // PANEL: independent runs (distinct requestIds — idempotency must not dedupe panelists)
  const candidates: Candidate[] = [];
  for (let i = 0; i < panelSize; i++) {
    const res = await adapter.invoke({ ...baseRequest, requestId: `${baseRequest.requestId}-p${i}` });
    candidates.push({ panelIndex: i, actions: res.actionRequests, structuredResult: res.structuredResult });
  }

  // EVIDENCE: core runs gates per candidate in isolated worktrees (caller supplies the runner)
  const evidence: FusionEvidence[] = candidates.map((c) => ({ panelIndex: c.panelIndex, ...runEvidence(c) }));

  // RESOLVE: evidence tournament — first gate-passing candidate wins; no synthesis of code (chimera risk)
  const winnerEv = evidence.find((e) => e.gatePassed) ?? null;
  const winner = winnerEv ? candidates[winnerEv.panelIndex]! : null;

  // CAPTURE: losing-but-passing candidates and failures become dissent notes (feed tests/tasks)
  const dissent = evidence
    .filter((e) => e.panelIndex !== winnerEv?.panelIndex)
    .map((e) => `panel#${e.panelIndex}: ${e.gatePassed ? 'also-passing alternative' : `failed — ${e.detail}`}`);

  return { winner, evidence, dissent, costMultiplier: panelSize };
}
