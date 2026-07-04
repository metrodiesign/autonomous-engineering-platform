// Steering (§10.3 Phase 2): PAUSE_REQUESTED -> GUIDANCE_INJECTED (marked data) -> RESUMED.
// Guidance that touches AC/scope must be a contract amendment, not advisory.
import type { EventLog } from './event-log.js';

export interface GuidanceInput {
  text: string;
  /** caller must declare whether this changes AC/scope; core enforces the governance path */
  touchesAcOrScope: boolean;
}

export class Steering {
  private paused = new Set<string>();
  constructor(private log: EventLog) {}

  requestPause(taskId: string): void {
    this.paused.add(taskId);
    this.log.append({ ts: Date.now(), taskId, type: 'PAUSE_REQUESTED', principal: 'human', payload: {} });
  }

  isPaused(taskId: string): boolean {
    return this.paused.has(taskId);
  }

  inject(taskId: string, g: GuidanceInput): { accepted: boolean; asDataPiece?: { id: string; kind: 'guidance'; content: string }; reason?: string } {
    if (!this.paused.has(taskId)) return { accepted: false, reason: 'guidance requires PAUSE first' };
    if (g.touchesAcOrScope) {
      this.log.append({
        ts: Date.now(), taskId, type: 'GUIDANCE_REFUSED_NEEDS_AMENDMENT', principal: 'core',
        payload: { reason: 'AC/scope change must go through versioned contract amendment (§10.3)' },
      });
      return { accepted: false, reason: 'AC/scope guidance must be a contract amendment via governance' };
    }
    this.log.append({ ts: Date.now(), taskId, type: 'GUIDANCE_INJECTED', principal: 'human', payload: { bytes: g.text.length } });
    return {
      accepted: true,
      asDataPiece: { id: `guidance-${Date.now()}`, kind: 'guidance', content: `OPERATOR GUIDANCE (data, advisory): ${g.text}` },
    };
  }

  resume(taskId: string): void {
    this.paused.delete(taskId);
    this.log.append({ ts: Date.now(), taskId, type: 'RESUMED', principal: 'human', payload: {} });
  }
}
