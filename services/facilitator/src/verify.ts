// /verify reservation logic (PAY-02) - the load-bearing FREE-COMPUTE GUARD.
//
// `verifyAndReserve` is the ONLY thing /verify does: it (1) recovers the EIP-712
// signer and rejects unless it equals the claimed buyer, (2) reads on-chain
// `balanceOf(buyer)` and subtracts the buyer's outstanding open reservations to
// get the AVAILABLE balance, rejecting when available < cap, (3) checks the nonce
// is free (store-pending AND on-chain usedNonce), then (4) writes the off-chain
// reservation lock and marks the nonce pending. It returns BEFORE any handler can
// run, and no handler runs here - this structurally enforces RESERVE-PRECEDES-RUN
// (CLAUDE.md §19: never run a handler against an unreserved authorization).
//
// The off-chain reservation accounting (available = balanceOf - outstandingReserved)
// is DEFENSE IN DEPTH. The on-chain `debit` revert (PaymentEscrow reverts on
// insufficient internal balance / replayed nonce) remains the FINAL AUTHORITY and
// backstop - a store bug can only cause a late revert at settle, never an overspend.
//
// Per-buyer serialization: the balance read + outstanding sum + reserve are taken
// under a per-buyer lock so two concurrent verifies against one balance cannot both
// reserve. The in-memory mutex here is the test default; the Redis `SET NX PX`
// equivalent is the real-adapter lock (pgRedis store, later wave).
import {
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  ESCROW_DOMAIN,
  DEBIT_AUTHORIZATION_TYPES,
  type PaymentStore,
  type PaymentPayload,
} from "@utter/x402-arc";
import { escrowAbi } from "@utter/chain";

/**
 * A per-buyer mutex. `runExclusive(buyer, fn)` serializes all `fn` calls for the
 * same buyer key so the balance read + reservation are atomic per buyer. The
 * in-memory implementation below is the test default; the production adapter is a
 * Redis `SET NX PX` lock with the same contract.
 */
export interface PerBuyerLock {
  runExclusive<T>(buyer: Hex, fn: () => Promise<T>): Promise<T>;
}

/**
 * In-memory per-buyer lock: a promise chain per buyer key (case-insensitive). Each
 * `runExclusive` for a buyer awaits the previous one, so same-buyer work is
 * strictly serialized while different buyers run concurrently. No timers, no
 * external services - fully offline for the test default.
 */
export function createInMemoryBuyerLock(): PerBuyerLock {
  const tails = new Map<string, Promise<unknown>>();
  return {
    async runExclusive<T>(buyer: Hex, fn: () => Promise<T>): Promise<T> {
      const key = buyer.toLowerCase();
      const prev = tails.get(key) ?? Promise.resolve();
      // Chain this task after the previous one for the same buyer. Swallow the
      // predecessor's rejection so one failure does not poison the queue.
      const run = prev.catch(() => undefined).then(() => fn());
      // The tail tracks completion (success or failure) without leaking the value
      // and without rejecting (so a later same-buyer task is never poisoned).
      const settled = run.then(
        () => undefined,
        () => undefined,
      );
      tails.set(key, settled);
      try {
        return await run;
      } finally {
        // Drop the entry once this is the last task in the chain, so the map does
        // not grow unbounded across many distinct buyers.
        if (tails.get(key) === settled) tails.delete(key);
      }
    },
  };
}

/** The resource requirements /verify checks the authorization against. */
export interface VerifyRequirements {
  /** The resource being charged (bytes32). The authorization must target it. */
  resourceId: Hex;
  /** The resource's max handler timeout (seconds) - drives the reservation TTL. */
  maxTimeoutSeconds: number;
}

/** Everything `verifyAndReserve` needs injected (store + chain + lock + TTL knobs). */
export interface VerifyDeps {
  /** The reservation/nonce store (in-memory test default; pg+redis real). */
  store: PaymentStore;
  /** The Arc public client for the balanceOf / usedNonce reads. */
  publicClient: PublicClient;
  /** The PaymentEscrow address the reads target. */
  escrowAddress: Address;
  /** The per-buyer serialization lock. */
  perBuyerLock: PerBuyerLock;
  /** Reservation TTL term: the resource's max handler timeout (seconds). */
  maxTimeoutSeconds: number;
  /** Reservation TTL term: settle buffer (seconds) added past the handler timeout. */
  settleBufferSeconds: number;
}

/** The /verify result. On valid: a reservation is written and `payer` is set. */
export interface VerifyResult {
  valid: boolean;
  /** The recovered buyer (only on valid). */
  payer?: Address;
  /** A machine reason on rejection (bad_signature | insufficient_balance | nonce_used | ...). */
  reason?: string;
}

