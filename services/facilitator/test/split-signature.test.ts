// splitSignature suite (WR-06): the exact-path signature split must reject a
// malformed (wrong-length) signature and a high-s (EIP-2 malleable) signature
// BEFORE the relayer submits it on-chain to revert opaquely. A canonical low-s
// 65-byte signature is accepted and yields the 27/28 v ERC-3009 expects.
import { describe, it, expect } from "vitest";
import { createWalletClient, http, parseSignature, type Hex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { arcTestnet, USDC, PAYMENT_SPLITTER } from "@utter/chain";
import { signExactTransfer } from "@utter/x402-arc";
import { splitSignature } from "../src/settle";

/** Half the secp256k1 curve order; an s above this is the malleable high-s sibling. */
const SECP256K1_N =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_HALF_N = SECP256K1_N / 2n;

describe("splitSignature (WR-06)", () => {
  it("accepts a canonical low-s 65-byte signature and returns v in {27,28}", async () => {
    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);
    const wallet = createWalletClient({
      account,
      chain: arcTestnet,
      transport: http(arcTestnet.rpcUrls.default.http[0]),
    });
    const signed = await signExactTransfer(wallet, {
      from: account.address,
      to: PAYMENT_SPLITTER,
      value: 1_000n,
      validAfter: 0n,
      validBefore: BigInt(Math.floor(Date.now() / 1000) + 300),
      nonce: `0x${"ab".repeat(32)}`,
    });
    const { v, r, s } = splitSignature(signed.signature);
    expect([27, 28]).toContain(v);
    expect(r).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(s).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  it("rejects a signature that is not exactly 65 bytes", () => {
    const tooShort = ("0x" + "11".repeat(64)) as Hex; // 64 bytes, missing v
    expect(() => splitSignature(tooShort)).toThrow(/65 bytes/);
    const empty = "0x" as Hex;
    expect(() => splitSignature(empty)).toThrow(/65 bytes/);
  });

  it("rejects a high-s (EIP-2 malleable) signature", () => {
    // Build a syntactically valid 65-byte signature whose s is above n/2.
    const highS = SECP256K1_HALF_N + 1n;
    const r = ("0x" + "22".repeat(32)) as Hex;
    const s = ("0x" + highS.toString(16).padStart(64, "0")) as Hex;
    const sig = (r + s.slice(2) + "1b") as Hex; // v = 27
    // sanity: parseSignature agrees this is a high-s value (s is a hex string).
    expect(BigInt(parseSignature(sig).s)).toBeGreaterThan(SECP256K1_HALF_N);
    expect(() => splitSignature(sig)).toThrow(/high-s/);
  });
});
