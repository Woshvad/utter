// slash.ts - the slash trigger (STK-02). It consumes a BondSlashReview raised by
// the ai-scorer's pure 5-CONSECUTIVE-failure reducer and drives the on-chain
// takedown spend through the INJECTED admin walletClient, mirroring the facilitator
// write path (services/facilitator/src/settle.ts simulate->write->waitForReceipt).
//
// LOAD-BEARING (Pitfall 7, confirmed in StakingVault.sol:130-137 +
// ResourceRegistry.sol NatSpec): `slashAuthorization` is an ADVISORY indexer event
// ONLY. The two contracts share NO on-chain state. triggerSlash therefore:
//   1. emits ResourceRegistry.slashAuthorization(resourceId, amount, reason) as the
//      advisory indexer signal, then
//   2. drives the REAL spend DIRECTLY via StakingVault.slash(resourceId, amount,
//      reason) with the ADMIN-supplied amount.
// It does NOT read back / reconcile the registry authorization between the two calls
// - the admin amount is authoritative. Wiring a reconcile read here would be the
// exact regression Pitfall 7 warns against.
//
// The slash is reachable ONLY from a STRIKE_LIMIT (5-consecutive-failure) review -
// the single trigger - so a healthy resource is never slashed. LIVE broadcast
// (slash/refund on Arc) is OPERATOR-GATED: the admin walletClient is constructed
// from a key in .env.local by the caller; this module never reads a key and the
// autonomous suite injects a mock client (no live broadcast).
import {
  STAKING_VAULT,
  RESOURCE_REGISTRY,
  stakingVaultAbi,
  registryAbi,
} from "@utter/chain";
import { STRIKE_LIMIT, type BondSlashReview } from "@utter/ai-scorer";

/**
 * The minimal admin write surface triggerSlash needs. Matches viem's
 * `WalletClient.writeContract` shape so the real Arc admin wallet (built from
 * REGISTRY_ADMIN_PRIVATE_KEY in .env.local) satisfies it, while the test injects a
 * spy. The admin is the StakingVault/ResourceRegistry Ownable owner (onlyOwner).
 */
export interface AdminWriter {
  writeContract(args: {
    address: `0x${string}`;
    abi: unknown;
    functionName: string;
    args: readonly unknown[];
  }): Promise<`0x${string}`>;
}

/**
 * The minimal read/wait surface for the receipt wait + the WR-04 bond pre-flight.
 *
 * The `readContract` here is used ONLY for the OFF-CHAIN PRE-FLIGHT bond read that
 * happens BEFORE BOTH writes (guarding the call, never deriving the spend amount).
 * It is deliberately NOT used to reconcile the slash amount between the advisory and
 * the real slash (Pitfall 7): triggerSlash performs NO read between the two writes -
 * the admin amount is authoritative. Receipt waits keep the call ordering observable
 * for the operator audit. Optional - the autonomous suite injects a stub.
 */
export interface SlashPublicClient {
  waitForTransactionReceipt?(args: { hash: `0x${string}` }): Promise<unknown>;
  /**
   * Read the current on-chain bond for the resource (StakingVault.bonds). Used by the
   * WR-04 pre-flight ONLY (before any write), to refuse an over-bond slash that would
   * revert on-chain after the advisory event is already mined. Optional - when absent
   * the pre-flight is skipped (the on-chain SlashExceedsBond guard still applies).
   */
  readContract?(args: {
    address: `0x${string}`;
    abi: unknown;
    functionName: "bonds";
    args: readonly [`0x${string}`];
  }): Promise<bigint>;
}

/** Injected clients for {@link triggerSlash}. */
export interface SlashDeps {
  /** The admin wallet (Ownable owner) that submits both writes. Operator-gated key. */
  admin: AdminWriter;
  /** Optional public client for receipt waits (never used to reconcile the amount). */
  publicClient?: SlashPublicClient;
}

/** The two tx hashes a slash produces, for the indexer / operator audit trail. */
export interface SlashResult {
  /** The advisory ResourceRegistry.slashAuthorization tx (indexer signal). */
  slashAuthorizationTx: `0x${string}`;
  /** The real StakingVault.slash tx (the spend). */
  slashTx: `0x${string}`;
}

/**
 * Drive a bond slash from a verified 5-strike review. Emits the advisory
 * slashAuthorization indexer signal, then drives StakingVault.slash directly with the
 * admin-supplied `amount` (USDC base units). Returns both tx hashes.
 *
 * Guards (defend the real spend BEFORE any write):
 * - `amount` must be > 0 (a zero/negative slash is refused).
 * - the review must have reached `STRIKE_LIMIT` consecutive failures (the only
 *   trigger) - a sub-limit review is refused.
 *
 * @throws if the amount is non-positive or the review did not reach the strike limit.
 */
export async function triggerSlash(
  deps: SlashDeps,
  review: BondSlashReview,
  amount: bigint,
): Promise<SlashResult> {
  // Guard the real spend BEFORE any on-chain write.
  if (amount <= 0n) {
    throw new Error("triggerSlash: slash amount must be a positive bigint (base units)");
  }
  if (review.consecutiveFailures < STRIKE_LIMIT) {
    throw new Error(
      `triggerSlash: review did not reach the strike limit (${review.consecutiveFailures} < ${STRIKE_LIMIT}); slash refused`,
    );
  }

  const resourceId = review.resourceId as `0x${string}`;
  const reason = review.reason;

  // WR-04 PRE-FLIGHT: read the current bond and refuse an over-bond slash BEFORE
  // broadcasting ANYTHING. A slash with amount > bonds[resourceId] reverts on-chain
  // (SlashExceedsBond) AFTER the advisory event is already mined - leaving the indexer
  // a dangling "slash authorized" with no Slashed event. Catching it here means no
  // advisory is ever emitted for a slash that cannot land. This read happens BEFORE
  // BOTH writes (not between them), so Pitfall 7 is intact: the admin amount is still
  // authoritative for the spend; the read only GUARDS the call, never derives it.
  if (deps.publicClient?.readContract) {
    const bond = await deps.publicClient.readContract({
      address: STAKING_VAULT,
      abi: stakingVaultAbi,
      functionName: "bonds",
      args: [resourceId],
    });
    if (amount > bond) {
      throw new Error(
        `triggerSlash: slash amount ${amount} exceeds current bond ${bond} (would revert; refused before any write)`,
      );
    }
  }

  // Step 1: the ADVISORY indexer signal. Separate contract, shares NO state with the
  // vault (Pitfall 7). The amount/reason mirror the spend for a consistent indexer
  // record - but the vault never consumes this event.
  const slashAuthorizationTx = await deps.admin.writeContract({
    address: RESOURCE_REGISTRY,
    abi: registryAbi,
    functionName: "slashAuthorization",
    args: [resourceId, amount, reason],
  });
  if (deps.publicClient?.waitForTransactionReceipt) {
    await deps.publicClient.waitForTransactionReceipt({ hash: slashAuthorizationTx });
  }

  // Step 2: the REAL spend, driven DIRECTLY with the admin amount. No reconcile read
  // against the registry authorization happens between the two writes.
  const slashTx = await deps.admin.writeContract({
    address: STAKING_VAULT,
    abi: stakingVaultAbi,
    functionName: "slash",
    args: [resourceId, amount, reason],
  });
  if (deps.publicClient?.waitForTransactionReceipt) {
    await deps.publicClient.waitForTransactionReceipt({ hash: slashTx });
  }

  return { slashAuthorizationTx, slashTx };
}
