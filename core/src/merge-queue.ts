// Merge queue (§6.5, Phase 3): serialize integration so attribution is unambiguous.
// One lane; each item re-verified against the integrated state before landing.
import type { EventLog } from './event-log.js';

export interface QueueItem {
  taskId: string;
  verify: () => boolean; // full regression against integrated state (core-run)
  land: () => void;
}

export interface QueueResult {
  taskId: string;
  landed: boolean;
  attribution?: string;
}

export class MergeQueue {
  private queue: QueueItem[] = [];

  constructor(private log: EventLog) {}

  enqueue(item: QueueItem): void {
    this.queue.push(item);
    this.log.append({ ts: Date.now(), taskId: item.taskId, type: 'MERGE_ENQUEUED', principal: 'core', payload: { position: this.queue.length } });
  }

  /** drain serially — a failure attributes to exactly the item under test (no batching) */
  drain(): QueueResult[] {
    const results: QueueResult[] = [];
    while (this.queue.length) {
      const item = this.queue.shift()!;
      const ok = item.verify();
      if (ok) {
        item.land();
        this.log.append({ ts: Date.now(), taskId: item.taskId, type: 'MERGE_LANDED', principal: 'core', payload: {} });
        results.push({ taskId: item.taskId, landed: true });
      } else {
        this.log.append({
          ts: Date.now(), taskId: item.taskId, type: 'MERGE_REJECTED', principal: 'core',
          payload: { attribution: 'serialized lane — failure belongs to this item alone' },
        });
        results.push({ taskId: item.taskId, landed: false, attribution: item.taskId });
      }
    }
    return results;
  }
}
