// marketplace-discovery-client.test.ts - the offline deterministic queryMarketplaceResources
// test.
//
// Stubs global fetch with a JSON Response and asserts queryMarketplaceResources GETs
// {url}/resources with NO Authorization header (discovery reads are public), reconstructs
// the reputation/bond money fields back to bigint while pricing stays string base units,
// strips a trailing slash, throws a bearer-free diagnostic naming the URL + cause code on a
// network failure, throws naming the status (+ detail) on a non-200, and throws a clear
// shape error on a malformed row. No network, no new dependency.
import { describe, it, expect, afterEach } from "vitest";
import { queryMarketplaceResources } from "../app/adapter/marketplace-discovery-client.server";

const MARKETPLACE_URL = "https://marketplace.example.com";

/**
 * One over-the-wire row the marketplace's GET /resources returns: the IndexRecord
 * projection with reputation + bond serialized as decimal-string base units (pricing
 * fields are already strings). Overridable per case.
 */
function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resourceId: `0x${"c3".repeat(32)}`,
    agentId: "7",
    slug: "echo",
    category: "data",
    pricing: { model: "metered", base: "10000", perKB: "0", max: "10000" },
    reputation: "3",
    uptime: 1,
    health: { verified: true, score: 1 },
    bond: "5000000",
    cardUrl: "https://echo.resources.example.com/.well-known/agent-card.json",
    active: true,
    ...overrides,
  };
}

/** Build a JSON Response with the given status + body (mirrors marketplace-client.test). */
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

describe("queryMarketplaceResources (offline, stubbed fetch JSON)", () => {
  it("GETs {url}/resources with no Authorization header and returns IndexRecord[] with bigint money fields", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return makeJsonResponse(200, [
        makeRow(),
        makeRow({ resourceId: `0x${"a1".repeat(32)}`, slug: "weather", reputation: "12", bond: "1000000" }),
      ]);
    }) as unknown as typeof fetch;

    const out = await queryMarketplaceResources({ marketplaceUrl: MARKETPLACE_URL });

    // The URL is {marketplaceUrl}/resources, GET, no query params.
    expect(capturedUrl).toBe(`${MARKETPLACE_URL}/resources`);
    expect(capturedInit?.method).toBe("GET");
    // Discovery reads are PUBLIC: there is NO Authorization header.
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(headers.accept).toBe("application/json");

    // Two rows reconstructed.
    expect(out.length).toBe(2);
    // reputation + bond come back as bigint base units.
    expect(out[0]?.reputation).toBe(3n);
    expect(typeof out[0]?.reputation).toBe("bigint");
    expect(out[0]?.bond).toBe(5_000_000n);
    expect(typeof out[0]?.bond).toBe("bigint");
    expect(out[1]?.reputation).toBe(12n);
    expect(out[1]?.bond).toBe(1_000_000n);
    // pricing stays string base units (no decimals literal, no coercion).
    expect(out[0]?.pricing.base).toBe("10000");
    expect(out[0]?.pricing.max).toBe("10000");
    expect(typeof out[0]?.pricing.base).toBe("string");
    // Passthrough fields preserved.
    expect(out[0]?.slug).toBe("echo");
    expect(out[1]?.slug).toBe("weather");
    expect(out[0]?.active).toBe(true);
    expect(out[0]?.health.verified).toBe(true);
  });

  it("strips a trailing slash from the marketplace URL before appending /resources", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return makeJsonResponse(200, []);
    }) as unknown as typeof fetch;

    const out = await queryMarketplaceResources({ marketplaceUrl: `${MARKETPLACE_URL}/` });
    expect(capturedUrl).toBe(`${MARKETPLACE_URL}/resources`);
    // An empty active set is a valid result, never an error.
    expect(out).toEqual([]);
  });

  it("surfaces a network-level fetch failure with the URL + cause code (bearer-free)", async () => {
    // The marketplace-unreachable case: undici throws TypeError "fetch failed" with the
    // real reason in err.cause.code. queryMarketplaceResources must rethrow a diagnostic
    // naming the URL + code + the actionable hint.
    globalThis.fetch = (async () => {
      const e = new TypeError("fetch failed");
      (e as unknown as { cause: { code: string } }).cause = { code: "ECONNREFUSED" };
      throw e;
    }) as typeof fetch;

    let caught: Error | undefined;
    try {
      await queryMarketplaceResources({ marketplaceUrl: MARKETPLACE_URL });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toContain("ECONNREFUSED");
    expect(caught?.message).toContain(`${MARKETPLACE_URL}/resources`);
    // There is no Authorization header on this client, so no bearer can ever leak.
    expect(caught?.message).not.toContain("Bearer");
  });

  it("throws naming the status + detail on a non-200 (500 {error})", async () => {
    globalThis.fetch = (async () =>
      makeJsonResponse(500, { error: "index store unavailable" })) as typeof fetch;

    let caught: Error | undefined;
    try {
      await queryMarketplaceResources({ marketplaceUrl: MARKETPLACE_URL });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toMatch(/500/);
    expect(caught?.message).toMatch(/index store unavailable/);
    expect(caught?.message).toContain(`${MARKETPLACE_URL}/resources`);
  });

  it("throws a clear shape error on a row with a non-numeric bond", async () => {
    globalThis.fetch = (async () =>
      makeJsonResponse(200, [makeRow({ bond: "not-a-number" })])) as typeof fetch;

    let caught: Error | undefined;
    try {
      await queryMarketplaceResources({ marketplaceUrl: MARKETPLACE_URL });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    // A malformed money field is a fault (the marketplace is the source of truth), never
    // silently dropped or coerced to zero.
    expect(caught?.message).toMatch(/bond/);
    expect(caught?.message).toMatch(/malformed/);
  });

  it("throws when the body is not a JSON array (never returns a fake/empty list to mask it)", async () => {
    globalThis.fetch = (async () =>
      makeJsonResponse(200, { not: "an array" })) as typeof fetch;

    await expect(
      queryMarketplaceResources({ marketplaceUrl: MARKETPLACE_URL }),
    ).rejects.toThrow(/malformed body/);
  });
});
