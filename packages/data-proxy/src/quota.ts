// @utter/data-proxy quota seam (PRX-03). A standalone per-resource call/byte
// quota counter that Plan 04 wires into the /proxy flow AFTER the existing
// token/allowlist/SSRF guards. This module deliberately does NOT touch proxy.ts:
// the Phase 3 egress logic is frozen; quota is an additive seam.
//
// The interface is Redis-shaped (a single atomic increment that returns the new
// running totals) so the real Redis adapter (Wave) drops in behind the same
// QuotaStore contract the InMemoryQuotaStore test default implements. All
// counters are plain call/byte counts - numbers, never USDC amounts - and carry
// NO 6/1e6 decimals literal (Pitfall 3); quota is request accounting, not money.

/** A single quota increment: the calls and bytes consumed by one proxied request. */
export interface QuotaBudget {
  /** Number of upstream calls to add (typically 1 per proxied request). */
  calls: number;
  /** Number of response bytes to add. */
  bytes: number;
}

/**
 * Per-resource quota counter. `increment` atomically adds the budget for a
 * resource and returns the new running totals, so the caller can compare against
 * a ceiling without a separate read (Redis HINCRBY-shaped). The real Redis
 * adapter implements this same contract; the in-memory adapter below is the test
 * default.
 */
export interface QuotaStore {
  /**
   * Atomically add `budget` to `resourceId`'s running counters and return the
   * new totals.
   */
  increment(resourceId: string, budget: QuotaBudget): Promise<QuotaBudget>;
}

/**
 * In-memory QuotaStore (test default - no Redis). Holds per-resource running
 * totals in a Map. The real Redis adapter exposes the same QuotaStore shape so
 * Plan 04 can swap adapters by env without touching the /proxy wiring.
 */
export class InMemoryQuotaStore implements QuotaStore {
  private readonly counters = new Map<string, QuotaBudget>();

  async increment(resourceId: string, budget: QuotaBudget): Promise<QuotaBudget> {
    const current = this.counters.get(resourceId) ?? { calls: 0, bytes: 0 };
    const next: QuotaBudget = {
      calls: current.calls + budget.calls,
      bytes: current.bytes + budget.bytes,
    };
    this.counters.set(resourceId, next);
    return next;
  }
}

/**
 * Per-resource quota gate: a deny-on-exhaustion ceiling check over the EXISTING
 * QuotaStore seam (SCL-05). It increments the resource's counters by `budget` via the
 * SAME store the /proxy flow uses (no fork), then returns "deny" once the new running
 * total crosses EITHER the call OR the byte `ceiling`, else "allow". This is the
 * reusable unit core the spend-cap plan exports alongside spendCapGate; the /proxy
 * route keeps its own 429 fail-closed wiring (quota-gate.test) - this gate is the same
 * decision factored out so the facilitator/data-proxy can share one ceiling check.
 *
 * Counters are PLAIN call/byte numbers - request accounting, never USDC money. They are
 * NEVER summed with the spend-cap bigint amounts (distinct stores; threat T-08-UNITMIX).
 *
 * @param resourceId The resource whose per-resource counters this checks.
 * @param budget     The calls/bytes this request would consume.
 * @param ceiling    The configured per-resource call + byte ceiling.
 * @param store      The QuotaStore (InMemory default or a Redis adapter).
 */
export async function quotaGate(
  resourceId: string,
  budget: QuotaBudget,
  ceiling: QuotaBudget,
  store: QuotaStore,
): Promise<"allow" | "deny"> {
  const totals = await store.increment(resourceId, budget);
  if (totals.calls > ceiling.calls || totals.bytes > ceiling.bytes) return "deny";
  return "allow";
}
