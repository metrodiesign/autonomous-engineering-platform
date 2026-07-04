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
