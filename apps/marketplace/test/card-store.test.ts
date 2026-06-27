// card-store.test.ts - the finalized A2A card serving cache (MKT-01/02).
//
// The InMemoryCardStore holds the FINALIZED, validateAgentCard-valid card the route
// serves. It deep-copies on BOTH put and get so a caller mutation (of the input after a
// put, or of a returned card) cannot poison the stored card. An unknown resource is null.
import { describe, it, expect } from "vitest";
import { InMemoryCardStore, type Hex } from "../src/index.js";

const RESOURCE_A = `0x${"a".repeat(64)}` as Hex;
const RESOURCE_B = `0x${"b".repeat(64)}` as Hex;

/** A small nested card so the deep-copy isolation is exercised below a top-level key. */
function card(): Record<string, unknown> {
  return {
    protocolVersion: "0.3.0",
    name: "weather-api",
    identity: { standard: "erc-8004", chainId: 5042002, agentId: "42" },
    health: { verified: true, score: null },
  };
}

describe("InMemoryCardStore (finalized-card serving cache)", () => {
  it("put then get returns an equal-by-value card", async () => {
    const store = new InMemoryCardStore();
    const c = card();
    await store.put(RESOURCE_A, c);
    const got = await store.get(RESOURCE_A);
    expect(got).toEqual(c);
  });

  it("get returns null for an unknown resource", async () => {
    const store = new InMemoryCardStore();
    expect(await store.get(RESOURCE_A)).toBeNull();
  });

  it("mutating the input AFTER put does not poison the store (deep copy on put)", async () => {
    const store = new InMemoryCardStore();
    const input = card();
    await store.put(RESOURCE_A, input);

    // Mutate the caller's object (top-level and nested) after the put.
    input.name = "poisoned";
    (input.identity as Record<string, unknown>).agentId = "999";

    const got = await store.get(RESOURCE_A);
    expect(got!.name).toBe("weather-api");
    expect((got!.identity as { agentId: string }).agentId).toBe("42");
  });

  it("mutating a returned card does not poison a later get (deep copy on get)", async () => {
    const store = new InMemoryCardStore();
    await store.put(RESOURCE_A, card());

    const first = await store.get(RESOURCE_A);
    first!.name = "poisoned";
    (first!.identity as Record<string, unknown>).agentId = "999";

    const second = await store.get(RESOURCE_A);
    expect(second!.name).toBe("weather-api");
    expect((second!.identity as { agentId: string }).agentId).toBe("42");
  });

  it("keys cards by resourceId (one resource does not read another)", async () => {
    const store = new InMemoryCardStore();
    await store.put(RESOURCE_A, { ...card(), name: "a" });
    await store.put(RESOURCE_B, { ...card(), name: "b" });
    expect((await store.get(RESOURCE_A))!.name).toBe("a");
    expect((await store.get(RESOURCE_B))!.name).toBe("b");
  });
});
