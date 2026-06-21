// batch-settler.ts (SCL-02) - accrue sub-cent debits, flush on a HYBRID trigger, and
// submit EXACTLY ONE settle() per batch, preserving the Phase 2 exactly-once guarantee
// at batch granularity.
//
// WHY: per-call on-chain settlement makes sub-cent prices uneconomical (gas dominates).
// The BatchSettler accrues many tiny debits into one batch and settles them with a
// single on-chain debit, with NO rounding leakage (the BatchLedger carry-forward) and
// NO double-charge (an idempotent, DETERMINISTIC batch key + the persisted pending
// ledger).
//
// HOW IT STAYS EXACTLY-ONCE: it does NOT fork the money guard. On flush it calls the
// SAME settle() from settle.ts (RESEARCH "Don't Hand-Roll"), so it inherits all three
// idempotency mechanisms verbatim:
//   1. result-cache short-circuit (a re-flush of the same batchIdemKey returns the
//      cached receipt with NO second debit - the buyer is never re-signed),
//   2. on-chain NonceUsed rebuild (a retry after a crash rebuilds the receipt from the
//      Debited event instead of submitting a second tx),
//   3. persist-before-respond (the receipt is durable before settle() returns).
// The settle.ts:286 clamp `min(batchAmount, cap)` still applies; the contract
// re-enforces `amount <= maxAmount` on-chain (the double ceiling).
//
// DETERMINISTIC KEY: the batchIdemKey is keccak256(resourceId || batchSeq) - a pure
// function of the resource and a monotonic batch sequence. It uses NO Math.random()
// and NO Date.now(), so a crash mid-flush re-derives the SAME key and the result-cache
// + on-chain NonceUsed guard make the re-flush a no-op debit.
//
// WIRING: this module does NOT touch settle.ts and does NOT edit the facilitator
// request route. The per-call route that decides "sub-cent -> BatchSettler vs settle()
// directly" is landed by Plan 08-06 Task 3 (the Wave 3 plan that owns the request-path
// edits), to avoid a same-wave settle-route conflict. The BatchSettler exposes a single
// `accrue(...)` entry the route calls - a clean injection seam.
//
// All amounts are USDC base-unit `bigint`. No `6`/`1e6`/`10**6` decimals literal.
import { keccak256, toHex, type Hex } from "viem";
import type { PaymentPayload } from "@utter/x402-arc";
import { settle, type SettleDeps, type Receipt } from "./settle";
import {
  reconcileBatch,
  type BatchLedgerStore,
  type BatchReconciliation,
} from "./batch-ledger";

/**
 * Build the buyer's batch authorization for a (deterministic batch nonce, batch
 * amount). The route (08-06) provides this - the BatchSettler stays agnostic to HOW
 * the batch DebitAuthorization is produced (one signed authorization per batch,
 * keyed on the batchIdemKey nonce). `cap` is the signed `maxAmount` the clamp
 * `min(batchAmount, cap)` uses.
 */
export type BuildBatchPayment = (
  batchIdemKey: Hex,
  batchAmount: bigint,
) => Promise<{ payment: PaymentPayload; cap: bigint }>;

/** Everything the BatchSettler needs injected. */
export interface BatchSettlerOptions {
  /** The persisted pending-accrual store (in-memory default or a durable adapter). */
  ledger: BatchLedgerStore;
  /** The settle() deps (relayer + stores + chain) routed through verbatim. */
  deps: SettleDeps;
  /** The buyer's per-batch authorization builder (the route's injection seam). */
  buildBatchPayment: BuildBatchPayment;
  /** The resource this settler batches for (one settler per (resource, payee-leg)). */
  resourceId: Hex;
  /** The resource's creator basis points - the canonical split the batch reconciles to. */
  creatorBps: bigint;
  /** N: flush once this many debits accumulate in the open batch. */
  maxBatchCount: number;
  /** T (seconds): flush once this long elapses since the batch's first accrual. */
  maxBatchSeconds: number;
  /** The min-economical accrued amount: flush once the batch total reaches it. */
  minEconomicalThreshold: bigint;
}

/** The result of a flush: the settled batch amount + the (possibly cached) receipt. */
export interface BatchFlushResult {
  /** The monotonic batch sequence that was flushed. */
  batchSeq: number;
  /** The on-chain settle amount for this batch (the reconciled accrued sum). */
  batchAmount: bigint;
  /** The reconciled legs + the remainder carried into the next batch. */
  reconciliation: BatchReconciliation;
  /** The settle() receipt (a cached receipt on an idempotent re-flush). */
  receipt: Receipt;
}

/**
 * Accrues debits into the BatchLedger and flushes on a hybrid trigger (N debits OR T
 * seconds OR accrued >= min-economical), submitting one settle() per batch. The batch
 * key is deterministic so a crash mid-flush re-runs to exactly one debit.
 */
export class BatchSettler {
  private readonly opts: BatchSettlerOptions;
  /** The resource this settler batches for (fixed at construction). */
  private readonly resourceId: Hex;
  /** The monotonic open-batch sequence (the deterministic key input - never wall-clock). */
  private batchSeq = 0;
  /** The injected `now` of the open batch's FIRST accrual (the time-trigger anchor). */
  private windowStart: number | null = null;

  constructor(opts: BatchSettlerOptions) {
    this.opts = opts;
    this.resourceId = opts.resourceId;
  }

  /** The batch key the ledger stores this batch under: `${resourceId}:${batchSeq}`. */
  private batchKey(seq: number): string {
    return `${this.resourceId}:${seq}`;
  }

