// AAL gap-fix coverage (C4): §7.1 toolDefs, §7.2 core-owned fallback + lineage,
// §7.3 drift canary, §7.4 scoring router (susceptibility + lineage), §10.2 token bucket,
// §9.2 rule-4 reviewer isolation, §7.5 injectable fusion verifier.
// No real model calls — every adapter here is a deterministic fake.
import { describe, it, expect } from 'vitest';
import type {
  Adapter,
  AgentRequest,
  AgentResponse,
  CapabilityManifest,
  ToolDef,
} from '../src/protocol.js';
import {
  adapterAgentPort,
  buildReviewRequest,
  SchemaValidationError,
  type BridgeTask,
} from '../src/bridge.js';
import { route, type RouteEntry } from '../src/router.js';
import { CircuitBreaker } from '../src/breaker.js';
import { TokenBucket } from '../src/rate-limit.js';
import { driftCheck } from '../src/conformance.js';
import { fusePanel, type Candidate } from '../src/fusion.js';

// ---- fakes -----------------------------------------------------------------

const baseManifest = (over: Partial<CapabilityManifest> = {}): CapabilityManifest => ({
  adapterId: 'fake',
  structuredOutput: true,
  toolCalling: false,
  contextWindowTokens: 100_000,
  executionBackend: false,
  seedDeterminism: false,
  ...over,
});

/** invoke-only fake: returns a scripted response, records the request it saw. */
function scriptedAdapter(
  respond: (req: AgentRequest) => AgentResponse,
  manifest: Partial<CapabilityManifest> = {},
): Adapter & { calls: AgentRequest[] } {
  const calls: AgentRequest[] = [];
  return {
    calls,
    manifest: () => baseManifest(manifest),
    invoke: async (req) => {
      calls.push(req);
      return respond(req);
    },
  };
}

/** manifest-only fake for routing tests (invoke must never fire). */
function routeAdapter(id: string, manifest: Partial<CapabilityManifest> = {}): Adapter {
  return {
    manifest: () => baseManifest({ adapterId: id, ...manifest }),
    invoke: async () => {
      throw new Error('invoke must not run during routing');
    },
  };
}

const mkResponse = (structuredResult: Record<string, unknown>, observedTools = 0): AgentResponse => ({
  requestId: 'r',
  structuredResult,
  actionRequests: [],
  usage: { costUnits: 1, interactionMode: 'non-interactive' },
  rawTranscriptRef: 'ref',
  adapterMeta: { adapterId: 'fake', modelVersion: 'v', observedTools },
});

const mkBreaker = (clock = { t: 0 }) =>
  new CircuitBreaker('a:m', {
    windowMs: 10_000,
    minCalls: 4,
    errorRateToOpen: 0.5,
    openMs: 5_000,
    now: () => clock.t,
  });

const openBreaker = () => {
  const b = mkBreaker();
  for (let i = 0; i < 4; i++) b.record(false);
  return b;
};

const task = (over: Partial<BridgeTask> = {}): BridgeTask => ({
  taskId: 'T1',
  goalExcerpt: 'do the thing',
  acceptanceCriteria: ['tests pass'],
  constraints: [],
  contextBundle: { pieces: [], manifestRef: 'm1' },
  ...over,
});

// ---- §7.1 toolDefs threaded through the bridge ------------------------------

describe('§7.1 toolDefs in AgentRequest', () => {
  it('bridge threads task.toolDefs onto every adapter request', async () => {
    const toolDefs: ToolDef[] = [
      { name: 'read_file', description: 'read a file', inputSchema: { type: 'object' } },
    ];
    const adapter = scriptedAdapter(() => mkResponse({ claim: 'GREEN' }));
    const port = adapterAgentPort(adapter, task({ toolDefs }));
    await port.propose({ taskId: 'T1', role: 'implementer', iteration: 0, feedback: [] });
    expect(adapter.calls[0]?.toolDefs).toEqual(toolDefs);
  });

  it('request always carries a toolDefs array even when task omits it', async () => {
    const adapter = scriptedAdapter(() => mkResponse({ claim: 'GREEN' }));
    const port = adapterAgentPort(adapter, task());
    await port.propose({ taskId: 'T1', role: 'implementer', iteration: 0, feedback: [] });
    expect(adapter.calls[0]?.toolDefs).toEqual([]);
  });
});

// ---- §7.2 core-owned validate + bounded repair ------------------------------

