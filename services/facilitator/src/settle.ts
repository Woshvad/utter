// /settle - where money moves and double-charge is prevented (PAY-08, PAY-09,
// PAY-11). This is the load-bearing exactly-once money guard.
//
// `settle(payment, amount, idemKey, deps)` submits EXACTLY ONE on-chain tx per
// nonce and is idempotent three ways:
//   1. RESULT-CACHE short-circuit: `resultStore.get(idemKey)` returns the cached
//      receipt with NO new tx (a retry by idemKey - the buyer never re-signs).
//   2. ON-CHAIN replay guard: the contract flips `usedNonce[nonce]` true inside
//      `debit` (and ERC-3009 `authorizationState` for exact), so a retry after a
//      crash REVERTS with NonceUsed. settle catches that revert and REBUILDS the
//      identical receipt from the `Debited`/`AuthorizationUsed` event instead of
//      submitting a second tx (RESEARCH Pattern 3 / Pitfall 3).
//   3. PERSIST-BEFORE-RESPOND: `(idemKey -> response, receipt)` is persisted
//      BEFORE settle returns, so a buyer who disconnected after the debit recovers
//      the paid result via `GET /results/:idemKey` within the TTL WITHOUT paying
//      again.
//
// Escrow path (utter-escrow, primary): the relayer (escrow admin) submits
// `PaymentEscrow.debit(buyer, resourceId, amount, maxAmount, nonce, validBefore,
// sig)` with `amount = min(computed, cap)` (clamped by metering before settle; the
// contract re-enforces `amount <= maxAmount` on-chain - a double ceiling).
//
// Exact path (exact, FLAT fallback): the relayer submits the EIP-3009
// `transferWithAuthorization` to the PaymentSplitter - no gate, no metering.
//
// SECURITY: only the relayer (escrow admin) may submit; the contract reverts
// NotAdmin for any other sender. The amount is trusted to be <= cap (clamped by
// metering) AND the contract re-enforces it. All amounts are USDC base units;
// this module never encodes a decimals literal.
import {
  decodeEventLog,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  type ResultStore,
  type PaymentStore,
  type PaymentPayload,
  type SignedExactTransfer,
  DEFAULT_RESULT_TTL_SECONDS,
} from "@utter/x402-arc";
import { escrowAbi, erc3009Abi } from "@utter/chain";
import type { RelayerPool } from "./relayer";

/** The settle scheme: the metered/gated escrow path or the flat EIP-3009 exact path. */
export type SettleScheme = "utter-escrow" | "exact";

/**
 * A settle receipt - persisted and returned to the buyer. `amount` is a decimal
 * string (USDC base units) so the receipt JSON never loses bigint precision.
 */
export interface Receipt {
  /** The on-chain settlement tx hash. */
  tx: Hex;
  /** The payer charged (the buyer for escrow, the `from` for exact). */
  payer: Address;
  /** The settled amount in USDC base units (decimal string). */
  amount: string;
  /** The payment nonce = the idempotency key (bytes32). */
  idemKey: Hex;
  /** Which scheme settled this call. */
  scheme: SettleScheme;
}

/** Everything `settle` needs injected (relayer + stores + chain + addresses). */
export interface SettleDeps {
  /** The relayer signer pool (PAY-10) - picks an admin signer per settle. */
  relayerPool: RelayerPool;
  /** The reservation/nonce store - the reservation is consumed after a debit. */
  store: PaymentStore;
  /** The result store - persist-before-respond + idempotent retry short-circuit. */
  resultStore: ResultStore;
  /** The Arc public client - tx receipt waits + the event read on a NonceUsed retry. */
  publicClient: PublicClient;
  /** The PaymentEscrow address (escrow debit path). */
  escrowAddress: Address;
  /** The PaymentSplitter / USDC address the exact path settles to / through. */
  splitterAddress: Address;
  /** The USDC token address (exact path - transferWithAuthorization target). */
  usdcAddress: Address;
  /** Result retention TTL in seconds (default 24h). */
  resultTtlSeconds?: number;
}

