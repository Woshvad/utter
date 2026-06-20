// Quota seam tests (PRX-03). Pin the counter contract: increment adds the budget
// and returns the new running totals, the in-memory adapter round-trips per
// resource, and distinct resources keep independent counters. These are plain
// call/byte counts, never USDC amounts.
import { describe, it, expect } from "vitest";
import {
  InMemoryQuotaStore,
  type QuotaStore,
  type QuotaBudget,
} from "../src/quota";

describe("InMemoryQuotaStore", () => {
  it("returns the budget on the first increment", async () => {
    const store: QuotaStore = new InMemoryQuotaStore();
    const total = await store.increment("resource-a", { calls: 1, bytes: 256 });
    expect(total).toEqual({ calls: 1, bytes: 256 });
  });

  it("accumulates running totals across increments for the same resource", async () => {
    const store = new InMemoryQuotaStore();
    await store.increment("resource-a", { calls: 1, bytes: 100 });
    await store.increment("resource-a", { calls: 1, bytes: 250 });
    const total = await store.increment("resource-a", { calls: 1, bytes: 50 });
    expect(total).toEqual({ calls: 3, bytes: 400 });
  });

  it("keeps independent counters per resource", async () => {
    const store = new InMemoryQuotaStore();
    await store.increment("resource-a", { calls: 1, bytes: 10 });
    const b = await store.increment("resource-b", { calls: 1, bytes: 20 });
    const a = await store.increment("resource-a", { calls: 1, bytes: 5 });
    expect(b).toEqual({ calls: 1, bytes: 20 });
    expect(a).toEqual({ calls: 2, bytes: 15 });
  });

  it("round-trips a zero budget without changing totals", async () => {
    const store = new InMemoryQuotaStore();
    await store.increment("resource-a", { calls: 2, bytes: 99 });
    const zero: QuotaBudget = { calls: 0, bytes: 0 };
    const total = await store.increment("resource-a", zero);
    expect(total).toEqual({ calls: 2, bytes: 99 });
  });
});
