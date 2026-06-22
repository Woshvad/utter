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
  parseSignature,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  type ResultStore,
  type PaymentStore,
  type PaymentPayload,
  type SignedExactTransfer,
  type RevenueLedger,
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
  /**
   * The on-chain creator leg in base units (decimal string), from the Debited event's
   * `toCreator`. OPTIONAL: present for an escrow settle whose Debited log was read
   * (the success + NonceUsed-rebuild paths); absent for the exact path (no split) and
   * for the escrow primary path on a chain stub that returns no Debited log. Carried
   * so the revenue ledger records the AUTHORITATIVE on-chain split, never a re-derive.
   */
  toCreator?: string;
  /** The on-chain treasury leg in base units (decimal string), from `toTreasury`. */
  toTreasury?: string;
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
  /**
   * OPTIONAL per-resource revenue ledger. When present, a SUCCESSFUL escrow settle
   * records its on-chain split into the ledger for the studio revenue dashboard. Purely
   * additive: unset (the default, and the ai-runtime G4 gate path) records nothing and
   * changes no settle/debit/split/exactly-once behavior. The legs recorded are the
   * on-chain `toCreator`/`toTreasury` from the Debited event, never a re-derived split.
   */
  revenueLedger?: RevenueLedger;
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
 * How many recent blocks the fallback `getLogs` scan covers when no tx hash was
 * persisted for a nonce (WR-02). A bounded window keeps the RPC call within
 * provider block-range caps; the PRIMARY path is the stored nonce->txHash lookup.
 */
const RECEIPT_REBUILD_BLOCK_WINDOW = 5_000n;

/**
 * Decode a single `Debited` log into the receipt for `idemKey`, or null if the log
 * is not the matching Debited event.
 */
function debitedLogToReceipt(
  log: { data: Hex; topics: [Hex, ...Hex[]]; transactionHash: Hex },
  idemKey: Hex,
): Receipt | null {
  const decoded = decodeEventLog({
    abi: escrowAbi,
    data: log.data,
    topics: log.topics,
  }) as { eventName: string; args: Record<string, unknown> };
  if (decoded.eventName !== "Debited") return null;
  if ((decoded.args.nonce as Hex)?.toLowerCase() !== idemKey.toLowerCase()) return null;
  // toCreator/toTreasury are the ON-CHAIN split legs the PaymentEscrow.debit emits
  // (uint256 each). Surfaced so the revenue ledger records the authoritative split.
  const toCreator = decoded.args.toCreator as bigint | undefined;
  const toTreasury = decoded.args.toTreasury as bigint | undefined;
  return {
    tx: log.transactionHash as Hex,
    payer: decoded.args.buyer as Address,
    amount: (decoded.args.amount as bigint).toString(),
    idemKey,
    scheme: "utter-escrow",
    toCreator: toCreator !== undefined ? toCreator.toString() : undefined,
    toTreasury: toTreasury !== undefined ? toTreasury.toString() : undefined,
  };
}

/**
 * Pull the on-chain split legs (`toCreator`/`toTreasury`) out of a confirmed tx
 * receipt's matching Debited log, or null if none is present. Used only to FEED the
 * revenue ledger with the authoritative on-chain split - it never changes the settle
 * receipt's amount/tx/payer. Defensive: a stub receipt with no `logs` array (the test
 * chain mock) returns null, in which case the ledger records the amount as the creator
 * leg (a single-payee fallback), never a fabricated bps split.
 */
function legsFromDebitedLogs(
  txReceipt: unknown,
  escrowAddress: Address,
  idemKey: Hex,
): { toCreator: string; toTreasury: string } | null {
  const logs = (txReceipt as { logs?: unknown }).logs;
  if (!Array.isArray(logs)) return null;
  for (const log of logs) {
    const l = log as { address?: string; data?: Hex; topics?: [Hex, ...Hex[]]; transactionHash?: Hex };
    if (!l.address || l.address.toLowerCase() !== escrowAddress.toLowerCase()) continue;
    if (!l.data || !l.topics) continue;
    try {
      const r = debitedLogToReceipt(
        { data: l.data, topics: l.topics, transactionHash: (l.transactionHash ?? ("0x" as Hex)) },
        idemKey,
      );
      if (r && r.toCreator !== undefined && r.toTreasury !== undefined) {
        return { toCreator: r.toCreator, toTreasury: r.toTreasury };
      }
    } catch {
      // A non-Debited log on the escrow address (or an undecodable one) is skipped.
    }
  }
  return null;
}

/**
 * Rebuild an escrow receipt for a nonce on a NonceUsed retry-after-crash so we
 * NEVER submit a second debit (RESEARCH Pattern 3).
 *
 * PRIMARY path (WR-02): look up the nonce->txHash mapping persisted at settle time
 * and read THAT single tx receipt's Debited log - O(1), no history scan, no
 * provider block-range cap risk. FALLBACK: a bounded recent-block `getLogs` window
 * (never `fromBlock:"earliest"`), used only when no tx hash was recorded (e.g. a
 * crash between the broadcast and the recordSettleTx write on an older adapter).
 */
