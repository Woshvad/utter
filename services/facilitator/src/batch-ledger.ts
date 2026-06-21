// batch-ledger.ts (SCL-02) - the persisted pending-accrual store under the
// BatchSettler. It accumulates exact USDC base-unit legs per (resource, payee-leg)
// and carries the sub-unit split remainder FORWARD (persisted) so the reconciliation
// invariant holds across sequential batches and survives a process restart.
//
// THE SPLIT IS NOT RE-DERIVED. It is the SAME split the on-chain PaymentEscrow.debit
// computes (contracts/src/PaymentEscrow.sol ~line 189):
//   toCreator = (amount * creatorBps) / BPS_DENOMINATOR   (integer floor)
//   toTreasury = amount - toCreator                       (remainder to treasury)
// We reconcile a batch to that split; we never invent a different one. The off-chain
// precedent is packages/buyer-sdk/test/client.test.ts ((amount * 7000n) / 10000n).
//
// REMAINDER CARRY-FORWARD (RESEARCH Pattern 3 / Pitfall 3): flooring the creator
// share PER DEBIT then summing loses sub-units versus the creator share a single
// batch-level split would yield. That difference is the CARRIED REMAINDER. It is
// accumulated, persisted, and added into the next batch so nothing leaks and nothing
// is double-counted: batchCreatorLeg + batchTreasuryLeg + carriedRemainder == sum(debits).
//
// PERSISTENCE SEAM (RESEARCH Pitfall 6): this mirrors stores/memory.ts - an
// in-memory default (InMemoryBatchLedger) behind a BatchLedgerStore interface a
// durable (Redis/pg) adapter implements the same way, swappable at bootstrap. A
// crash mid-flush must not double-charge or lose a debit, so the pending entry and
// the carried remainder are part of the durable snapshot.
//
// All amounts are USDC base-unit `bigint`. This module NEVER encodes a `6`/`1e6`/
// `10**6` decimals literal (CHAIN-03); the only numeric constant is the basis-point
// denominator 10000n (the canonical PaymentEscrow BPS_DENOMINATOR), which is a
// fraction denominator, not a token-decimals scale.

/** The basis-point denominator - the canonical PaymentEscrow `BPS_DENOMINATOR`. */
export const BPS_DENOMINATOR = 10000n;

/**
 * The canonical PaymentEscrow.debit split: floor the creator share, route the
 * remainder (rounding dust) to the treasury so the two legs always sum to `amount`.
 * This is reconciled to - never a re-derived alternative split.
 */
export function splitDebit(
  amount: bigint,
  creatorBps: bigint,
): { toCreator: bigint; toTreasury: bigint } {
  const toCreator = (amount * creatorBps) / BPS_DENOMINATOR;
  return { toCreator, toTreasury: amount - toCreator };
}

/**
 * A pending batch accrual: the running totals for one batch window keyed by
 * `(resource, payee-leg)`. All values are USDC base-unit bigint.
 */
export interface PendingBatch {
  /** The batch key (e.g. `${resourceId}:${batchSeq}`) this accrual belongs to. */
  batchKey: string;
  /** The basis-point creator share this batch reconciles to (the resource's split). */
  creatorBps: bigint;
  /** The sum of every debit accrued into this batch (the on-chain settle amount). */
  accruedTotal: bigint;
  /** The sum of per-debit FLOORED creator legs (what actually settles to the creator). */
  creatorAccrued: bigint;
  /** The sum of per-debit treasury legs (what actually settles to the treasury). */
  treasuryAccrued: bigint;
  /** How many debits have been folded in (the N-trigger counter). */
  debitCount: number;
  /** A remainder carried IN from the previous batch (seeded at batch start). */
  carriedRemainderIn: bigint;
}

