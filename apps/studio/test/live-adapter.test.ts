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
import {
  ScaffoldGenerator,
  validateBundle,
  type Bundle,
  type ResourceSpec,
  type ValidationResult,
} from "@utter/ai-runtime";
import { LiveAdapter } from "../app/adapter/live";
import { RequiresLiveServicesError } from "../app/adapter/live";
import { BuildEventChannel } from "../app/adapter/build-channel";
import { runPlaygroundHarness } from "../app/adapter/playground-harness";
import type { ComposeSpec } from "../app/adapter/types";
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

/** The real offline scaffold generator (no ANTHROPIC key, no network). */
const scaffold = new ScaffoldGenerator();
const scaffoldGenerate = (spec: ResourceSpec): Promise<Bundle> => scaffold.generate(spec);

/**
 * Build a LiveAdapter with injected offline deps + a freshly seeded index store + a
 * shared BuildEventChannel + the real scaffold generate seam + the real validateBundle
 * seam. The SAME indexStore instance backs both the seeded reads and the create publish,
 * so the post-create visibility assertion is real. An optional `validate` override lets
 * one case force a validation failure without affecting the others.
 */
async function makeLiveAdapter(
  validate: (bundle: Bundle, spec: ResourceSpec) => Promise<ValidationResult> = validateBundle,
): Promise<LiveAdapter> {
  const indexStore = new InMemoryIndexStore();
  for (const rec of seedRecords()) {
    await indexStore.upsert(rec);
  }
  return new LiveAdapter({
    publicClient: makeStubPublicClient(),
    indexStore,
    buildChannel: new BuildEventChannel(),
    generate: scaffoldGenerate,
    validate,
    // Inject the REAL harness so the escrow reserve-before-run gate is proven, not faked.
    runPlayground: runPlaygroundHarness,
  });
}

/** A ComposeSpec for the create-flow cases. All money is base-unit bigint (no literal
 *  decimals); payout is a 0x...40hex checksummed-shaped address. */
function makeComposeSpec(overrides: Partial<ComposeSpec> = {}): ComposeSpec {
  return {
    prompt: "echo the caller's text back with its length",
    pricingModel: "metered",
    basePrice: 10_000n,
    bond: 5_000_000n,
    payout: "0x1111111111111111111111111111111111111111",
    ...overrides,
  };
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
  // createResource and subscribeBuildEvents are now REAL in local-real mode (covered by
  // the create-flow block below). getRevenue stays deferred: the live revenue
  // aggregation lands later, so it must still fail loud rather than return fake data.
  it("getRevenue still throws RequiresLiveServicesError", async () => {
    const adapter = await makeLiveAdapter();
    await expect(adapter.getRevenue(FIXTURE_RESOURCE_ID)).rejects.toBeInstanceOf(
      RequiresLiveServicesError,
    );
  });
});

describe("LiveAdapter create flow (local-real, injected deps)", () => {
  it("createResource(spec) returns { resourceId(bytes32), eventsUrl }", async () => {
    const adapter = await makeLiveAdapter();
    const { resourceId, eventsUrl } = await adapter.createResource(makeComposeSpec());
    expect(resourceId).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(eventsUrl).toBe(`/resources/${resourceId}/events`);
  });

  it("the created resource is visible in listMarketplace + getResourceDetail (shared store)", async () => {
    const adapter = await makeLiveAdapter();
    const { resourceId } = await adapter.createResource(makeComposeSpec());

    // Visible in discovery: the SAME singleton-shaped store backs both reads and the
    // create publish, so the new id appears alongside the seeded cards.
    const cards = await adapter.listMarketplace({});
    expect(cards.map((c) => c.resourceId)).toContain(resourceId);

    // Visible in detail: a real ResourceDetail projection (bigint bond, truthy pricing).
    const detail = await adapter.getResourceDetail(resourceId);
    expect(detail.resourceId).toBe(resourceId);
    expect(detail.bond).toBeTypeOf("bigint");
    expect(detail.pricing.base).toBeTruthy();
  });

  it("subscribeBuildEvents(newId) drains Generate..Live and terminates (no throw/hang)", async () => {
    const adapter = await makeLiveAdapter();
    // createResource emits the stages fire-and-forget, so await it first; the channel
    // buffers earlier events, so a slightly-late subscriber still sees Generate.
    const { resourceId } = await adapter.createResource(makeComposeSpec());

    const collected: { stage: string; status: string }[] = [];
    // The channel completes after Live, so this loop terminates naturally (no hang). If
    // it hung, the test's own timeout would fail it.
    for await (const ev of adapter.subscribeBuildEvents(resourceId)) {
      collected.push({ stage: ev.stage, status: ev.status });
    }

    const stages = collected.map((e) => e.stage);
    // The full ordered sequence is present, starting at Generate and ending at Live.
    expect(stages[0]).toBe("Generate");
    expect(stages.at(-1)).toBe("Live");
    expect(stages).toContain("Deploy");
    expect(stages).toContain("Verify");
    expect(stages).toContain("Mint");
    expect(stages).toContain("Publish");
    // Exactly one terminal Live(ok) event.
    const liveOk = collected.filter((e) => e.stage === "Live" && e.status === "ok");
    expect(liveOk.length).toBe(1);
  });

  it("the created resource is playable through runPlayground", async () => {
    const adapter = await makeLiveAdapter();
    const { resourceId } = await adapter.createResource(makeComposeSpec());
    // The harness builds its OWN served card for any valid bytes32 id, so the derived
    // local-dev resourceId is playable end-to-end through the reserve-before-run gate.
    const res = await adapter.runPlayground(resourceId, { text: "hello" });
    expect(res.paid).toBe(true);
    expect(res.debitAmount).toBeGreaterThan(0n);
  });

  it("a validation failure rejects WITHOUT publishing the resource", async () => {
    // Force a validation failure via an injected validate stub on a SEPARATE adapter so
    // the other cases keep the real four-gate validator.
    const failingValidate = async (): Promise<ValidationResult> => ({
      pass: false,
      gates: {
        g1: { pass: false, violations: [] },
        g2: { pass: true, violations: [] },
        g3: { pass: true, violations: [] },
        g4: { pass: true, violations: [] },
      },
      violations: [{ gate: "g1", kind: "forced", detail: "forced failure for the test" }],
    });
    const adapter = await makeLiveAdapter(failingValidate);

    const before = (await adapter.listMarketplace({})).map((c) => c.resourceId);
    await expect(adapter.createResource(makeComposeSpec())).rejects.toThrow(/forced/);
    // Reject-before-publish: no new card was added to the store.
    const after = (await adapter.listMarketplace({})).map((c) => c.resourceId);
    expect(after).toEqual(before);
  });

  it("getRevenue still throws RequiresLiveServicesError (deferred)", async () => {
    const adapter = await makeLiveAdapter();
    await expect(adapter.getRevenue(FIXTURE_RESOURCE_ID)).rejects.toBeInstanceOf(
      RequiresLiveServicesError,
    );
  });
});