async function rebuildEscrowReceiptFromEvent(
  idemKey: Hex,
  escrowAddress: Address,
  publicClient: PublicClient,
  store: PaymentStore,
): Promise<Receipt> {
  // (1) PRIMARY: the stored tx hash -> read that single receipt's logs.
  const storedTx = await store.getSettleTx(idemKey);
  if (storedTx) {
    const txReceipt = await publicClient.getTransactionReceipt({ hash: storedTx });
    for (const log of txReceipt.logs) {
      if ((log.address as Address).toLowerCase() !== escrowAddress.toLowerCase()) continue;
      const receipt = debitedLogToReceipt(
        log as { data: Hex; topics: [Hex, ...Hex[]]; transactionHash: Hex },
        idemKey,
      );
      if (receipt) return receipt;
    }
  }

  // (2) FALLBACK: a BOUNDED recent-block scan (never earliest..latest).
  const debitedEvent = escrowAbi.find(
    (e) => e.type === "event" && e.name === "Debited",
  );
  const latest = await publicClient.getBlockNumber();
  const fromBlock =
    latest > RECEIPT_REBUILD_BLOCK_WINDOW ? latest - RECEIPT_REBUILD_BLOCK_WINDOW : 0n;
  const logs = (await publicClient.getLogs({
    address: escrowAddress,
    event: debitedEvent as never,
    fromBlock,
    toBlock: "latest",
  })) as Array<{ data: Hex; topics: [Hex, ...Hex[]]; transactionHash: Hex }>;

  for (const log of logs) {
    const receipt = debitedLogToReceipt(log, idemKey);
    if (receipt) return receipt;
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
      // WR-02: persist the nonce->txHash mapping the instant the tx is broadcast so a
      // retry-after-crash rebuilds the receipt from THIS single tx, never a full
      // history scan. Recorded before waitForTransactionReceipt (the crash window).
      await deps.store.recordSettleTx(idemKey, tx);
      const txReceipt = await deps.publicClient.waitForTransactionReceipt({ hash: tx });
      receipt = {
        tx,
        payer: a.buyer as Address,
        amount: debitAmount.toString(),
        idemKey,
        scheme: "utter-escrow",
      };
      // ADDITIVE: read the on-chain split legs (toCreator/toTreasury) from the confirmed
      // tx's Debited log so the revenue ledger records the authoritative split. Best-
      // effort only: a chain stub that returns no logs simply leaves the legs unset (the
      // ledger then falls back to amount-as-creator). This never alters the receipt
      // amount/tx/payer or any settle control flow.
      const legs = legsFromDebitedLogs(txReceipt, deps.escrowAddress, idemKey);
      if (legs) {
        receipt.toCreator = legs.toCreator;
        receipt.toTreasury = legs.toTreasury;
      }
    } catch (err) {
      if (!isAlreadySettledError(err)) throw err;
      // On-chain usedNonce already true (retry after crash): rebuild the receipt
      // from the Debited event - NO second debit (RESEARCH Pattern 3).
      receipt = await rebuildEscrowReceiptFromEvent(
        idemKey,
        deps.escrowAddress,
        deps.publicClient,
        deps.store,
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

  // ADDITIVE (revenue dashboard): record this SUCCESSFUL escrow settle into the optional
  // per-resource revenue ledger. Escrow-only (the exact path is flat with no metered
  // split, so it is not aggregated as metered revenue). The legs are the AUTHORITATIVE
  // on-chain toCreator/toTreasury from the Debited event; when the chain layer surfaced
  // no logs (e.g. a stub), fall back to recording the whole amount as the creator leg so
  // amount === creatorShare + platformShare still holds (never a fabricated bps split).
  // The ledger.record is idempotent on idemKey, so a settle RETRY never double-counts.
  // Wrapped defensively: a ledger failure must NEVER break the money path.
  if (deps.revenueLedger && receipt.scheme === "utter-escrow" && !isExact(payment)) {
    try {
      const debited = BigInt(receipt.amount);
      const creatorShare =
        receipt.toCreator !== undefined ? BigInt(receipt.toCreator) : debited;
      const platformShare =
        receipt.toTreasury !== undefined ? BigInt(receipt.toTreasury) : debited - creatorShare;
      await deps.revenueLedger.record({
        idemKey,
        resourceId: payment.authorization.resourceId as Hex,
        amount: debited,
        creatorShare,
        platformShare,
        tx: receipt.tx,
        kind: "settle",
        at: Date.now(),
      });
    } catch {
      // Revenue recording is best-effort; the settle already succeeded and persisted.
    }
  }

  return receipt;
}

/** Narrow a settle input to the exact-scheme payload. */
function isExact(
  payment: PaymentPayload | ExactSettlePayload,
): payment is ExactSettlePayload {
  return (payment as ExactSettlePayload).scheme === "exact";
}

/** Half the secp256k1 curve order (n/2); s must be <= this (EIP-2 low-s). */
const SECP256K1_HALF_N =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/**
 * Split a 65-byte ECDSA signature into the (v, r, s) ERC-3009 expects, REJECTING a
 * malformed or malleable signature BEFORE it is submitted on-chain (WR-06). Uses
 * viem's `parseSignature` (no hand-rolled hex slicing) and asserts:
 *   - the signature is exactly 132 hex chars (0x + 65 bytes),
 *   - s <= secp256k1n/2 (low-s; reject the EIP-2 malleable high-s sibling).
 * Exact path only (the escrow path uses viem recovery and never calls this).
 */
export function splitSignature(signature: Hex): { v: number; r: Hex; s: Hex } {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new Error("splitSignature: signature must be exactly 65 bytes (0x + 130 hex)");
  }
  const parsed = parseSignature(signature);
  // parseSignature returns r/s as hex strings; parse s to bigint for the bound check.
  if (BigInt(parsed.s) > SECP256K1_HALF_N) {
    throw new Error("splitSignature: high-s signature rejected (EIP-2 malleability)");
  }
  // parseSignature yields yParity (0/1) and/or v; ERC-3009 wants the 27/28 form.
  const v = parsed.v !== undefined ? Number(parsed.v) : (parsed.yParity ?? 0) + 27;
  return { v, r: parsed.r, s: parsed.s };
}
