// @utter/facilitator public surface (the re-export barrel).
//
// Phase 8 SCL-02 introduces the nanopayment batching core. The per-call route that
// decides "sub-cent -> BatchSettler vs settle() directly" is landed by Plan 08-06
// Task 3 (Wave 3); this barrel exposes BatchSettler + BatchLedger as the single clean
// injection seam that route adopts, without 08-06 having to reach into the modules.

export {
  BatchSettler,
  type BatchSettlerOptions,
  type BatchFlushResult,
  type BuildBatchPayment,
} from "./batch-settler";

export {
  BPS_DENOMINATOR,
  splitDebit,
  reconcileBatch,
  InMemoryBatchLedger,
  type BatchLedgerStore,
  type PendingBatch,
  type BatchReconciliation,
} from "./batch-ledger";

// Re-export the settle surface the batch core routes through (one canonical money guard).
export {
  settle,
  type SettleDeps,
  type Receipt,
  type SettleScheme,
} from "./settle";

// SCL-05 pre-reserve spend-cap gate: the data-proxy spendCapGate mounted AHEAD of
// /verify reserve + handler dispatch (deny-by-default free-compute guard; threat
// T-08-FREECOMPUTE). Additive in front of the reserve path - it never touches the
// money guard itself.
export {
  spendCapPreReserveGate,
  type SpendCapGateInput,
  type SpendCapDownstream,
  type SpendCapGateResult,
  type ReserveOutcome,
} from "./spend-cap-gate";

// SCL-02 batch route: the min-economical threshold branch that routes a sub-cent debit
// into the Plan 08-03 BatchSettler (accrue, no immediate debit) vs an immediate settle().
// A mutually-exclusive branch (no double-settle); the threshold is injected config.
export {
  routeDebit,
  type RouteDebitInput,
  type RouteDebitResult,
  type RouteSettleArgs,
} from "./batch-route";

// C1 per-resource caller-auth token: mint/verify a small HMAC token bound to a single
// resourceId so a caller may only act on the resource its token authorizes. The
// deployer reuses mintResourceAuthToken at deploy time to mint one token per resource
// and inject it into the SIDECAR (never the untrusted handler). The HMAC lives here;
// callers never reimplement it.
export {
  mintResourceAuthToken,
  verifyResourceAuthToken,
  type MintOpts,
} from "./resource-auth";
