// Bridge (Ring 1): adapts a Ring-2 Adapter to core's AgentPort for the propose/dispose loop.
// Core never sees which vendor answered (INV-7); this file is the seam.
// The §7.2 structured-output fallback (schema-in-prompt + validate + one bounded repair round)
// lives HERE, so it protects every adapter uniformly — not inside any single vendor adapter.
import type { AgentPort, AgentRequest as CoreRequest, Proposal, EventLog } from '@platform/core';
import { checkInjectionCanary } from '@platform/core';
import type { Adapter, AgentRequest as AalRequest, AgentResponse, ContextBundle, ToolDef } from './protocol.js';

export interface BridgeTask {
  taskId: string;
  goalExcerpt: string;
  acceptanceCriteria: string[];
  constraints: string[];
  contextBundle: ContextBundle;
  /** tools the agent may request (§7.1); threaded onto every request, adapters may ignore */
  toolDefs?: ToolDef[];
}

/** typed failure surfaced when structured output cannot be coerced to the schema (§7.2). */
export class SchemaValidationError extends Error {
  constructor(readonly requestId: string, readonly errors: string) {
    super(`structured output for ${requestId} failed schema validation: ${errors}`);
    this.name = 'SchemaValidationError';
  }
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    claim: { type: 'string', enum: ['GREEN', 'WORKING', 'BLOCKED'] },
    note: { type: 'string' },
  },
  required: ['claim'],
};

function matchesType(v: unknown, t: string): boolean {
  switch (t) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number';
    case 'boolean': return typeof v === 'boolean';
    case 'object': return typeof v === 'object' && v !== null && !Array.isArray(v);
    case 'array': return Array.isArray(v);
    default: return true;
  }
}

/** structural JSON-schema check (required keys + property type/enum) — no runtime dependency. */
export function validateStructured(
  value: unknown,
  schema: Record<string, unknown>,
): { ok: boolean; errors: string } {
  const errs: string[] = [];
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { ok: false, errors: 'expected a JSON object' };
    }
    const obj = value as Record<string, unknown>;
    for (const key of Array.isArray(schema.required) ? (schema.required as string[]) : []) {
      if (!(key in obj)) errs.push(`missing required "${key}"`);
    }
    const props = (schema.properties ?? {}) as Record<string, { type?: string; enum?: unknown[] }>;
    for (const [key, spec] of Object.entries(props)) {
      if (!(key in obj)) continue;
      const v = obj[key];
      if (spec.type && !matchesType(v, spec.type)) errs.push(`"${key}" must be ${spec.type}`);
      if (spec.enum && !spec.enum.includes(v)) errs.push(`"${key}" not in enum`);
    }
  }
  return { ok: errs.length === 0, errors: errs.join('; ') };
}

/** Options for the runtime injection tripwire (§10.1) wired into the propose path. */
export interface InjectionTripwireOptions {
  /**
   * When present, the bridge runs checkInjectionCanary on every adapter response and appends
   * INJECTION_CANARY_TRIPPED on a trip. Threaded from the run's EventLog by the caller (loop/orchestrator).
   */
  log?: EventLog;
  /** Fired on a trip so the registration/router side can mark the adapter injectionSusceptible (§7.4 P7). */
  onCanaryTrip?: () => void;
}

/** Note carried by a quarantine proposal — empty actions + no claim keep contaminated output out of the executor. */
export const INJECTION_QUARANTINE_NOTE =
  'INJECTION_CANARY_TRIPPED: contaminated response quarantined — withheld from executor (§10.1)';

/** True when a proposal is the injection-canary quarantine (no actions, no claim, marked note). */
export function isInjectionQuarantine(p: Proposal): boolean {
  return p.actions.length === 0 && p.claim === undefined && p.note === INJECTION_QUARANTINE_NOTE;
}

// Mirror of the canary marker in core/src/security-plane.ts — used only as the no-log fallback detector.
const CANARY_MARKER = /CANARY-\d+-TRIPPED/;

