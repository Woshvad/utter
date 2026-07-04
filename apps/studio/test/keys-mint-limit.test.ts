// keys-mint-limit.test.ts - the /keys mint admission throttle (S8b).
//
// Runs in its own file so the module-singleton mint limiter is constructed from THIS
// file's low knob (KEYS_MINT_LIMIT_PER_IP_PER_MIN=1). A mint does a synchronous
// full-file rewrite of the on-disk key store, and SIWE wallets are free, so an
// unthrottled mint loop is both an unbounded-disk and an event-loop-block DoS.
import { describe, it, expect, vi, beforeAll } from "vitest";

const CREATOR = "0x1111111111111111111111111111111111111111";

beforeAll(() => {
  process.env.SESSION_SECRET = "test-session-secret-which-is-long-enough-32b";
  process.env.KEYS_MINT_LIMIT_PER_IP_PER_MIN = "1";
});

/** Commit a session for the given address and return its Cookie header value. */
async function sessionCookie(address: string): Promise<string> {
  const { sessionStorage } = await import("../app/auth/session.server");
  const session = await sessionStorage.getSession();
  session.set("address", address);
  const setCookie = await sessionStorage.commitSession(session);
  return setCookie.split(";")[0]!;
}

/** A key-mint POST from a given forwarded IP + creator session. */
async function mintRequest(creator: string, ip: string): Promise<Request> {
  return new Request("http://localhost/keys", {
    method: "POST",
    headers: { Cookie: await sessionCookie(creator), "x-forwarded-for": ip },
  });
}

describe("/keys action mint throttle (S8b)", () => {
  it("denies an over-rate mint INLINE and BEFORE the store is touched (no disk write, no raw 500)", async () => {
    const { apiKeyStore } = await import("../app/auth/apiKeyStore.server");
    const mintSpy = vi.spyOn(apiKeyStore, "mintFor");
    const { action } = await import("../app/routes/keys");

    // First mint from this IP: allowed, reaches the store.
    const first = await action({
      request: await mintRequest(CREATOR, "7.7.7.1"),
      params: {},
      context: {},
    } as never);
    expect(first.mintedRaw).toMatch(/^utk_/);
    const callsAfterFirst = mintSpy.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Second mint from the SAME IP within the window: denied inline, store untouched.
    const denied = await action({
      request: await mintRequest(CREATOR, "7.7.7.1"),
      params: {},
      context: {},
    } as never);
    expect(denied.mintedRaw).toBeNull();
    expect(denied.error).toMatch(/too many key mints/i);
    expect(mintSpy.mock.calls.length).toBe(callsAfterFirst);
    mintSpy.mockRestore();
  });
});
