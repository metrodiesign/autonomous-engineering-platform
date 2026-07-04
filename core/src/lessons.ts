// Learning plane — lessons (§10.4, Phase 4): sourced ONLY from confirmed hypotheses +
// evidence; human approval required before a lesson becomes injectable; injected as marked data.
import type { EventLog } from './event-log.js';

export interface Lesson {
  id: string;
  text: string;
  sourceTaskId: string;
  sourceHypothesis: string;
  approved: boolean;
}

export class LessonStore {
  private lessons = new Map<string, Lesson>();

  constructor(private log: EventLog) {}

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
    this.log.append({ ts: Date.now(), taskId: l.sourceTaskId, type: 'LESSON_APPROVED', principal: 'human', payload: { id } });
    return true;
  }

  /** injectable lessons only after human approval; always wrapped as marked data */
  injectable(): { id: string; kind: 'guidance'; content: string }[] {
    return [...this.lessons.values()]
      .filter((l) => l.approved)
      .map((l) => ({ id: l.id, kind: 'guidance' as const, content: `LESSON (data, advisory, human-approved): ${l.text}` }));
  }
}
