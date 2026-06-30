// cctp-funder.ts - cross-chain escrow funding via CCTP V2 (SCL-04).
//
// Flow (CCTP V2, 08-RESEARCH Code Examples): depositForBurn on the source chain
// (TokenMessengerV2) -> obtain a Circle Iris attestation (mock default | live
// gated) -> receiveMessage on Arc (MessageTransmitterV2, mint) -> credit the
// PaymentEscrow balance the buyer client funds. Mirrors the
// services/facilitator/src/settle.ts chain-write shape (writeContract +
// waitForTransactionReceipt, abstracted here behind an injectable CctpChainWriter)
// and the packages/buyer-sdk/src/transport.ts mock/live gating.
//
// Critical invariants:
//   - DESTINATION DOMAIN: read from the pinned CCTP_DOMAIN const in @utter/chain
//     (= the authoritative Arc value; 08-RESEARCH Pitfall 1: the "7" snippet is
//     WRONG). NEVER a bare domain literal in this module.
//   - AUTO-CREDIT DEFAULT = poll-and-credit (08-RESEARCH Pitfall 2: CCTP hooks are
//     opaque metadata the core protocol does NOT execute). No credit happens
//     without an explicit receiveMessage + credit; a hook-receiver is the
//     operator-built variant.
//   - ATTESTATION (T-08-CCTPREPLAY): only Iris-signed attestations are consumed.
//     A malformed/unsigned attestation is rejected BEFORE receiveMessage; the mock
//     is signed in tests, never forged on the live path.
//   - All amounts are base-unit bigint; this module encodes no decimals literal.
import type { Address, Hex } from "viem";
import {
  CCTP_DOMAIN,
  CCTP_TOKEN_MESSENGER,
  CCTP_MESSAGE_TRANSMITTER,
} from "@utter/chain";

/** A Circle Iris attestation: the burn message + its Iris signature over that message. */
export interface Attestation {
  /** The CCTP burn message emitted on the source chain. */
  readonly message: Hex;
  /** The Iris signature attesting the burn (consumed by receiveMessage). */
  readonly signature: Hex;
}

/**
 * The attestation source seam: turns a source-chain burn message into an
 * Iris-signed attestation. MockAttestation is the deterministic autonomous
 * default; LiveCctp is the operator-gated live Iris service.
 */
export interface AttestationSource {
  /** A label for diagnostics (never logged to stdout). */
  readonly kind: "mock" | "live";
  /** Attest a burn message; resolves to the signed attestation. */
  attest(message: Hex): Promise<Attestation>;
}

/**
 * The injectable chain-write seam (the settle.ts writeContract shape). The mock in
 * tests records calls; the live wiring drives a real viem wallet client.
 */
export interface CctpChainWriter {
  /** Burn USDC on the source chain (TokenMessengerV2.depositForBurn). */
  depositForBurn(args: {
    tokenMessenger: Address;
    destinationDomain: number;
    amount: bigint;
    recipient: Address;
    srcChain: string;
  }): Promise<{ message: Hex; txHash: Hex }>;
  /**
   * Mint on Arc by consuming the attestation (MessageTransmitterV2.receiveMessage).
   * The on-chain transmitter mints the amount encoded in the ATTESTED burn message
   * (possibly less than the requested burn after a CCTP fee); the caller does NOT
   * dictate the minted amount. The writer returns the AUTHORITATIVE `mintedAmount`
   * the mint actually produced (WR-03) - the funder credits that, never the request.
   */
  receiveMessage(args: {
    messageTransmitter: Address;
    message: Hex;
    attestation: Hex;
  }): Promise<{ mintedAmount: bigint; txHash: Hex }>;
}

/** Credits the minted USDC into the PaymentEscrow balance the buyer client funds. */
export interface EscrowCreditStore {
  /** Credit `amount` base units to `account`; resolves to the new balance. */
  credit(account: Address, amount: bigint): Promise<bigint>;
}

