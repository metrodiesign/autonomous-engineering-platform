// G01 runtime injection tripwire (§10.1): the bridge must quarantine any adapter response whose
// text carries an injection canary — contaminated output never reaches the executor. No real model calls.
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog } from '@platform/core';
import type { Action, AgentRequest as CoreRequest } from '@platform/core';
import type { Adapter, AgentResponse, CapabilityManifest, ContextBundle } from '../src/protocol.js';
import {
  adapterAgentPort,
  isInjectionQuarantine,
  INJECTION_QUARANTINE_NOTE,
  type BridgeTask,
} from '../src/bridge.js';

function makeLog(): EventLog {
  return new EventLog(join(mkdtempSync(join(tmpdir(), 'trip-')), 'events.db'));
}

const manifest: CapabilityManifest = {
  adapterId: 'fake', structuredOutput: true, toolCalling: false,
  contextWindowTokens: 100_000, executionBackend: false, seedDeterminism: false,
};

function fakeAdapter(respond: () => AgentResponse): Adapter {
  return { manifest: () => manifest, invoke: async () => respond() };
}

const response = (structuredResult: Record<string, unknown>, actionRequests: Action[] = []): AgentResponse => ({
  requestId: 'r', structuredResult, actionRequests,
  usage: { costUnits: 1, interactionMode: 'non-interactive' },
  rawTranscriptRef: 'ref', adapterMeta: { adapterId: 'fake', modelVersion: 'v', observedTools: 0 },
});

const bundle: ContextBundle = { pieces: [], manifestRef: 'm' };
const task: BridgeTask = { taskId: 'T-canary', goalExcerpt: 'g', acceptanceCriteria: ['a'], constraints: [], contextBundle: bundle };
const req: CoreRequest = { taskId: 'T-canary', role: 'implementer', iteration: 0, feedback: [] };

describe('injection tripwire (§10.1 / G01)', () => {
  it('quarantines when the adapter echoes the canary marker in its structured result', async () => {
    const log = makeLog();
    let susceptible = false;
    const adapter = fakeAdapter(() => response({ echo: 'CANARY-9911-TRIPPED' }));
    const proposal = await adapterAgentPort(adapter, task, { log, onCanaryTrip: () => { susceptible = true; } }).propose(req);

    expect(isInjectionQuarantine(proposal)).toBe(true);
    expect(proposal.actions).toEqual([]);
    expect(proposal.claim).toBeUndefined();
    expect(proposal.note).toBe(INJECTION_QUARANTINE_NOTE);
    expect(susceptible).toBe(true); // registration/router side can now set injectionSusceptible (P7)
    expect(log.eventsFor('T-canary').some((e) => e.type === 'INJECTION_CANARY_TRIPPED')).toBe(true);
  });

  it('quarantines when the structured result sets canaryTripped:true (explicit flag)', async () => {
    const log = makeLog();
    const adapter = fakeAdapter(() => response({ claim: 'GREEN', canaryTripped: true }));
    expect(isInjectionQuarantine(await adapterAgentPort(adapter, task, { log }).propose(req))).toBe(true);
  });

  it('quarantines when the canary hides in a proposed action, not the structured result', async () => {
    const log = makeLog();
    const actions: Action[] = [{ type: 'WRITE_FILE', actionId: 'w1', path: 'src/x.txt', content: 'CANARY-4242-TRIPPED' }];
    const adapter = fakeAdapter(() => response({ claim: 'GREEN' }, actions));
    const proposal = await adapterAgentPort(adapter, task, { log }).propose(req);

    expect(isInjectionQuarantine(proposal)).toBe(true);
    expect(log.eventsFor('T-canary').some((e) => e.type === 'INJECTION_CANARY_TRIPPED')).toBe(true);
  });

  it('passes a clean response through unchanged and fires nothing', async () => {
    const log = makeLog();
    let susceptible = false;
    const adapter = fakeAdapter(() => response({ claim: 'GREEN', note: 'ok' }));
    const proposal = await adapterAgentPort(adapter, task, { log, onCanaryTrip: () => { susceptible = true; } }).propose(req);

    expect(isInjectionQuarantine(proposal)).toBe(false);
    expect(proposal.claim).toBe('GREEN');
    expect(susceptible).toBe(false);
    expect(log.eventsFor('T-canary').some((e) => e.type === 'INJECTION_CANARY_TRIPPED')).toBe(false);
  });

  it('quarantines via the marker fallback even when no log is armed', async () => {
    const adapter = fakeAdapter(() => response({ echo: 'CANARY-1-TRIPPED' }));
    expect(isInjectionQuarantine(await adapterAgentPort(adapter, task).propose(req))).toBe(true);
  });
});
