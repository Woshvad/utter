// refund.ts - insurance refund accounting (STK-03) + the honest-creator withdrawBond
// passthrough (PLAN-CHECK W-1).
//
// REFUND (STK-03): affected-buyer identification is OFF-CHAIN and deterministic. Given
// the settled payments for a resource and the failure window [first of the 5
// consecutive failing probes, deactivation] (Open Q3 boundary, inclusive both ends),
// identifyAffectedBuyers returns the payer + settled amount per buyer. executeRefund
// reads insurancePoolBalance and REFUSES the whole batch BEFORE any write if the
// aggregate refund would exceed the pool (mirrors the on-chain OverRefund guard,
// StakingVault.sol:200), then drives StakingVault.refund(payer, amount) per buyer
// through the injected admin client. Live broadcast is OPERATOR-GATED.
//
// WITHDRAW (W-1): withdrawBond.request/finalize are thin passthroughs over
// StakingVault.requestWithdraw / withdraw so an honest creator can withdraw a bond
// after the on-chain COOLDOWN. This gives STK-03's withdraw half an explicit off-chain
// seam symmetric with the refund path. The COOLDOWN / NotBondOwner / NothingToWithdraw
// guards live on-chain (StakingVault.sol:154-189); this passthrough simply submits the
// two txs through the injected admin client.
//
// DECIMALS DISCIPLINE (Pitfall 3): all amounts are USDC base units (bigint) read/
// summed in base-unit space. No 6/1e6 scaling literal appears in this module.
import { STAKING_VAULT, stakingVaultAbi } from "@utter/chain";
import type { AdminWriter } from "./slash.js";

/**
 * A settled payment row from the payments table, as the off-chain affected-buyer
 * query reads it. `amount` and `settledAt` are the refund driver + the window
 * selector. `amount` is USDC base units (bigint). `settledAt` is a comparable epoch.
 */
export interface SettledPayment {
  /** The resource the payment was for (matched against the failing resource). */
  resourceId: `0x${string}` | string;
  /** The buyer to reimburse. */
  payer: `0x${string}`;
  /** The settled amount in USDC base units (the refund amount per payer). */
  amount: bigint;
  /** The settlement time, compared against the failure window (inclusive). */
  settledAt: number;
  /** The payment status; only `settled` rows are refundable. */
  status: "settled" | "pending" | "failed" | string;
}

/** The failure window [from, to], both inclusive, that scopes the refund. */
export interface FailureWindow {
  /** The settledAt at/after which a payment is affected (first-of-5-failing-probes). */
  from: number;
  /** The settledAt at/before which a payment is affected (deactivation). */
  to: number;
}

/** One affected buyer + the base-unit amount owed back. */
export interface AffectedBuyer {
  payer: `0x${string}`;
  amount: bigint;
}

/**
 * Select the settled payments for `resourceId` inside the failure window and return
 * the per-payer refund amounts. Pure: no I/O. A payment is affected iff its
 * resourceId matches, its status is `settled`, and its settledAt is within
 * [window.from, window.to] (both inclusive, Open Q3).
 */
export function identifyAffectedBuyers(
  payments: readonly SettledPayment[],
  resourceId: `0x${string}` | string,
  window: FailureWindow,
): AffectedBuyer[] {
  return payments
    .filter(
      (p) =>
        p.resourceId === resourceId &&
        p.status === "settled" &&
        p.settledAt >= window.from &&
        p.settledAt <= window.to,
    )
    .map((p) => ({ payer: p.payer, amount: p.amount }));
}

/**
 * The minimal pool-balance read surface (insurancePoolBalance view). Matches viem's
 * `PublicClient.readContract`; the test injects a spy, prod injects the Arc public
 * client. This is the ONLY chain read the refund path performs (the over-refund bound).
 */
export interface PoolReader {
  readContract(args: {
    address: `0x${string}`;
    abi: typeof stakingVaultAbi;
    functionName: "insurancePoolBalance";
    args: readonly [];
  }): Promise<bigint>;
}

