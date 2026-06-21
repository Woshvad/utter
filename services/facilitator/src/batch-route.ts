// batch-route.ts (SCL-02 integration) - the min-economical threshold branch that lands
// the Plan 08-03 BatchSettler into the live facilitator settle path.
//
// WHY: per-call on-chain settlement makes sub-cent prices uneconomical (gas dominates).
// Plan 08-03 built + unit-proved the BatchSettler logic core; this module inserts it
// into the request path by CHOOSING, per computed debit, between two existing paths:
//
//   - debit <  minEconomical -> batchSettler.accrue(resourceId, debit, now)
//        the sub-cent path: the debit is ACCRUED into the pending ledger with NO
//        immediate on-chain debit. The BatchSettler's hybrid trigger (N / T / threshold,
//        Plan 08-03) later flushes ONE settle() for the whole batch.
//   - debit >= minEconomical -> settle(payment, amount, idemKey, deps, body)
//        the existing immediate path, UNCHANGED (one debit, clamp-to-cap inside settle).
//
// This is a thin DECISION helper: it does NOT re-implement a debit path and does NOT
// touch settle()'s internals or the BatchSettler (Plan 08-03 owns both). A debit goes to
// EXACTLY ONE of the two paths - a mutually-exclusive threshold branch (threat
// T-08-ROUTEDOUBLE: never both, so never a double-settle).
//
// The `minEconomical` threshold is INJECTED config - there is NO magic decimals literal
// (`6`/`1e6`/`10**6`) here. The `now` is the INJECTED facilitator clock - NO Date.now(),
// NO Math.random(). All amounts are USDC base-unit bigint.
import type { Hex } from "viem";
import type { PaymentPayload } from "@utter/x402-arc";
import {
  settle,
  type ExactSettlePayload,
  type SettleDeps,
  type SettleResponseBody,
  type Receipt,
} from "./settle";
import type { BatchSettler, BatchFlushResult } from "./batch-settler";

/** The immediate-settle arguments routeDebit forwards verbatim to settle() (>= threshold). */
export interface RouteSettleArgs {
  /** The escrow PaymentPayload (or an ExactSettlePayload) settle() submits. */
  payment: PaymentPayload | ExactSettlePayload;
  /** The metered charge (base-unit bigint), already clamped to cap by metering. */
  amount: bigint;
  /** The payment nonce = the idempotency key. */
  idemKey: Hex;
  /** Injected relayer + stores + chain + addresses. */
  deps: SettleDeps;
  /** The buyer's paid response bytes to persist for replay (default ""). */
  body?: SettleResponseBody;
}

/** The routeDebit inputs: the computed debit + the threshold + both downstream seams. */
export interface RouteDebitInput {
  /** The computed debit for THIS call (base-unit bigint). */
  debit: bigint;
  /** The injected min-economical threshold (base-unit bigint) - NOT a magic literal. */
  minEconomical: bigint;
  /** The resource the debit is for (the BatchSettler's batch key). */
  resourceId: Hex;
  /** The injected facilitator clock (seconds) - NEVER Date.now(). */
  now: number;
  /** The Plan 08-03 BatchSettler the sub-cent path accrues into. */
  batchSettler: BatchSettler;
  /** The immediate-settle args (used only on the >= threshold path). */
  settle: RouteSettleArgs;
}

/** The route outcome: which path the debit took + the path-specific result. */
export interface RouteDebitResult {
  /**
   * - "batched":   debit < threshold; accrued into the BatchSettler (no immediate debit).
   * - "immediate": debit >= threshold; settled now via settle() (one debit).
   */
  path: "batched" | "immediate";
  /** On the batched path: the flush result IF this accrual tripped a trigger, else null. */
  flush?: BatchFlushResult | null;
  /** On the immediate path: the settle() receipt. */
  receipt?: Receipt;
}

/**
 * Route ONE computed debit to EXACTLY ONE settlement path on the injected min-economical
 * threshold. A sub-cent debit (`< minEconomical`) is accrued into the Plan 08-03
 * BatchSettler (no immediate on-chain debit - the batch flushes one settle() later); an
 * at/above-threshold debit settles immediately via the existing settle() money guard.
 *
 * The branch is mutually exclusive: a debit NEVER takes both paths (no double-settle),
 * and the sub-cent path produces ZERO immediate debit. This is a pure decision over the
 * two existing seams - it forks NO new debit path.
 */
export async function routeDebit(input: RouteDebitInput): Promise<RouteDebitResult> {
  if (input.debit < input.minEconomical) {
    // SUB-CENT: accrue into the BatchSettler. NO immediate on-chain debit; the hybrid
    // trigger flushes ONE settle() for the batch later (Plan 08-03). Returns the flush
    // result IF this accrual tripped a trigger (N / T / threshold), else null.
    const flush = await input.batchSettler.accrue(
      input.resourceId,
      input.debit,
      input.now,
    );
    return { path: "batched", flush };
  }

  // AT/ABOVE THRESHOLD: the existing immediate path, unchanged. settle() applies the
  // result-cache short-circuit, the clamp min(amount, cap), the NonceUsed rebuild, and
  // persist-before-respond - we never fork that guard.
  const s = input.settle;
  const receipt = await settle(s.payment, s.amount, s.idemKey, s.deps, s.body);
  return { path: "immediate", receipt };
}
