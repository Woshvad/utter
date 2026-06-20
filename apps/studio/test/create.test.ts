// create.test.ts - STU-01 composer validation + action tests.
//
// Covers: (1) validateComposeSpec rejects empty/over-long prompt, malformed pricing,
// non-positive bond, and a non-address payout - WITHOUT producing a spec
// (reject-before-create, T-06-INPUTVAL); (2) a valid spec parses bond/price to
// base-unit bigints with no money literal; (3) the action runs validation first and
// only calls adapter.createResource on success, returning { resourceId, eventsUrl }.
import { describe, it, expect, vi } from "vitest";
import {
  validateComposeSpec,
  parseUsdcToBaseUnits,
  PROMPT_MAX,
} from "../app/validation/compose";

const GOOD = {
  prompt: "return the current weather for a city",
  pricingModel: "flat",
  basePrice: "0.010000",
  bond: "5.000000",
  payout: "0x1111111111111111111111111111111111111111",
};

describe("parseUsdcToBaseUnits", () => {
  it("parses a decimal USDC string to base units using the runtime decimals", () => {
    expect(parseUsdcToBaseUnits("0.010000", 6)).toBe(10000n);
    expect(parseUsdcToBaseUnits("5", 6)).toBe(5000000n);
    expect(parseUsdcToBaseUnits("1.5", 6)).toBe(1500000n);
  });

  it("rejects more fractional precision than the token decimals supports", () => {
    expect(parseUsdcToBaseUnits("0.0000001", 6)).toBeNull();
  });

  it("rejects non-numeric, signed, or exponent strings", () => {
    expect(parseUsdcToBaseUnits("abc", 6)).toBeNull();
    expect(parseUsdcToBaseUnits("-1", 6)).toBeNull();
    expect(parseUsdcToBaseUnits("1e6", 6)).toBeNull();
  });
});

describe("validateComposeSpec", () => {
  it("accepts a valid spec and returns base-unit bigint money", () => {
    const result = validateComposeSpec(GOOD, 6);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.basePrice).toBe(10000n);
      expect(result.spec.bond).toBe(5000000n);
      expect(typeof result.spec.basePrice).toBe("bigint");
      expect(result.spec.pricingModel).toBe("flat");
      expect(result.spec.payout).toBe(GOOD.payout);
    }
  });

  it("rejects an empty prompt with a field error (no spec)", () => {
    const result = validateComposeSpec({ ...GOOD, prompt: "" }, 6);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.prompt).toBeTruthy();
  });

  it("rejects an over-long prompt", () => {
    const result = validateComposeSpec({ ...GOOD, prompt: "x".repeat(PROMPT_MAX + 1) }, 6);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.prompt).toBeTruthy();
  });

  it("rejects a malformed pricing model", () => {
    const result = validateComposeSpec({ ...GOOD, pricingModel: "freemium" }, 6);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.pricingModel).toBeTruthy();
  });

  it("rejects a non-positive bond", () => {
    const result = validateComposeSpec({ ...GOOD, bond: "0" }, 6);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.bond).toBeTruthy();
  });

  it("rejects a non-positive price", () => {
    const result = validateComposeSpec({ ...GOOD, basePrice: "0" }, 6);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.basePrice).toBeTruthy();
  });

  it("rejects a non-address payout", () => {
    const result = validateComposeSpec({ ...GOOD, payout: "0xnothex" }, 6);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.payout).toBeTruthy();
  });

  it("accumulates multiple field errors at once", () => {
    const result = validateComposeSpec(
      { prompt: "", pricingModel: "x", basePrice: "x", bond: "x", payout: "x" },
      6,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.prompt).toBeTruthy();
      expect(result.errors.pricingModel).toBeTruthy();
      expect(result.errors.basePrice).toBeTruthy();
      expect(result.errors.bond).toBeTruthy();
      expect(result.errors.payout).toBeTruthy();
    }
  });
});

describe("create action", () => {
  /** Build a POST Request with a urlencoded body the action can read. */
  function postRequest(fields: Record<string, string>): Request {
    const body = new URLSearchParams(fields).toString();
    return new Request("http://localhost/create", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  }

  it("returns { resourceId, eventsUrl } for a valid submit (calls adapter.createResource)", async () => {
    const { action } = await import("../app/routes/create");
    const result = await action({
      request: postRequest(GOOD),
      params: {},
      context: {},
    } as never);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resourceId).toBeTruthy();
      expect(result.eventsUrl).toMatch(/^\/resources\/.+\/events$/);
    }
  });

  it("rejects a bad submit with field errors and never creates a resource", async () => {
    const { action } = await import("../app/routes/create");
    // spy the adapter factory to assert createResource is NOT reached on bad input.
    const selectMod = await import("../app/adapter/select");
    const real = selectMod.selectAdapter(process.env);
    const createSpy = vi.spyOn(
      Object.getPrototypeOf(real) as { createResource: () => unknown },
      "createResource",
    );

    const result = await action({
      request: postRequest({ ...GOOD, payout: "not-an-address", bond: "0" }),
      params: {},
      context: {},
    } as never);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.payout).toBeTruthy();
      expect(result.errors.bond).toBeTruthy();
    }
    expect(createSpy).not.toHaveBeenCalled();
    createSpy.mockRestore();
  });
});
