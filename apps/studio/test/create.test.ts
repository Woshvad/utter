// create.test.ts - STU-01 composer validation + action tests.
//
// Covers: (1) validateComposeSpec rejects empty/over-long prompt, malformed pricing,
// non-positive bond, and a non-address payout - WITHOUT producing a spec
// (reject-before-create, T-06-INPUTVAL); (2) a valid spec parses bond/price to
// base-unit bigints with no money literal; (3) the action runs validation first and
// only calls adapter.createResource on success, returning { resourceId, eventsUrl }.
import { describe, it, expect, vi, beforeAll } from "vitest";
import {
  validateComposeSpec,
  parseUsdcToBaseUnits,
  PROMPT_MAX,
} from "../app/validation/compose";

// The /create action is now gated by requireCreator (CR-01); these action tests must
// carry a valid session cookie. A long SESSION_SECRET makes the signed cookie stable.
// The create-gate limit knobs are raised far above what this file exercises (three
// same-address action calls sit exactly at the default 3/60s creator burst); the gate
// singleton reads env lazily on first action call, so beforeAll is early enough. The
// deny paths are covered in create-limits.test.ts with low knobs.
beforeAll(() => {
  process.env.SESSION_SECRET = "test-session-secret-which-is-long-enough-32b";
  process.env.CREATE_BURST_GLOBAL = "10000";
  process.env.CREATE_LIMIT_GLOBAL_PER_DAY = "10000";
  process.env.CREATE_LIMIT_PER_IP_PER_HOUR = "10000";
  process.env.CREATE_BURST_PER_CREATOR = "10000";
  process.env.CREATE_LIMIT_PER_CREATOR_PER_DAY = "10000";
});

/** Commit a session for the given address and return its Cookie header value. */
async function sessionCookie(address: string): Promise<string> {
  const { sessionStorage } = await import("../app/auth/session.server");
  const session = await sessionStorage.getSession();
  session.set("address", address);
  const setCookie = await sessionStorage.commitSession(session);
  return setCookie.split(";")[0]!;
}

const CREATOR = "0x1111111111111111111111111111111111111111";

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

describe("create loader (?prompt= prefill)", () => {
  it("returns the prompt from the query string as initialPrompt", async () => {
    const { loader } = await import("../app/routes/create");
    const data = await loader({
      request: new Request("http://localhost/create?prompt=return%20json%20instead"),
      params: {},
      context: {},
    } as never);
    expect(data.initialPrompt).toBe("return json instead");
  });

  it("returns null initialPrompt when no ?prompt= is present (not gated)", async () => {
    const { loader } = await import("../app/routes/create");
    const data = await loader({
      request: new Request("http://localhost/create"),
      params: {},
      context: {},
    } as never);
    expect(data.initialPrompt).toBeNull();
  });
});

describe("Composer prefill", () => {
  it("renders the textarea pre-filled when given initialPrompt", async () => {
    const { render, screen } = await import("@testing-library/react");
    const React = await import("react");
    const { createRoutesStub } = await import("react-router");
    const { Composer } = await import("../app/components/build/Composer");
    // Composer uses react-router's <Form> (a data-router hook), so it must mount inside
    // a data router; createRoutesStub provides one for the component under test.
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: () =>
          React.createElement(Composer, { initialPrompt: "cap at $5/day" }),
      },
    ]);
    render(React.createElement(Stub));
    const textarea = screen.getByLabelText("prompt") as HTMLTextAreaElement;
    expect(textarea.value).toBe("cap at $5/day");
  });
});

describe("create action", () => {
  /** Build an authenticated POST Request with a urlencoded body the action can read. */
  async function postRequest(fields: Record<string, string>): Promise<Request> {
    const body = new URLSearchParams(fields).toString();
    return new Request("http://localhost/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: await sessionCookie(CREATOR),
      },
      body,
    });
  }

  it("returns { resourceId, eventsUrl } for a valid submit (calls adapter.createResource)", async () => {
    const { action } = await import("../app/routes/create");
    const result = await action({
      request: await postRequest(GOOD),
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
      request: await postRequest({ ...GOOD, payout: "not-an-address", bond: "0" }),
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

  it("returns a prompt field error (no throw) when createResource throws on a valid submit", async () => {
    // Live-shaped failure: a valid form passes validation and reaches createResource,
    // which throws (an unbuildable prompt rejected by the four-gate validator). The action
    // returns an inline prompt error rather than crashing. Driven by a STUB throw.
    const selectMod = await import("../app/adapter/select");
    const real = selectMod.selectAdapter(process.env);
    const createSpy = vi
      .spyOn(
        Object.getPrototypeOf(real) as { createResource: () => unknown },
        "createResource",
      )
      .mockRejectedValueOnce(new Error("generation failed the four-gate validator"));

    const { action } = await import("../app/routes/create");
    let result: unknown;
    let threw = false;
    try {
      result = await action({
        request: await postRequest(GOOD),
        params: {},
        context: {},
      } as never);
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    const r = result as { ok: boolean; errors?: { prompt?: string } };
    expect(r.ok).toBe(false);
    expect(typeof r.errors?.prompt).toBe("string");
    expect(r.errors?.prompt!.length).toBeGreaterThan(0);
    // it reached createResource (validation passed first), then degraded on the throw
    expect(createSpy).toHaveBeenCalled();
    createSpy.mockRestore();
  });
});