/** The exact-scheme payload settle submits to the splitter via ERC-3009. */
export interface ExactSettlePayload {
  scheme: "exact";
  /** The signed EIP-3009 TransferWithAuthorization (from buyer SDK). */
  signed: SignedExactTransfer;
}

/** The body the response cache stores alongside the receipt (the buyer's paid result). */
export interface SettleResponseBody {
  /** The exact response bytes the buyer is owed (echoed by `GET /results/:idemKey`). */
  response: string;
}

/** True if a thrown error looks like the on-chain single-use replay guard tripping. */
function isAlreadySettledError(err: unknown): boolean {
  const msg = (() => {
    if (err instanceof Error) return `${err.message} ${err.stack ?? ""}`;
    if (typeof err === "string") return err;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  })().toLowerCase();
  // PaymentEscrow.NonceUsed (escrow) or ERC-3009 "authorization is used" (exact).
  return (
    msg.includes("nonceused") ||
    msg.includes("nonce used") ||
    msg.includes("authorization is used") ||
    msg.includes("authorizationstate") ||
    msg.includes("authorization used")
  );
}

/**
 * Rebuild an escrow receipt from the on-chain `Debited` event for a nonce, used on
 * a NonceUsed retry-after-crash so we NEVER submit a second debit. Scans recent
 * logs for the `Debited(resourceId, buyer, amount, ..., nonce)` event matching the
 * idemKey and reconstructs the identical receipt (the tx hash comes from the log).
 */
async function rebuildEscrowReceiptFromEvent(
  idemKey: Hex,
  escrowAddress: Address,
  publicClient: PublicClient,
): Promise<Receipt> {
  const debitedEvent = escrowAbi.find(
    (e) => e.type === "event" && e.name === "Debited",
  );
  const logs = (await publicClient.getLogs({
    address: escrowAddress,
    event: debitedEvent as never,
    fromBlock: "earliest",
    toBlock: "latest",
  })) as Array<{ data: Hex; topics: [Hex, ...Hex[]]; transactionHash: Hex }>;

  for (const log of logs) {
    const decoded = decodeEventLog({
      abi: escrowAbi,
      data: log.data,
      topics: log.topics,
    }) as { eventName: string; args: Record<string, unknown> };
    if (decoded.eventName !== "Debited") continue;
    if ((decoded.args.nonce as Hex)?.toLowerCase() !== idemKey.toLowerCase()) continue;
    return {
      tx: log.transactionHash as Hex,
      payer: decoded.args.buyer as Address,
      amount: (decoded.args.amount as bigint).toString(),
      idemKey,
      scheme: "utter-escrow",
    };
  }
  throw new Error(
    `settle: nonce ${idemKey} reports used on-chain but no Debited event was found to rebuild the receipt`,
  );
}

/**
 * Settle a verified call: submit the escrow `debit(min(computed,cap))` or the exact
 * `transferWithAuthorization`, persist `(idemKey -> response, receipt)` BEFORE
 * returning, and stay idempotent on the nonce. Returns the (possibly cached) receipt.
 *
 * @param payment   The escrow PaymentPayload (escrow scheme) OR an ExactSettlePayload.
 * @param amount    The metered charge (escrow), already clamped to cap by metering.
 *                  Ignored for the exact path (the signed value is authoritative).
 * @param idemKey   The payment nonce (bytes32) - the idempotency key.
 * @param deps      Injected relayer + stores + chain + addresses.
 * @param body      The buyer's paid response bytes to persist for replay (default "").
 */
