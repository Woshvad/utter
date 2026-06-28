// marketplace-client.test.ts - the offline deterministic publishResource test.
//
// Stubs global fetch with a JSON Response and asserts publishResource POSTs to
// {url}/resources with the Authorization: Bearer header and the right body, returns the
// parsed outcome on 201, throws the right shaped message on 202 (review) / 403 (blocked) /
// other non-2xx, surfaces a network failure with the URL + cause code, and NEVER leaks the
// bearer into a thrown message. No network, no new dependency.
import { describe, it, expect, afterEach } from "vitest";
import { publishResource, type PublishParams } from "../app/adapter/marketplace-client.server";

/** The fake bearer. No thrown message may ever contain this string. */
const SECRET = "test-marketplace-secret-at-least-32-chars-long";
const MARKETPLACE_URL = "https://marketplace.example.com";

/** The publish params the studio sends (mirrors live.ts createResource). */
function makeParams(overrides: Partial<PublishParams> = {}): PublishParams {
  return {
    prompt: "echo the caller's text back with its length",
    resourceId: `0x${"c3".repeat(32)}`,
    category: "data",
    card: { name: "echo", x402: { pricing: { model: "metered" } } },
    cardUrl: "https://echo.resources.example.com/.well-known/agent-card.json",
    slug: "echo",
    ...overrides,
  };
}

/** Build a JSON Response with the given status + body (mirrors the deployer test idiom). */
function makeJsonResponse(status: number, json: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return json;
    },
  } as unknown as Response;
}

/** Save + restore the global fetch around each case. */
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("publishResource (offline, stubbed fetch JSON)", () => {
  it("POSTs to {url}/resources with the Bearer header and the right body, returns { listed:true } on 201", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return makeJsonResponse(201, { listed: true, agentId: "7", resourceId: makeParams().resourceId });
    }) as unknown as typeof fetch;

    const out = await publishResource(makeParams(), {
      marketplaceUrl: MARKETPLACE_URL,
      authSecret: SECRET,
    });

    // The URL is {marketplaceUrl}/resources.
    expect(capturedUrl).toBe(`${MARKETPLACE_URL}/resources`);
    // The bearer goes ONLY in the Authorization header.
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(headers["content-type"]).toBe("application/json");
    // The body carries exactly the publish fields the marketplace parsePublishRequest reads.
    const body = JSON.parse(capturedInit?.body as string);
    expect(body).toEqual({
      prompt: makeParams().prompt,
      resourceId: makeParams().resourceId,
      category: "data",
      card: makeParams().card,
      cardUrl: makeParams().cardUrl,
      slug: "echo",
    });
    // 201 -> the parsed { listed, agentId } outcome.
    expect(out.listed).toBe(true);
    expect(out.agentId).toBe("7");
  });

  it("strips a trailing slash from the marketplace URL before appending /resources", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return makeJsonResponse(201, { listed: true });
    }) as unknown as typeof fetch;

    await publishResource(makeParams(), {
      marketplaceUrl: `${MARKETPLACE_URL}/`,
      authSecret: SECRET,
    });
    expect(capturedUrl).toBe(`${MARKETPLACE_URL}/resources`);
  });

  it("surfaces a network-level fetch failure with the URL + cause code, bearer-free", async () => {
    // The marketplace-unreachable case: undici throws TypeError "fetch failed" with the
    // real reason in err.cause.code. publishResource must rethrow a diagnostic naming the
    // URL + code + the actionable hint, and NEVER include the bearer.
    globalThis.fetch = (async () => {
      const e = new TypeError("fetch failed");
      (e as unknown as { cause: { code: string } }).cause = { code: "ECONNREFUSED" };
      throw e;
    }) as typeof fetch;

    let caught: Error | undefined;
    try {
      await publishResource(makeParams(), { marketplaceUrl: MARKETPLACE_URL, authSecret: SECRET });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toContain("ECONNREFUSED");
    expect(caught?.message).toContain(`${MARKETPLACE_URL}/resources`);
    // The bearer is ABSENT from the message.
    expect(caught?.message).not.toContain(SECRET);
  });

  it("throws a bearer-free message with the status + detail on a 500 {error}", async () => {
    globalThis.fetch = (async () =>
      makeJsonResponse(500, { error: "internal pipeline fault" })) as typeof fetch;

    let caught: Error | undefined;
    try {
      await publishResource(makeParams(), { marketplaceUrl: MARKETPLACE_URL, authSecret: SECRET });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toMatch(/500/);
    expect(caught?.message).toMatch(/internal pipeline fault/);
    expect(caught?.message).not.toContain(SECRET);
  });

  it("throws a clear 'blocked' message on 403", async () => {
    globalThis.fetch = (async () =>
      makeJsonResponse(403, { error: "blocked", reason: "disallowed category" })) as typeof fetch;

    let caught: Error | undefined;
    try {
      await publishResource(makeParams(), { marketplaceUrl: MARKETPLACE_URL, authSecret: SECRET });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toMatch(/blocked/);
    expect(caught?.message).toMatch(/disallowed category/);
    expect(caught?.message).not.toContain(SECRET);
  });

  it("throws a clear 'review' message on 202", async () => {
    globalThis.fetch = (async () =>
      makeJsonResponse(202, { status: "review", reason: "flagged for manual review" })) as typeof fetch;

    let caught: Error | undefined;
    try {
      await publishResource(makeParams(), { marketplaceUrl: MARKETPLACE_URL, authSecret: SECRET });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toMatch(/review/);
    expect(caught?.message).toMatch(/flagged for manual review/);
    expect(caught?.message).not.toContain(SECRET);
  });
});
