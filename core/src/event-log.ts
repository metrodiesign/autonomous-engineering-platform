// Append-only event log + lease (INV-10). SQLite WAL for atomic compare-and-set.
import type { PlatformEvent } from './types.js';

export interface Lease {
  taskId: string;
  ownerId: string;
  leaseUntil: number;
}

export class EventLog {
  constructor(_dbPath: string) {
    throw new Error('NOT_IMPLEMENTED');
  }
  append(_e: PlatformEvent): number { throw new Error('NOT_IMPLEMENTED'); }
  eventsFor(_taskId: string): PlatformEvent[] { throw new Error('NOT_IMPLEMENTED'); }
  all(): PlatformEvent[] { throw new Error('NOT_IMPLEMENTED'); }
  /** atomic CAS claim — single writer per task (§6.2) */
  claimLease(_taskId: string, _ownerId: string, _ttlMs: number): boolean { throw new Error('NOT_IMPLEMENTED'); }
  releaseLease(_taskId: string, _ownerId: string): void { throw new Error('NOT_IMPLEMENTED'); }
  close(): void { throw new Error('NOT_IMPLEMENTED'); }
}
