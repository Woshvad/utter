// Facilitator pre-reserve spend-cap gate (SCL-05 / threat T-08-FREECOMPUTE).
//
// This is the thin wrapper that mounts the data-proxy `spendCapGate` AHEAD of the
// /verify reserve + handler dispatch, mirroring the Phase 2 reserve-before-run order
// (verify.ts: "NO handler runs here ... RESERVE-PRECEDES-RUN"). It is ADDITIVE - it does
// NOT touch verifyAndReserve or settle; it sits in front of them exactly as the Phase 2
// payment gate sits before next().
//
// THE LOAD-BEARING INVARIANT IS ORDER (CLAUDE.md §19 / 08-RESEARCH Pitfall 4): the
// per-payer rolling-24h spend cap is checked FIRST. On "deny" the gate short-circuits
// and NEITHER reserve NOR the handler runs - an over-cap payer consumes ZERO compute
// (the free-compute guard). Only on "allow" does it proceed to reserve, and only after a
// VALID reservation does the handler run. The payer's spend is recorded ONLY on the
// allowed-and-reserved path, so a denied or reserve-rejected call accrues nothing.
//
// The clock is INJECTED (`now: number`, seconds) - there is NO Date.now() here. All
// amounts are USDC base-unit bigint. The spend-cap money never touches the quota
// call/byte counters (distinct stores).
import { spendCapGate, type SpendCapStore } from "@utter/data-proxy";

/** A reservation outcome from the wrapped reserve fn (mirrors verify.ts VerifyResult). */
export interface ReserveOutcome {
  valid: boolean;
  reason?: string;
  payer?: string;
}

/** The spend-cap inputs: the payer + the cap amount this call would consume + the cap. */
export interface SpendCapGateInput {
  /** The payer identity (the recovered buyer; the caller normalizes the key). */
  payer: string;
  /** The cap amount this call would consume (USDC base-unit bigint). */
  amount: bigint;
  /** The per-payer rolling-24h cap (USDC base-unit bigint). */
  cap: bigint;
  /** The rolling-24h spend store (InMemory default or a Redis adapter). */
  store: SpendCapStore;
  /** The injected clock (seconds) - NEVER Date.now(). */
  now: number;
}

/**
 * The downstream pipeline the gate wraps: the /verify reserve and the handler. Both are
 * injected so the gate stays agnostic to the concrete facilitator wiring (and so the
 * order is spy-assertable in tests). `reserve` is called ONLY on a spend-cap allow;
 * `handler` runs ONLY after a valid reservation.
 */
export interface SpendCapDownstream<H> {
  /** The /verify reserve step (verifyAndReserve, bound by the caller). */
  reserve: () => Promise<ReserveOutcome>;
  /** The handler dispatch, gated on a valid reservation. */
  handler: () => Promise<H>;
}

/** The gate decision + (on the allowed path) the handler's result. */
export interface SpendCapGateResult<H> {
  /**
   * - "deny": over-cap; nothing downstream ran (free-compute guard).
   * - "reserve_rejected": cap allowed but the reservation failed; handler did NOT run.
   * - "allow": cap allowed, reserved, handler ran, spend recorded.
   */
  decision: "deny" | "reserve_rejected" | "allow";
  /** The reservation outcome (present once reserve was attempted). */
  reserve?: ReserveOutcome;
  /** The handler result (present only on the fully-allowed path). */
  handlerResult?: H;
}

/**
 * Run the per-payer spend-cap check BEFORE the /verify reserve and the handler.
 *
 * Order (the free-compute guard):
 *   1. spendCapGate(payer, amount, cap, store, now) - a PURE READ of the 24h window.
 *      "deny" -> short-circuit: NO reserve, NO handler, NO spend recorded.
 *   2. "allow" -> reserve(). If the reservation is not valid -> stop: handler does NOT
 *      run and NO spend is recorded (no compute consumed).
 *   3. valid reservation -> handler(), then record the spend (store.recordSpend) so a
 *      subsequent over-cap call denies. Recording AFTER a successful reserve means a
 *      denied/rejected call never accrues against the payer's window.
 */
export async function spendCapPreReserveGate<H>(
  input: SpendCapGateInput,
  downstream: SpendCapDownstream<H>,
): Promise<SpendCapGateResult<H>> {
  const { payer, amount, cap, store, now } = input;

  // (1) The deny-by-default spend-cap check runs FIRST - before any compute.
  const decision = await spendCapGate(payer, amount, cap, store, now);
  if (decision === "deny") {
    return { decision: "deny" };
  }

  // (2) Allowed -> reserve. Reserve PRECEDES the handler (Phase 2 invariant).
  const reserve = await downstream.reserve();
  if (!reserve.valid) {
    // A rejected reservation: the handler must NOT run and NO spend is recorded.
    return { decision: "reserve_rejected", reserve };
  }

  // (3) Valid reservation -> run the handler, then record the payer's spend so the
  // rolling-24h window reflects this call for the NEXT gate check.
  const handlerResult = await downstream.handler();
  await store.recordSpend(payer, amount, now);

  return { decision: "allow", reserve, handlerResult };
}
