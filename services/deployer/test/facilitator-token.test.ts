// facilitator-token.test.ts - the deployer-side caller-auth token mint helper (C1,
// wave BC1).
//
// Proves mintFacilitatorToken REUSES the facilitator's HMAC (the minted token
// round-trips with verifyResourceAuthToken back to the bound resourceId), validates
// the secret (a short/blank secret throws a value-free error so a misconfig fails loud
// rather than 401-ing every paid call), and defaults to a NON-EXPIRING token.
import { describe, it, expect } from "vitest";
import type { Hex } from "viem";
import { mintResourceAuthToken, verifyResourceAuthToken } from "@utter/facilitator/index";
import {
  mintFacilitatorToken,
  MIN_FACILITATOR_AUTH_SECRET_LENGTH,
} from "../src/facilitator-token";

const RID = `0x${"cd".repeat(32)}` as Hex;
// A >=32 char secret (the production minimum).
const SECRET = "a".repeat(MIN_FACILITATOR_AUTH_SECRET_LENGTH);
const OTHER_SECRET = "b".repeat(MIN_FACILITATOR_AUTH_SECRET_LENGTH);

describe("mintFacilitatorToken (reuses mintResourceAuthToken; secret validation)", () => {
  it("round-trips with verifyResourceAuthToken to the bound resourceId (same secret)", () => {
    const token = mintFacilitatorToken({ resourceId: RID, secret: SECRET });
    const claim = verifyResourceAuthToken(token, SECRET);
    expect(claim).not.toBeNull();
    expect(claim?.resourceId).toBe(RID);
  });

  it("verifies to null under a WRONG secret (the secret gates forgery)", () => {
    const token = mintFacilitatorToken({ resourceId: RID, secret: SECRET });
    expect(verifyResourceAuthToken(token, OTHER_SECRET)).toBeNull();
  });

  it("produces the SAME token as the underlying mintResourceAuthToken (reuse, not reimpl)", () => {
    // No ttl -> the helper delegates to mintResourceAuthToken with no exp, so the
    // outputs are byte-identical (the HMAC lives in ONE place).
    const viaHelper = mintFacilitatorToken({ resourceId: RID, secret: SECRET });
    const viaCore = mintResourceAuthToken(RID, SECRET, { ttlSeconds: undefined });
    expect(viaHelper).toBe(viaCore);
  });

  it("defaults to a NON-EXPIRING token (no exp claim; verifies indefinitely)", () => {
    const token = mintFacilitatorToken({ resourceId: RID, secret: SECRET });
    // The payload half decodes to JSON with rid but NO exp.
    const encoded = token.slice(0, token.indexOf("."));
    const json = Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf8",
    );
    const payload = JSON.parse(json) as Record<string, unknown>;
    expect(payload.rid).toBe(RID);
    expect("exp" in payload).toBe(false);
  });

  it("mints an expiring token when ttlSeconds is provided (and it still verifies)", () => {
    const token = mintFacilitatorToken({ resourceId: RID, secret: SECRET, ttlSeconds: 3600 });
    const encoded = token.slice(0, token.indexOf("."));
    const json = Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf8",
    );
    const payload = JSON.parse(json) as Record<string, unknown>;
    expect(typeof payload.exp).toBe("number");
    expect(verifyResourceAuthToken(token, SECRET)?.resourceId).toBe(RID);
  });

  it("throws (value-free) on a short secret (< the production minimum)", () => {
    const short = "a".repeat(MIN_FACILITATOR_AUTH_SECRET_LENGTH - 1);
    expect(() => mintFacilitatorToken({ resourceId: RID, secret: short })).toThrow(
      /at least 32 characters/,
    );
    // The error must NEVER contain the secret value.
    try {
      mintFacilitatorToken({ resourceId: RID, secret: short });
    } catch (err) {
      expect((err as Error).message).not.toContain(short);
    }
  });

  it("throws on a blank/empty secret", () => {
    expect(() => mintFacilitatorToken({ resourceId: RID, secret: "" })).toThrow(/at least 32/);
    expect(() => mintFacilitatorToken({ resourceId: RID, secret: "   " })).toThrow(/at least 32/);
  });
});
