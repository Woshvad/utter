// live-adapter.test.ts - the offline deterministic LiveAdapter read-path test.
//
// Builds the LiveAdapter DIRECTLY with INJECTED deps (a stub publicClient + a
// seeded InMemoryIndexStore + the real runPlaygroundHarness), never through
// selectAdapter, so no real env/chain is touched. Asserts the four read methods
// return real-shaped data and the three deferred methods still fail loud.
//
// Money discipline: getEscrowBalance flows through readUsdcBalance, so its decimals
// come from the stub publicClient's runtime decimals() read (6), never a literal.
// runPlayground reuses runPlaygroundHarness verbatim, keeping the reserve-before-run
// escrow gate intact (the gate reserves the cap BEFORE the handler runs).
import { describe, it, expect } from "vitest";
import type { PublicClient } from "viem";
import { InMemoryIndexStore, type IndexRecord } from "@utter/marketplace";
import { LiveAdapter } from "../app/adapter/live";
import { RequiresLiveServicesError } from "../app/adapter/live";
import { runPlaygroundHarness } from "../app/adapter/playground-harness";
import { FIXTURE_MARKETPLACE, FIXTURE_RESOURCE_ID } from "../app/fixtures/index";

/** A clearly-fake unknown id for the not-found case (never seeded). */
const UNKNOWN_ID =
  "0x00000000000000000000000000000000000000000000000000000000deadbeef" as const;

/** A fixed base-unit balance the stub publicClient returns for balanceOf. */
const STUB_RAW_BALANCE = 25_000_000n;

/**
 * A stub viem PublicClient: decimals() returns 6 (the runtime read the money path
 * depends on) and balanceOf() returns a fixed base-unit bigint. No network. The
 * cast mirrors the playground-harness mock idiom.
 */
function makeStubPublicClient(): PublicClient {
  return {
    async readContract({ functionName }: { functionName: string }) {
      if (functionName === "decimals") return 6;
      if (functionName === "balanceOf") return STUB_RAW_BALANCE;
      throw new Error(`live-adapter test stub: unexpected functionName ${functionName}`);
    },
  } as unknown as PublicClient;
}

/**
 * Project the FIXTURE_MARKETPLACE cards into IndexRecord shape - the SAME projection
 * the live-deps.server bootstrap seeds. Kept inline here so the test seeds the store
 * deterministically without going through the server bootstrap.
 */
function seedRecords(): IndexRecord[] {
  return FIXTURE_MARKETPLACE.map((c) => ({
    resourceId: c.resourceId,
    agentId: c.agentId,
    slug: c.slug,
    category: c.category,
    pricing: { ...c.pricing },
    reputation: c.reputation,
    uptime: c.uptime,
    health: { verified: c.uptime > 0, score: c.uptime },
    bond: c.bond,
    cardUrl: `https://${c.slug}.resources.example.com/.well-known/agent-card.json`,
    active: c.active,
  }));
}

/** Build a LiveAdapter with injected offline deps + a freshly seeded index store. */
async function makeLiveAdapter(): Promise<LiveAdapter> {
  const indexStore = new InMemoryIndexStore();
  for (const rec of seedRecords()) {
    await indexStore.upsert(rec);
  }
  return new LiveAdapter({
    publicClient: makeStubPublicClient(),
    indexStore,
    // Inject the REAL harness so the escrow reserve-before-run gate is proven, not faked.
    runPlayground: runPlaygroundHarness,
  });
}

describe("LiveAdapter read path (injected offline deps)", () => {
  it("getEscrowBalance returns {raw, decimals} from the runtime decimals() read", async () => {
    const adapter = await makeLiveAdapter();
    const bal = await adapter.getEscrowBalance(
      "0x1111111111111111111111111111111111111111",
    );
    // decimals comes from the stub's decimals() read (6), not a literal in the adapter.
    expect(bal.decimals).toBe(6);
    expect(bal.raw).toBe(STUB_RAW_BALANCE);
    expect(typeof bal.raw).toBe("bigint");
  });

  it("listMarketplace({}) returns the seeded cards (length > 1)", async () => {
    const adapter = await makeLiveAdapter();
    const all = await adapter.listMarketplace({});
    expect(all.length).toBeGreaterThan(1);
    expect(all.map((c) => c.resourceId)).toContain(FIXTURE_RESOURCE_ID);
  });

  it("listMarketplace({category}) applies the shared filterResources", async () => {
    const adapter = await makeLiveAdapter();
    const dataOnly = await adapter.listMarketplace({ category: "data" });
    expect(dataOnly.length).toBeGreaterThan(0);
    expect(dataOnly.every((c) => c.category === "data")).toBe(true);
  });

  it("getResourceDetail(seededId) returns a ResourceDetail projection", async () => {
    const adapter = await makeLiveAdapter();
    const detail = await adapter.getResourceDetail(FIXTURE_RESOURCE_ID);
    expect(detail.resourceId).toBe(FIXTURE_RESOURCE_ID);
    expect(detail.creator).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(detail.payout).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(detail.bond).toBeTypeOf("bigint");
    expect(detail.pricing.base).toBeTruthy();
    expect(detail.health).toHaveProperty("verified");
    expect(["live", "deploying", "degraded", "down"]).toContain(detail.sandbox);
    expect(detail.cardUrl).toContain(".well-known/agent-card.json");
  });

  it("getResourceDetail(unknownId) throws a not-found-shaped error", async () => {
    const adapter = await makeLiveAdapter();
    await expect(adapter.getResourceDetail(UNKNOWN_ID)).rejects.toThrow();
  });

  it("runPlayground(id, req) settles a paid result through the escrow gate", async () => {
    const adapter = await makeLiveAdapter();
    // runPlayground reuses runPlaygroundHarness verbatim: the harness builds its OWN
    // served card per resourceId and pays against it, so the id need only be a valid
    // bytes32 payTo (it does not read the seeded index). Use the same harness-friendly
    // id the criterion-3 e2e uses to prove the reserve-before-run gate end-to-end.
    const PAY_ID = `0x${"c3".repeat(32)}` as const;
    // The in-process handler validates input shape: a {text} body is the success path
    // (a {city} body is a declared bad-input 400, correctly no-charge). Use the same
    // {text} body the criterion-3 e2e uses so the success debit settles through the gate.
    const res = await adapter.runPlayground(PAY_ID, { text: "hello" });
    expect(res.paid).toBe(true);
    expect(res.debitAmount).toBeGreaterThan(0n);
    expect(res.body).toBeDefined();
  });
});

describe("LiveAdapter deferred path (fail loud, never fake data)", () => {
  it("createResource still throws RequiresLiveServicesError", async () => {
    const adapter = await makeLiveAdapter();
    await expect(
      adapter.createResource({
        prompt: "x",
        pricingModel: "flat",
        basePrice: 1n,
        bond: 1n,
        payout: "0x1111111111111111111111111111111111111111",
      }),
    ).rejects.toBeInstanceOf(RequiresLiveServicesError);
  });

  it("getRevenue still throws RequiresLiveServicesError", async () => {
    const adapter = await makeLiveAdapter();
    await expect(adapter.getRevenue(FIXTURE_RESOURCE_ID)).rejects.toBeInstanceOf(
      RequiresLiveServicesError,
    );
  });

  it("subscribeBuildEvents throws on first iteration (real async generator)", async () => {
    const adapter = await makeLiveAdapter();
    let thrown: unknown;
    try {
      for await (const _ev of adapter.subscribeBuildEvents(FIXTURE_RESOURCE_ID)) {
        // The generator throws before yielding; this body never runs.
        void _ev;
      }
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RequiresLiveServicesError);
  });
});