  /**
   * The DETERMINISTIC idempotent batch nonce (bytes32): keccak256 of the resource id
   * concatenated with the batch sequence. Pure - NO Math.random(), NO Date.now() - so a
   * re-flush after a crash re-derives the SAME key and settle()'s result-cache +
   * on-chain NonceUsed guard make the second attempt a no-op.
   */
  batchIdemKey(seq: number): Hex {
    // keccak256(resourceId(32 bytes) || seq(big-endian 32 bytes)) - a stable bytes32.
    const seqHex = toHex(BigInt(seq), { size: 32 }).slice(2);
    return keccak256(`${this.resourceId}${seqHex}` as Hex);
  }

  /**
   * Accrue one debit into the open batch and evaluate the hybrid flush trigger. Returns
   * the flush result if this accrual tripped a trigger (N debits OR T seconds elapsed OR
   * accrued >= min-economical, whichever fires FIRST), else null.
   *
   * @param resourceId The resource the debit is for (fixes this settler's batch key).
   * @param debit      The metered sub-cent charge in USDC base units.
   * @param now        The injected clock (seconds). NEVER read wall-clock internally.
   */
  async accrue(
    resourceId: Hex,
    debit: bigint,
    now: number,
  ): Promise<BatchFlushResult | null> {
    if (this.resourceId !== resourceId) {
      throw new Error(
        `BatchSettler: resource mismatch (batching ${this.resourceId}, got ${resourceId})`,
      );
    }
    if (this.windowStart === null) this.windowStart = now;

    const key = this.batchKey(this.batchSeq);
    const accruedTotal = await this.opts.ledger.accrue(key, debit, this.opts.creatorBps);
    const pending = await this.opts.ledger.getPending(key);
    const debitCount = pending?.debitCount ?? 0;

    // HYBRID trigger, first-wins: N debits OR T seconds OR accrued >= threshold.
    const hitCount = debitCount >= this.opts.maxBatchCount;
    const hitTime = now - this.windowStart >= this.opts.maxBatchSeconds;
    const hitThreshold = accruedTotal >= this.opts.minEconomicalThreshold;
    if (!hitCount && !hitTime && !hitThreshold) return null;

    return this.flushBatch(this.batchSeq);
  }

  /**
   * Flush the batch at `seq`: reconcile the accrued legs, derive the deterministic
   * batchIdemKey, and submit ONE settle(batchPayment, batchAmount, batchIdemKey, deps)
   * routed THROUGH the existing money guard. Idempotent: re-flushing the same seq after
   * a crash short-circuits on the result-cache with NO second debit and the persisted
   * pending ledger + carry survive the restart (exactly-once at batch granularity).
   *
   * The ledger is marked flushed (and its carry seeded into the next batch) only AFTER
   * settle() persists the receipt, so a crash BEFORE persist re-flushes idempotently.
   */
  async flushBatch(seq: number): Promise<BatchFlushResult | null> {
    // A recovery flush after a restart re-derives the SAME deterministic batch key/nonce
    // from the fixed resourceId + seq (the persisted ledger + the deterministic key are
    // the recovery seam) - no prior accrual in THIS instance is required.
    const key = this.batchKey(seq);
    const batchIdemKey = this.batchIdemKey(seq);
    const pending = await this.opts.ledger.getPending(key);

    // IDEMPOTENT RE-FLUSH: if this batch already settled (a re-flush after the ledger
    // entry was consumed, or a crash after settle persisted but before this returned),
    // the result-cache holds the receipt by the DETERMINISTIC batchIdemKey. Return it
    // with NO second debit - the buyer is never re-signed. This is the same short-circuit
    // settle() applies; checking it here lets a re-flush succeed even once the pending
    // entry is gone.
    const cached = await this.opts.deps.resultStore.get(batchIdemKey);
    if (cached) {
      const cachedReceipt = cached.receipt as Receipt;
      return {
        batchSeq: seq,
        batchAmount: BigInt(cachedReceipt.amount),
        reconciliation: pending
          ? reconcileBatch(pending)
          : { creatorLeg: 0n, treasuryLeg: 0n, carriedRemainder: 0n },
        receipt: cachedReceipt,
      };
    }

    if (!pending || pending.accruedTotal === 0n) return null;

    const reconciliation = reconcileBatch(pending);
    const batchAmount = pending.accruedTotal + pending.carriedRemainderIn;

    // Build the buyer's batch authorization (the route's seam) and route ONE settle()
    // through the existing exactly-once money guard. settle() applies the result-cache
    // short-circuit, the clamp min(batchAmount, cap), the NonceUsed rebuild, and
    // persist-before-respond - we never fork that path.
    const { payment } = await this.opts.buildBatchPayment(batchIdemKey, batchAmount);
    const receipt = await settle(payment, batchAmount, batchIdemKey, this.opts.deps, {
      response: "",
    });

    // Mark flushed ONLY after settle() persisted the receipt: a crash before this point
    // re-flushes idempotently (same batchIdemKey short-circuits via the result-cache).
    // Advance the open batch and carry the sub-unit remainder into the next window.
    const nextSeq = seq + 1;
    await this.opts.ledger.markFlushed(
      key,
      this.batchKey(nextSeq),
      reconciliation.carriedRemainder,
    );
    if (seq === this.batchSeq) {
      this.batchSeq = nextSeq;
      this.windowStart = null;
    }

    return { batchSeq: seq, batchAmount, reconciliation, receipt };
  }
}
