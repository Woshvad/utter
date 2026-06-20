// query.test.ts - the pure filterResources over the projected index records (MKT-02).
//
// filterResources is a PURE filter over records (no I/O), mirroring the
// reconcile() pure-diff idiom. It supports category, price range, min reputation,
// min uptime, min bond, and active - the discovery criteria an agent operator
// queries before paying per call. All amounts are base units (no 1e6 literal).
import { describe, it, expect } from "vitest";
import { filterResources } from "../src/query";
import type { IndexRecord } from "../src/index-store";

function rec(i: number, over: Partial<IndexRecord> = {}): IndexRecord {
  return {
    resourceId: `0x${String(i).padStart(64, "0")}` as `0x${string}`,
    agentId: String(i),
    slug: `api-${i}`,
    category: "data",
    pricing: { model: "metered", base: "1000", perKB: "10", max: "100000" },
    reputation: 5n,
    uptime: 0.9,
    health: { verified: true, score: 0.9 },
    bond: 1_000_000n,
    cardUrl: `https://api-${i}.resources.example/.well-known/agent-card.json`,
    active: true,
    ...over,
  };
}

describe("filterResources", () => {
  const records: IndexRecord[] = [
    rec(1, { category: "data", reputation: 10n, uptime: 0.99, bond: 2_000_000n, pricing: { model: "metered", base: "500", perKB: "1", max: "1000" } }),
    rec(2, { category: "compute", reputation: 2n, uptime: 0.5, bond: 1_000_000n, pricing: { model: "metered", base: "5000", perKB: "1", max: "1000" } }),
    rec(3, { category: "data", reputation: 8n, uptime: 0.95, bond: 1_000_000n, active: false }),
  ];

  it("returns all records with no criteria", () => {
    expect(filterResources(records, {}).length).toBe(3);
  });

  it("filters by category", () => {
    const out = filterResources(records, { category: "compute" });
    expect(out.map((r) => r.agentId)).toEqual(["2"]);
  });

  it("filters by active (excludes delisted)", () => {
    const out = filterResources(records, { active: true });
    expect(out.map((r) => r.agentId).sort()).toEqual(["1", "2"]);
  });

  it("filters by min reputation", () => {
    const out = filterResources(records, { minReputation: 8n });
    expect(out.map((r) => r.agentId).sort()).toEqual(["1", "3"]);
  });

  it("filters by min uptime", () => {
    const out = filterResources(records, { minUptime: 0.95 });
    expect(out.map((r) => r.agentId).sort()).toEqual(["1", "3"]);
  });

  it("filters by min bond (base units)", () => {
    const out = filterResources(records, { minBond: 2_000_000n });
    expect(out.map((r) => r.agentId)).toEqual(["1"]);
  });

  it("filters by max base price (base units)", () => {
    const out = filterResources(records, { maxBasePrice: 1000n });
    expect(out.map((r) => r.agentId).sort()).toEqual(["1", "3"]);
  });

  it("filters by min base price (base units)", () => {
    const out = filterResources(records, { minBasePrice: 5000n });
    expect(out.map((r) => r.agentId)).toEqual(["2"]);
  });

  it("composes multiple criteria (AND)", () => {
    const out = filterResources(records, { category: "data", active: true, minReputation: 5n });
    expect(out.map((r) => r.agentId)).toEqual(["1"]);
  });

  it("is pure - does not mutate the input array", () => {
    const copy = [...records];
    filterResources(records, { category: "data" });
    expect(records).toEqual(copy);
  });
});
