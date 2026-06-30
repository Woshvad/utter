// SCL-04 tests: CctpFunder runs the full burn -> mock-attest -> receiveMessage ->
// credit-escrow flow against a mock chain + mock attestation, with the CCTP
// destination domain pinned to 26 (from @utter/chain, never a literal 7), poll-and-
// credit as the default (CCTP hooks are opaque metadata, NOT auto-executed),
// attestation-signature validation (only Iris-signed attestations consumed), and a
// fail-loud LiveCctp (RequiresLiveCctp). No network/chain/Iris service is reached.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Address, Hex } from "viem";
import {
  CCTP_DOMAIN,
  CCTP_TOKEN_MESSENGER,
  CCTP_MESSAGE_TRANSMITTER,
} from "@utter/chain";
import {
  CctpFunder,
  MockAttestation,
  LiveCctp,
  RequiresLiveCctp,
  InMemoryNonceStore,
  ShapeAttestationVerifier,
  type CctpChainWriter,
  type EscrowCreditStore,
  type Attestation,
  type AttestationSource,
  type AttestationVerifier,
} from "../src/index";

const RECIPIENT = ("0x" + "ab".repeat(20)) as Address;
const SRC_CHAIN = "ethereum-sepolia";

/**
 * A mock chain writer recording the burn/receive calls (no real chain). The mint is
 * the AUTHORITATIVE on-chain mint: the writer reports what it minted (WR-03). By
 * default it mints the burned amount (no fee); `opts.mintedAmount` simulates a CCTP
 * fee (attested mint < requested burn) or a lying/buggy writer (mint > burn).
 */
function mockChainWriter(opts: { mintedAmount?: bigint } = {}): CctpChainWriter & {
  burns: Array<{ address: Address; destinationDomain: number; amount: bigint }>;
  receives: Array<{ address: Address; message: Hex; attestation: Hex }>;
} {
  const burns: Array<{ address: Address; destinationDomain: number; amount: bigint }> = [];
  const receives: Array<{ address: Address; message: Hex; attestation: Hex }> = [];
  let lastBurnAmount = 0n;
  return {
    burns,
    receives,
    async depositForBurn(args) {
      lastBurnAmount = args.amount;
      burns.push({
        address: args.tokenMessenger,
        destinationDomain: args.destinationDomain,
        amount: args.amount,
      });
      // Return the burn message the source emits (mock: encodes the amount).
      return { message: ("0x" + "11".repeat(32)) as Hex, txHash: ("0x" + "22".repeat(32)) as Hex };
    },
    async receiveMessage(args) {
      receives.push({
        address: args.messageTransmitter,
        message: args.message,
        attestation: args.attestation,
      });
      // The mint reports the AUTHORITATIVE minted amount (the attested message value).
      // Default: the full burn (no fee). Override simulates a fee or an over-mint.
      const mintedAmount = opts.mintedAmount ?? lastBurnAmount;
      return { mintedAmount, txHash: ("0x" + "33".repeat(32)) as Hex };
    },
  };
}

/** An in-memory escrow credit store (the mock PaymentEscrow balance). */
function mockEscrowStore(): EscrowCreditStore & { balances: Map<string, bigint> } {
  const balances = new Map<string, bigint>();
  return {
    balances,
    async credit(account, amount) {
      const key = account.toLowerCase();
      balances.set(key, (balances.get(key) ?? 0n) + amount);
      return balances.get(key)!;
    },
  };
}

