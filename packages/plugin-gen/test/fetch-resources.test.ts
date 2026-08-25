// fetch-resources.test.ts - the live reader, exercised offline with an injected fetcher.
import { describe, it, expect } from "vitest";
import { enrichDescriptions, fetchResources, type FetchLike } from "../src/fetch-resources.js";
import { indexRow } from "./fixtures.js";

function fetcherFor(map: Record<string, [number, unknown]>): { fetcher: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetcher: FetchLike = async (input) => {
    calls.push(input);
    const hit = map[input];
    if (hit) return { status: hit[0], json: async () => hit[1] };
    return { status: 404, json: async () => ({}) };
  };
  return { fetcher, calls };
}

describe("fetchResources", () => {
  it("reads GET /resources and maps active rows to PluginResource", async () => {
    const rows = [
      indexRow({ slug: "a", resourceId: `0x${"a1".repeat(32)}` }),
      indexRow({ slug: "b", resourceId: `0x${"b2".repeat(32)}`, active: false }),
    ];
    const { fetcher, calls } = fetcherFor({ "https://m.utter.app/resources": [200, rows] });
    const resources = await fetchResources({ marketplaceIndexUrl: "https://m.utter.app/", fetcher });
    expect(calls).toContain("https://m.utter.app/resources"); // trailing slash stripped
    expect(resources.map((r) => r.slug)).toEqual(["a"]); // inactive row dropped
  });

  it("fail-louds on a non-200 or a non-array body", async () => {
    const bad = fetcherFor({ "https://m.utter.app/resources": [503, []] });
    await expect(fetchResources({ marketplaceIndexUrl: "https://m.utter.app", fetcher: bad.fetcher })).rejects.toThrow(/HTTP 503/);
    const notArray = fetcherFor({ "https://m.utter.app/resources": [200, { nope: true }] });
    await expect(
      fetchResources({ marketplaceIndexUrl: "https://m.utter.app", fetcher: notArray.fetcher }),
    ).rejects.toThrow(/array/);
  });
});

describe("enrichDescriptions", () => {
  it("adopts the card description for a placeholder, best-effort, without throwing", async () => {
    const resources = await fetchResources({
      marketplaceIndexUrl: "https://m.utter.app",
      fetcher: fetcherFor({
        "https://m.utter.app/resources": [
          200,
          [
            indexRow({ slug: "a", cardUrl: "https://a/card" }),
            indexRow({ slug: "b", resourceId: `0x${"b2".repeat(32)}`, cardUrl: "https://b/card" }),
          ],
        ],
      }).fetcher,
    });
    // a's card resolves with a description; b's card 404s (left unchanged).
    const enrichFetcher: FetchLike = async (input) => {
      if (input === "https://a/card") return { status: 200, json: async () => ({ description: "real desc for a" }) };
      throw new Error("network down");
    };
    const enriched = await enrichDescriptions(resources, enrichFetcher);
    const a = enriched.find((r) => r.slug === "a")!;
    const b = enriched.find((r) => r.slug === "b")!;
    expect(a.description).toBe("real desc for a");
    expect(b.description).toBe("The b Utter endpoint."); // unchanged (fetch threw)
  });
});
