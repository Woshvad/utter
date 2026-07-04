// create-limits.test.ts - the /create action admission gate wiring (S5).
//
// Runs in its own file so the module-singleton gate is constructed from THIS file's
// low env knobs (create.test.ts raises them high for its three same-creator calls).
// Covers: the deny split (browser inline errors vs bearer/non-HTML 429 Response),
// the gate running BEFORE the getEscrowBalance chain read, and TooManyBuildsError
// being caught specifically (capacity copy, never the could-not-generate copy).
import { describe, it, expect, vi, beforeAll } from "vitest";
import { TooManyBuildsError } from "../app/limits/build-slots.server";

beforeAll(() => {
  process.env.SESSION_SECRET = "test-session-secret-which-is-long-enough-32b";
  // Pin the creator burst low; every other window stays open. The gate singleton
  // reads env lazily on the first action call, so beforeAll is early enough.
  process.env.CREATE_BURST_PER_CREATOR = "1";
  process.env.CREATE_LIMIT_PER_CREATOR_PER_DAY = "10000";
  process.env.CREATE_BURST_GLOBAL = "10000";
  process.env.CREATE_LIMIT_GLOBAL_PER_DAY = "10000";
  process.env.CREATE_LIMIT_PER_IP_PER_HOUR = "10000";
});

/** Commit a session for the given address and return its Cookie header value. */
async function sessionCookie(address: string): Promise<string> {
  const { sessionStorage } = await import("../app/auth/session.server");
  const session = await sessionStorage.getSession();
  session.set("address", address);
  const setCookie = await sessionStorage.commitSession(session);
  return setCookie.split(";")[0]!;
}

const GOOD = {
  prompt: "return the current weather for a city",
  pricingModel: "flat",
  basePrice: "0.010000",
  bond: "5.000000",
  payout: "0x1111111111111111111111111111111111111111",
};

/** An authed POST with an explicit Accept header (the deny-split discriminator). */
async function postRequest(
  creator: string,
  accept: string,
  extraHeaders: Record<string, string> = {},
): Promise<Request> {
  return new Request("http://localhost/create", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: await sessionCookie(creator),
      Accept: accept,
      ...extraHeaders,
    },
    body: new URLSearchParams(GOOD).toString(),
  });
}

const A = "0xaaaa000000000000000000000000000000000001";
const B = "0xaaaa000000000000000000000000000000000002";
const C = "0xaaaa000000000000000000000000000000000003";

describe("create action admission gate (S5)", () => {
  it("denies a browser post inline, BEFORE the getEscrowBalance chain read", async () => {
    const { action } = await import("../app/routes/create");
    const selectMod = await import("../app/adapter/select");
    const adapter = selectMod.selectAdapter(process.env);
    const balanceSpy = vi.spyOn(
      Object.getPrototypeOf(adapter) as { getEscrowBalance: () => unknown },
      "getEscrowBalance",
    );

    // First create for A: allowed (burst 1), reaches the adapter normally.
    const first = await action({
      request: await postRequest(A, "text/html"),
      params: {},
      context: {},
    } as never);
    expect(first.ok).toBe(true);
    const callsAfterFirst = balanceSpy.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Second create for A: denied by creator_burst as the INLINE errors shape (a
    // browser form post renders the message, never the error boundary), and the
    // chain read is never paid for a denied request.
    const denied = await action({
      request: await postRequest(A, "text/html"),
      params: {},
      context: {},
    } as never);
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.errors.prompt).toMatch(/try again/i);
      expect(denied.errors.prompt).toMatch(/creator_burst/);
    }
    expect(balanceSpy.mock.calls.length).toBe(callsAfterFirst);
    balanceSpy.mockRestore();
  });

  it("denies a NON-html post that carries NO Bearer as the INLINE shape (not a thrown 429)", async () => {
    // REGRESSION GUARD (P1): React Router single-fetch form posts send Accept: */*
    // (no text/html). The old Accept-based heuristic threw a 429 into the app-wide
    // error boundary for these honest browser submissions. Now only a Bearer header
    // forces the 429; every non-Bearer post - whatever its Accept - gets the inline
    // errors shape so the composer renders the message.
    const { action } = await import("../app/routes/create");
    // A is still at its burst cap from the previous test (same 60s window).
    const denied = await action({
      request: await postRequest(A, "*/*"),
      params: {},
      context: {},
    } as never);
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.errors.prompt).toMatch(/try again/i);
      expect(denied.errors.prompt).toMatch(/creator_burst/);
    }
  });

  it("a Bearer header forces the 429 Response shape even when Accept includes text/html", async () => {
    const { action } = await import("../app/routes/create");
    let thrown: unknown;
    try {
      await action({
        request: await postRequest(A, "text/html", { Authorization: "Bearer utk_whatever" }),
        params: {},
        context: {},
      } as never);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(429);
  });

  it("catches TooManyBuildsError specifically: browser gets the capacity copy", async () => {
    const selectMod = await import("../app/adapter/select");
    const adapter = selectMod.selectAdapter(process.env);
    const createSpy = vi
      .spyOn(
        Object.getPrototypeOf(adapter) as { createResource: () => unknown },
        "createResource",
      )
      .mockRejectedValueOnce(new TooManyBuildsError(3));

    const { action } = await import("../app/routes/create");
    const result = await action({
      request: await postRequest(B, "text/html"),
      params: {},
      context: {},
    } as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.prompt).toMatch(/build capacity/i);
      expect(result.errors.prompt).not.toMatch(/could not generate/i);
    }
    createSpy.mockRestore();
  });

  it("catches TooManyBuildsError specifically: bearer (programmatic) callers get a 429 with build_capacity", async () => {
    const selectMod = await import("../app/adapter/select");
    const adapter = selectMod.selectAdapter(process.env);
    const createSpy = vi
      .spyOn(
        Object.getPrototypeOf(adapter) as { createResource: () => unknown },
        "createResource",
      )
      .mockRejectedValueOnce(new TooManyBuildsError(3));

    const { action } = await import("../app/routes/create");
    // A programmatic caller is identified by the Bearer header; requireCreator still
    // authenticates via the session cookie, then the build-capacity deny throws 429.
    let thrown: unknown;
    try {
      await action({
        request: await postRequest(C, "application/json", {
          Authorization: "Bearer utk_whatever",
        }),
        params: {},
        context: {},
      } as never);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Response);
    const res = thrown as Response;
    expect(res.status).toBe(429);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toBe("build_capacity");
    createSpy.mockRestore();
  });
});
