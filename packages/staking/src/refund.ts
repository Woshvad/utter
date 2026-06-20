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

/** Injected clients for {@link executeRefund}. */
export interface RefundDeps {
  /** The admin wallet (Ownable owner) that submits each refund. Operator-gated key. */
  admin: AdminWriter;
  /** The read-path client for the insurancePoolBalance bound. */
  publicClient: PoolReader;
}

/** The outcome of an {@link executeRefund} batch. */
export interface RefundResult {
  /** The buyers refunded, in order. */
  refunded: AffectedBuyer[];
  /** The aggregate refunded in USDC base units. */
  totalRefunded: bigint;
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
    return { refunded: [], totalRefunded: 0n };
  }

  const total = affected.reduce((sum, a) => sum + a.amount, 0n);

  // Bound the aggregate by the on-chain pool BEFORE any write (over-refund refused).
  const poolBalance = await deps.publicClient.readContract({
    address: STAKING_VAULT,
    abi: stakingVaultAbi,
    functionName: "insurancePoolBalance",
    args: [],
  });
  if (total > poolBalance) {
    throw new Error(
      `executeRefund: aggregate refund ${total} exceeds insurance pool balance ${poolBalance} (over-refund refused)`,
    );
  }

  for (const buyer of affected) {
    await deps.admin.writeContract({
      address: STAKING_VAULT,
      abi: stakingVaultAbi,
      functionName: "refund",
      args: [buyer.payer, buyer.amount],
    });
  }

  return { refunded: affected, totalRefunded: total };
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
