// PaymentPayload base64 codec suite (codec.ts; Pitfall 5 x402 v2 wire; ASVS V5).
// encode -> decode is a lossless round-trip; decode validates address/bytes32/uint
// bounds and REJECTS malformed base64/JSON/out-of-bounds (no partial coercion).
// Offline unit test - no env.
import { describe, it, expect } from "vitest";
import { encodePayment, decodePayment } from "../src/codec";
import type { PaymentPayload } from "../src/codec";

const buyer = "0x00000000000000000000000000000000000000bb" as const;
const resourceId =
  "0x2222222222222222222222222222222222222222222222222222222222222222" as const;
const nonce =
  "0x3333333333333333333333333333333333333333333333333333333333333333" as const;

const payload: PaymentPayload = {
  x402Version: 2,
  scheme: "utter-escrow",
  network: "eip155:5042002",
  authorization: {
    buyer,
    resourceId,
    maxAmount: "10000",
    nonce,
    validBefore: "1999999999",
  },
  signature:
    "0x4444444444444444444444444444444444444444444444444444444444444444555555555555555555555555555555555555555555555555555555555555555501",
};

describe("PaymentPayload codec round-trip", () => {
  it("encodes to a base64 string and decodes back to identical fields", () => {
    const header = encodePayment(payload);
    expect(typeof header).toBe("string");
    // base64 only (no JSON braces leaking through)
    expect(header).not.toContain("{");

    const decoded = decodePayment(header);
    expect(decoded).toEqual(payload);
  });
});

describe("codec decodePayment input validation (ASVS V5)", () => {
  it("throws on non-base64 / malformed input (does not return a partial object)", () => {
    expect(() => decodePayment("not-base64!!")).toThrow();
  });

  it("throws on valid base64 that is not JSON", () => {
    const notJson = Buffer.from("hello world", "utf8").toString("base64");
    expect(() => decodePayment(notJson)).toThrow();
  });

  it("rejects an invalid buyer address", () => {
    const bad = encodePayment({
      ...payload,
      authorization: { ...payload.authorization, buyer: "0xnotanaddress" as never },
    });
    expect(() => decodePayment(bad)).toThrow();
  });

  it("rejects a bytes32 nonce of the wrong length", () => {
    const bad = encodePayment({
      ...payload,
      authorization: { ...payload.authorization, nonce: "0xabcd" as never },
    });
    expect(() => decodePayment(bad)).toThrow();
  });

  it("rejects a negative / non-numeric maxAmount (out-of-bounds uint)", () => {
    const bad = encodePayment({
      ...payload,
      authorization: { ...payload.authorization, maxAmount: "-1" },
    });
    expect(() => decodePayment(bad)).toThrow();
  });
});
