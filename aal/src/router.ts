// Router (§7.4, Phase 2 slice): capability match -> health-aware (skip breaker-open,
// quota-aware) -> first eligible. No eligible -> BLOCKED(no_capacity), never thrash (INV-5).
import type { Adapter } from './protocol.js';
import type { CircuitBreaker } from './breaker.js';

export interface RouteEntry {
  adapter: Adapter;
  breaker: CircuitBreaker;
}

export interface RoleNeeds {
  structuredOutput?: boolean;
  toolCalling?: boolean;
}

export type RouteResult =
  | { ok: true; entry: RouteEntry }
  | { ok: false; reason: 'no_capacity' | 'no_capability'; detail: string };

export function route(entries: RouteEntry[], needs: RoleNeeds): RouteResult {
  const capable = entries.filter((e) => {
    const m = e.adapter.manifest();
    if (needs.structuredOutput && !m.structuredOutput) return false;
    if (needs.toolCalling && !m.toolCalling) return false;
    return true;
  });
  if (capable.length === 0) {
    return { ok: false, reason: 'no_capability', detail: 'no adapter satisfies role capability profile' };
  }
  for (const e of capable) {
    if (e.breaker.admit()) return { ok: true, entry: e };
  }
  return {
    ok: false, reason: 'no_capacity',
    detail: `all ${capable.length} capable adapters are breaker-open or quota-unhealthy — BLOCKED(no_capacity), no retry storm (INV-5)`,
  };
}
