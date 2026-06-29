// live-discovery.test.ts - the LIVE MCP discovery READ proof (Discovery/Playground-real
// subtask B). It proves, offline (an injected FetchLike; NO live marketplace, NO live
// chain, NO model), that createLiveCardSource:
//   - reads the PUBLIC marketplace GET /resources and projects each row to a DiscoveredCard
//     with escrow/asset from the TRUSTED @utter/chain constants and payTo=resourceId (the
//     row never authors a money field); pricing strings copied verbatim; capBaseUnits =
//     BigInt(max); verified/agentId/bondPosted projected; a trailing slash on the base URL
//     is stripped and the read targets ${base}/resources.
//   - reads openapi best-effort: a 200 object body becomes the typed openapi; a 404 / throw
//     / non-object becomes {} (the passthrough fallback), and the source still returns the
//     card (the helper never throws).
//   - honors the query filter (slug/category/resourceId, lowercased), filtering BEFORE the
//     per-row openapi fetch.
//   - fail-louds on a non-200 /resources (naming the URL + status), a non-array body, and a
//     non-numeric pricing.max (a clean shape error, never a raw SyntaxError).
import { describe, it, expect } from "vitest";
import { PAYMENT_ESCROW, USDC } from "@utter/chain";

import { createLiveCardSource } from "../src/mcp/live-discovery.js";
import type { FetchLike } from "../src/discover.js";

const RES_A = `0x${"a1".repeat(32)}`;
const RES_B = `0x${"b2".repeat(32)}`;

/** One marketplace GET /resources row (the IndexRecord JSON projection). */
function indexRow(overrides: Record<string, unknown> = {}) {
  return {
    resourceId: RES_A,
    agentId: "42",
    slug: "weather",
    category: "data",
    pricing: { model: "metered", base: "5000", perKB: "100", max: "10000" },
    reputation: "3",
    uptime: 0.99,
    health: { verified: true, score: 0.95 },
    bond: "1000000",
    cardUrl: "https://weather.resources.utter.app/.well-known/agent-card.json",
    active: true,
    ...overrides,
  };
}

/** A served openapi.json object (the inputSchema is derived from this downstream). */
const OPENAPI: Record<string, unknown> = {
  openapi: "3.1.0",
  info: { title: "weather", version: "1.0.0" },
  paths: {
    "/call": {
      post: {
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", required: ["city"], properties: { city: { type: "string" } } },
            },
          },
        },
      },
    },
  },
};

/**
 * Build an injectable FetchLike + a call log. `resources` is the body GET /resources serves
 * (with `resourcesStatus`); `openapiByUrl` maps an exact openapi URL to a [status, body]
 * pair (a missing URL -> 404). Any /openapi.json URL listed in `throwOpenapi` throws.
 */
function makeFetcher(opts: {
  resources: unknown;
  resourcesStatus?: number;
  openapiByUrl?: Record<string, [number, unknown]>;
  throwOpenapi?: string[];
}): { fetcher: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetcher: FetchLike = async (input) => {
    calls.push(input);
    if (input.endsWith("/resources")) {
      const status = opts.resourcesStatus ?? 200;
      return { status, json: async () => opts.resources };
    }
    if (input.endsWith("/openapi.json")) {
      if (opts.throwOpenapi?.includes(input)) throw new Error("network down");
      const hit = opts.openapiByUrl?.[input];
      if (hit) return { status: hit[0], json: async () => hit[1] };
      return { status: 404, json: async () => ({}) };
    }
    return { status: 404, json: async () => ({}) };
  };
  return { fetcher, calls };
}

