// slash.ts - the slash driver (STK-02). It consumes a BondSlashReview raised by
// the ai-scorer's pure 5-CONSECUTIVE-failure reducer and drives the on-chain
// takedown spend through the INJECTED admin walletClient, mirroring the facilitator
// write path (services/facilitator/src/settle.ts simulate->write->waitForReceipt).
//
// ON-CHAIN COUPLING (confirmed in ResourceRegistry.sol + StakingVault.sol): the
// slash is COUPLED across the two contracts on chain, not advisory-and-decoupled.
// ResourceRegistry.slashAuthorization records a single-use PendingSlash with a
// 1-day dispute window (SLASH_DISPUTE_WINDOW); the recorded {amount, executableAt}
// is readable via getPendingSlash. StakingVault.slash, before touching the bond,
// calls registry.consumeSlashAuthorization, which REVERTS SlashWindowActive until
// block.timestamp >= executableAt, SlashAmountMismatch unless the amount matches
// the recorded one exactly, and NoPendingSlash if none is recorded. So a single
// back-to-back authorize-then-slash always reverts during the dispute window.
//
// The driver therefore splits into two steps the operator runs at least a day
// apart:
//   1. recordSlashAuthorization: records the registry authorization (starts the
//      dispute window). No vault write here.
//   2. executeMaturedSlash: FIRST reads the pending slash via the public client and
//      only calls StakingVault.slash once chain time has reached executableAt AND
//      the recorded amount matches; otherwise it returns a "not yet matured" result
//      WITHOUT broadcasting, so a premature run never burns a reverting tx.
//
// During the window DEFAULT_ADMIN may cancelSlashAuthorization on the registry to
// dispute the slash; the vault then can never consume it.
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
 * The minimal admin write surface the slash steps need. Matches viem's
 * `WalletClient.writeContract` shape so the real Arc admin wallet (built from
 * REGISTRY_ADMIN_PRIVATE_KEY in .env.local) satisfies it, while the test injects a
 * spy. The admin holds SLASHER_ROLE on both the registry and the vault.
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
 * The minimal read/wait surface the slash steps need.
 *
 * `readContract` serves two reads, both BEFORE any vault write: the WR-04 bond
 * pre-flight (functionName "bonds") that refuses an over-bond slash, and the
 * maturity read (functionName "getPendingSlash") that executeMaturedSlash uses to
 * decide whether the registry authorization is consumable yet. The maturity read
 * is REQUIRED by executeMaturedSlash so it never broadcasts a slash that would
 * revert SlashWindowActive / SlashAmountMismatch on chain. Receipt waits keep the
 * call ordering observable for the operator audit.
 */
export interface SlashPublicClient {
  waitForTransactionReceipt?(args: { hash: `0x${string}` }): Promise<unknown>;
  /**
   * Read the current on-chain bond for the resource (StakingVault.bonds) or the
   * pending slash authorization (ResourceRegistry.getPendingSlash). Both reads
   * happen BEFORE the vault write. The "bonds" read guards an over-bond slash; the
   * "getPendingSlash" read returns the recorded {amount, executableAt} so the
   * driver only consumes a matured, matching authorization.
   */
  readContract?(args: {
    address: `0x${string}`;
    abi: unknown;
    functionName: "bonds" | "getPendingSlash";
    args: readonly [`0x${string}`];
  }): Promise<unknown>;
}

/** Injected clients for the slash steps. */
export interface SlashDeps {
  /** The admin wallet (SLASHER_ROLE) that submits the writes. Operator-gated key. */
  admin: AdminWriter;
  /** Optional public client for receipt waits and the bond pre-flight. */
  publicClient?: SlashPublicClient;
}

/** The result of {@link recordSlashAuthorization}: the registry authorization tx. */
export interface RecordSlashResult {
  /** The ResourceRegistry.slashAuthorization tx that started the dispute window. */
  slashAuthorizationTx: `0x${string}`;
}

/**
 * The result of {@link executeMaturedSlash}. When `executed` is true the vault
 * slash was broadcast and `slashTx` is its hash. When false the authorization was
 * not yet consumable (window still active, no pending record, or the recorded
 * amount did not match) and NO tx was broadcast; `reason` says why.
 */
export type ExecuteSlashResult =
  | { executed: true; slashTx: `0x${string}` }
  | {
      executed: false;
      reason: "not-yet-matured" | "no-pending-authorization" | "amount-mismatch";
      /** The recorded amount on chain, when a pending authorization exists. */
      pendingAmount?: bigint;
      /** The timestamp the window elapses, when a pending authorization exists. */
      executableAt?: bigint;
    };

