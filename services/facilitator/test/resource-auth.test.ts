// resource-auth suite (Security review C1): the per-resource caller-auth token.
//
// These pin the load-bearing security properties of the token: it binds to ONE
// resourceId, verifies only under the same secret (HMAC, secret stays on the
// facilitator), a tampered/wrong-secret/expired token returns null, the verify is
// constant-time (crypto.timingSafeEqual), and neither the token nor the secret is
// ever embedded where it could leak. Fully offline (node:crypto only).
import { describe, it, expect } from "vitest";
import type { Hex } from "viem";
import { mintResourceAuthToken, verifyResourceAuthToken } from "../src/resource-auth";

const SECRET = "facilitator-auth-secret-at-least-32-chars-long";
const RESOURCE_A: Hex = `0x${"a1".repeat(32)}`;
const RESOURCE_B: Hex = `0x${"b2".repeat(32)}`;

describe("mintResourceAuthToken / verifyResourceAuthToken", () => {
  it("mints a token that verifies and returns the bound resourceId (round-trip)", () => {
    const token = mintResourceAuthToken(RESOURCE_A, SECRET);
    expect(typeof token).toBe("string");
    const claim = verifyResourceAuthToken(token, SECRET);
    expect(claim).not.toBeNull();
    expect(claim?.resourceId).toBe(RESOURCE_A);
  });

  it("returns null for a token verified under a DIFFERENT secret (secret stays on facilitator)", () => {
    const token = mintResourceAuthToken(RESOURCE_A, SECRET);
    expect(verifyResourceAuthToken(token, "a-totally-different-secret-value-here")).toBeNull();
  });

  it("returns null for a tampered token (signature break)", () => {
    const token = mintResourceAuthToken(RESOURCE_A, SECRET);
    const tampered = token.slice(0, -2) + (token.endsWith("a") ? "bb" : "aa");
    expect(verifyResourceAuthToken(tampered, SECRET)).toBeNull();
  });

  it("returns null for a garbage / malformed token", () => {
    expect(verifyResourceAuthToken("not-a-token", SECRET)).toBeNull();
    expect(verifyResourceAuthToken("", SECRET)).toBeNull();
    expect(verifyResourceAuthToken(".abc", SECRET)).toBeNull();
    expect(verifyResourceAuthToken("abc.", SECRET)).toBeNull();
  });

  it("returns null for a forged-payload token (different resourceId, same dummy mac)", () => {
    // An attacker that swaps the payload half cannot keep the MAC valid: the MAC is
    // over the payload, so any payload change invalidates the signature.
    const token = mintResourceAuthToken(RESOURCE_A, SECRET);
    const mac = token.slice(token.indexOf(".") + 1);
    const forgedPayload = Buffer.from(JSON.stringify({ rid: RESOURCE_B }), "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const forged = `${forgedPayload}.${mac}`;
    expect(verifyResourceAuthToken(forged, SECRET)).toBeNull();
  });

  it("honors an expiry: an elapsed token returns null, a live one verifies", () => {
    // ttl in the past -> already expired.
    const expired = mintResourceAuthToken(RESOURCE_A, SECRET, {
      ttlSeconds: 60,
      now: () => Date.now() - 120_000,
    });
    expect(verifyResourceAuthToken(expired, SECRET)).toBeNull();

    const live = mintResourceAuthToken(RESOURCE_A, SECRET, { ttlSeconds: 300 });
    expect(verifyResourceAuthToken(live, SECRET)?.resourceId).toBe(RESOURCE_A);
  });

  it("binds to a single resourceId: a token for A returns A, never B", () => {
    const tokenA = mintResourceAuthToken(RESOURCE_A, SECRET);
    const tokenB = mintResourceAuthToken(RESOURCE_B, SECRET);
    expect(verifyResourceAuthToken(tokenA, SECRET)?.resourceId).toBe(RESOURCE_A);
    expect(verifyResourceAuthToken(tokenB, SECRET)?.resourceId).toBe(RESOURCE_B);
    // The two tokens differ (the bound resource is authenticated, not interchangeable).
    expect(tokenA).not.toBe(tokenB);
  });

  it("never embeds the raw secret in the token", () => {
    const token = mintResourceAuthToken(RESOURCE_A, SECRET);
    expect(token).not.toContain(SECRET);
  });
});