/**
 * The per-buyer refund idempotency store (mirrors the facilitator's exactly-once
 * `(idemKey -> result)` store, services/facilitator/src/settle.ts). It records which
 * buyers have already been refunded for a given `(resourceId, failureWindow)` batch so
 * a retry after a mid-batch revert SKIPS the already-paid buyers and resumes only the
 * unpaid remainder - the on-chain `StakingVault.refund` has no replay guard, so the
 * double-pay defense lives here. The InMemory adapter is the test default; the real
 * Postgres/Redis adapter (SPEC §10) implements the same contract so the live refund
 * path swaps adapters by env without change.
 */
export interface RefundIdempotencyStore {
  /** True iff this buyer was already refunded for this `(resourceId, window)` batch. */
  isRefunded(idemKey: string, payer: `0x${string}`): Promise<boolean>;
  /** Mark this buyer refunded for this `(resourceId, window)` batch (the tx hash). */
  markRefunded(idemKey: string, payer: `0x${string}`, txHash: `0x${string}`): Promise<void>;
}

/** The in-memory refund idempotency store (autonomous test default). */
export class InMemoryRefundIdempotencyStore implements RefundIdempotencyStore {
  private readonly done = new Map<string, `0x${string}`>();

  private key(idemKey: string, payer: `0x${string}`): string {
    return `${idemKey}::${payer.toLowerCase()}`;
  }

  async isRefunded(idemKey: string, payer: `0x${string}`): Promise<boolean> {
    return this.done.has(this.key(idemKey, payer));
  }

  async markRefunded(
    idemKey: string,
    payer: `0x${string}`,
    txHash: `0x${string}`,
  ): Promise<void> {
    this.done.set(this.key(idemKey, payer), txHash);
  }
}

/**
 * Derive the deterministic refund batch idempotency key for a `(resourceId, window)`.
 * The same failing resource + failure window always produces the SAME key, so a retry
 * re-uses the per-buyer completion records from the first attempt. The off-chain
 * affected-buyer query is deterministic over the same window, so the same buyer list
 * is reproduced and the already-refunded buyers are skipped.
 */
export function refundBatchIdemKey(
  resourceId: `0x${string}` | string,
  window: FailureWindow,
): string {
  return `refund:${resourceId}:${window.from}-${window.to}`;
}

/** Injected clients for {@link executeRefund}. */
export interface RefundDeps {
  /** The admin wallet (Ownable owner) that submits each refund. Operator-gated key. */
  admin: AdminWriter;
  /** The read-path client for the insurancePoolBalance bound. */
  publicClient: PoolReader;
  /**
   * Per-buyer refund idempotency store. When provided, a buyer already refunded for
   * this `(resourceId, window)` batch is SKIPPED on a retry - never paid twice. Omit
   * for a fresh in-memory store (a single-process batch with no retry recovery).
   */
  idempotencyStore?: RefundIdempotencyStore;
}

/** The outcome of an {@link executeRefund} batch. */
export interface RefundResult {
  /** The buyers refunded in THIS call (excludes buyers already refunded on a prior try). */
  refunded: AffectedBuyer[];
  /** The aggregate refunded in THIS call in USDC base units. */
  totalRefunded: bigint;
  /** The buyers SKIPPED because a prior attempt already refunded them (idempotency). */
  skipped: AffectedBuyer[];
}

/**
 * Refund the affected buyers for a failing resource from the insurance pool. Reads
 * insurancePoolBalance and REFUSES the whole batch BEFORE any write if the aggregate
 * exceeds the pool (over-refund guard, mirrors StakingVault.OverRefund). Then drives
 * StakingVault.refund(payer, amount) per buyer through the injected admin client.
 * Live broadcast is operator-gated.
 *
 * @throws if the aggregate refund exceeds the on-chain insurance pool balance.
 */
