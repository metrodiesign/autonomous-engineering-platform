// Bridge (Ring 1): adapts a Ring-2 Adapter to core's AgentPort for the propose/dispose loop.
// Core never sees which vendor answered (INV-7); this file is the seam.
import type { AgentPort, AgentRequest as CoreRequest, Proposal } from '@platform/core';
import type { Adapter, ContextBundle } from './protocol.js';

export interface BridgeTask {
  taskId: string;
  goalExcerpt: string;
  acceptanceCriteria: string[];
  constraints: string[];
  contextBundle: ContextBundle;
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    claim: { type: 'string', enum: ['GREEN', 'WORKING', 'BLOCKED'] },
    note: { type: 'string' },
  },
  required: ['claim'],
};

export function adapterAgentPort(adapter: Adapter, task: BridgeTask): AgentPort {
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
      const res = await adapter.invoke({
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
        budget: { costUnits: 200 },
      });
      const claim = res.structuredResult.claim === 'GREEN' ? 'GREEN' : undefined;
      const proposal: Proposal = { actions: res.actionRequests };
      if (claim) proposal.claim = claim;
      if (typeof res.structuredResult.note === 'string') proposal.note = res.structuredResult.note;
      return proposal;
    },
  };
}