describe('§7.2 bridge-owned schema fallback (validate + one repair round)', () => {
  it('re-prompts once with a fresh requestId when structured output violates schema', async () => {
    const adapter = scriptedAdapter((req) =>
      req.requestId.endsWith('-repair') ? mkResponse({ claim: 'GREEN' }) : mkResponse({ note: 'oops' }),
    );
    const port = adapterAgentPort(adapter, task());
    const proposal = await port.propose({ taskId: 'T1', role: 'implementer', iteration: 0, feedback: [] });
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1]?.requestId).toMatch(/-repair$/);
    expect(proposal.claim).toBe('GREEN');
  });

  it('throws a typed SchemaValidationError when repair still fails', async () => {
    const adapter = scriptedAdapter(() => mkResponse({ note: 'never conforms' }));
    const port = adapterAgentPort(adapter, task());
    await expect(
      port.propose({ taskId: 'T1', role: 'implementer', iteration: 0, feedback: [] }),
    ).rejects.toBeInstanceOf(SchemaValidationError);
    expect(adapter.calls).toHaveLength(2); // one attempt + one bounded repair, no more
  });

  it('accepts a conforming result without any repair round', async () => {
    const adapter = scriptedAdapter(() => mkResponse({ claim: 'GREEN', note: 'done' }));
    const port = adapterAgentPort(adapter, task());
    const proposal = await port.propose({ taskId: 'T1', role: 'implementer', iteration: 0, feedback: [] });
    expect(adapter.calls).toHaveLength(1);
    expect(proposal.claim).toBe('GREEN');
    expect(proposal.note).toBe('done');
  });
});

// ---- §7.2 lineage-preferring fallback --------------------------------------

describe('§7.2 same-lineage fallback preference', () => {
  it('prefers a same-lineage fallback over a different-lineage one when primary is unavailable', () => {
    const entries: RouteEntry[] = [
      { adapter: routeAdapter('primary', { lineage: { family: 'claude' } }), breaker: openBreaker() },
      { adapter: routeAdapter('fb-glm', { lineage: { family: 'glm' } }), breaker: mkBreaker() },
      { adapter: routeAdapter('fb-claude', { lineage: { family: 'claude' } }), breaker: mkBreaker() },
    ];
    const r = route(entries, {});
    expect(r.ok && r.entry.adapter.manifest().adapterId).toBe('fb-claude');
  });
});

// ---- §7.4 susceptibility-aware routing -------------------------------------

describe('§7.4 susceptibility-aware routing', () => {
  it('avoids an injection-susceptible adapter when the context is untrusted', () => {
    const entries: RouteEntry[] = [
      { adapter: routeAdapter('susceptible', { injectionSusceptible: true }), breaker: mkBreaker() },
      { adapter: routeAdapter('safe', { injectionSusceptible: false }), breaker: mkBreaker() },
    ];
    const r = route(entries, {}, { untrustedContext: true });
    expect(r.ok && r.entry.adapter.manifest().adapterId).toBe('safe');
  });

  it('keeps preference order when the context is trusted', () => {
    const entries: RouteEntry[] = [
      { adapter: routeAdapter('susceptible', { injectionSusceptible: true }), breaker: mkBreaker() },
      { adapter: routeAdapter('safe', { injectionSusceptible: false }), breaker: mkBreaker() },
    ];
    const r = route(entries, {}, { untrustedContext: false });
    expect(r.ok && r.entry.adapter.manifest().adapterId).toBe('susceptible');
  });
});

// ---- §7.4 test_designer lineage separation ---------------------------------

describe('§7.4 test_designer must differ in lineage from implementer', () => {
  it('excludes same-family candidates and routes tests to a different model family', () => {
    const entries: RouteEntry[] = [
      { adapter: routeAdapter('codex-tester', { lineage: { family: 'codex' } }), breaker: mkBreaker() },
      { adapter: routeAdapter('claude-tester', { lineage: { family: 'claude' } }), breaker: mkBreaker() },
    ];
    const r = route(entries, {}, { implementerLineage: 'codex' });
    expect(r.ok && r.entry.adapter.manifest().adapterId).toBe('claude-tester');
  });

  it('BLOCKED(lineage_conflict) when every capable adapter shares the implementer lineage', () => {
    const entries: RouteEntry[] = [
      { adapter: routeAdapter('codex-only', { lineage: { family: 'codex' } }), breaker: mkBreaker() },
    ];
    const r = route(entries, {}, { implementerLineage: 'codex' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('lineage_conflict');
  });

  it('does not constrain lineage when implementerLineage is unset (other roles)', () => {
    const entries: RouteEntry[] = [
      { adapter: routeAdapter('codex-a', { lineage: { family: 'codex' } }), breaker: mkBreaker() },
    ];
    const r = route(entries, {});
    expect(r.ok && r.entry.adapter.manifest().adapterId).toBe('codex-a');
  });
});

// ---- §10.2 token bucket -----------------------------------------------------

describe('§10.2 TokenBucket', () => {
  it('drains to empty then refills lazily on the injected clock', () => {
    const clock = { t: 0 };
    const b = new TokenBucket('anthropic', { capacity: 2, refillPerSec: 1, now: () => clock.t });
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false); // empty
    clock.t = 1_000; // +1s -> +1 token
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false);
  });
});

