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
