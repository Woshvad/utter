// index-store.test.ts - the read-through projection index store (MKT-02).
//
// The InMemoryIndexStore is the autonomous test default mirroring the facilitator
// store adapter idiom (stores/memory.ts): the Postgres-shaped IndexStore interface
// is identical so route logic swaps adapters by env without change. The store is a
// READ-THROUGH PROJECTION - it carries price/reputation/bond values PROJECTED from
// their real sources (the card x402, the Scorer + ERC-8004 reads, StakingVault) and
// exposes NO setter that authors money/identity independently of upsert (T-05-06-INDEXTRUST).
import { describe, it, expect } from "vitest";
import { InMemoryIndexStore, type IndexRecord } from "../src/index-store";

const RESOURCE_A = `0x${"a".repeat(64)}` as const;
const RESOURCE_B = `0x${"b".repeat(64)}` as const;

function record(over: Partial<IndexRecord> = {}): IndexRecord {
  return {
    resourceId: RESOURCE_A,
    agentId: "42",
    slug: "weather-api",
    category: "data",
    // pricing projected from the card x402 block (base units, no 1e6 literal).
    pricing: { model: "metered", base: "1000", perKB: "10", max: "100000" },
    reputation: 7n, // feedbackCount projected from ERC-8004 readReputation
    uptime: 0.99, // health score projected from the Scorer
    health: { verified: true, score: 0.99 },
    bond: 1_000_000n, // bonds() projected from StakingVault
    cardUrl: "https://weather-api.resources.example/.well-known/agent-card.json",
    active: true,
    ...over,
  };
}

describe("InMemoryIndexStore (read-through projection)", () => {
  it("upsert then get round-trips a record", async () => {
    const store = new InMemoryIndexStore();
    const rec = record();
    await store.upsert(rec);
    const got = await store.get(RESOURCE_A);
    expect(got).toEqual(rec);
  });

  it("get returns null for an unknown resource", async () => {
    const store = new InMemoryIndexStore();
    expect(await store.get(RESOURCE_A)).toBeNull();
  });

  it("upsert replaces an existing record (re-projection)", async () => {
    const store = new InMemoryIndexStore();
    await store.upsert(record({ reputation: 1n }));
    await store.upsert(record({ reputation: 9n }));
    const got = await store.get(RESOURCE_A);
    expect(got?.reputation).toBe(9n);
    expect((await store.list()).length).toBe(1);
  });

  it("list returns every projected record", async () => {
    const store = new InMemoryIndexStore();
    await store.upsert(record({ resourceId: RESOURCE_A }));
    await store.upsert(record({ resourceId: RESOURCE_B, slug: "fx-api" }));
    const all = await store.list();
    expect(all.map((r) => r.resourceId).sort()).toEqual([RESOURCE_A, RESOURCE_B].sort());
  });

  it("delist removes a resource from discovery (active=false)", async () => {
    const store = new InMemoryIndexStore();
    await store.upsert(record());
    await store.delist(RESOURCE_A);
    const got = await store.get(RESOURCE_A);
    expect(got?.active).toBe(false);
  });

  it("delist is idempotent and a no-op for an unknown resource", async () => {
    const store = new InMemoryIndexStore();
    await expect(store.delist(RESOURCE_A)).resolves.toBeUndefined();
    await store.upsert(record());
    await store.delist(RESOURCE_A);
    await store.delist(RESOURCE_A);
    expect((await store.get(RESOURCE_A))?.active).toBe(false);
  });

  it("exposes NO independent money/identity setter (read-through only)", () => {
    const store = new InMemoryIndexStore() as unknown as Record<string, unknown>;
    // The projection has no setter that authors price/reputation/bond apart from
    // upsert (which mirrors the source). A poisoned entry cannot enable spoofing
    // because the card route + on-chain reads resolve the canonical values.
    expect(store.setPrice).toBeUndefined();
    expect(store.setReputation).toBeUndefined();
    expect(store.setBond).toBeUndefined();
  });
});
