// auth-gate.test.ts - STU-05 / ASVS V4 access control: requireCreator +
// requireResourceOwner + the /auth action.
//
// Covers: (1) requireCreator throws a redirect/401 for an unauthenticated request
// (no session cookie) and returns the address for an authenticated one; (2)
// requireResourceOwner returns for the owner but THROWS (403) when the authenticated
// address != the resource creator (T-06-PRIVESC - cross-creator escalation blocked);
// (3) the /auth action issues a nonce (GET) into the session and, on POST verify,
// sets the session cookie carrying the authenticated address.
import { describe, it, expect, beforeAll } from "vitest";
import { SiweMessage, generateNonce } from "siwe";
import { privateKeyToAccount } from "viem/accounts";
import { FIXTURE_CREATOR, FIXTURE_RESOURCE_ID } from "../app/fixtures/index";

const TEST_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const account = privateKeyToAccount(TEST_PK);
const DOMAIN = "studio.utter.test";

beforeAll(() => {
  process.env.SESSION_SECRET = "test-session-secret-which-is-long-enough-32b";
  process.env.SIWE_DOMAIN = DOMAIN;
});

/** Build a Request carrying a committed session for the given address. */
async function authedRequest(address: string, url = "http://localhost/"): Promise<Request> {
  const { sessionStorage } = await import("../app/auth/session.server");
  const session = await sessionStorage.getSession();
  session.set("address", address);
  const setCookie = await sessionStorage.commitSession(session);
  const cookie = setCookie.split(";")[0]!;
  return new Request(url, { headers: { Cookie: cookie } });
}

describe("requireCreator", () => {
  it("throws for an unauthenticated request (no session cookie)", async () => {
    const { requireCreator } = await import("../app/auth/requireCreator.server");
    const anon = new Request("http://localhost/create");
    await expect(requireCreator(anon)).rejects.toBeDefined();
  });

  it("returns the authenticated address for a request with a valid session", async () => {
    const { requireCreator } = await import("../app/auth/requireCreator.server");
    const req = await authedRequest(account.address, "http://localhost/create");
    const addr = await requireCreator(req);
    expect(addr.toLowerCase()).toBe(account.address.toLowerCase());
  });
});

describe("requireResourceOwner (T-06-PRIVESC)", () => {
  it("returns for the owner (authenticated address == resource creator)", async () => {
    const { requireResourceOwner } = await import("../app/auth/requireCreator.server");
    const req = await authedRequest(FIXTURE_CREATOR);
    const addr = await requireResourceOwner(req, FIXTURE_RESOURCE_ID);
    expect(addr.toLowerCase()).toBe(FIXTURE_CREATOR.toLowerCase());
  });

  it("throws 403 when a different creator tries to act on the resource", async () => {
    const { requireResourceOwner } = await import("../app/auth/requireCreator.server");
    const stranger = account.address; // != FIXTURE_CREATOR
    const req = await authedRequest(stranger);
    await expect(requireResourceOwner(req, FIXTURE_RESOURCE_ID)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("throws for an unauthenticated request before any ownership compare", async () => {
    const { requireResourceOwner } = await import("../app/auth/requireCreator.server");
    const anon = new Request("http://localhost/");
    await expect(requireResourceOwner(anon, FIXTURE_RESOURCE_ID)).rejects.toBeDefined();
  });
});

describe("/auth action", () => {
  /** Sign an EIP-4361 message with the given nonce. */
  async function signSiwe(nonce: string): Promise<{ message: string; signature: string }> {
    const siwe = new SiweMessage({
      domain: DOMAIN,
      address: account.address,
      statement: "Sign in to Utter Studio",
      uri: `https://${DOMAIN}`,
      version: "1",
      chainId: 5042002,
      nonce,
    });
    const message = siwe.prepareMessage();
    const signature = await account.signMessage({ message });
    return { message, signature };
  }

  it("issues a nonce (GET loader) and stores it in the session cookie", async () => {
    const { loader } = await import("../app/routes/auth");
    const res = (await loader({
      request: new Request("http://localhost/auth"),
      params: {},
      context: {},
    } as never)) as Response;
    const body = await res.clone().json();
    expect(body.nonce).toMatch(/^[A-Za-z0-9]{8,}$/);
    expect(res.headers.get("Set-Cookie")).toMatch(/__utter_session=/);
  });

  it("verifies a signed message (POST) and sets the authenticated session cookie", async () => {
    const { loader, action } = await import("../app/routes/auth");
    // 1. GET a nonce and capture the session cookie that holds it
    const getRes = (await loader({
      request: new Request("http://localhost/auth"),
      params: {},
      context: {},
    } as never)) as Response;
    const { nonce } = await getRes.json();
    const nonceCookie = getRes.headers.get("Set-Cookie")!.split(";")[0]!;

    // 2. sign with that nonce and POST the message+signature back with the cookie
    const { message, signature } = await signSiwe(nonce);
    const form = new URLSearchParams({ message, signature });
    const postRes = (await action({
      request: new Request("http://localhost/auth", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: nonceCookie,
        },
        body: form.toString(),
      }),
      params: {},
      context: {},
    } as never)) as Response;

    // 3. the action committed a session cookie carrying the authenticated address
    const setCookie = postRes.headers.get("Set-Cookie");
    expect(setCookie).toMatch(/__utter_session=/);
    const { getAuthAddress } = await import("../app/auth/session.server");
    const authedReq = new Request("http://localhost/", {
      headers: { Cookie: setCookie!.split(";")[0]! },
    });
    const addr = await getAuthAddress(authedReq);
    expect(addr?.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it("rejects a POST whose nonce does not match the session nonce (replay)", async () => {
    const { action } = await import("../app/routes/auth");
    // sign with a nonce the session never issued; the session has no nonce cookie
    const { message, signature } = await signSiwe(generateNonce());
    const form = new URLSearchParams({ message, signature });
    const res = await action({
      request: new Request("http://localhost/auth", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: {},
    } as never).catch((e) => e);
    // either a thrown 401 Response or a returned non-ok - both are acceptable rejection
    if (res instanceof Response) {
      expect(res.status).toBe(401);
    } else {
      expect(res).toBeDefined();
    }
  });
});
