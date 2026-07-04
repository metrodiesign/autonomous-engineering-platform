// Append-only event log + lease (INV-10). SQLite WAL for atomic compare-and-set.
import Database from 'better-sqlite3';
import type { PlatformEvent } from './types.js';

export interface Lease {
  taskId: string;
  ownerId: string;
  leaseUntil: number;
}

export class EventLog {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        task_id TEXT NOT NULL,
        type TEXT NOT NULL,
        principal TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, seq);
      CREATE TABLE IF NOT EXISTS leases (
        task_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        lease_until INTEGER NOT NULL
      );
    `);
    // append-only enforcement at the storage layer
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS no_update BEFORE UPDATE ON events
        BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS no_delete BEFORE DELETE ON events
        BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
    `);
  }

  append(e: PlatformEvent): number {
    const r = this.db
      .prepare('INSERT INTO events (ts, task_id, type, principal, payload) VALUES (?, ?, ?, ?, ?)')
      .run(e.ts, e.taskId, e.type, e.principal, JSON.stringify(e.payload));
    return Number(r.lastInsertRowid);
  }

  private rowToEvent = (r: Record<string, unknown>): PlatformEvent => ({
    seq: r.seq as number,
    ts: r.ts as number,
    taskId: r.task_id as string,
    type: r.type as string,
    principal: r.principal as PlatformEvent['principal'],
    payload: JSON.parse(r.payload as string) as Record<string, unknown>,
  });

  eventsFor(taskId: string): PlatformEvent[] {
    return this.db
      .prepare('SELECT * FROM events WHERE task_id = ? ORDER BY seq')
      .all(taskId)
      .map((r) => this.rowToEvent(r as Record<string, unknown>));
  }

  all(): PlatformEvent[] {
    return this.db
      .prepare('SELECT * FROM events ORDER BY seq')
      .all()
      .map((r) => this.rowToEvent(r as Record<string, unknown>));
  }

  /** atomic CAS claim — single writer per task (§6.2) */
  claimLease(taskId: string, ownerId: string, ttlMs: number): boolean {
    const now = Date.now();
    const until = now + ttlMs;
    const claim = this.db.transaction(() => {
      const cur = this.db.prepare('SELECT owner_id, lease_until FROM leases WHERE task_id = ?').get(taskId) as
        | { owner_id: string; lease_until: number }
        | undefined;
      if (cur && cur.owner_id !== ownerId && cur.lease_until > now) return false;
      this.db
        .prepare(
          `INSERT INTO leases (task_id, owner_id, lease_until) VALUES (?, ?, ?)
           ON CONFLICT(task_id) DO UPDATE SET owner_id = excluded.owner_id, lease_until = excluded.lease_until`,
        )
        .run(taskId, ownerId, until);
      this.append({ ts: now, taskId, type: 'LEASE_CLAIMED', principal: 'core', payload: { ownerId, leaseUntil: until } });
      return true;
    });
    return claim();
  }

  releaseLease(taskId: string, ownerId: string): void {
    const r = this.db.prepare('DELETE FROM leases WHERE task_id = ? AND owner_id = ?').run(taskId, ownerId);
    if (r.changes > 0) {
      this.append({ ts: Date.now(), taskId, type: 'LEASE_RELEASED', principal: 'core', payload: { ownerId } });
    }
  }

  close(): void {
    this.db.close();
  }
}
