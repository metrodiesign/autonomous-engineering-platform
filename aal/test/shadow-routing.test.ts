// Shadow routing (§10.4): observe-only, never influences live choice, activation needs human + n>=50.
import { describe, it, expect } from 'vitest';
import { ShadowRouter } from '../src/shadow-routing.js';

describe('shadow routing', () => {
  it('records disagreement without changing the live choice', () => {
    const r = new ShadowRouter([
      { adapterId: 'a', attempts: 10, heldOutPasses: 9 },
      { adapterId: 'b', attempts: 10, heldOutPasses: 2 },
    ]);
    const d = r.observe('b');
    expect(d.liveChoice).toBe('b'); // untouched
    expect(d.shadowChoice).toBe('a');
    expect(d.agreed).toBe(false);
  });

  it('small samples never mark ready for activation', () => {
    const r = new ShadowRouter([{ adapterId: 'a', attempts: 1, heldOutPasses: 1 }]);
    for (let i = 0; i < 10; i++) r.observe('a');
    const rep = r.report();
    expect(rep.agreementRate).toBe(1);
    expect(rep.readyForActivationReview).toBe(false);
  });
});