export async function executeRefund(
  deps: RefundDeps,
  payments: readonly SettledPayment[],
  resourceId: `0x${string}` | string,
  window: FailureWindow,
): Promise<RefundResult> {
  const affected = identifyAffectedBuyers(payments, resourceId, window);

  // Nothing to do: no read, no write.
  if (affected.length === 0) {
    return { refunded: [], totalRefunded: 0n, skipped: [] };
  }

  // IDEMPOTENCY (mirrors the facilitator (idemKey -> result) store): partition the
  // affected buyers into those a PRIOR attempt already refunded (skip - never re-pay)
  // and the unpaid remainder this call must refund. A retry after a mid-batch revert
  // resumes from the remainder; buyers 1..i are not paid a second time. With no store
  // injected, a fresh in-memory store is used (single-process batch, no cross-retry
  // recovery), so the unconditional behavior is unchanged for the non-retry path.
  const idempotencyStore: RefundIdempotencyStore =
    deps.idempotencyStore ?? new InMemoryRefundIdempotencyStore();
  const idemKey = refundBatchIdemKey(resourceId, window);

  const skipped: AffectedBuyer[] = [];
  const pending: AffectedBuyer[] = [];
  for (const buyer of affected) {
    if (await idempotencyStore.isRefunded(idemKey, buyer.payer)) {
      skipped.push(buyer);
    } else {
      pending.push(buyer);
    }
  }

  // Nothing left to refund: every affected buyer was already paid on a prior attempt.
  if (pending.length === 0) {
    return { refunded: [], totalRefunded: 0n, skipped };
  }

  // Bound the REMAINING aggregate (the unpaid buyers only) by the on-chain pool BEFORE
  // any write (over-refund refused). On a retry the pool has already shrunk by the
  // buyers paid in the prior attempt, so bounding the remainder - not the full batch -
  // is the correct mirror of the on-chain OverRefund guard.
  const remaining = pending.reduce((sum, a) => sum + a.amount, 0n);
  const poolBalance = await deps.publicClient.readContract({
    address: STAKING_VAULT,
    abi: stakingVaultAbi,
    functionName: "insurancePoolBalance",
    args: [],
  });
  if (remaining > poolBalance) {
    throw new Error(
      `executeRefund: remaining refund ${remaining} exceeds insurance pool balance ${poolBalance} (over-refund refused)`,
    );
  }

  const refunded: AffectedBuyer[] = [];
  for (const buyer of pending) {
    // Write THEN mark: a revert throws before markRefunded, so a buyer is recorded
    // ONLY after its refund tx is broadcast. A retry then skips the recorded buyers
    // and re-runs only the one that reverted plus the unstarted remainder.
    const txHash = await deps.admin.writeContract({
      address: STAKING_VAULT,
      abi: stakingVaultAbi,
      functionName: "refund",
      args: [buyer.payer, buyer.amount],
    });
    await idempotencyStore.markRefunded(idemKey, buyer.payer, txHash);
    refunded.push(buyer);
  }

  const totalRefunded = refunded.reduce((sum, a) => sum + a.amount, 0n);
  return { refunded, totalRefunded, skipped };
}

/** Injected client for the {@link withdrawBond} passthrough. */
export interface WithdrawDeps {
  /** The bond-owner wallet that submits requestWithdraw / withdraw. */
  admin: AdminWriter;
}

/**
 * The honest-creator bond-withdraw passthrough (W-1). `request` starts the on-chain
 * COOLDOWN via requestWithdraw; `finalize` transfers the bond out via withdraw once
 * the cooldown has elapsed. The COOLDOWN / NotBondOwner / NothingToWithdraw guards are
 * enforced on-chain (StakingVault.sol); this seam only submits the txs.
 */
export const withdrawBond = {
  /** Start the withdraw cooldown (StakingVault.requestWithdraw). Returns the tx hash. */
  async request(deps: WithdrawDeps, resourceId: `0x${string}`): Promise<`0x${string}`> {
    return deps.admin.writeContract({
      address: STAKING_VAULT,
      abi: stakingVaultAbi,
      functionName: "requestWithdraw",
      args: [resourceId],
    });
  },

  /** Finalize the withdraw after COOLDOWN (StakingVault.withdraw). Returns the tx hash. */
  async finalize(deps: WithdrawDeps, resourceId: `0x${string}`): Promise<`0x${string}`> {
    return deps.admin.writeContract({
      address: STAKING_VAULT,
      abi: stakingVaultAbi,
      functionName: "withdraw",
      args: [resourceId],
    });
  },
};
