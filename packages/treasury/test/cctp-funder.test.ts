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
  type CctpChainWriter,
  type EscrowCreditStore,
  type Attestation,
} from "../src/index";

const RECIPIENT = ("0x" + "ab".repeat(20)) as Address;
const SRC_CHAIN = "ethereum-sepolia";

/** A mock chain writer recording the burn/receive calls (no real chain). */
function mockChainWriter(): CctpChainWriter & {
  burns: Array<{ address: Address; destinationDomain: number; amount: bigint }>;
  receives: Array<{ address: Address; message: Hex; attestation: Hex }>;
} {
  const burns: Array<{ address: Address; destinationDomain: number; amount: bigint }> = [];
  const receives: Array<{ address: Address; message: Hex; attestation: Hex }> = [];
  return {
    burns,
    receives,
    async depositForBurn(args) {
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
      return { mintedAmount: args.mintedAmount, txHash: ("0x" + "33".repeat(32)) as Hex };
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