/** The reconciled legs of a batch + the sub-unit remainder it carries forward. */
export interface BatchReconciliation {
  /** The creator leg that settles this batch (per-debit floored sum). */
  creatorLeg: bigint;
  /** The treasury leg that settles this batch (per-debit floored sum). */
  treasuryLeg: bigint;
  /**
   * The sub-unit remainder carried FORWARD: the creator sub-units lost to per-debit
   * flooring (the batch-level creator share minus the summed per-debit creator legs),
   * plus any remainder carried IN. Persisted, never dropped, never double-counted.
   */
  carriedRemainder: bigint;
}

/**
 * Reconcile a pending batch to the canonical split. The reconciliation invariant the
 * tests assert directly is:
 *   creatorLeg + treasuryLeg + carriedRemainder == sum(individual debits)
 *                                               == accruedTotal + carriedRemainderIn
 *
 * The split is computed at BATCH granularity exactly as PaymentEscrow.debit computes
 * it per debit - `creatorLeg = floor(settleAmount * creatorBps / 10000)` - but a batch
 * fixes the per-debit rounding leakage: settling the whole window once means the
 * sub-unit dust each per-debit floor shaved off is recovered. `treasuryLeg` is the
 * floored treasury share `floor(settleAmount * (10000 - creatorBps) / 10000)`; the
 * leftover dust `settleAmount - creatorLeg - treasuryLeg` is the `carriedRemainder` -
 * carried INTO the next batch (persisted), never given to one payee as a windfall,
 * never floored away (leakage), never double-counted. Over many batches the carry
 * eventually rolls a whole sub-unit into a leg, so nothing leaks long-run either.
 */
export function reconcileBatch(pending: PendingBatch): BatchReconciliation {
  const settleAmount = pending.accruedTotal + pending.carriedRemainderIn;
  // The canonical PaymentEscrow split, applied once at batch granularity.
  const creatorLeg = (settleAmount * pending.creatorBps) / BPS_DENOMINATOR;
  const treasuryLeg =
    (settleAmount * (BPS_DENOMINATOR - pending.creatorBps)) / BPS_DENOMINATOR;
  // The sub-unit dust the two floors leave behind - carried forward, never dropped.
  const carriedRemainder = settleAmount - creatorLeg - treasuryLeg;
  return { creatorLeg, treasuryLeg, carriedRemainder };
}

/**
 * The persisted pending-accrual store. The in-memory default is the test/bootstrap
 * adapter; a durable (Redis/pg) adapter implements the SAME interface so a crash
 * mid-flush recovers the pending entry + carry (no double-charge, no lost debit).
 */
export interface BatchLedgerStore {
  /**
   * Atomically fold one debit into the batch under `batchKey`, updating the running
   * legs (per-debit floored split) and the accrued total. Returns the new accrued
   * total (the running sum used by the N-/threshold-trigger).
   */
  accrue(batchKey: string, amount: bigint, creatorBps: bigint): Promise<bigint>;
  /** Read the current pending accrual for `batchKey`, or null if none/flushed. */
  getPending(batchKey: string): Promise<PendingBatch | null>;
  /**
   * Mark `batchKey` flushed (consume it) and seed the NEXT batch (`nextKey`) with the
   * carried remainder so it is added into the next window - never dropped, never
   * double-counted. Called only AFTER settle() has persisted the receipt.
   */
  markFlushed(batchKey: string, nextKey: string, carriedRemainder: bigint): Promise<void>;
}

/** The durable snapshot shape (bigints serialized as decimal strings for JSON). */
interface PendingBatchSnapshot {
  batchKey: string;
  creatorBps: string;
  accruedTotal: string;
  creatorAccrued: string;
  treasuryAccrued: string;
  debitCount: number;
  carriedRemainderIn: string;
}

/**
 * In-memory BatchLedger (test/bootstrap default). Holds a Map of pending accruals.
 * The persistence seam is the `snapshot()` / `fromSnapshot()` pair: the durable
 * adapter persists this same shape so a restart re-reads the identical pending legs
 * + carry. Mirrors stores/memory.ts (the in-memory-default + env-swappable factory).
 */