describe("CctpFunder.fund (burn -> mock-attest -> receiveMessage -> credit)", () => {
  it("runs the full flow and credits the escrow balance by the minted amount", async () => {
    const writer = mockChainWriter();
    const escrow = mockEscrowStore();
    const funder = new CctpFunder({
      writer,
      escrow,
      attestation: new MockAttestation(),
    });
    const amount = 7_000_000n;
    const result = await funder.fund(SRC_CHAIN, amount, RECIPIENT);

    expect(writer.burns).toHaveLength(1);
    expect(writer.receives).toHaveLength(1);
    expect(result.minted).toBe(amount);
    expect(escrow.balances.get(RECIPIENT.toLowerCase())).toBe(amount);
    // burn went to the pinned TokenMessenger; receive to the pinned MessageTransmitter.
    expect(writer.burns[0]!.address.toLowerCase()).toBe(
      CCTP_TOKEN_MESSENGER.toLowerCase(),
    );
    expect(writer.receives[0]!.address.toLowerCase()).toBe(
      CCTP_MESSAGE_TRANSMITTER.toLowerCase(),
    );
  });

  it("WR-03: credits the ATTESTED minted amount, not the requested burn (respects CCTP fees)", async () => {
    // The attested mint is LESS than the requested burn (a CCTP fee was deducted).
    const requested = 7_000_000n;
    const minted = 6_900_000n; // requested minus a 0.1 USDC fee
    const writer = mockChainWriter({ mintedAmount: minted });
    const escrow = mockEscrowStore();
    const funder = new CctpFunder({ writer, escrow, attestation: new MockAttestation() });

    const result = await funder.fund(SRC_CHAIN, requested, RECIPIENT);

    // The escrow is credited the SMALLER attested amount, never the requested burn -
    // so a buyer is never credited USDC the protocol did not actually deliver on-chain.
    expect(result.minted).toBe(minted);
    expect(escrow.balances.get(RECIPIENT.toLowerCase())).toBe(minted);
    expect(escrow.balances.get(RECIPIENT.toLowerCase())).not.toBe(requested);
  });

  it("WR-03: rejects an over-mint (writer reports minted > burn) - no over-credit", async () => {
    // A lying/buggy writer claims it minted MORE than was burned: refuse to credit.
    const requested = 1_000_000n;
    const writer = mockChainWriter({ mintedAmount: requested + 1n });
    const escrow = mockEscrowStore();
    const funder = new CctpFunder({ writer, escrow, attestation: new MockAttestation() });

    await expect(funder.fund(SRC_CHAIN, requested, RECIPIENT)).rejects.toThrow(
      /exceeds the requested burn|WR-03/i,
    );
    // Nothing was credited - the over-mint never reached the escrow balance.
    expect(escrow.balances.size).toBe(0);
  });

  it("uses the CCTP destination domain 26 from the pinned constant (never a literal 7)", async () => {
    const writer = mockChainWriter();
    const funder = new CctpFunder({
      writer,
      escrow: mockEscrowStore(),
      attestation: new MockAttestation(),
    });
    await funder.fund(SRC_CHAIN, 1_000_000n, RECIPIENT);
    expect(writer.burns[0]!.destinationDomain).toBe(CCTP_DOMAIN);
    expect(writer.burns[0]!.destinationDomain).toBe(26);
  });

  it("poll-and-credit is the default: no credit without an explicit receiveMessage + credit", async () => {
    const writer = mockChainWriter();
    const escrow = mockEscrowStore();
    const creditSpy = vi.spyOn(escrow, "credit");
    const receiveSpy = vi.spyOn(writer, "receiveMessage");
    const funder = new CctpFunder({
      writer,
      escrow,
      attestation: new MockAttestation(),
    });
    // Before fund(): no auto-hook ever credited anything.
    expect(escrow.balances.size).toBe(0);
    await funder.fund(SRC_CHAIN, 1_000_000n, RECIPIENT);
    // The credit happened strictly AFTER an explicit receiveMessage call (poll-and-credit).
    expect(receiveSpy).toHaveBeenCalledTimes(1);
    expect(creditSpy).toHaveBeenCalledTimes(1);
    expect(receiveSpy.mock.invocationCallOrder[0]!).toBeLessThan(
      creditSpy.mock.invocationCallOrder[0]!,
    );
  });

  it("rejects a malformed/unsigned attestation BEFORE receiveMessage (T-08-CCTPREPLAY)", async () => {
    const writer = mockChainWriter();
    const escrow = mockEscrowStore();
    // An attestation source that returns an unsigned (forged) attestation.
    const forged = {
      kind: "mock" as const,
      async attest(): Promise<Attestation> {
        return { message: ("0x" + "11".repeat(32)) as Hex, signature: "0x" as Hex };
      },
    };
    const funder = new CctpFunder({ writer, escrow, attestation: forged });
    await expect(funder.fund(SRC_CHAIN, 1_000_000n, RECIPIENT)).rejects.toThrow(
      /attestation/i,
    );
    // The forged attestation never reached receiveMessage, never credited.
    expect(writer.receives).toHaveLength(0);
    expect(escrow.balances.size).toBe(0);
  });
});

describe("CctpFunder replay-dedup (T-08-CCTPREPLAY: a replayed attestation cannot double-credit)", () => {
  it("rejects a replayed attestation (same message nonce) and credits the escrow only once", async () => {
    // A SHARED nonce store across two fund() calls (the production durability shape).
    // MockAttestation always attests the SAME fixed burn message, so the second call
    // replays the same nonce and must be rejected without a second credit.
    const nonces = new InMemoryNonceStore();
    const escrow = mockEscrowStore();
    const writer1 = mockChainWriter();
    const funder1 = new CctpFunder({
      writer: writer1,
      escrow,
      attestation: new MockAttestation(),
      nonces,
    });
    const amount = 4_000_000n;
    const first = await funder1.fund(SRC_CHAIN, amount, RECIPIENT);
    expect(first.minted).toBe(amount);
    expect(escrow.balances.get(RECIPIENT.toLowerCase())).toBe(amount);

    // Replay: a fresh funder sharing the SAME nonce store + the same attested message.
    const writer2 = mockChainWriter();
    const funder2 = new CctpFunder({
      writer: writer2,
      escrow,
      attestation: new MockAttestation(),
      nonces,
    });
    await expect(funder2.fund(SRC_CHAIN, amount, RECIPIENT)).rejects.toThrow(
      /already consumed|replayed|T-08-CCTPREPLAY/i,
    );
    // The replay never minted and never credited a second time.
    expect(writer2.receives).toHaveLength(0);
    expect(escrow.balances.get(RECIPIENT.toLowerCase())).toBe(amount);
  });

  it("a first-seen nonce is claimed (the happy path is not blocked by the dedup)", async () => {
    const claimed = await new InMemoryNonceStore().claim("0xdeadbeef");
    expect(claimed).toBe(true);
  });
});

