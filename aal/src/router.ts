// Router (§7.4): capability match (required) -> scored preference over the capable set:
// avoid injection-susceptible adapters under untrusted context, prefer a healthy breaker,
// prefer same-lineage as the primary. Rate limit (§10.2) is honored before dispatch and a
// token is consumed only from the selected adapter. No eligible -> BLOCKED, never thrash (INV-5).
import type { Adapter } from './protocol.js';
import type { CircuitBreaker } from './breaker.js';
import type { TokenBucket } from './rate-limit.js';

export interface RouteEntry {
  adapter: Adapter;
  breaker: CircuitBreaker;
  /** optional per-provider rate limit; absent means unlimited (§10.2) */
  bucket?: TokenBucket;
}

export interface RoleNeeds {
  structuredOutput?: boolean;
  toolCalling?: boolean;
}

/** request-side signals that steer routing (§10.1 susceptibility-aware). */
export interface RouteContext {
  /** the request carries low-trust content — avoid injection-susceptible models */
  untrustedContext?: boolean;
  /**
   * When routing a test_designer, the implementer's lineage family. Candidates that share it
   * are excluded so tests come from a different model family than the code (§7.4). Presence of
   * this field is the test_designer signal; leave it unset for every other role.
   */
  implementerLineage?: string;
}

export type RouteResult =
  | { ok: true; entry: RouteEntry }
  | { ok: false; reason: 'no_capacity' | 'no_capability' | 'rate_limited' | 'lineage_conflict'; detail: string };

/** breaker is available if it is not error-open and not quota-unhealthy (does not consume a probe). */
function breakerHealthy(b: CircuitBreaker): boolean {
  return b.state === 'closed' && !b.quotaUnhealthy;
}

export function route(entries: RouteEntry[], needs: RoleNeeds, ctx: RouteContext = {}): RouteResult {
  const capable = entries.filter((e) => {
    const m = e.adapter.manifest();
    if (needs.structuredOutput && !m.structuredOutput) return false;
    if (needs.toolCalling && !m.toolCalling) return false;
    return true;
  });
  if (capable.length === 0) {
    return { ok: false, reason: 'no_capability', detail: 'no adapter satisfies role capability profile' };
  }

  // §7.4 lineage separation: a test_designer must not share the implementer's model family.
  // Exclude same-family candidates BEFORE routing; if that empties the pool, fail closed — only a
  // human may relax this (INV-16, no auto-loosen), never the router.
  const pool = ctx.implementerLineage
    ? capable.filter((e) => e.adapter.manifest().lineage?.family !== ctx.implementerLineage)
    : capable;
  if (ctx.implementerLineage && pool.length === 0) {
    return {
      ok: false, reason: 'lineage_conflict',
      detail: `all capable adapters share the implementer lineage "${ctx.implementerLineage}" — test_designer must differ (§7.4); only a human override may relax this (INV-16, no auto-loosen)`,
    };
  }

  // primary = most preferred eligible entry; same-lineage fallback is scored against it (§7.2)
  const primaryLineage = pool[0]!.adapter.manifest().lineage?.family;

  const score = (e: RouteEntry): number => {
    const m = e.adapter.manifest();
    let s = 0;
    if (ctx.untrustedContext && m.injectionSusceptible) s -= 100; // dominant: keep low-trust off susceptible models
    if (breakerHealthy(e.breaker)) s += 10;
    if (primaryLineage && m.lineage?.family === primaryLineage) s += 1;
    return s;
  };

  // stable sort by score desc; ties keep input (preference) order
  const ranked = pool
    .map((e, i) => ({ e, i, s: score(e) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.e);

  let sawRateLimited = false;
  let sawBreakerBlocked = false;
  for (const e of ranked) {
    if (e.bucket && e.bucket.available() < 1) {
      sawRateLimited = true; // throttled: skip before touching the breaker probe
      continue;
    }
    if (!e.breaker.admit()) {
      sawBreakerBlocked = true;
      continue;
    }
    e.bucket?.tryTake(); // consume only for the winner (§10.2)
    return { ok: true, entry: e };
  }

  if (sawRateLimited && !sawBreakerBlocked) {
    return {
      ok: false, reason: 'rate_limited',
      detail: `all ${pool.length} eligible adapters are rate-limited — BLOCKED(rate_limited), no retry storm (INV-5)`,
    };
  }
  return {
    ok: false, reason: 'no_capacity',
    detail: `all ${pool.length} eligible adapters are breaker-open, quota-unhealthy, or throttled — BLOCKED(no_capacity), no retry storm (INV-5)`,
  };
}