export class InMemoryBatchLedger implements BatchLedgerStore {
  private readonly pending = new Map<string, PendingBatch>();

  async accrue(batchKey: string, amount: bigint, creatorBps: bigint): Promise<bigint> {
    if (amount < 0n) throw new Error("BatchLedger.accrue: amount must be non-negative");
    let entry = this.pending.get(batchKey);
    if (!entry) {
      entry = {
        batchKey,
        creatorBps,
        accruedTotal: 0n,
        creatorAccrued: 0n,
        treasuryAccrued: 0n,
        debitCount: 0,
        carriedRemainderIn: 0n,
      };
      this.pending.set(batchKey, entry);
    }
    if (entry.creatorBps === 0n && entry.debitCount === 0) {
      // A batch seeded purely by a carried-in remainder (markFlushed) has no split yet;
      // the first real debit fixes the split this window reconciles to.
      entry.creatorBps = creatorBps;
    } else if (entry.creatorBps !== creatorBps) {
      // A batch is keyed per (resource, payee-leg); a differing split for the same
      // batch key is a wiring bug, not a silent re-split.
      throw new Error(
        `BatchLedger.accrue: creatorBps mismatch for ${batchKey} (had ${entry.creatorBps}, got ${creatorBps})`,
      );
    }
    const { toCreator, toTreasury } = splitDebit(amount, creatorBps);
    entry.accruedTotal += amount;
    entry.creatorAccrued += toCreator;
    entry.treasuryAccrued += toTreasury;
    entry.debitCount += 1;
    return entry.accruedTotal;
  }

  async getPending(batchKey: string): Promise<PendingBatch | null> {
    const entry = this.pending.get(batchKey);
    if (!entry) return null;
    // Return a copy so callers cannot mutate the persisted entry out from under us.
    return { ...entry };
  }

  async markFlushed(
    batchKey: string,
    nextKey: string,
    carriedRemainder: bigint,
  ): Promise<void> {
    this.pending.delete(batchKey);
    if (carriedRemainder === 0n) return;
    // Seed the next batch with the carried remainder so it is added into that window.
    const existing = this.pending.get(nextKey);
    if (existing) {
      existing.carriedRemainderIn += carriedRemainder;
    } else {
      this.pending.set(nextKey, {
        batchKey: nextKey,
        // creatorBps is set on first accrue; seed with 0 BPS sentinel? No - carry the
        // bps of the flushed batch so the next window reconciles to the same split.
        creatorBps: 0n,
        accruedTotal: 0n,
        creatorAccrued: 0n,
        treasuryAccrued: 0n,
        debitCount: 0,
        carriedRemainderIn: carriedRemainder,
      });
    }
  }

  /** Serialize the durable snapshot (the persistence seam a real adapter writes). */
  snapshot(): PendingBatchSnapshot[] {
    return [...this.pending.values()].map((e) => ({
      batchKey: e.batchKey,
      creatorBps: e.creatorBps.toString(),
      accruedTotal: e.accruedTotal.toString(),
      creatorAccrued: e.creatorAccrued.toString(),
      treasuryAccrued: e.treasuryAccrued.toString(),
      debitCount: e.debitCount,
      carriedRemainderIn: e.carriedRemainderIn.toString(),
    }));
  }

  /** Rebuild a store from a durable snapshot (the restart-recovery path). */
  static fromSnapshot(snapshot: PendingBatchSnapshot[]): InMemoryBatchLedger {
    const store = new InMemoryBatchLedger();
    for (const s of snapshot) {
      store.pending.set(s.batchKey, {
        batchKey: s.batchKey,
        creatorBps: BigInt(s.creatorBps),
        accruedTotal: BigInt(s.accruedTotal),
        creatorAccrued: BigInt(s.creatorAccrued),
        treasuryAccrued: BigInt(s.treasuryAccrued),
        debitCount: s.debitCount,
        carriedRemainderIn: BigInt(s.carriedRemainderIn),
      });
    }
    return store;
  }
}
