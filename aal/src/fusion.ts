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

/** Result of verifying one candidate — gate outcome plus a human-readable reason. */
export interface EvidenceResult {
  gatePassed: boolean;
  detail: string;
}

/**
 * EVIDENCE-stage verifier (§7.5). Injectable so fusion works for any artifact, not only code diffs:
 * a code-diff run applies actions + runs gates, a plan run checks the planning gate, a test run
 * RED-checks each test. Sync or async; the default resolve stays evidence-tournament regardless.
 */
export type Verifier = (candidate: Candidate) => EvidenceResult | Promise<EvidenceResult>;

export async function fusePanel(
  adapter: Adapter,
  baseRequest: AgentRequest,
  panelSize: number,
  runEvidence: Verifier,
): Promise<FusionOutcome> {
  // PANEL: independent runs (distinct requestIds — idempotency must not dedupe panelists)
  const candidates: Candidate[] = [];
  for (let i = 0; i < panelSize; i++) {
    const res = await adapter.invoke({ ...baseRequest, requestId: `${baseRequest.requestId}-p${i}` });
    candidates.push({ panelIndex: i, actions: res.actionRequests, structuredResult: res.structuredResult });
  }

  // EVIDENCE: core runs the injected verifier per candidate (isolated worktrees for code diffs)
  const evidence: FusionEvidence[] = [];
  for (const c of candidates) {
    const r = await runEvidence(c);
    evidence.push({ panelIndex: c.panelIndex, ...r });
  }

  // RESOLVE: evidence tournament — first gate-passing candidate wins; no synthesis of code (chimera risk)
  const winnerEv = evidence.find((e) => e.gatePassed) ?? null;
  const winner = winnerEv ? candidates[winnerEv.panelIndex]! : null;

  // CAPTURE: losing-but-passing candidates and failures become dissent notes (feed tests/tasks)
  const dissent = evidence
    .filter((e) => e.panelIndex !== winnerEv?.panelIndex)
    .map((e) => `panel#${e.panelIndex}: ${e.gatePassed ? 'also-passing alternative' : `failed — ${e.detail}`}`);

  return { winner, evidence, dissent, costMultiplier: panelSize };
}