/**
 * The replay-dedup store (T-08-CCTPREPLAY). Each CCTP burn message carries a unique
 * nonce, so the burn message is the natural dedup key: a replayed or retried
 * attestation over the SAME message must never credit the escrow twice. The store
 * atomically claims a key the first time it is seen; a second claim of the same key
 * resolves false so the funder rejects the duplicate before crediting. An injectable
 * seam so production can back it with Redis/Postgres and tests with an in-memory set.
 */
export interface NonceStore {
  /**
   * Atomically claim `key`. Resolves true if this is the first claim (proceed),
   * false if `key` was already claimed (a replay - reject without crediting).
   */
  claim(key: string): Promise<boolean>;
}

/**
 * The attestation verifier seam (T-08-CCTPREPLAY). The default light verifier
 * asserts the attestation carries a non-empty, hex-shaped signature; it is enough
 * for the mock/autonomous path but is NOT a real signature check. On the live path a
 * real secp256k1 / Iris-public-key verifier MUST be injected so a forged attestation
 * over a real burn message cannot mint. CctpFunder requires a non-default verifier
 * whenever the attestation source is live.
 */
export interface AttestationVerifier {
  /** A label for diagnostics. "shape" is the light default; "live" is a real verifier. */
  readonly kind: "shape" | "live";
  /** Throw if `att` is not a valid Iris attestation; return for a valid one. */
  verify(att: Attestation): Promise<void> | void;
}

/** The resolved funding result: the minted amount + the source/mint tx hashes. */
export interface FundResult {
  /** The base-unit amount minted on Arc and credited to the escrow balance. */
  readonly minted: bigint;
  /** The source-chain burn tx hash. */
  readonly burnTx: Hex;
  /** The Arc mint (receiveMessage) tx hash. */
  readonly mintTx: Hex;
}

/** Everything CctpFunder needs injected: the chain writer, escrow store, attestation source. */
export interface CctpFunderDeps {
  /** The chain-write seam (burn + receiveMessage). */
  readonly writer: CctpChainWriter;
  /** The escrow credit store (the PaymentEscrow balance). */
  readonly escrow: EscrowCreditStore;
  /** The attestation source (MockAttestation default / LiveCctp gated). */
  readonly attestation: AttestationSource;
  /**
   * The replay-dedup store keyed by the burn message nonce (T-08-CCTPREPLAY). When
   * omitted the funder uses a process-local in-memory store, which dedups within a
   * single process; production should inject a durable store.
   */
  readonly nonces?: NonceStore;
  /**
   * The attestation verifier. When omitted the funder uses the light shape verifier,
   * which is rejected on the live attestation path: a live source REQUIRES a real
   * injected verifier so a forged attestation cannot mint.
   */
  readonly verifier?: AttestationVerifier;
}

/**
 * MockAttestation - the deterministic autonomous default. It simulates Circle's
 * Iris service: it returns a SIGNED attestation (a deterministic non-empty
 * signature) over the burn message. It never forges a live attestation; on the live
 * path LiveCctp throws instead.
 */
export class MockAttestation implements AttestationSource {
  readonly kind = "mock" as const;

  async attest(message: Hex): Promise<Attestation> {
    // A deterministic mock "Iris signature": a fixed-shape signed blob. This stands
    // in for the off-chain Iris attestation; it is signed (non-empty) so the funder's
    // signature-shape validation accepts it, exactly as a real Iris attestation would.
    const signature = ("0x" + "cc".repeat(MOCK_SIG_BYTES)) as Hex;
    return { message, signature };
  }
}

/**
 * The operator-gated fail-loud error for the live CCTP round-trip. Mirrors
 * RequiresLiveBuyerError: a readonly `code` discriminant + a message naming the
 * missing funded source EOA and the live Iris service. The live path is NEVER run
 * by the autonomous suite.
 */