describe("createLiveCardSource (live MCP discovery READ): row -> DiscoveredCard projection", () => {
  it("projects two rows with trusted escrow/asset, payTo=resourceId, verbatim pricing, and a stripped base URL", async () => {
    const rowA = indexRow();
    const rowB = indexRow({
      resourceId: RES_B,
      slug: "translate",
      agentId: "7",
      pricing: { model: "metered", base: "2000", perKB: "50", max: "8000" },
      health: { verified: false, score: 0.4 },
      bond: "0",
      cardUrl: "https://translate.resources.utter.app/.well-known/agent-card.json",
    });
    const { fetcher, calls } = makeFetcher({ resources: [rowA, rowB] });

    // A trailing slash on the base must be stripped (read targets ${base}/resources).
    const source = createLiveCardSource({
      marketplaceIndexUrl: "https://market.utter.app/",
      fetcher,
    });
    const cards = await source();

    expect(cards).toHaveLength(2);
    expect(calls).toContain("https://market.utter.app/resources");

    const a = cards[0]!;
    const b = cards[1]!;
    // Money/identity fields come from the TRUSTED constants + the resourceId, NOT the row.
    for (const c of cards) {
      expect(c.escrow).toBe(PAYMENT_ESCROW);
      expect(c.asset).toBe(USDC);
      expect(c.payTo).toBe(c.resourceId);
    }
    expect(a.resourceId).toBe(RES_A);
    expect(a.name).toBe("weather");
    expect(a.payTo).toBe(RES_A);
    // Pricing strings copied verbatim; capBaseUnits = BigInt(max).
    expect(a.pricing).toEqual({ model: "metered", base: "5000", perKB: "100", max: "10000" });
    expect(a.capBaseUnits).toBe(10_000n);
    expect(a.verified).toBe(true);
    expect(a.agentId).toBe("42");
    expect(a.bondPosted).toBe(true); // bond "1000000" > 0

    expect(b.resourceId).toBe(RES_B);
    expect(b.capBaseUnits).toBe(8_000n);
    expect(b.verified).toBe(false);
    expect(b.bondPosted).toBe(false); // bond "0"
  });

  it("reads openapi best-effort: a 200 object is typed; a 404 / throw / non-object is {} and the card still returns", async () => {
    const served = indexRow({
      resourceId: RES_A,
      cardUrl: "https://served.resources.utter.app/.well-known/agent-card.json",
    });
    const missing = indexRow({
      resourceId: RES_B,
      slug: "missing",
      cardUrl: "https://missing.resources.utter.app/.well-known/agent-card.json",
    });
    const { fetcher } = makeFetcher({
      resources: [served, missing],
      openapiByUrl: {
        "https://served.resources.utter.app/openapi.json": [200, OPENAPI],
      },
    });
    const source = createLiveCardSource({ marketplaceIndexUrl: "https://market.utter.app", fetcher });
    const cards = await source();

    expect(cards).toHaveLength(2);
    const servedCard = cards.find((c) => c.resourceId === RES_A)!;
    const missingCard = cards.find((c) => c.resourceId === RES_B)!;
    expect(servedCard.openapi).toEqual(OPENAPI); // served 200 object -> typed
    expect(missingCard.openapi).toEqual({}); // 404 -> passthrough fallback

    // A THROWING openapi GET still yields {} (best-effort, never throws out).
    const throwing = makeFetcher({
      resources: [served],
      throwOpenapi: ["https://served.resources.utter.app/openapi.json"],
    });
    const source2 = createLiveCardSource({
      marketplaceIndexUrl: "https://market.utter.app",
      fetcher: throwing.fetcher,
    });
    const cards2 = await source2();
    expect(cards2).toHaveLength(1);
    expect(cards2[0]!.openapi).toEqual({});

    // A non-object openapi body (200 but an array) also falls back to {}.
    const arrayBody = makeFetcher({
      resources: [served],
      openapiByUrl: { "https://served.resources.utter.app/openapi.json": [200, [1, 2, 3]] },
    });
    const source3 = createLiveCardSource({
      marketplaceIndexUrl: "https://market.utter.app",
      fetcher: arrayBody.fetcher,
    });
    const cards3 = await source3();
    expect(cards3[0]!.openapi).toEqual({});
  });

  it("filters by query (slug/category/resourceId) BEFORE fetching openapi for filtered-out rows", async () => {
    const rowA = indexRow({ slug: "weather" });
    const rowB = indexRow({
      resourceId: RES_B,
      slug: "translate",
      cardUrl: "https://translate.resources.utter.app/.well-known/agent-card.json",
    });
    const { fetcher, calls } = makeFetcher({ resources: [rowA, rowB] });
    const source = createLiveCardSource({ marketplaceIndexUrl: "https://market.utter.app", fetcher });

    const cards = await source("trans"); // matches rowB's slug only
    expect(cards).toHaveLength(1);
    expect(cards[0]!.resourceId).toBe(RES_B);
    // Only the matching row's openapi was fetched (the filter ran first).
    expect(calls).toContain("https://translate.resources.utter.app/openapi.json");
    expect(calls).not.toContain("https://weather.resources.utter.app/openapi.json");
  });

  it("fail-louds on a non-200 /resources, a non-array body, and a non-numeric pricing.max", async () => {
    const non200 = makeFetcher({ resources: [], resourcesStatus: 503 });
    const s1 = createLiveCardSource({ marketplaceIndexUrl: "https://market.utter.app", fetcher: non200.fetcher });
    await expect(s1()).rejects.toThrow(/market\.utter\.app\/resources.*503|503.*resources/);

    const notArray = makeFetcher({ resources: { not: "an array" } });
    const s2 = createLiveCardSource({ marketplaceIndexUrl: "https://market.utter.app", fetcher: notArray.fetcher });
    await expect(s2()).rejects.toThrow(/array/i);

    const badMax = makeFetcher({
      resources: [indexRow({ pricing: { model: "metered", base: "0", perKB: "0", max: "1e9" } })],
    });
    const s3 = createLiveCardSource({ marketplaceIndexUrl: "https://market.utter.app", fetcher: badMax.fetcher });
    // A clean shape error, NOT a raw SyntaxError from BigInt().
    await expect(s3()).rejects.toThrow(/pricing\.max.*base-unit integer/);
  });
});
