// F-Usage Phase 0 card (§5.3 / INV-13): estimate from local transcripts,
// 5h rolling windows from first activity, always labeled as estimate.
import { describe, it, expect } from 'vitest';
import { estimateUsage } from '../src/usage.js';

const H = 3_600_000;

describe('usage estimator (§5.3 / INV-13)', () => {
  const now = 100 * H;

  it('groups activity into 5h windows anchored at first event in window', () => {
    const est = estimateUsage(
      [
        { lastModified: now - 1 * H, fileSize: 1000 },
        { lastModified: now - 2 * H, fileSize: 2000 },
        { lastModified: now - 30 * H, fileSize: 500 }, // separate window, outside current
      ],
      now,
    );
    expect(est.currentWindow.sessions).toBe(2);
    expect(est.currentWindow.bytes).toBe(3000);
  });

  it('is always labeled an estimate with official source pointer (INV-13)', () => {
    const est = estimateUsage([], now);
    expect(est.label).toMatch(/ประมาณ|estimate/i);
    expect(est.officialSource).toMatch(/\/usage/);
  });

  it('weekly totals accumulate across windows', () => {
    const est = estimateUsage(
      [
        { lastModified: now - 1 * H, fileSize: 100 },
        { lastModified: now - 50 * H, fileSize: 100 },
        { lastModified: now - 200 * H, fileSize: 100 }, // > 7 days ago, excluded
      ],
      now,
    );
    expect(est.week.sessions).toBe(2);
  });
});
