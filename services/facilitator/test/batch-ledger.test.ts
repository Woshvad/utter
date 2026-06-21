// batch-ledger suite (SCL-02): the persisted pending-accrual store under BatchSettler.
//
// The BatchLedger accumulates exact USDC base-unit legs per (resource, payee-leg)
// and carries the sub-unit split remainder forward (PERSISTED) so the reconciliation
// invariant holds across sequential batches and survives a restart. It mirrors the
// stores/memory.ts in-memory-default + persistence-seam shape (a THIRD store).
//
// The split is the SAME the on-chain PaymentEscrow.debit computes:
//   toCreator = amount * creatorBps / 10000n   (floor), remainder -> treasury.
// We reconcile to that split, never re-derive a different one. All amounts are
// bigint base-units; NO 6/1e6/10**6 decimals literal lives in batch-ledger.ts.
//
// Fully offline: pure in-memory store, no chain, no RPC.
import { describe, it, expect, beforeEach } from "vitest";
import {
  InMemoryBatchLedger,
  splitDebit,
  reconcileBatch,
  type BatchLedgerStore,
} from "../src/batch-ledger";

const RESOURCE = "0x" + "a1".repeat(32);
const CREATOR_BPS = 7000n; // the canonical 70/30 split (creator 70%, treasury 30%)

/** The expected canonical split of a single debit (mirrors PaymentEscrow.debit). */
function expectedSplit(amount: bigint): { toCreator: bigint; toTreasury: bigint } {
  const toCreator = (amount * CREATOR_BPS) / 10000n;
  return { toCreator, toTreasury: amount - toCreator };
}

describe("splitDebit (the canonical PaymentEscrow split, reconciled not re-derived)", () => {
  it("computes toCreator = amount * creatorBps / 10000n with remainder to treasury", () => {
    const amount = 12_345n;
    const { toCreator, toTreasury } = splitDebit(amount, CREATOR_BPS);
    expect(toCreator).toBe((amount * CREATOR_BPS) / 10000n);
    expect(toTreasury).toBe(amount - toCreator);
    // The two legs always sum back to the whole amount (no leakage at the single-debit level).
    expect(toCreator + toTreasury).toBe(amount);
  });
});

