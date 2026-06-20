// size-cap.test.ts - the HARD request/response size cap (SBX-04 size clause),
// and the distinct-from-metering invariant. Pure; no container launch.
import { describe, expect, it } from "vitest";
import { computeMeteredAmount, type Pricing } from "@utter/x402-arc";
import {
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_MAX_RESPONSE_BYTES,
  SizeCapError,
  byteLengthOf,
  enforceRequestSizeCap,
  enforceResponseSizeCap,
  maxRequestBytesFromEnv,
  maxResponseBytesFromEnv,
} from "../src/runner/size-cap";

describe("size-cap - request (HARD reject before the handler runs)", () => {
  it("REJECTS an oversize request body with a 413 SizeCapError", () => {
    const body = "x".repeat(11);
    let err: unknown;
    try {
      enforceRequestSizeCap(body, 10);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SizeCapError);
    expect((err as SizeCapError).status).toBe(413);
    expect((err as SizeCapError).reason).toBe("request_too_large");
    expect((err as SizeCapError).limit).toBe(10);
    expect((err as SizeCapError).actual).toBe(11);
  });

  it("passes an at-limit request body unchanged", () => {
    const body = "x".repeat(10);
    expect(enforceRequestSizeCap(body, 10)).toBe(body);
  });

  it("passes an under-limit request body unchanged", () => {
    expect(enforceRequestSizeCap("hi", 10)).toBe("hi");
  });

  it("measures multibyte utf8 by bytes, not chars", () => {
    // "€" is 3 bytes in utf8.
    expect(byteLengthOf("€€")).toBe(6);
    expect(() => enforceRequestSizeCap("€€", 5)).toThrow(SizeCapError);
  });

  it("accepts raw bytes (Uint8Array) too", () => {
    expect(() => enforceRequestSizeCap(new Uint8Array(11), 10)).toThrow(SizeCapError);
  });
});

describe("size-cap - response (HARD reject at egress; mode = reject)", () => {
  it("REJECTS an oversize response body with a 502 SizeCapError", () => {
    let err: unknown;
    try {
      enforceResponseSizeCap("y".repeat(11), 10);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SizeCapError);
    expect((err as SizeCapError).status).toBe(502);
    expect((err as SizeCapError).reason).toBe("response_too_large");
  });

  it("passes an at/under-limit response body unchanged", () => {
    expect(enforceResponseSizeCap("y".repeat(10), 10)).toBe("y".repeat(10));
    expect(enforceResponseSizeCap("ok", 10)).toBe("ok");
  });
});

describe("size-cap - env-driven limits", () => {
  it("derives the request cap from MAX_REQUEST_BYTES", () => {
    expect(maxRequestBytesFromEnv({ MAX_REQUEST_BYTES: "2048" } as NodeJS.ProcessEnv)).toBe(2048);
  });
  it("derives the response cap from MAX_RESPONSE_BYTES", () => {
    expect(maxResponseBytesFromEnv({ MAX_RESPONSE_BYTES: "4096" } as NodeJS.ProcessEnv)).toBe(4096);
  });
  it("falls back to the documented defaults when env is unset", () => {
    expect(maxRequestBytesFromEnv({} as NodeJS.ProcessEnv)).toBe(DEFAULT_MAX_REQUEST_BYTES);
    expect(maxResponseBytesFromEnv({} as NodeJS.ProcessEnv)).toBe(DEFAULT_MAX_RESPONSE_BYTES);
  });
});

describe("size-cap - DISTINCT from the metering pricing clamp", () => {
  const pricing: Pricing = {
    model: "metered",
    base: "0",
    perKB: "1000", // 1000 base units per KiB - makes the size term visible
    computeMultiplier: "0",
    maxResponseBytes: 1024, // the metering clamp bounds the BILLED size term at 1 KiB
  };

  it("the size cap trips on an oversize body; metering only clamps the CHARGE", () => {
    const oversize = "z".repeat(2048); // 2 KiB

    // 1. The HARD size cap REJECTS the oversize body (the bytes are bounded).
    expect(() => enforceResponseSizeCap(oversize, 1024)).toThrow(SizeCapError);

    // 2. metering's clamp does NOT reject - it returns a CHARGE, bounding the
    //    size *term* at maxResponseBytes (1 KiB = 1 unit) regardless of body.
    const charge2k = computeMeteredAmount(pricing, 2048, 0, 10_000_000n);
    const charge1k = computeMeteredAmount(pricing, 1024, 0, 10_000_000n);
    // Both clamp to the same 1-KiB size term -> identical charge -> proves the
    // clamp bounds the CHARGE, not the bytes (it never threw, never truncated).
    expect(charge2k).toBe(charge1k);
    expect(charge2k).toBe(1000n);
  });

  it("the two are independent: a body under the size cap still meters normally", () => {
    const ok = "z".repeat(512); // under both caps
    expect(enforceResponseSizeCap(ok, 1024)).toBe(ok);
    // metering still computes a charge for it (1 KiB-rounded size term).
    expect(computeMeteredAmount(pricing, 512, 0, 10_000_000n)).toBe(1000n);
  });
});
