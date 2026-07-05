// Learning plane — lessons (§10.4, Phase 4): sourced ONLY from confirmed hypotheses +
// evidence; human approval required before a lesson becomes injectable; injected as marked data.
// Optional persistence: approved lessons survive restart as .ai/lessons/<id>.json (§14 "lessons/ (P4)").
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventLog } from './event-log.js';

export interface Lesson {
  id: string;
  text: string;
  sourceTaskId: string;
  sourceHypothesis: string;
  approved: boolean;
}

/** Wrap a lesson as marked, advisory, human-approved data (never trusted as instruction). */
function asMarkedData(l: Lesson): { id: string; kind: 'guidance'; content: string } {
  return { id: l.id, kind: 'guidance' as const, content: `LESSON (data, advisory, human-approved): ${l.text}` };
}

/** Read approved lessons persisted under `dir`, returned as marked data (survives process restart). */
export function loadLessons(dir: string): { id: string; kind: 'guidance'; content: string }[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: { id: string; kind: 'guidance'; content: string }[] = [];
  for (const name of names) {
    const l = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Lesson;
    if (l.approved) out.push(asMarkedData(l));
  }
  return out;
}

export class LessonStore {
  private lessons = new Map<string, Lesson>();

  constructor(private log: EventLog, private dir?: string) {
    if (dir) {
      mkdirSync(dir, { recursive: true });
      for (const name of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
        const l = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Lesson;
        this.lessons.set(l.id, l); // rehydrate silently — no re-appended approval events
      }
    }
  }

  private persist(l: Lesson): void {
    if (!this.dir) return;
    const dest = join(this.dir, `${l.id}.json`);
    const tmp = `${dest}.tmp`;
    writeFileSync(tmp, JSON.stringify(l, null, 2), { mode: 0o600 });
    renameSync(tmp, dest); // atomic
  }

  /** propose from a CONFIRMED hypothesis only — anything else is refused */
  proposeFromHypothesis(taskId: string, hypothesisStatement: string, text: string): { ok: boolean; id?: string; reason?: string } {
    const confirmed = this.log
      .eventsFor(taskId)
      .some((e) => e.type === 'HYPOTHESIS_CONFIRMED' && e.payload.statement === hypothesisStatement);
    if (!confirmed) {
      return { ok: false, reason: 'lessons come only from confirmed hypotheses + evidence (§10.4)' };
    }
    const id = `lesson-${this.lessons.size + 1}`;
    this.lessons.set(id, { id, text, sourceTaskId: taskId, sourceHypothesis: hypothesisStatement, approved: false });
    this.log.append({ ts: Date.now(), taskId, type: 'LESSON_PROPOSED', principal: 'core', payload: { id } });
    return { ok: true, id };
  }

  approve(id: string): boolean {
    const l = this.lessons.get(id);
    if (!l) return false;
    l.approved = true;
    this.persist(l); // approved lessons are the only ones written to disk
    this.log.append({ ts: Date.now(), taskId: l.sourceTaskId, type: 'LESSON_APPROVED', principal: 'human', payload: { id } });
    return true;
  }

  /** injectable lessons only after human approval; always wrapped as marked data */
  injectable(): { id: string; kind: 'guidance'; content: string }[] {
    return [...this.lessons.values()].filter((l) => l.approved).map(asMarkedData);
  }
}
