// batch-ledger.ts (SCL-02) - the persisted pending-accrual store under the
// BatchSettler. It accumulates exact USDC base-unit legs per (resource, payee-leg)
// so the reconciliation invariant holds across sequential batches and survives a
// process restart.
//
// THE SPLIT IS NOT RE-DERIVED. It is the SAME split the on-chain PaymentEscrow.debit
// computes (contracts/src/PaymentEscrow.sol ~line 189):
//   toCreator = (amount * creatorBps) / BPS_DENOMINATOR   (integer floor)
//   toTreasury = amount - toCreator                       (remainder to treasury)
// We reconcile a batch to that split; we never invent a different one. The off-chain
// precedent is packages/buyer-sdk/test/client.test.ts ((amount * 7000n) / 10000n).
//
// NO PHANTOM CARRY (CR-03 fix / RESEARCH Pattern 3 / Pitfall 3): the batch flushes
// with ONE on-chain PaymentEscrow.debit(batchAmount), and that contract call splits
// `toCreator = floor(batchAmount * creatorBps / 10000)` then `toTreasury = batchAmount
// - toCreator` (the treasury gets the WHOLE remainder; there is NO second floor and NO
// sub-unit withheld). Reconciliation MUST mirror that EXACTLY: the treasury leg is the
// remainder `settleAmount - creatorLeg`, never an independent second floor. The two
// legs therefore always sum to the settled amount and there is NO genuine sub-unit to
// carry: batchCreatorLeg + batchTreasuryLeg == settleAmount == sum(debits).
// The earlier model floored BOTH legs and carried the leftover dust forward; that
// carry was FICTION - the contract already paid that dust to the treasury this batch -
// and carrying it inflated the NEXT batch's on-chain debit, over-charging the buyer
// across the batch boundary (off-ledger value leak). With the contract-faithful split,
// carriedRemainder is always 0n and markFlushed seeds nothing into the next window.
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

/** The reconciled legs of a batch (matching the single on-chain debit's split). */
export interface BatchReconciliation {
  /** The creator leg the batch debit pays: floor(settleAmount * creatorBps / 10000). */
  creatorLeg: bigint;
  /** The treasury leg the batch debit pays: settleAmount - creatorLeg (the remainder). */
  treasuryLeg: bigint;
  /**
   * Always 0n (CR-03): the on-chain debit(batchAmount) routes the whole remainder to
   * the treasury this batch, so NO sub-unit is withheld and nothing is carried forward.
   * Retained in the shape for the markFlushed seam (which now seeds nothing) and the
   * BatchFlushResult contract; a non-zero value here would be phantom over-credit.
   */
  carriedRemainder: bigint;
}

/**
 * Reconcile a pending batch to the canonical on-chain split. The invariant the tests
 * assert directly is the one that governs the SETTLED funds:
 *   creatorLeg + treasuryLeg == settleAmount == sum(individual debits)
 *                            == accruedTotal + carriedRemainderIn
 *
 * The split is computed at BATCH granularity EXACTLY as PaymentEscrow.debit computes
 * it on the single `debit(batchAmount)` this batch submits:
 *   creatorLeg  = floor(settleAmount * creatorBps / 10000)
 *   treasuryLeg = settleAmount - creatorLeg            (the WHOLE remainder; CR-03)
 * The treasury leg is the remainder, NOT a second independent floor, so the two legs
 * always sum to the settled amount and there is NO sub-unit to carry. Settling the
 * whole window once already recovers the per-debit rounding leakage; the contract pays
 * every base unit out this batch, so `carriedRemainder` is always 0n. (Double-flooring
 * the treasury leg and carrying the leftover forward was the CR-03 defect: that carry
 * was phantom value the contract had already settled, and it inflated the next batch's
 * debit, over-charging the buyer across the batch boundary.)
 */
export function reconcileBatch(pending: PendingBatch): BatchReconciliation {
  const settleAmount = pending.accruedTotal + pending.carriedRemainderIn;
  // The canonical PaymentEscrow.debit split, applied once at batch granularity:
  // floor the creator share, route the WHOLE remainder to the treasury (CR-03) so the
  // two legs sum to settleAmount exactly as the on-chain debit(batchAmount) does.
  const creatorLeg = (settleAmount * pending.creatorBps) / BPS_DENOMINATOR;
  const treasuryLeg = settleAmount - creatorLeg; // matches PaymentEscrow.debit
  // No sub-unit is withheld on-chain, so nothing is carried forward.
  return { creatorLeg, treasuryLeg, carriedRemainder: 0n };
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
