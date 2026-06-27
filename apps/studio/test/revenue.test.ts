// revenue.test.ts - the display-only tryGetRevenue wrapper.
//
// Covers: (1) on success it returns the adapter's RevenueSummary unchanged; (2) on a
// getRevenue throw it returns strictly null (NOT a fabricated zero summary). This is the
// money-DISPLAY tolerance seam, so the failure path is driven by a STUB throw (the
// fixture adapter never throws).
import { describe, it, expect } from "vitest";
import { tryGetRevenue } from "../app/adapter/revenue";
import type { StudioDataAdapter, RevenueSummary } from "../app/adapter/types";

const ID = "0x00000000000000000000000000000000000000000000000000000000000000a1";

/** A minimal stub adapter exposing only getRevenue (the method under test). */
function stubAdapter(getRevenue: StudioDataAdapter["getRevenue"]): StudioDataAdapter {
  return { backend: "fixture", getRevenue } as unknown as StudioDataAdapter;
}

describe("tryGetRevenue (display-only wrapper)", () => {
  it("returns the summary unchanged on success", async () => {
    const summary: RevenueSummary = {
      resourceId: ID as RevenueSummary["resourceId"],
      calls: 42,
      gross: 1000n,
      creatorShare: 700n,
      platformShare: 300n,
      refunds: 0n,
      receipts: [],
    };
    const adapter = stubAdapter(async () => summary);

    const result = await tryGetRevenue(adapter, ID);
    expect(result).toBe(summary);
  });

  it("returns strictly null when getRevenue throws (never a fabricated zero)", async () => {
    const adapter = stubAdapter(async () => {
      throw new Error("facilitator unreachable");
    });

    const result = await tryGetRevenue(adapter, ID);
    // strictly null - distinct from a real reachable-but-empty zero summary
    expect(result).toBeNull();
  });
});
