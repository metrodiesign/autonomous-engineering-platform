// Outcome routing — shadow mode (§10.4, Phase 4): log what outcome-weighted routing WOULD pick,
// never influence live decisions until shadow proves itself. off -> shadow -> active is a human step.
export interface OutcomeStats {
  adapterId: string;
  attempts: number;
  heldOutPasses: number;
}

export interface ShadowDecision {
  liveChoice: string;
  shadowChoice: string;
  agreed: boolean;
}

export class ShadowRouter {
  private decisions: ShadowDecision[] = [];

  constructor(private stats: OutcomeStats[]) {}

  /** record-only comparison; returns the LIVE choice untouched */
  observe(liveChoice: string): ShadowDecision {
    const ranked = [...this.stats]
      .filter((s) => s.attempts > 0)
      .sort((a, b) => b.heldOutPasses / b.attempts - a.heldOutPasses / a.attempts);
    const shadowChoice = ranked[0]?.adapterId ?? liveChoice;
    const d = { liveChoice, shadowChoice, agreed: liveChoice === shadowChoice };
    this.decisions.push(d);
    return d;
  }

  /** evidence for the human decision to activate: agreement rate + sample size */
  report(): { samples: number; agreementRate: number; readyForActivationReview: boolean } {
    const samples = this.decisions.length;
    const agreed = this.decisions.filter((d) => d.agreed).length;
    return {
      samples,
      agreementRate: samples ? agreed / samples : 0,
      readyForActivationReview: samples >= 50, // small-n never auto-activates
    };
  }
}
