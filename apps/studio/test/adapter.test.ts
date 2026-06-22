// adapter.test.ts - the StudioDataAdapter seam smoke test (the heart of Wave 0).
//
// Asserts the three load-bearing invariants:
//  1. selectAdapter defaults to the FixtureAdapter (backend "fixture") when
//     STUDIO_DATA_ADAPTER is unset or != "live" - the autonomous-safe default.
//  2. selectAdapter returns the LiveAdapter (backend "live", fail-loud) when "live".
//  3. Draining FixtureAdapter.subscribeBuildEvents yields the six build stages in
//     order and terminates (Pitfall 4 - the generator settles).
import { describe, it, expect } from "vitest";
import { selectAdapter } from "../app/adapter/select";
import { FixtureAdapter } from "../app/adapter/fixture";
import { LiveAdapter } from "../app/adapter/live";
import { BUILD_STAGES, type BuildStage } from "../app/adapter/types";
import { FIXTURE_RESOURCE_ID } from "../app/fixtures/index";

describe("selectAdapter", () => {
  it("defaults to the FixtureAdapter when STUDIO_DATA_ADAPTER is unset", () => {
    const adapter = selectAdapter({} as NodeJS.ProcessEnv);
    expect(adapter.backend).toBe("fixture");
    expect(adapter).toBeInstanceOf(FixtureAdapter);
  });

  it("defaults to the FixtureAdapter when STUDIO_DATA_ADAPTER is not 'live'", () => {
    const adapter = selectAdapter({ STUDIO_DATA_ADAPTER: "fixture" } as NodeJS.ProcessEnv);
    expect(adapter.backend).toBe("fixture");
  });

  it("returns the LiveAdapter only when STUDIO_DATA_ADAPTER === 'live'", () => {
    const adapter = selectAdapter({ STUDIO_DATA_ADAPTER: "live" } as NodeJS.ProcessEnv);
    expect(adapter.backend).toBe("live");
  });
});

describe("LiveAdapter (real reads against injected deps, fail-loud without them)", () => {
  // Every method (the four reads, createResource, subscribeBuildEvents, and now
  // getRevenue) reads through injected deps - covered offline in live-adapter.test.ts.
  // getRevenue reads REAL aggregated revenue via the injected seam (an HTTP GET to the
  // facilitator's /revenue/:resourceId in production). A NO-DEPS construction therefore
  // fails loud with the "deps not injected" error rather than returning fake/zero data.
  it("getRevenue without injected deps throws a clear not-injected error (never fake data)", async () => {
    const adapter = new LiveAdapter();
    await expect(adapter.getRevenue("0xabc")).rejects.toThrow(/not injected/i);
  });
});

describe("FixtureAdapter.subscribeBuildEvents", () => {
  it("drains to the six build stages in order and terminates", async () => {
    const adapter = new FixtureAdapter();
    const seenStages: BuildStage[] = [];
    for await (const ev of adapter.subscribeBuildEvents(FIXTURE_RESOURCE_ID)) {
      if (!seenStages.includes(ev.stage)) seenStages.push(ev.stage);
    }
    // The loop terminating at all proves the generator settles (no hang).
    expect(seenStages).toEqual([...BUILD_STAGES]);
  });

  it("ends with the Live stage at status ok", async () => {
    const adapter = new FixtureAdapter();
    let last: { stage: BuildStage; status: string } | undefined;
    for await (const ev of adapter.subscribeBuildEvents(FIXTURE_RESOURCE_ID)) {
      last = ev;
    }
    expect(last?.stage).toBe("Live");
    expect(last?.status).toBe("ok");
  });
});

describe("FixtureAdapter reads (no network/chain/model)", () => {
  it("returns a deterministic detail carrying a creator owner address", async () => {
    const adapter = new FixtureAdapter();
    const detail = await adapter.getResourceDetail(FIXTURE_RESOURCE_ID);
    expect(detail.creator).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(detail.bond).toBeTypeOf("bigint");
  });

  it("filters the marketplace through the shared filterResources", async () => {
    const adapter = new FixtureAdapter();
    const all = await adapter.listMarketplace({});
    expect(all.length).toBeGreaterThan(1);
    const dataOnly = await adapter.listMarketplace({ category: "data" });
    expect(dataOnly.every((c) => c.category === "data")).toBe(true);
  });
});
