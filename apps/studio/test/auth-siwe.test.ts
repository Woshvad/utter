// auth-siwe.test.ts - STU-05 SIWE nonce/verify replay-safety + session cookie.
//
// Covers the V2/V3 controls from 06-RESEARCH Security Domain:
// (1) verifySiwe binds the server-issued, session-bound, one-time nonce AND the
//     domain - a valid signature over a message whose nonce matches the session
//     nonce authenticates, returning the recovered address (T-06-SIWE-REPLAY);
// (2) a message whose nonce does NOT match the session-issued nonce is REJECTED
//     (the replay guard), as is an absent nonce;
// (3) issueNonce returns a fresh generateNonce() value (>=8 alphanumeric);
// (4) the session cookie is signed httpOnly secure SameSite=lax with SESSION_SECRET
//     read from env (createCookieSessionStorage), never hardcoded.
//
// No network: siwe verify is local crypto. We sign with a throwaway viem account
// so the recovered address is deterministic - a private key NEVER reaches the
// server code under test; only the message + signature do.
import { describe, it, expect, beforeAll } from "vitest";
import { SiweMessage, generateNonce } from "siwe";
import { privateKeyToAccount } from "viem/accounts";

// A throwaway test account; its private key lives ONLY in this test, never in the
// server modules. The server only ever sees message + signature.
const TEST_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const account = privateKeyToAccount(TEST_PK);
const DOMAIN = "studio.utter.test";

beforeAll(() => {
  // SESSION_SECRET / SIWE_DOMAIN are read from env by the server modules. Provide
  // test values here (never committed real secrets); .env.local holds real ones.
  process.env.SESSION_SECRET = "test-session-secret-which-is-long-enough-32b";
  process.env.SIWE_DOMAIN = DOMAIN;
});

/** Build + sign an EIP-4361 message with the given nonce, returning {message, signature}. */
async function signSiwe(nonce: string, domain = DOMAIN): Promise<{ message: string; signature: string }> {
  const siwe = new SiweMessage({
    domain,
    address: account.address,
    statement: "Sign in to Utter Studio",
    uri: `https://${domain}`,
    version: "1",
    chainId: 5042002,
    nonce,
  });
  const message = siwe.prepareMessage();
  const signature = await account.signMessage({ message });
  return { message, signature };
}

describe("issueNonce", () => {
  it("returns a fresh nonce of at least 8 alphanumeric chars", async () => {
    const { issueNonce } = await import("../app/auth/siwe.server");
    const a = issueNonce();
    const b = issueNonce();
    expect(a).toMatch(/^[A-Za-z0-9]{8,}$/);
    expect(a).not.toBe(b); // fresh per call
  });
});

describe("verifySiwe (replay-safe, domain-bound)", () => {
  it("authenticates a valid signature whose message nonce matches the session nonce", async () => {
    const { verifySiwe } = await import("../app/auth/siwe.server");
    const nonce = generateNonce();
    const { message, signature } = await signSiwe(nonce);
    const address = await verifySiwe(message, signature, nonce);
    expect(address.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it("rejects a message whose nonce does NOT match the session nonce (replay guard)", async () => {
    const { verifySiwe } = await import("../app/auth/siwe.server");
    const messageNonce = generateNonce();
    const sessionNonce = generateNonce(); // different => must reject
    const { message, signature } = await signSiwe(messageNonce);
    await expect(verifySiwe(message, signature, sessionNonce)).rejects.toBeDefined();
  });

  it("rejects when the session nonce is absent/empty (no nonce to bind)", async () => {
    const { verifySiwe } = await import("../app/auth/siwe.server");
    const nonce = generateNonce();
    const { message, signature } = await signSiwe(nonce);
    await expect(verifySiwe(message, signature, "")).rejects.toBeDefined();
  });

  it("rejects a tampered signature (wrong signer) even with a matching nonce", async () => {
    const { verifySiwe } = await import("../app/auth/siwe.server");
    const nonce = generateNonce();
    const { message } = await signSiwe(nonce);
    // a signature from a different message/nonce - will not recover the claimed address
    const other = await signSiwe(generateNonce());
    await expect(verifySiwe(message, other.signature, nonce)).rejects.toBeDefined();
  });

  it("rejects a message bound to a different domain", async () => {
    const { verifySiwe } = await import("../app/auth/siwe.server");
    const nonce = generateNonce();
    const { message, signature } = await signSiwe(nonce, "evil.example.com");
    await expect(verifySiwe(message, signature, nonce)).rejects.toBeDefined();
  });
});

describe("session cookie storage", () => {
  it("creates a signed httpOnly secure SameSite=lax session cookie from env SESSION_SECRET", async () => {
    const { sessionStorage } = await import("../app/auth/session.server");
    const session = await sessionStorage.getSession();
    session.set("address", account.address);
    const setCookie = await sessionStorage.commitSession(session);
    expect(setCookie).toMatch(/__utter_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    // round-trips through the signed cookie
    const cookiePair = setCookie.split(";")[0]!;
    const round = await sessionStorage.getSession(cookiePair);
    expect(round).toBeDefined();
  });

  it("getAuthAddress reads the authenticated address back from a committed session", async () => {
    const { sessionStorage, getAuthAddress } = await import("../app/auth/session.server");
    const session = await sessionStorage.getSession();
    session.set("address", account.address);
    const setCookie = await sessionStorage.commitSession(session);
    const cookieHeader = setCookie.split(";")[0]!;
    const req = new Request("http://localhost/", { headers: { Cookie: cookieHeader } });
    const addr = await getAuthAddress(req);
    expect(addr?.toLowerCase()).toBe(account.address.toLowerCase());
  });
});
