// register-resource.ts - the on-chain ResourceRegistry registration step (DEP-01,
// design RESOURCE-DEPLOY-DESIGN.md §5.2). Without it, PaymentEscrow.debit reverts
// ResourceInactive for a deployed resource whose keccak resourceId was never
// registered (ResourceRegistry.getResource reverts UnknownResource on a
// never-registered id). This module writes that registration before any debit can
// fire, idempotently across redeploys of the same label.
//
// It mirrors the proven admin-signed registry-write pattern in
// packages/staking/src/slash.ts: the admin writer + the reader are INJECTED, so
// this module NEVER reads a key or an env var itself and is unit-testable with a
// spy. The caller (live-deploy.ts) is the only place a key is read; it builds the
// admin wallet from .env.local and passes it in. No key is ever logged.
//
// Money discipline: creatorBps is a uint16 RATIO against 10000 (the contract's
// BPS_DENOMINATOR), NEVER a USDC amount. This module does no token math - the
// split stays on-chain in PaymentEscrow.debit. The validation here mirrors the
// contract's own ZeroAddress / InvalidBps guards so bad config fails locally
// instead of paying gas for a guaranteed revert.
import { RESOURCE_REGISTRY, registryAbi } from "@utter/chain";

/** A 32-byte zero word: the default agentId / pricingHash (advisory indexer
 * fields the registry stores but PaymentEscrow.debit never reads). */
const ZERO32 = `0x${"00".repeat(32)}` as `0x${string}`;

/** The basis-point denominator the contract validates creatorBps against. */
const BPS_DENOMINATOR = 10_000;

/**
 * The minimal admin write surface registerResourceIfNeeded needs. Matches viem's
 * `WalletClient.writeContract` shape so the real Arc admin wallet (built from
 * REGISTRY_ADMIN_PRIVATE_KEY in .env.local by the caller) satisfies it, while the
 * test injects a spy. The admin is the ResourceRegistry Ownable owner (register is
 * onlyOwner).
 */
export interface RegistryAdminWriter {
  writeContract(args: {
    address: `0x${string}`;
    abi: unknown;
    functionName: string;
    args: readonly unknown[];
  }): Promise<`0x${string}`>;
}

/**
 * The minimal read surface for the idempotency check + the optional receipt wait.
 *
 * `readContract` is used ONLY for the idempotency read (`isActive(resourceId)`)
 * that happens BEFORE any write. It is deliberately the only read: it returns a
 * plain bool and never reverts (isActive returns false for an unknown id, unlike
 * getResource which reverts UnknownResource). `waitForTransactionReceipt` keeps the
 * registration observable for the operator audit. Both are optional - the
 * autonomous suite injects a stub or omits them.
 */
export interface RegistryReader {
  readContract?(args: {
    address: `0x${string}`;
    abi: unknown;
    functionName: "isActive";
    args: readonly [`0x${string}`];
  }): Promise<boolean>;
  waitForTransactionReceipt?(args: { hash: `0x${string}` }): Promise<unknown>;
}

/** Injected clients for {@link registerResourceIfNeeded}. */
export interface RegisterResourceDeps {
  /** The admin wallet (Ownable owner) that submits the register write. Operator-gated key. */
  admin: RegistryAdminWriter;
  /** Optional reader for the idempotency check + receipt wait (never reads a key). */
  reader?: RegistryReader;
}

/** Registration inputs. creatorBps is a RATIO (0-10000), never an amount. */
export interface RegisterResourceParams {
  /** The keccak resourceId the quote advertises as payTo (the escrow debit target). */
  resourceId: `0x${string}`;
  /** The resource creator (the split recipient the registry records). */
  creator: `0x${string}`;
  /** The platform treasury (the second split recipient). */
  treasury: `0x${string}`;
  /** The creator's share in basis points against 10000 (NOT a USDC amount). */
  creatorBps: number;
}