/**
 * STEP 1. Record the slash authorization on the registry from a verified 5-strike
 * review. This starts the 1-day dispute window; it does NOT touch the bond. The
 * vault slash runs later via {@link executeMaturedSlash} once the window elapses.
 *
 * Guards (defend the real spend BEFORE any write):
 * - `amount` must be > 0 (a zero/negative slash is refused; the registry also
 *   reverts ZeroSlashAmount).
 * - the review must have reached `STRIKE_LIMIT` consecutive failures (the only
 *   trigger) - a sub-limit review is refused.
 * - WR-04: when a public client with a bond read is provided, an amount exceeding
 *   the current bond is refused before recording, so no authorization is ever
 *   recorded for a slash that could never be consumed (it would revert
 *   SlashExceedsBond at consume time).
 *
 * @throws if the amount is non-positive, the review did not reach the strike limit,
 *   or the amount exceeds the current bond.
 */
export async function recordSlashAuthorization(
  deps: SlashDeps,
  review: BondSlashReview,
  amount: bigint,
): Promise<RecordSlashResult> {
  // Guard the real spend BEFORE any on-chain write.
  if (amount <= 0n) {
    throw new Error("recordSlashAuthorization: slash amount must be a positive bigint (base units)");
  }
  if (review.consecutiveFailures < STRIKE_LIMIT) {
    throw new Error(
      `recordSlashAuthorization: review did not reach the strike limit (${review.consecutiveFailures} < ${STRIKE_LIMIT}); slash refused`,
    );
  }

  const resourceId = review.resourceId as `0x${string}`;
  const reason = review.reason;

  // WR-04 PRE-FLIGHT: read the current bond and refuse an over-bond slash BEFORE
  // recording anything. A slash with amount > bonds[resourceId] reverts on-chain
  // (SlashExceedsBond) at consume time, so the recorded authorization could never
  // be consumed and would leave a dangling pending record for a day. Catching it
  // here means no authorization is ever recorded for a slash that cannot land.
  if (deps.publicClient?.readContract) {
    const bond = (await deps.publicClient.readContract({
      address: STAKING_VAULT,
      abi: stakingVaultAbi,
      functionName: "bonds",
      args: [resourceId],
    })) as bigint;
    if (amount > bond) {
      throw new Error(
        `recordSlashAuthorization: slash amount ${amount} exceeds current bond ${bond} (would revert; refused before any write)`,
      );
    }
  }

  const slashAuthorizationTx = await deps.admin.writeContract({
    address: RESOURCE_REGISTRY,
    abi: registryAbi,
    functionName: "slashAuthorization",
    args: [resourceId, amount, reason],
  });
  if (deps.publicClient?.waitForTransactionReceipt) {
    await deps.publicClient.waitForTransactionReceipt({ hash: slashAuthorizationTx });
  }

  return { slashAuthorizationTx };
}

/**
 * STEP 2. Execute the matured slash. FIRST reads the pending authorization via the
 * public client (ResourceRegistry.getPendingSlash) and only broadcasts
 * StakingVault.slash when chain time has reached executableAt AND the recorded
 * amount matches `amount`. Otherwise it returns `{ executed: false, ... }` WITHOUT
 * broadcasting, so a premature run never burns a tx that would revert
 * SlashWindowActive / SlashAmountMismatch / NoPendingSlash on chain.
 *
 * The maturity read is REQUIRED: a public client with `readContract` must be
 * provided. The chain time is supplied by the caller (`now`, unix seconds) so the
 * decision is testable without a live clock; in prod pass the latest block
 * timestamp.
 *
 * @throws if no public client with a getPendingSlash read is provided.
 */
export async function executeMaturedSlash(
  deps: SlashDeps,
  review: BondSlashReview,
  amount: bigint,
  now: bigint,
): Promise<ExecuteSlashResult> {
  if (!deps.publicClient?.readContract) {
    throw new Error(
      "executeMaturedSlash: a public client with readContract is required to read the pending slash before broadcasting",
    );
  }

  const resourceId = review.resourceId as `0x${string}`;
  const reason = review.reason;

  // Read the recorded authorization BEFORE any write. getPendingSlash returns
  // (amount, executableAt); (0, 0) means nothing is pending.
  const pending = (await deps.publicClient.readContract({
    address: RESOURCE_REGISTRY,
    abi: registryAbi,
    functionName: "getPendingSlash",
    args: [resourceId],
  })) as readonly [bigint, bigint];
  const pendingAmount = BigInt(pending[0]);
  const executableAt = BigInt(pending[1]);

  if (pendingAmount === 0n) {
    return { executed: false, reason: "no-pending-authorization" };
  }
  if (pendingAmount !== amount) {
    return { executed: false, reason: "amount-mismatch", pendingAmount, executableAt };
  }
  if (now < executableAt) {
    return { executed: false, reason: "not-yet-matured", pendingAmount, executableAt };
  }

  // Matured + matching: broadcast the real spend. The vault re-checks the registry
  // authorization in consumeSlashAuthorization, so this is safe even if the chain
  // state moved between the read and the write (the tx simply reverts on chain).
  const slashTx = await deps.admin.writeContract({
    address: STAKING_VAULT,
    abi: stakingVaultAbi,
    functionName: "slash",
    args: [resourceId, amount, reason],
  });
  if (deps.publicClient?.waitForTransactionReceipt) {
    await deps.publicClient.waitForTransactionReceipt({ hash: slashTx });
  }

  return { executed: true, slashTx };
}
