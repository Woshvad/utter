// adapters.test.ts - map real Utter representations onto PluginResource, fail-closed on
// malformed money/identity fields.
import { describe, it, expect } from "vitest";
import { resourceFromAgentCard, resourceFromIndexRow } from "../src/adapters.js";
import { LIVE_UTC_CARD, LIVE_UTC_RESOURCE_ID, indexRow } from "./fixtures.js";

describe("resourceFromAgentCard", () => {
  it("maps the real live UTC card (resourceId=payTo, pricing, description)", () => {
    const r = resourceFromAgentCard(LIVE_UTC_CARD, { cardUrl: "https://x/.well-known/agent-card.json" });
    expect(r.resourceId).toBe(LIVE_UTC_RESOURCE_ID);
    expect(r.slug).toBe("return-the-current-utc-time-as-json");
    expect(r.description).toBe("return the current utc time as json");
    expect(r.pricing).toEqual({ model: "metered", base: "10000", perKB: "0", max: "10000" });
    expect(r.verified).toBe(false);
    expect(r.bondPosted).toBe(false);
    expect(r.cardUrl).toBe("https://x/.well-known/agent-card.json");
  });

  it("throws when x402.payTo is not a bytes32 resourceId", () => {
    const bad = { ...LIVE_UTC_CARD, x402: { ...(LIVE_UTC_CARD.x402 as object), payTo: "0x1234" } };
    expect(() => resourceFromAgentCard(bad)).toThrow(/payTo/);
  });

  it("throws on a non-integer pricing string (fail-closed, not a raw crash)", () => {
    const bad = {
      ...LIVE_UTC_CARD,
      x402: { ...(LIVE_UTC_CARD.x402 as Record<string, unknown>), pricing: { model: "metered", base: "1e9", perKB: "0", max: "10000" } },
    };
    expect(() => resourceFromAgentCard(bad)).toThrow(/base-unit integer/);
  });
});

describe("resourceFromIndexRow", () => {
  it("maps a valid row and projects bond>0 to bondPosted", () => {
    const r = resourceFromIndexRow(indexRow() as never);
    expect(r.resourceId).toBe(`0x${"a1".repeat(32)}`);
    expect(r.slug).toBe("weather-now");
    expect(r.category).toBe("data");
    expect(r.pricing.max).toBe("10000");
    expect(r.verified).toBe(true);
    expect(r.bondPosted).toBe(true);
  });

  it("falls back to a generated description when the row has none", () => {
    const r = resourceFromIndexRow(indexRow() as never);
    expect(r.description).toBe("The weather-now Utter endpoint.");
  });

  it("uses a provided row description when present", () => {
    const r = resourceFromIndexRow(indexRow({ description: "current weather by city" }) as never);
    expect(r.description).toBe("current weather by city");
  });

  it("throws on a malformed resourceId and on a non-integer price", () => {
    expect(() => resourceFromIndexRow(indexRow({ resourceId: "0xabc" }) as never)).toThrow(/bytes32/);
    expect(() =>
      resourceFromIndexRow(indexRow({ pricing: { model: "metered", base: "0", perKB: "0", max: "x" } }) as never),
    ).toThrow(/base-unit integer/);
  });
});