/**
 * Verify a payment authorization and, on success, reserve its cap. NO handler runs
 * here; this function only reserves (RESERVE-PRECEDES-RUN, CLAUDE.md §19).
 *
 * Steps:
 *   1. Recover the EIP-712 signer under the LOCKED UtterEscrow/1 domain; reject if
 *      signer !== buyer ("bad_signature").
 *   2. Reject if the authorization does not target the required resource
 *      ("resource_mismatch") or has expired ("authorization_expired").
 *   3. Under the per-buyer lock: read on-chain balanceOf(buyer), compute
 *      available = balanceOf - outstandingReserved(buyer), reject if available < cap
 *      ("insufficient_balance"). This rejects BOTH a low raw balance AND a balance
 *      already committed to open reservations (two sequential verifies with
 *      different nonces cannot over-commit one balance).
 *   4. Reject if the nonce is store-pending OR on-chain usedNonce ("nonce_used").
 *   5. store.reserve(...); if it returns false (race) reject ("reserve_race").
 *   6. Return { valid:true, payer:buyer }.
 *
 * The off-chain accounting is defense in depth; the on-chain `debit` revert is the
 * FINAL authority and backstop.
 */
export async function verifyAndReserve(
  payment: PaymentPayload,
  requirements: VerifyRequirements,
  deps: VerifyDeps,
): Promise<VerifyResult> {
  const { authorization, signature } = payment;
  const buyer = authorization.buyer as Address;

  // Wire amounts are decimal strings; parse to bigint at the boundary (base units).
  let maxAmount: bigint;
  let validBefore: bigint;
  try {
    maxAmount = BigInt(authorization.maxAmount);
    validBefore = BigInt(authorization.validBefore);
  } catch {
    return { valid: false, reason: "bad_authorization" };
  }

  // (1) Recover the EIP-712 signer over the LOCKED UtterEscrow/1 domain + field
  // order; reject unless it equals the claimed buyer. recoverTypedDataAddress
  // throws on a malformed signature - treat that as a bad signature too.
  let signer: Address;
  try {
    signer = await recoverTypedDataAddress({
      domain: ESCROW_DOMAIN,
      types: { DebitAuthorization: DEBIT_AUTHORIZATION_TYPES },
      primaryType: "DebitAuthorization",
      message: {
        buyer,
        resourceId: authorization.resourceId,
        maxAmount,
        nonce: authorization.nonce,
        validBefore,
      },
      signature,
    });
  } catch {
    return { valid: false, reason: "bad_signature" };
  }
  if (signer.toLowerCase() !== buyer.toLowerCase()) {
    return { valid: false, reason: "bad_signature" };
  }

  // (2) The authorization must target the required resource and be unexpired.
  if (authorization.resourceId.toLowerCase() !== requirements.resourceId.toLowerCase()) {
    return { valid: false, reason: "resource_mismatch" };
  }
  if (validBefore <= BigInt(Math.floor(Date.now() / 1000))) {
    return { valid: false, reason: "authorization_expired" };
  }

  const nonce = authorization.nonce;
  const cap = maxAmount;

  // (3)-(5) The balance read + outstanding sum + nonce check + reserve are taken
  // atomically per buyer so two concurrent verifies against one balance cannot
  // both reserve.
  return deps.perBuyerLock.runExclusive(buyer, async (): Promise<VerifyResult> => {
    // (3) On-chain available balance = balanceOf(buyer) - outstandingReserved(buyer).
    // Read decimals-agnostic base units; never compare a decimals-scaled number.
    const onchainBalance = (await deps.publicClient.readContract({
      address: deps.escrowAddress,
      abi: escrowAbi,
      functionName: "balanceOf",
      args: [buyer],
    })) as bigint;
    const outstanding = await deps.store.outstandingReserved(buyer);
    const available = onchainBalance - outstanding;
    if (available < cap) {
      return { valid: false, reason: "insufficient_balance" };
    }

    // (4) The nonce must be free: not store-pending AND not on-chain usedNonce.
    if (await deps.store.isNoncePending(nonce)) {
      return { valid: false, reason: "nonce_used" };
    }
    const onchainUsed = (await deps.publicClient.readContract({
      address: deps.escrowAddress,
      abi: escrowAbi,
      functionName: "usedNonce",
      args: [nonce],
    })) as boolean;
    if (onchainUsed) {
      return { valid: false, reason: "nonce_used" };
    }

    // (5) Reserve. TTL = (maxTimeoutSeconds + settleBuffer) so the lock outlives the
    // handler run + on-chain debit. reserve() returns false on a store-layer race
    // (already pending / spent) - reject rather than proceed.
    const expiresAt =
      Date.now() + (deps.maxTimeoutSeconds + deps.settleBufferSeconds) * 1000;
    const reserved = await deps.store.reserve({
      idemKey: nonce,
      buyer,
      cap,
      resourceId: authorization.resourceId,
      expiresAt,
    });
    if (!reserved) {
      return { valid: false, reason: "reserve_race" };
    }

    // (6) Reserved. The handler can now run (Plan 05 gate awaits this valid before
    // next()). The on-chain `debit` revert remains the FINAL backstop.
    return { valid: true, payer: buyer };
  });
}