export class RequiresLiveCctp extends Error {
  readonly code = "requiresLiveCctp" as const;
  constructor() {
    super(
      "The live CCTP funding round-trip requires a funded source-chain EOA and the " +
        "Circle Iris attestation service (CCTP_*_PRIVATE_KEY + IRIS_URL) in " +
        ".env.local. It broadcasts an irreversible cross-chain burn/mint; it is " +
        "operator-gated and not run autonomously.",
    );
    this.name = "RequiresLiveCctp";
  }
}

/**
 * LiveCctp - the operator-gated live attestation source. A real run polls Circle's
 * Iris service for the attestation over a real burn. It is fail-loud: `attest`
 * throws RequiresLiveCctp so the autonomous suite never reaches the live Iris path.
 */
export class LiveCctp implements AttestationSource {
  readonly kind = "live" as const;

  async attest(_message: Hex): Promise<Attestation> {
    throw new RequiresLiveCctp();
  }
}

/** The minimum signed-attestation length the funder requires (0x + at least one byte). */
const MIN_SIGNED_HEX_LENGTH = "0x".length + "ff".length;
/** The mock Iris signature size in bytes (a fixed deterministic non-empty blob). */
const MOCK_SIG_BYTES = 65;

/**
 * The process-local replay-dedup store: an in-memory set of claimed burn-message
 * keys. The default when no durable NonceStore is injected. It dedups within one
 * process; production should inject a durable store so a replay across processes or
 * restarts is also rejected.
 */
export class InMemoryNonceStore implements NonceStore {
  private readonly seen = new Set<string>();

  async claim(key: string): Promise<boolean> {
    if (this.seen.has(key)) {
      return false;
    }
    this.seen.add(key);
    return true;
  }
}

/**
 * The light attestation verifier: asserts the attestation carries a non-empty,
 * hex-shaped signature. This is the autonomous/mock default - it is a SHAPE check,
 * not a real signature verification (we never hand-roll secp256k1 recovery; that is
 * Circle's / the on-chain transmitter's job). The live path must inject a real
 * verifier instead (CctpFunder rejects this default for a live attestation source).
 */
export class ShapeAttestationVerifier implements AttestationVerifier {
  readonly kind = "shape" as const;

  verify(att: Attestation): void {
    assertSignedAttestation(att);
  }
}

/**
 * CctpFunder runs the burn -> attest -> mint -> credit flow against the injected
 * chain writer + attestation source + escrow store. The DEFAULT auto-credit is
 * poll-and-credit: the funder explicitly calls receiveMessage then credits the
 * escrow - it never assumes a CCTP hook auto-credits (08-RESEARCH Pitfall 2).
 */
export class CctpFunder {
  private readonly deps: CctpFunderDeps;
  private readonly nonces: NonceStore;
  private readonly verifier: AttestationVerifier;

  constructor(deps: CctpFunderDeps) {
    this.deps = deps;
    // Default the replay-dedup store to a process-local one and the verifier to the
    // light shape check. The shape verifier is rejected below when the attestation
    // source is live (a live mint requires a real signature verifier).
    this.nonces = deps.nonces ?? new InMemoryNonceStore();
    this.verifier = deps.verifier ?? new ShapeAttestationVerifier();
  }