export function adapterAgentPort(
  adapter: Adapter,
  task: BridgeTask,
  tripwire: InjectionTripwireOptions = {},
): AgentPort {
  // Scan the WHOLE response — structured result AND proposed actions — for canary contamination (§10.1).
  const scan = (res: AgentResponse): Record<string, unknown> => ({
    ...res.structuredResult,
    actionRequests: res.actionRequests,
  });
  const tripped = (res: AgentResponse): boolean => {
    const target = scan(res);
    // Wire checkInjectionCanary when a log is armed (it also appends INJECTION_CANARY_TRIPPED);
    // fall back to the marker check when the caller passed no log.
    return tripwire.log
      ? checkInjectionCanary(tripwire.log, task.taskId, target).tripped
      : target.canaryTripped === true || CANARY_MARKER.test(JSON.stringify(target));
  };
  const quarantine = (): Proposal => {
    tripwire.onCanaryTrip?.();
    return { actions: [], note: INJECTION_QUARANTINE_NOTE };
  };

  return {
    async propose(req: CoreRequest): Promise<Proposal> {
      const feedbackDoc = req.feedback.length
        ? [{
            id: `feedback-i${req.iteration}`,
            kind: 'doc' as const,
            content:
              'EXECUTOR FEEDBACK for your previous proposals (fix rejections; when your changes should pass the tests, set claim GREEN):\n' +
              JSON.stringify(req.feedback, null, 1),
          }]
        : [];
      const baseReq: AalRequest = {
        requestId: `${task.taskId}-i${req.iteration}`,
        agentRole: 'implementer',
        taskContract: {
          taskId: task.taskId,
          goalExcerpt: task.goalExcerpt,
          acceptanceCriteria: task.acceptanceCriteria,
          constraints: task.constraints,
        },
        contextBundle: {
          pieces: [...task.contextBundle.pieces, ...feedbackDoc],
          manifestRef: task.contextBundle.manifestRef,
        },
        outputSchema: OUTPUT_SCHEMA,
        toolDefs: task.toolDefs ?? [],
        budget: { costUnits: 200 },
      };

      let res = await adapter.invoke(baseReq);
      // Tripwire BEFORE schema handling: contaminated output never reaches the executor and never
      // gets a repair round that could launder the canary out of the response.
      if (tripped(res)) return quarantine();

      let check = validateStructured(res.structuredResult, OUTPUT_SCHEMA);
      if (!check.ok) {
        // bounded repair: exactly one re-prompt with a fresh requestId (idempotency must not return the bad cache)
        const repairReq: AalRequest = {
          ...baseReq,
          requestId: `${baseReq.requestId}-repair`,
          contextBundle: {
            pieces: [...baseReq.contextBundle.pieces, {
              id: 'schema-repair',
              kind: 'guidance' as const,
              content:
                `Your previous structured result did not conform to the required output schema (${check.errors}). ` +
                'Return ONLY a JSON object that conforms to the schema.',
            }],
            manifestRef: baseReq.contextBundle.manifestRef,
          },
        };
        res = await adapter.invoke(repairReq);
        if (tripped(res)) return quarantine();
        check = validateStructured(res.structuredResult, OUTPUT_SCHEMA);
        if (!check.ok) throw new SchemaValidationError(baseReq.requestId, check.errors);
      }

      const claim = res.structuredResult.claim === 'GREEN' ? 'GREEN' : undefined;
      const proposal: Proposal = { actions: res.actionRequests };
      if (claim) proposal.claim = claim;
      if (typeof res.structuredResult.note === 'string') proposal.note = res.structuredResult.note;
      return proposal;
    },
  };
}

/**
 * Build a reviewer request carrying ONLY goal, acceptance criteria, diff and evidence (§9.2 rule 4).
 * There is deliberately no parameter for implementer notes/claims, so persuasion cannot leak in.
 */
export function buildReviewRequest(
  requestId: string,
  goalExcerpt: string,
  acceptanceCriteria: string[],
  diff: string,
  evidence: string[],
): AalRequest {
  return {
    requestId,
    agentRole: 'reviewer',
    taskContract: { taskId: requestId, goalExcerpt, acceptanceCriteria, constraints: [] },
    contextBundle: {
      pieces: [
        { id: 'diff', kind: 'diff', content: diff },
        ...evidence.map((e, i) => ({ id: `evidence-${i}`, kind: 'doc' as const, content: e })),
      ],
      manifestRef: `review-${requestId}`,
    },
    outputSchema: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['APPROVE', 'CHANGES_REQUESTED'] },
        findings: { type: 'array' },
      },
      required: ['verdict'],
    },
    budget: { costUnits: 200 },
  };
}