/** The outcome of {@link registerResourceIfNeeded}. */
export interface RegisterResourceResult {
  /** True only when this call submitted a register tx. */
  registered: boolean;
  /** True when the resourceId was already registered + active (no tx submitted). */
  alreadyActive: boolean;
  /** The register tx hash, present only when `registered` is true. */
  registrationTx?: `0x${string}`;
  /** True when the id is registered but PAUSED (active false). The deployer logs
   * this rather than auto-unpausing - unpause is an explicit operator decision. */
  registeredButPaused?: boolean;
}

/** The zero address (a creator/treasury of zero would lock the split share). */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Register `resourceId` on the ResourceRegistry if it is not already active,
 * idempotently. The flow (design §5.2):
 *
 *   1. Idempotency read FIRST: if a reader is provided, call `isActive(resourceId)`;
 *      if true, return `{ registered:false, alreadyActive:true }` and emit NO tx -
 *      a redeploy of the same label is a no-op (no second register, no wasted gas).
 *   2. Validate BEFORE the write: reject a zero `creator`/`treasury` and a
 *      `creatorBps > 10000`, mirroring the contract's ZeroAddress / InvalidBps so
 *      bad config fails locally instead of paying gas for a guaranteed revert.
 *   3. Write `register(resourceId, creator, treasury, creatorBps, ZERO32, ZERO32)`
 *      (agentId / pricingHash default to the zero word - advisory indexer fields,
 *      not read by debit). Await the receipt when a waiter is available.
 *   4. Race safety: a concurrent register that lands first makes our write revert
 *      AlreadyRegistered - treat that as idempotent success. A registered-but-paused
 *      id (isActive false but the register reverts AlreadyRegistered) is surfaced as
 *      `registeredButPaused` so the deployer logs it instead of silently unpausing.
 *
 * @throws on a zero creator/treasury or creatorBps > 10000 (local config error).
 */
export async function registerResourceIfNeeded(
  deps: RegisterResourceDeps,
  params: RegisterResourceParams,
): Promise<RegisterResourceResult> {
  const { resourceId, creator, treasury, creatorBps } = params;

  // (2) Validate BEFORE any read/write so a bad config fails locally and never
  // reaches the chain. creatorBps is a RATIO - guard against the contract's bounds.
  if (creator === ZERO_ADDRESS || treasury === ZERO_ADDRESS) {
    throw new Error(
      "registerResourceIfNeeded: creator and treasury must be non-zero (a zero recipient locks its split share)",
    );
  }
  if (!Number.isInteger(creatorBps) || creatorBps < 0 || creatorBps > BPS_DENOMINATOR) {
    throw new Error(
      `registerResourceIfNeeded: creatorBps must be an integer ratio in [0, ${BPS_DENOMINATOR}] (got ${creatorBps}); it is a ratio, never an amount`,
    );
  }

  // (1) Idempotency read FIRST. isActive returns false for an unknown id (it does
  // NOT revert, unlike getResource), so this is the safe redeploy probe.
  if (deps.reader?.readContract) {
    const active = await deps.reader.readContract({
      address: RESOURCE_REGISTRY,
      abi: registryAbi,
      functionName: "isActive",
      args: [resourceId],
    });
    if (active) {
      return { registered: false, alreadyActive: true };
    }
  }

  // (3) Write the registration. agentId / pricingHash default to ZERO32.
  try {
    const registrationTx = await deps.admin.writeContract({
      address: RESOURCE_REGISTRY,
      abi: registryAbi,
      functionName: "register",
      args: [resourceId, creator, treasury, creatorBps, ZERO32, ZERO32],
    });
    if (deps.reader?.waitForTransactionReceipt) {
      await deps.reader.waitForTransactionReceipt({ hash: registrationTx });
    }
    return { registered: true, alreadyActive: false, registrationTx };
  } catch (err: unknown) {
    // (4) Race safety. A register revert with AlreadyRegistered means the id was
    // taken between our isActive read and our write. If isActive read false above
    // yet the id exists, the id is registered but PAUSED: surface it as a flagged
    // result so the deployer LOGS it rather than auto-unpausing (an explicit
    // operator decision). Any other revert is a real failure and is rethrown.
    const message = err instanceof Error ? err.message : String(err);
    if (/AlreadyRegistered/i.test(message)) {
      return { registered: false, alreadyActive: false, registeredButPaused: true };
    }
    throw err;
  }
}