  /**
   * Fund the escrow balance of `recipient` by burning `amount` USDC base units on
   * `srcChain` and minting it on Arc. The destination domain is the pinned
   * CCTP_DOMAIN (never a bare literal).
   *
   * @param srcChain  The CCTP source chain identifier (where the burn happens).
   * @param amount    The base-unit USDC amount to bridge.
   * @param recipient The escrow account credited with the minted USDC.
   */
  async fund(srcChain: string, amount: bigint, recipient: Address): Promise<FundResult> {
    // (1) BURN on the source chain. Destination domain = the pinned CCTP_DOMAIN
    // import (authoritative Arc value), never a bare literal (08-RESEARCH Pitfall 1).
    const burn = await this.deps.writer.depositForBurn({
      tokenMessenger: CCTP_TOKEN_MESSENGER,
      destinationDomain: CCTP_DOMAIN,
      amount,
      recipient,
      srcChain,
    });

    // (2) ATTEST: obtain the Iris attestation (mock default | live gated). REJECT a
    // malformed/unsigned attestation BEFORE receiveMessage (T-08-CCTPREPLAY): only
    // Iris-signed attestations are consumed; the mock is signed, never forged. The
    // verification runs through the injectable verifier seam. A LIVE attestation
    // source mints irreversibly, so it REQUIRES a real injected verifier - the light
    // shape default is refused there so a forged attestation can never mint.
    const att = await this.deps.attestation.attest(burn.message);
    if (this.deps.attestation.kind === "live" && this.verifier.kind !== "live") {
      throw new Error(
        "CctpFunder: refusing to mint - a live attestation source requires a real " +
          "(non-shape) attestation verifier; the light shape check is not a " +
          "signature verification (T-08-CCTPREPLAY)",
      );
    }
    await this.verifier.verify(att);

    // (2b) REPLAY-DEDUP (T-08-CCTPREPLAY): each burn message carries a unique nonce,
    // so the burn message is the dedup key. Atomically claim it BEFORE the mint so a
    // replayed or retried attestation over the same message cannot double-credit the
    // escrow. A second claim of the same key is rejected without minting or crediting.
    const claimed = await this.nonces.claim(att.message);
    if (!claimed) {
      throw new Error(
        "CctpFunder: refusing to mint - this CCTP attestation was already consumed " +
          "(replayed/retried message nonce; T-08-CCTPREPLAY)",
      );
    }

    // (3) MINT on Arc via receiveMessage (poll-and-credit: explicit, no auto-hook).
    // The transmitter mints the amount encoded in the ATTESTED message - we do NOT pass
    // the requested `amount` in as the minted amount (WR-03). CCTP can deduct a fee, so
    // the actual mint is frequently < the requested burn.
    const mint = await this.deps.writer.receiveMessage({
      messageTransmitter: CCTP_MESSAGE_TRANSMITTER,
      message: att.message,
      attestation: att.signature,
    });

    // WR-03: the minted amount can never EXCEED the requested burn (you cannot mint more
    // than you burned). Reject an over-mint so a buggy/lying writer cannot over-credit the
    // escrow with USDC the protocol never delivered on-chain.
    if (mint.mintedAmount > amount) {
      throw new Error(
        "CctpFunder: refusing to credit - the attested minted amount exceeds the " +
          "requested burn (a CCTP mint can never exceed the burn; WR-03)",
      );
    }

    // (4) CREDIT the escrow balance by the AMOUNT ACTUALLY MINTED (strictly after the
    // mint), so CCTP fees are respected and the credit never exceeds what was minted.
    await this.deps.escrow.credit(recipient, mint.mintedAmount);

    return { minted: mint.mintedAmount, burnTx: burn.txHash, mintTx: mint.txHash };
  }
}

/**
 * Reject a malformed/unsigned attestation BEFORE it is submitted to receiveMessage
 * (T-08-CCTPREPLAY / 08-RESEARCH Security Domain). We never hand-roll the secp256k1
 * recovery (that is Circle's / the on-chain transmitter's job); we assert the
 * attestation carries a non-empty, hex-shaped signature so an obviously
 * forged/unsigned attestation never reaches the mint.
 */
function assertSignedAttestation(att: Attestation): void {
  if (!/^0x[0-9a-fA-F]+$/.test(att.signature) || att.signature.length < MIN_SIGNED_HEX_LENGTH) {
    throw new Error(
      "CctpFunder: refusing to mint - the CCTP attestation is unsigned or malformed " +
        "(only Iris-signed attestations are consumed; T-08-CCTPREPLAY)",
    );
  }
}