describe("InMemoryBatchLedger accrual + reconciliation", () => {
  let ledger: BatchLedgerStore;

  beforeEach(() => {
    ledger = new InMemoryBatchLedger();
  });

  it("accrues d1,d2,d3 as exact base-units; the running sum equals d1+d2+d3 (bigint, no float)", async () => {
    const key = `${RESOURCE}:batch-0`;
    const debits = [3n, 5n, 7n];
    let running = 0n;
    for (const d of debits) {
      running = await ledger.accrue(key, d, CREATOR_BPS);
    }
    expect(running).toBe(3n + 5n + 7n);
    const pending = await ledger.getPending(key);
    expect(pending).not.toBeNull();
    expect(pending!.accruedTotal).toBe(15n);
  });

  it("reconciliation invariant: creatorLeg + treasuryLeg + carriedRemainder == sum(individual debits)", async () => {
    const key = `${RESOURCE}:batch-1`;
    // Debits whose batch-level split leaves a genuine sub-unit remainder: sum=5,
    // creator = floor(5*7000/10000)=3, treasury = floor(5*3000/10000)=1, dust=1 carried.
    const tricky = [1n, 1n, 1n, 1n, 1n];
    let sum = 0n;
    for (const d of tricky) {
      await ledger.accrue(key, d, CREATOR_BPS);
      sum += d;
    }
    const pending = await ledger.getPending(key);
    expect(pending).not.toBeNull();
    const { creatorLeg, treasuryLeg, carriedRemainder } = reconcileBatch(pending!);
    // THE invariant: the two settled legs + the carried dust reconcile to the whole.
    expect(creatorLeg + treasuryLeg + carriedRemainder).toBe(sum);
    // The split is the canonical batch-level PaymentEscrow split (not re-derived).
    expect(creatorLeg).toBe((sum * CREATOR_BPS) / 10000n);
    expect(treasuryLeg).toBe((sum * (10000n - CREATOR_BPS)) / 10000n);
    // A real sub-unit remainder exists here and is carried (not floored away).
    expect(carriedRemainder).toBe(1n);
    // A single-debit split still partitions cleanly via the precedent helper.
    const s = expectedSplit(7n);
    expect(s.toCreator + s.toTreasury).toBe(7n);
  });

  it("carries the sub-unit remainder from batch K into batch K+1 (never dropped, never double-counted)", async () => {
    // Batch K: five 1-unit debits. Per-debit creator floor = 0 each; the lost creator
    // sub-units (5 * 0.7 = 3.5 -> 3 whole + 0.5 carry) are carried, NOT given to treasury here.
    const keyK = `${RESOURCE}:batch-K`;
    const keyK1 = `${RESOURCE}:batch-K+1`;
    const batchK = [1n, 1n, 1n, 1n, 1n];
    let sumK = 0n;
    for (const d of batchK) {
      await ledger.accrue(keyK, d, CREATOR_BPS);
      sumK += d;
    }
    const pendingK = await ledger.getPending(keyK);
    const reconK = reconcileBatch(pendingK!);
    expect(reconK.creatorLeg + reconK.treasuryLeg + reconK.carriedRemainder).toBe(sumK);

    // Flush K, carrying its remainder forward into K+1.
    await ledger.markFlushed(keyK, keyK1, reconK.carriedRemainder);
    // After flush, batch K's pending entry is consumed.
    expect(await ledger.getPending(keyK)).toBeNull();

    // Batch K+1 starts seeded with the carried remainder.
    const seeded = await ledger.getPending(keyK1);
    expect(seeded).not.toBeNull();
    expect(seeded!.carriedRemainderIn).toBe(reconK.carriedRemainder);

    const batchK1 = [1n, 1n, 1n];
    let sumK1 = 0n;
    for (const d of batchK1) {
      await ledger.accrue(keyK1, d, CREATOR_BPS);
      sumK1 += d;
    }
    const pendingK1 = await ledger.getPending(keyK1);
    const reconK1 = reconcileBatch(pendingK1!);
    // CUMULATIVE reconciliation across both batches: the carried-in remainder is added,
    // never double-counted. Total settled value across K and K+1 equals total debits.
    const totalSettled =
      reconK.creatorLeg +
      reconK.treasuryLeg +
      reconK1.creatorLeg +
      reconK1.treasuryLeg +
      reconK1.carriedRemainder;
    expect(totalSettled).toBe(sumK + sumK1);
  });

  it("is restart-safe: re-reading a persisted pending entry after a simulated restart returns the same accrued legs + carry", async () => {
    const key = `${RESOURCE}:batch-restart`;
    await ledger.accrue(key, 1n, CREATOR_BPS);
    await ledger.accrue(key, 1n, CREATOR_BPS);
    await ledger.accrue(key, 1n, CREATOR_BPS);
    const before = await ledger.getPending(key);
    expect(before).not.toBeNull();

    // Simulate a process restart: serialize the durable snapshot, rebuild a fresh store
    // from it (the persistence seam survives — no in-process state relied upon).
    const snapshot = (ledger as InMemoryBatchLedger).snapshot();
    const restarted = InMemoryBatchLedger.fromSnapshot(snapshot);

    const after = await restarted.getPending(key);
    expect(after).not.toBeNull();
    expect(after!.accruedTotal).toBe(before!.accruedTotal);
    expect(after!.creatorAccrued).toBe(before!.creatorAccrued);
    expect(after!.treasuryAccrued).toBe(before!.treasuryAccrued);
    expect(after!.carriedRemainderIn).toBe(before!.carriedRemainderIn);
    // The reconciliation invariant still holds on the restarted store (no lost debit).
    const recon = reconcileBatch(after!);
    expect(recon.creatorLeg + recon.treasuryLeg + recon.carriedRemainder).toBe(
      before!.accruedTotal + before!.carriedRemainderIn,
    );
  });
});
