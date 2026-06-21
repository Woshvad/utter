// @utter/data-proxy spend-cap gate (SCL-05). A per-payer rolling-24h USDC spend cap,
// the MONEY sibling of the per-resource call/byte quota in quota.ts.
//
// This module is cloned from the quota.ts shape (a Redis-shaped atomic store + an
// InMemory test default) with two deliberate divergences:
//
//   1. MONEY, not counts. recordSpend takes a USDC base-unit `bigint` amount and
//      returns a base-unit `bigint` rolling total. It is NEVER summed with the
//      quota.ts call/byte counters (those stay plain numbers in a DISTINCT store) -
//      mixing the two accounting surfaces corrupts both (08-RESEARCH Pitfall 5 /
//      threat T-08-UNITMIX). There is NO 6/1e6/10**6 decimals literal here; all
//      arithmetic is base-unit bigint.
//
//   2. ROLLING-24h over an INJECTED clock. recordSpend / spendCapGate take a
//      `now: number` (seconds) and the window math drops spends older than 24h from
//      `now`. There is NO Date.now() anywhere in this module (08-RESEARCH Pattern 2 /
//      threat T-08-CLOCK) - the window reset is deterministic under a fake clock.
//
// The gate is DENY-BY-DEFAULT and runs BEFORE /verify reserve + handler dispatch (the
// facilitator mounts it ahead of compute in Plan 08-06 Task 2). spendCapGate is a pure
// READ (it records nothing); the caller records the spend via store.recordSpend only on
// an allowed, settled call. Reading-before-recording is what lets an over-cap payer be
// rejected with ZERO compute (08-RESEARCH Pitfall 4 / the §19 free-compute hard rule).

/** The rolling window length in seconds (24h). The injected `now` is in seconds. */
export const SPEND_CAP_WINDOW_SECONDS = 24 * 3600;

/**
 * Per-payer rolling-24h spend store. `recordSpend` atomically adds `amount` to the
 * payer's window at time `now` and returns the new rolling-24h total (base-unit
 * `bigint`). A zero-amount call is the pure READ of the current window total (what
 * the gate uses). The interface is Redis-shaped (atomic add-and-return) so a real
 * Redis adapter drops in behind this same contract; the InMemory adapter below is the
 * test default. All amounts are USDC base-unit bigint - never the quota call/byte
 * numbers.
 */
export interface SpendCapStore {
  /**
   * Atomically add `amount` to `payer`'s rolling-24h spend at `now` (seconds) and
   * return the new in-window total. Pass `amount === 0n` to read the current total
   * without recording a spend.
   */
  recordSpend(payer: string, amount: bigint, now: number): Promise<bigint>;
  /**
   * ATOMIC check-and-reserve (WR-04): in ONE indivisible operation, read the payer's
   * rolling-24h total, and IFF `rolling + amount <= cap` record `amount` and return
   * `{ allowed: true }`; otherwise record NOTHING and return `{ allowed: false }`.
   *
   * This closes the TOCTOU hole the read-then-record gate had: two concurrent requests
   * from the same payer that JOINTLY exceed the cap can no longer BOTH pass (each would
   * read the pre-spend total, both pass, both record). With the atomic op the second
   * request sees the first request's reservation and is denied. The interface is
   * Redis-shaped (a single atomic add-if-within-cap) so a real Redis adapter implements
   * it as one Lua/EVAL round-trip. `total` is the rolling total INCLUDING this spend on
   * allow, or the unchanged rolling total on deny. All amounts are USDC base-unit bigint.
   */
  tryRecordSpend(
    payer: string,
    amount: bigint,
    cap: bigint,
    now: number,
  ): Promise<{ allowed: boolean; total: bigint }>;
  /**
   * Compensating REFUND (WR-04): atomically remove a previously-reserved `amount` from
   * the payer's window at `now`, undoing a tryRecordSpend hold when the downstream
   * reservation is rejected (so a denied-after-reserve call does not permanently consume
   * the payer's cap - a self-DoS). A no-op when there is nothing to refund.
   */
  refundSpend(payer: string, amount: bigint, now: number): Promise<bigint>;
}

/** One timestamped spend entry in a payer's rolling window. */
interface SpendEntry {
  /** When the spend occurred (injected clock seconds). */
  at: number;
  /** The spend amount in USDC base units. */
  amount: bigint;
}