describe('§10.2 router respects rate limit before dispatch', () => {
  it('BLOCKED(rate_limited) when the only capable adapter has no tokens', () => {
    const clock = { t: 0 };
    const bucket = new TokenBucket('a', { capacity: 1, refillPerSec: 0, now: () => clock.t });
    bucket.tryTake(); // drain
    const r = route([{ adapter: routeAdapter('a'), breaker: mkBreaker(), bucket }], {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('rate_limited');
  });

  it('skips a rate-limited adapter and consumes a token only from the selected one', () => {
    const clock = { t: 0 };
    const empty = new TokenBucket('a', { capacity: 1, refillPerSec: 0, now: () => clock.t });
    empty.tryTake();
    const funded = new TokenBucket('b', { capacity: 1, refillPerSec: 0, now: () => clock.t });
    const entries: RouteEntry[] = [
      { adapter: routeAdapter('a'), breaker: mkBreaker(), bucket: empty },
      { adapter: routeAdapter('b'), breaker: mkBreaker(), bucket: funded },
    ];
    const r = route(entries, {});
    expect(r.ok && r.entry.adapter.manifest().adapterId).toBe('b');
    expect(funded.available()).toBe(0); // winner consumed its token
  });
});

// ---- §7.3 drift canary ------------------------------------------------------

describe('§7.3 driftCheck', () => {
  const baseline = {
    probes: [
      { probe: 'P1-echo-schema', pass: true },
      { probe: 'P6-no-execution-authority', pass: true },
    ],
  };

  it('reports no drift when the cheap subset still conforms to baseline', async () => {
    const adapter = scriptedAdapter(() => mkResponse({ echo: 'pong' }, 0));
    const report = await driftCheck(adapter, baseline);
    expect(report.drifted).toBe(false);
    expect(report.changes).toHaveLength(0);
  });

  it('flags drift when isolation regresses (tools appear on the wire)', async () => {
    const adapter = scriptedAdapter(() => mkResponse({ echo: 'pong' }, 3));
    const report = await driftCheck(adapter, baseline);
    expect(report.drifted).toBe(true);
    expect(report.changes).toEqual([
      { probe: 'P6-no-execution-authority', baseline: true, current: false },
    ]);
  });
});

// ---- §9.2 rule 4 reviewer isolation ----------------------------------------

describe('§9.2 rule 4 reviewer isolation', () => {
  it('review request carries only goal/AC/diff/evidence — implementer prose cannot leak in', () => {
    const IMPLEMENTER_CLAIM = 'trust me, this is definitely correct and GREEN';
    const req = buildReviewRequest('rev-1', 'ship feature X', ['AC1 works'], 'diff --git a/x b/x', [
      'T1: pass',
    ]);
    expect(req.agentRole).toBe('reviewer');
    expect(req.taskContract.goalExcerpt).toBe('ship feature X');
    expect(req.taskContract.acceptanceCriteria).toContain('AC1 works');
    const serialized = JSON.stringify(req);
    expect(serialized).toContain('diff --git a/x b/x');
    expect(serialized).toContain('T1: pass');
    // there is no channel for implementer persuasion in the request shape
    expect(serialized).not.toContain(IMPLEMENTER_CLAIM);
    expect(req.contextBundle.pieces.every((p) => p.kind === 'diff' || p.kind === 'doc')).toBe(true);
  });
});

// ---- §7.5 injectable fusion verifier ---------------------------------------

describe('§7.5 fusion EVIDENCE verifier is injectable', () => {
  const fusionRequest = (): AgentRequest => ({
    requestId: 'fuse-1',
    agentRole: 'implementer',
    taskContract: { taskId: 'F1', goalExcerpt: 'g', acceptanceCriteria: [], constraints: [] },
    contextBundle: { pieces: [], manifestRef: 'm' },
    outputSchema: { type: 'object' },
    budget: { costUnits: 10 },
  });

  it('accepts an async, non-code-diff verifier and resolves by its evidence', async () => {
    const adapter = scriptedAdapter(() => mkResponse({ claim: 'X' }));
    const verifier = async (c: Candidate) => ({ gatePassed: c.panelIndex === 1, detail: 'async check' });
    const outcome = await fusePanel(adapter, fusionRequest(), 2, verifier);
    expect(outcome.winner?.panelIndex).toBe(1);
    expect(outcome.costMultiplier).toBe(2);
  });

  it('still supports the existing synchronous verifier as the default shape', async () => {
    const adapter = scriptedAdapter(() => mkResponse({ claim: 'X' }));
    const verifier = (c: Candidate) => ({ gatePassed: c.panelIndex === 0, detail: 'sync check' });
    const outcome = await fusePanel(adapter, fusionRequest(), 2, verifier);
    expect(outcome.winner?.panelIndex).toBe(0);
  });
});
