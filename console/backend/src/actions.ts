// Background ops (§8): work >5s runs as an action; UI polls GET /api/actions/{id}/status.
import { randomUUID } from 'node:crypto';

export interface ActionRecord {
  id: string;
  kind: string;
  status: 'running' | 'done' | 'error';
  startedAt: number;
  finishedAt?: number;
  result?: unknown;
  error?: string;
}

export class ActionRegistry {
  private actions = new Map<string, ActionRecord>();

  start(kind: string, work: () => Promise<unknown>): ActionRecord {
    const rec: ActionRecord = { id: randomUUID(), kind, status: 'running', startedAt: Date.now() };
    this.actions.set(rec.id, rec);
    void work()
      .then((result) => { rec.status = 'done'; rec.result = result; rec.finishedAt = Date.now(); })
      .catch((e: Error) => { rec.status = 'error'; rec.error = e.message.slice(0, 500); rec.finishedAt = Date.now(); });
    // keep the registry bounded
    if (this.actions.size > 200) {
      const oldest = [...this.actions.values()].filter((a) => a.status !== 'running')
        .sort((a, b) => a.startedAt - b.startedAt)[0];
      if (oldest) this.actions.delete(oldest.id);
    }
    return rec;
  }

  get(id: string): ActionRecord | undefined {
    return this.actions.get(id);
  }
}