/**
 * In-memory SpendCapStore (test default - no Redis). Holds per-payer timestamped
 * spend entries and sums ONLY those within the 24h window from the injected `now`.
 * The window math takes `now` as a parameter - there is NO Date.now() here, so the
 * window reset is fully deterministic under a fake clock (08-RESEARCH Pattern 2).
 * The real Redis adapter (a sorted-set keyed by timestamp, trimmed by score) exposes
 * the same SpendCapStore contract so the facilitator gate swaps adapters by env.
 */
export class InMemorySpendCapStore implements SpendCapStore {
  private readonly entries = new Map<string, SpendEntry[]>();

  async recordSpend(payer: string, amount: bigint, now: number): Promise<bigint> {
    const cutoff = now - SPEND_CAP_WINDOW_SECONDS;
    // Trim entries older than the 24h window (deterministic on the injected `now`),
    // then append this spend if it is non-zero (a zero amount is a pure read).
    const kept = (this.entries.get(payer) ?? []).filter((e) => e.at > cutoff);
    if (amount !== 0n) kept.push({ at: now, amount });
    this.entries.set(payer, kept);
    // Sum the in-window base-unit amounts - bigint money, never coerced to number.
    let total = 0n;
    for (const e of kept) total += e.amount;
    return total;
  }

  /**
   * ATOMIC check-and-reserve (WR-04). In the single-threaded event loop this is
   * indivisible because there is NO `await` between reading the window total and
   * appending the spend - no other request can interleave between the check and the
   * record. The Redis adapter achieves the same indivisibility with one EVAL. On allow
   * the spend is recorded (so a concurrent second request sees it and is denied); on
   * deny NOTHING is recorded.
   */
  async tryRecordSpend(
    payer: string,
    amount: bigint,
    cap: bigint,
    now: number,
  ): Promise<{ allowed: boolean; total: bigint }> {
    const cutoff = now - SPEND_CAP_WINDOW_SECONDS;
    const kept = (this.entries.get(payer) ?? []).filter((e) => e.at > cutoff);
    let rolling = 0n;
    for (const e of kept) rolling += e.amount;
    // Deny-by-default: only record if the spend stays within the cap. No await between
    // this decision and the write below, so two concurrent calls cannot both pass.
    if (rolling + amount > cap) {
      this.entries.set(payer, kept); // persist the window trim even on deny
      return { allowed: false, total: rolling };
    }
    if (amount !== 0n) kept.push({ at: now, amount });
    this.entries.set(payer, kept);
    return { allowed: true, total: rolling + amount };
  }

  /** Compensating refund (WR-04): remove a reserved spend of `amount` at `now`. */
  async refundSpend(payer: string, amount: bigint, now: number): Promise<bigint> {
    const cutoff = now - SPEND_CAP_WINDOW_SECONDS;
    const kept = (this.entries.get(payer) ?? []).filter((e) => e.at > cutoff);
    // Remove ONE matching reserved entry (same amount + timestamp) if present.
    const idx = kept.findIndex((e) => e.amount === amount && e.at === now);
    if (idx >= 0) kept.splice(idx, 1);
    this.entries.set(payer, kept);
    let total = 0n;
    for (const e of kept) total += e.amount;
    return total;
  }
}

/**
 * The per-payer rolling-24h spend-cap gate (08-RESEARCH Code Examples). Reads the
 * payer's current 24h window total and DENIES when `rolling + amount > cap`
 * (deny-by-default); otherwise ALLOWS. This is a pure READ - it records nothing, so it
 * can run BEFORE /verify reserve + handler dispatch and reject an over-cap payer with
 * ZERO compute (the free-compute guard). All amounts are USDC base-unit bigint.
 *
 * @param payer  The payer identity (case-sensitive key; the caller normalizes).
 * @param amount The cap amount this call would consume (base-unit bigint).
 * @param cap    The per-payer 24h cap (base-unit bigint).
 * @param store  The SpendCapStore (InMemory default or a Redis adapter).
 * @param now    The injected clock (seconds) - NEVER Date.now().
 */
export async function spendCapGate(
  payer: string,
  amount: bigint,
  cap: bigint,
  store: SpendCapStore,
  now: number,
): Promise<"allow" | "deny"> {
  // A zero-amount recordSpend is the pure read of the current 24h window total.
  const rolling = await store.recordSpend(payer, 0n, now);
  return rolling + amount > cap ? "deny" : "allow";
}
