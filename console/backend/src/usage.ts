// F-Usage Phase 0 card (§5.3 / INV-13): estimate from local transcript metadata only.
// No hardcoded caps; always labeled estimate; official numbers live in /usage.
const WINDOW_MS = 5 * 3_600_000;
const WEEK_MS = 7 * 24 * 3_600_000;

export interface SessionStat {
  lastModified: number;
  fileSize?: number;
}

export interface UsageEstimate {
  label: string;
  officialSource: string;
  currentWindow: { sessions: number; bytes: number; windowStart: number | null };
  week: { sessions: number; bytes: number };
}

export interface UsageBreakdown {
  label: string;
  byDay: { day: string; sessions: number }[];
  byProject: { projectKey: string; sessions: number }[];
  byModel: { model: string; sessions: number }[];
}

export interface AggregateInput {
  projectKey: string;
  day: string;
  models: string[];
}

/** F-Usage Phase 2 (§8): day/project/model breakdown from indexed transcript metadata. */
export function usageBreakdown(aggregates: AggregateInput[]): UsageBreakdown {
  const count = <K extends string>(keys: K[]): Map<K, number> => {
    const m = new Map<K, number>();
    for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
    return m;
  };
  const top = <T>(m: Map<string, number>, mk: (k: string, n: number) => T, limit: number): T[] =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k, n]) => mk(k, n));
  return {
    label: 'estimate from local transcripts — not official numbers',
    byDay: [...count(aggregates.map((a) => a.day)).entries()].sort().map(([day, sessions]) => ({ day, sessions })),
    byProject: top(count(aggregates.map((a) => a.projectKey)), (projectKey, sessions) => ({ projectKey, sessions }), 10),
    byModel: top(count(aggregates.flatMap((a) => a.models)), (model, sessions) => ({ model, sessions }), 10),
  };
}

export interface UsageAlert {
  level: 'ok' | 'warn';
  message: string;
}

/** Alerts (§8): threshold on window utilization; label interactive vs non-interactive explicitly. */
export function evaluateAlerts(utilization: number, threshold: number): UsageAlert[] {
  const pct = Math.round(utilization * 100);
  if (utilization >= threshold) {
    return [
      { level: 'warn', message: `estimated window utilization ${pct}% >= threshold ${Math.round(threshold * 100)}% — non-interactive (scheduler/loop) work should yield` },
      { level: 'warn', message: 'interactive sessions keep priority; official numbers: /usage in the CLI' },
    ];
  }
  return [{ level: 'ok', message: `estimated window utilization ${pct}% < threshold ${Math.round(threshold * 100)}%` }];
}

/** Operator-supplied anchor for the estimate (§5.3): real % from `/usage` + weekly reset day/time. */
export interface QuotaCalibration {
  actualPct?: number; // 0..100, from the official /usage screen
  weeklyResetDay?: number; // 0 (Sun) .. 6 (Sat)
  weeklyResetHour?: number; // 0..23, local time
  updatedAt?: number;
}

export interface ResetEstimate {
  windowResetAt: number | null; // rolling 5h window end (windowStart + 5h)
  weeklyResetAt: number | null; // next weekly reset from calibration, if provided
}

/** Pure reset-time estimate (§5.3): 5h window end + next weekly reset from calibration. */
export function computeResets(windowStart: number | null, cal: QuotaCalibration, now: number): ResetEstimate {
  const windowResetAt = windowStart === null ? null : windowStart + WINDOW_MS;
  let weeklyResetAt: number | null = null;
  if (typeof cal.weeklyResetDay === 'number' && typeof cal.weeklyResetHour === 'number') {
    const d = new Date(now);
    d.setHours(cal.weeklyResetHour, 0, 0, 0);
    const dayDelta = (cal.weeklyResetDay - d.getDay() + 7) % 7;
    d.setDate(d.getDate() + dayDelta);
    if (d.getTime() <= now) d.setDate(d.getDate() + 7); // already passed today → next week
    weeklyResetAt = d.getTime();
  }
  return { windowResetAt, weeklyResetAt };
}

export function estimateUsage(sessions: SessionStat[], now: number): UsageEstimate {
  const week = sessions.filter((s) => now - s.lastModified <= WEEK_MS);
  // rolling 5h window anchored at the first activity inside it (§5.3)
  const recent = sessions.filter((s) => now - s.lastModified <= WINDOW_MS).sort((a, b) => a.lastModified - b.lastModified);
  const windowStart = recent[0]?.lastModified ?? null;
  const inWindow = windowStart === null ? [] : recent.filter((s) => s.lastModified - windowStart <= WINDOW_MS);
  const sum = (xs: SessionStat[]) => xs.reduce((n, s) => n + (s.fileSize ?? 0), 0);
  return {
    label: 'ค่าประมาณจาก transcript ในเครื่อง — ไม่ใช่ตัวเลขทางการ (estimate)',
    officialSource: 'official: /usage in the CLI or Settings > Usage',
    currentWindow: { sessions: inWindow.length, bytes: sum(inWindow), windowStart },
    week: { sessions: week.length, bytes: sum(week) },
  };
}
