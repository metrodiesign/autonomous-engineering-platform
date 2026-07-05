// F-Sess full-text search (§8, FTS5) + per-session aggregates reused by F-Usage breakdown.
// Index lives outside ~/.claude (INV-11: we never mutate CLI state) and rebuilds incrementally by mtime.
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MAX_TEXT_PER_SESSION = 512 * 1024; // cap so one huge transcript cannot bloat the index

export interface SearchHit {
  sessionId: string;
  projectKey: string;
  snippet: string;
  lastModified: number;
}

export interface SessionAggregate {
  sessionId: string;
  projectKey: string;
  day: string; // YYYY-MM-DD of last modification
  models: string[];
  lastModified: number;
}

export class SessionSearch {
  private db: Database.Database;

  constructor(dbPath: string, private projectsDir: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('busy_timeout = 3000'); // parallel opens (tests, second console) wait instead of throwing
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY, mtime INTEGER NOT NULL, session_id TEXT NOT NULL,
        project_key TEXT NOT NULL, models TEXT NOT NULL DEFAULT '[]', last_modified INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS transcripts USING fts5(session_id, project_key, body);
    `);
  }

  /** Incremental index pass: only files whose mtime changed are re-read. */
  index(): { indexed: number; skipped: number; total: number } {
    if (!existsSync(this.projectsDir)) return { indexed: 0, skipped: 0, total: 0 };
    const known = new Map<string, number>(
      (this.db.prepare('SELECT path, mtime FROM files').all() as { path: string; mtime: number }[])
        .map((r) => [r.path, r.mtime]),
    );
    const upFile = this.db.prepare(
      'INSERT OR REPLACE INTO files (path, mtime, session_id, project_key, models, last_modified) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const delFts = this.db.prepare('DELETE FROM transcripts WHERE session_id = ?');
    const insFts = this.db.prepare('INSERT INTO transcripts (session_id, project_key, body) VALUES (?, ?, ?)');
    let indexed = 0, skipped = 0, total = 0;
    for (const proj of readdirSync(this.projectsDir, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue;
      const pdir = join(this.projectsDir, proj.name);
      for (const f of readdirSync(pdir)) {
        if (!f.endsWith('.jsonl')) continue;
        total++;
        const path = join(pdir, f);
        const mtime = statSync(path).mtimeMs;
        if (known.get(path) === mtime) { skipped++; continue; }
        const sessionId = f.replace(/\.jsonl$/, '');
        const { body, models } = extractText(path);
        const tx = this.db.transaction(() => {
          delFts.run(sessionId);
          insFts.run(sessionId, proj.name, body);
          upFile.run(path, mtime, sessionId, proj.name, JSON.stringify(models), mtime);
        });
        tx();
        indexed++;
      }
    }
    return { indexed, skipped, total };
  }

  query(q: string, limit = 20): SearchHit[] {
    if (!q.trim()) return [];
    // quote each term: user input is a literal phrase set, not FTS5 syntax
    const safe = q.trim().split(/\s+/).map((t) => `"${t.replaceAll('"', '""')}"`).join(' ');
    const rows = this.db.prepare(`
      SELECT t.session_id AS sessionId, t.project_key AS projectKey,
             snippet(transcripts, 2, '[', ']', ' … ', 12) AS snippet, f.last_modified AS lastModified
      FROM transcripts t JOIN files f ON f.session_id = t.session_id
      WHERE transcripts MATCH ? ORDER BY f.last_modified DESC LIMIT ?
    `).all(safe, limit) as SearchHit[];
    return rows;
  }

  aggregates(sinceMs: number): SessionAggregate[] {
    const rows = this.db.prepare(
      'SELECT session_id AS sessionId, project_key AS projectKey, models, last_modified AS lastModified FROM files WHERE last_modified >= ?',
    ).all(sinceMs) as { sessionId: string; projectKey: string; models: string; lastModified: number }[];
    return rows.map((r) => ({
      sessionId: r.sessionId,
      projectKey: r.projectKey,
      day: new Date(r.lastModified).toISOString().slice(0, 10),
      models: JSON.parse(r.models) as string[],
      lastModified: r.lastModified,
    }));
  }

  close(): void {
    this.db.close();
  }
}

function extractText(path: string): { body: string; models: string[] } {
  const models = new Set<string>();
  const parts: string[] = [];
  let size = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line || size > MAX_TEXT_PER_SESSION) continue;
    try {
      const e = JSON.parse(line) as { message?: { model?: string; content?: unknown }; summary?: string };
      if (e.message?.model) models.add(e.message.model);
      if (typeof e.summary === 'string') { parts.push(e.summary); size += e.summary.length; }
      const c = e.message?.content;
      if (typeof c === 'string') { parts.push(c); size += c.length; }
      else if (Array.isArray(c)) {
        for (const b of c as { type?: string; text?: string }[]) {
          if (b?.type === 'text' && typeof b.text === 'string') { parts.push(b.text); size += b.text.length; }
        }
      }
    } catch { /* non-JSON line — skip */ }
  }
  return { body: parts.join('\n').slice(0, MAX_TEXT_PER_SESSION), models: [...models] };
}