describe("CctpFunder attestation verifier seam (live requires a real verifier)", () => {
  /** A live attestation source that returns a well-shaped (but live-path) attestation. */
  function liveLookingSource(): AttestationSource {
    return {
      kind: "live",
      async attest(message): Promise<Attestation> {
        return { message, signature: ("0x" + "cc".repeat(65)) as Hex };
      },
    };
  }

  it("refuses to mint when the source is live but only the default shape verifier is present", async () => {
    const writer = mockChainWriter();
    const escrow = mockEscrowStore();
    // No verifier injected => the light ShapeAttestationVerifier default, which is
    // rejected for a live source even though the signature is well-shaped.
    const funder = new CctpFunder({
      writer,
      escrow,
      attestation: liveLookingSource(),
    });
    await expect(funder.fund(SRC_CHAIN, 1_000_000n, RECIPIENT)).rejects.toThrow(
      /requires a real.*verifier|shape check is not a signature/i,
    );
    expect(writer.receives).toHaveLength(0);
    expect(escrow.balances.size).toBe(0);
  });

  it("mints on a live source when a real (kind:'live') verifier is injected", async () => {
    const writer = mockChainWriter();
    const escrow = mockEscrowStore();
    const realVerifier: AttestationVerifier = {
      kind: "live",
      async verify() {
        // A stub standing in for a real secp256k1 / Iris-public-key check.
      },
    };
    const funder = new CctpFunder({
      writer,
      escrow,
      attestation: liveLookingSource(),
      verifier: realVerifier,
    });
    const result = await funder.fund(SRC_CHAIN, 1_000_000n, RECIPIENT);
    expect(result.minted).toBe(1_000_000n);
    expect(escrow.balances.get(RECIPIENT.toLowerCase())).toBe(1_000_000n);
  });

  it("the verifier seam still rejects a malformed attestation via the shape default", async () => {
    const verifier = new ShapeAttestationVerifier();
    expect(() =>
      verifier.verify({ message: ("0x" + "11".repeat(32)) as Hex, signature: "0x" as Hex }),
    ).toThrow(/attestation/i);
  });
});

describe("MockAttestation (the deterministic autonomous default)", () => {
  it("produces an Iris-signed-shaped attestation that the funder accepts", async () => {
    const att = new MockAttestation();
    const out = await att.attest(("0x" + "11".repeat(32)) as Hex);
    expect(out.signature).toMatch(/^0x[0-9a-fA-F]+$/);
    expect(out.signature.length).toBeGreaterThan(2); // non-empty = signed shape
  });
});

describe("LiveCctp (operator-gated, fail-loud)", () => {
  it("throws RequiresLiveCctp with the code discriminant", async () => {
    const live = new LiveCctp();
    await expect(live.attest(("0x" + "11".repeat(32)) as Hex)).rejects.toBeInstanceOf(
      RequiresLiveCctp,
    );
    try {
      await live.attest(("0x" + "11".repeat(32)) as Hex);
    } catch (err) {
      expect((err as RequiresLiveCctp).code).toBe("requiresLiveCctp");
    }
  });
});

describe("no decimals literal / no bare domain literal in cctp-funder.ts", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/cctp-funder.ts", import.meta.url)),
    "utf8",
  );
  // strip comments before scanning (prose mentions "domain 26" / "6dp")
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("contains no 6 / 1e6 / 10**6 decimals literal", () => {
    expect(code).not.toMatch(/\b1e6\b/);
    expect(code).not.toMatch(/10\s*\*\*\s*6/);
    expect(code).not.toMatch(/\b6\b/);
  });

  it("contains no bare 7 or bare 26 domain literal (domain comes from CCTP_DOMAIN import)", () => {
    expect(code).not.toMatch(/\b7\b/);
    expect(code).not.toMatch(/\b26\b/);
    expect(code).toMatch(/CCTP_DOMAIN/);
  });
});