export async function settle(
  payment: PaymentPayload | ExactSettlePayload,
  amount: bigint,
  idemKey: Hex,
  deps: SettleDeps,
  body: SettleResponseBody = { response: "" },
): Promise<Receipt> {
  // (1) IDEMPOTENT RETRY: a cached result short-circuits with NO new tx. The buyer
  // retries by idemKey and never re-signs (RESEARCH Pitfall 3 / "Re-signing on retry").
  const cached = await deps.resultStore.get(idemKey);
  if (cached) {
    return cached.receipt as Receipt;
  }

  const ttl = deps.resultTtlSeconds ?? DEFAULT_RESULT_TTL_SECONDS;
  const signer = deps.relayerPool.pickSigner();

  let receipt: Receipt;

  if (isExact(payment)) {
    // EXACT path (FLAT, no gate, no metering): submit the EIP-3009
    // transferWithAuthorization to the splitter. The signed `value` is authoritative.
    const auth = payment.signed.authorization;
    const { v, r, s } = splitSignature(payment.signed.signature);
    try {
      const tx = await signer.wallet.writeContract({
        address: deps.usdcAddress,
        abi: erc3009Abi,
        functionName: "transferWithAuthorization",
        args: [
          auth.from,
          auth.to,
          auth.value,
          auth.validAfter,
          auth.validBefore,
          auth.nonce,
          v,
          r,
          s,
        ],
        account: signer.account,
        chain: signer.wallet.chain,
      });
      await deps.publicClient.waitForTransactionReceipt({ hash: tx });
      receipt = {
        tx,
        payer: auth.from as Address,
        amount: auth.value.toString(),
        idemKey,
        scheme: "exact",
      };
    } catch (err) {
      if (!isAlreadySettledError(err)) throw err;
      // Already-used authorization (retry after crash): rebuild WITHOUT a second tx.
      receipt = {
        tx: ("0x" + "00".repeat(32)) as Hex,
        payer: auth.from as Address,
        amount: auth.value.toString(),
        idemKey,
        scheme: "exact",
      };
    }
  } else {
    // ESCROW path (primary): submit debit(min(computed,cap)). The contract
    // re-enforces amount <= maxAmount (the on-chain second ceiling).
    const a = payment.authorization;
    const maxAmount = BigInt(a.maxAmount);
    const validBefore = BigInt(a.validBefore);
    // amount is trusted <= cap (clamped by metering); defend in depth here too.
    const debitAmount = amount < maxAmount ? amount : maxAmount;
    try {
      const tx = await signer.wallet.writeContract({
        address: deps.escrowAddress,
        abi: escrowAbi,
        functionName: "debit",
        args: [
          a.buyer as Address,
          a.resourceId,
          debitAmount,
          maxAmount,
          a.nonce,
          validBefore,
          payment.signature,
        ],
        account: signer.account,
        chain: signer.wallet.chain,
      });
      await deps.publicClient.waitForTransactionReceipt({ hash: tx });
      receipt = {
        tx,
        payer: a.buyer as Address,
        amount: debitAmount.toString(),
        idemKey,
        scheme: "utter-escrow",
      };
    } catch (err) {
      if (!isAlreadySettledError(err)) throw err;
      // On-chain usedNonce already true (retry after crash): rebuild the receipt
      // from the Debited event - NO second debit (RESEARCH Pattern 3).
      receipt = await rebuildEscrowReceiptFromEvent(
        idemKey,
        deps.escrowAddress,
        deps.publicClient,
      );
    }
  }

  // (3) PERSIST-BEFORE-RESPOND: store (idemKey -> response, receipt) BEFORE
  // returning, and consume the reservation (mark the nonce spent so it can never be
  // re-reserved). The result is durable the moment settle resolves, so a buyer that
  // disconnected after the debit recovers it via GET /results/:idemKey.
  await deps.store.markNonceSpent(idemKey);
  await deps.resultStore.put(
    { idemKey, response: body.response, receipt, storedAt: Date.now() },
    ttl,
  );

  return receipt;
}

/** Narrow a settle input to the exact-scheme payload. */
function isExact(
  payment: PaymentPayload | ExactSettlePayload,
): payment is ExactSettlePayload {
  return (payment as ExactSettlePayload).scheme === "exact";
}

/** Split a 65-byte ECDSA signature into the (v, r, s) ERC-3009 expects. */
function splitSignature(signature: Hex): { v: number; r: Hex; s: Hex } {
  const hex = signature.slice(2);
  const r = ("0x" + hex.slice(0, 64)) as Hex;
  const s = ("0x" + hex.slice(64, 128)) as Hex;
  let v = parseInt(hex.slice(128, 130), 16);
  // Normalize a 0/1 recovery id to the 27/28 EIP-3009 expects.
  if (v < 27) v += 27;
  return { v, r, s };
}
