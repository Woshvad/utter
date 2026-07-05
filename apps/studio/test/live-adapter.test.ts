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
import { describe, it, expect, vi, beforeAll } from "vitest";
import type { PublicClient } from "viem";
import { PAYMENT_ESCROW } from "@utter/chain";
import { FIXTURE_CREATOR } from "../app/fixtures/index";
import { InMemoryIndexStore, type IndexRecord } from "@utter/marketplace";
import {
  ScaffoldGenerator,
  validateBundle,
  finalizeAgentCard,
  type Bundle,
  type ResourceSpec,
  type ValidationResult,
} from "@utter/ai-runtime";
import { resourceIdForLabel } from "@utter/x402-arc";
import { LiveAdapter } from "../app/adapter/live";
import { RequiresLiveServicesError } from "../app/adapter/live";
import type { LiveDeps } from "../app/adapter/live-deps.server";
import type { BuildEvent } from "../app/adapter/types";
import { BuildEventChannel } from "../app/adapter/build-channel";
import { runPlaygroundHarness } from "../app/adapter/playground-harness";
import type { ComposeSpec, Hex, RevenueSummary } from "../app/adapter/types";
import { FIXTURE_MARKETPLACE, FIXTURE_RESOURCE_ID } from "../app/fixtures/index";

// createResource now takes a build slot from the module-singleton pool (S4) and
// releases it when the background IIFE finishes. This file runs many creates, one of
// which (the never-resolving generate stub) holds its slot for the whole file, so the
// pool is raised far above the default 3. The pool reads env lazily on first acquire.
beforeAll(() => {
  process.env.MAX_CONCURRENT_BUILDS = "10000";
});

/** A clearly-fake unknown id for the not-found case (never seeded). */
const UNKNOWN_ID =
  "0x00000000000000000000000000000000000000000000000000000000deadbeef" as const;

/** A fixed base-unit WALLET USDC balance the stub publicClient returns for the USDC
 *  balanceOf (the getEscrowBalance read). */
const STUB_RAW_BALANCE = 25_000_000n;

/** A DISTINCT fixed base-unit ACCRUED escrow balance the stub returns for the
 *  PaymentEscrow.balanceOf (the getAccruedEarnings read), proving the two reads target
 *  different contracts and surface different amounts. */
const STUB_ACCRUED_BALANCE = 12_340_000n;

/** The fixed base-unit posted bond the stub returns for StakingVault.bonds(resourceId)
 *  (the getBondStatus read), plus its owner + cooldownEnds. */
const STUB_BOND_POSTED = 5_000_000n;
const STUB_BOND_OWNER = FIXTURE_CREATOR;
const STUB_BOND_COOLDOWN_ENDS = 0n;

/**
 * A stub viem PublicClient: decimals() returns 6 (the runtime read the money path
 * depends on) and balanceOf() returns a fixed base-unit bigint - the WALLET USDC balance
 * when read against USDC (readUsdcBalance), the ACCRUED escrow balance when read against
 * PAYMENT_ESCROW (readEscrowBalance). Switching on the contract address proves
 * getAccruedEarnings reads PaymentEscrow.balanceOf, distinct from the USDC balanceOf. The
 * bonds/bondOwner/cooldownEnds reads (the getBondStatus path) return the fixed bond stub.
 * No network. The cast mirrors the playground-harness mock idiom.
 */
function makeStubPublicClient(): PublicClient {
  return {
    async readContract({ functionName, address }: { functionName: string; address: string }) {
      if (functionName === "decimals") return 6;
      if (functionName === "balanceOf") {
        return address === PAYMENT_ESCROW ? STUB_ACCRUED_BALANCE : STUB_RAW_BALANCE;
      }
      if (functionName === "bonds") return STUB_BOND_POSTED;
      if (functionName === "bondOwner") return STUB_BOND_OWNER;
      if (functionName === "cooldownEnds") return STUB_BOND_COOLDOWN_ENDS;
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
 * A deterministic RevenueSummary the injected getRevenue seam returns. Stands in for the
 * real HTTP GET to the facilitator's /revenue/:resourceId (exercised offline in the
 * facilitator's own revenue-route test), so this suite proves the LiveAdapter pass-
 * through WITHOUT any network. All money is base-unit bigint (no decimals literal).
 */
const STUB_REVENUE: RevenueSummary = {
  resourceId: FIXTURE_RESOURCE_ID as Hex,
  calls: 2,
  gross: 30_000n,
  creatorShare: 21_000n,
  platformShare: 9_000n,
  refunds: 5_000n,
  receipts: [
    { tx: `0x${"11".repeat(32)}` as Hex, kind: "settle", amount: 20_000n, idemKey: `0x${"a1".repeat(32)}` },
    { tx: `0x${"22".repeat(32)}` as Hex, kind: "settle", amount: 10_000n, idemKey: `0x${"a2".repeat(32)}` },
    { tx: `0x${"33".repeat(32)}` as Hex, kind: "refund", amount: 5_000n, idemKey: `0x${"a3".repeat(32)}` },
  ],
};

/**
 * Build a LiveAdapter with injected offline deps + a freshly seeded index store + a
 * shared BuildEventChannel + the real scaffold generate seam + the real validateBundle
 * seam. The SAME indexStore instance backs both the seeded reads and the create publish,
 * so the post-create visibility assertion is real. An optional `validate` override lets
 * one case force a validation failure without affecting the others.
 */
async function makeLiveAdapter(
  validate: (bundle: Bundle, spec: ResourceSpec) => Promise<ValidationResult> = validateBundle,
  deployBundle?: LiveDeps["deployBundle"],
  publishToMarketplace?: LiveDeps["publishToMarketplace"],
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
    finalizeCard: finalizeAgentCard,
    // The real deploy seam (undefined by default so the existing cases keep the
    // LOCAL_REAL_BUILD_EVENTS local-sim path). When injected, createResource streams it.
    deployBundle,
    // The marketplace publish seam (undefined by default so the existing cases keep the
    // local-index Publish:ok path). When injected, createResource lists to the marketplace.
    publishToMarketplace,
    // Inject the REAL harness so the escrow reserve-before-run gate is proven, not faked.
    runPlayground: runPlaygroundHarness,
    // Inject a deterministic revenue seam (the production seam GETs the facilitator's
    // /revenue/:resourceId; the aggregation itself is covered in the facilitator test).
    getRevenue: async () => ({
      ...STUB_REVENUE,
      receipts: STUB_REVENUE.receipts.map((r) => ({ ...r })),
    }),
    // The cardUrl builder is bound to DEPLOY_DOMAIN by buildLiveDeps in production; inject a
    // deterministic offline builder so createResource records a real-shaped agent-card URL.
    buildCardUrl: (slug) => `https://${slug}.resources.example.com/.well-known/agent-card.json`,
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

/** Drain the per-resource build channel to completion. The publish/upsert now runs in the
 *  background IIFE after generation, so a post-create read must wait for the channel to
 *  complete (the loop terminates when the channel completes - it cannot hang here). */
async function drainBuild(adapter: LiveAdapter, resourceId: string): Promise<void> {
  for await (const _ev of adapter.subscribeBuildEvents(resourceId)) {
    // drain - we only need the stream to terminate (channel.complete after Live)
  }
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

  it("getAccruedEarnings reads PaymentEscrow.balanceOf (distinct from the wallet USDC balance)", async () => {
    const adapter = await makeLiveAdapter();
    const accrued = await adapter.getAccruedEarnings(
      "0x1111111111111111111111111111111111111111",
    );
    // decimals comes from the stub's decimals() read (6), not a literal in the adapter.
    expect(accrued.decimals).toBe(6);
    // The accrued read targets PAYMENT_ESCROW.balanceOf, so it returns the DISTINCT
    // accrued value, NOT the wallet USDC balance getEscrowBalance reads.
    expect(accrued.raw).toBe(STUB_ACCRUED_BALANCE);
    expect(accrued.raw).not.toBe(STUB_RAW_BALANCE);
    expect(typeof accrued.raw).toBe("bigint");
  });

  it("getBondStatus reads StakingVault bonds/bondOwner/cooldownEnds (mapped BondStatusView)", async () => {
    const adapter = await makeLiveAdapter();
    // A valid bytes32 resourceId (readBondStatus rejects a non-32-byte hex).
    const RESOURCE_ID = `0x${"a1".repeat(32)}` as const;
    const bond = await adapter.getBondStatus(RESOURCE_ID);
    // decimals comes from the stub's decimals() read (6), not a literal in the adapter.
    expect(bond.decimals).toBe(6);
    // posted maps from StakingVault.bonds(resourceId); owner from bondOwner; cooldownEnds
    // from cooldownEnds. All base-unit/raw values, no decimals literal.
    expect(bond.posted).toBe(STUB_BOND_POSTED);
    expect(typeof bond.posted).toBe("bigint");
    expect(bond.owner.toLowerCase()).toBe(STUB_BOND_OWNER.toLowerCase());
    expect(bond.cooldownEnds).toBe(STUB_BOND_COOLDOWN_ENDS);
    expect(typeof bond.cooldownEnds).toBe("bigint");
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
    // creator stays a real owner address (the ownership gate compares it to the SIWE
    // account); the registry stores creator and resourceId separately.
    expect(detail.creator).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // payout is now the canonical bytes32 resourceId, the escrow target the wallet signs
    // (PaymentEscrow.debit keys settlement off the resourceId, not a creator EOA).
    expect(detail.payout).toBe(FIXTURE_RESOURCE_ID);
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

describe("LiveAdapter getRevenue (real pass-through to the injected seam)", () => {
  // createResource and subscribeBuildEvents are REAL in local-real mode (covered by the
  // create-flow block below). getRevenue now reads REAL aggregated revenue through the
  // injected seam (the production seam GETs the facilitator's /revenue/:resourceId), so
  // it must pass the seam's RevenueSummary straight through, NOT throw.
  it("returns the injected seam's RevenueSummary (base-unit bigint, no fake data)", async () => {
    const adapter = await makeLiveAdapter();
    const revenue = await adapter.getRevenue(FIXTURE_RESOURCE_ID);
    expect(revenue.resourceId).toBe(FIXTURE_RESOURCE_ID);
    expect(revenue.calls).toBe(STUB_REVENUE.calls);
    expect(revenue.gross).toBe(STUB_REVENUE.gross);
    expect(revenue.creatorShare).toBe(STUB_REVENUE.creatorShare);
    expect(revenue.platformShare).toBe(STUB_REVENUE.platformShare);
    expect(revenue.refunds).toBe(STUB_REVENUE.refunds);
    // The gross equals the sum of the settle receipt amounts (split sums to gross).
    expect(revenue.creatorShare + revenue.platformShare).toBe(revenue.gross);
    expect(typeof revenue.gross).toBe("bigint");
    expect(revenue.receipts.length).toBe(STUB_REVENUE.receipts.length);
    expect(revenue.receipts[0]?.amount).toBeTypeOf("bigint");
  });

  it("RequiresLiveServicesError is still exported (referenced by other code/tests)", () => {
    // getRevenue no longer throws it, but the class remains part of the public surface.
    expect(typeof RequiresLiveServicesError).toBe("function");
  });
});

describe("LiveAdapter create flow (local-real, injected deps)", () => {
  /** The slug derived from the standard makeComposeSpec prompt (kebab of the prompt text),
   *  pinned by the deterministic-id test below. The canonical id is the shared-helper
   *  keccak over utter:resource:<slug>. */
  const EXPECTED_SLUG = "echo-the-caller-s-text-back-with-its-length";

  it("createResource(spec) returns { resourceId(bytes32), eventsUrl }", async () => {
    const adapter = await makeLiveAdapter();
    const { resourceId, eventsUrl } = await adapter.createResource(makeComposeSpec());
    expect(resourceId).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(eventsUrl).toBe(`/resources/${resourceId}/events`);
  });

  it("returns immediately WITHOUT awaiting generation (the never-resolving generate case)", async () => {
    // The regression this locks: generation moved off the blocking POST and into the
    // background IIFE. A generate stub that NEVER resolves must NOT hang createResource -
    // the method derives the identity up front and returns before generation runs.
    const indexStore = new InMemoryIndexStore();
    for (const rec of seedRecords()) await indexStore.upsert(rec);
    const adapter = new LiveAdapter({
      publicClient: makeStubPublicClient(),
      indexStore,
      buildChannel: new BuildEventChannel(),
      // Never resolves: if createResource awaited this, the test would time out.
      generate: () => new Promise<Bundle>(() => {}),
      validate: validateBundle,
      finalizeCard: finalizeAgentCard,
      runPlayground: runPlaygroundHarness,
      getRevenue: async () => ({ ...STUB_REVENUE, receipts: STUB_REVENUE.receipts.map((r) => ({ ...r })) }),
      buildCardUrl: (slug) => `https://${slug}.resources.example.com/.well-known/agent-card.json`,
    });

    // Resolves quickly with the deterministic identity (no hang). Do NOT drain the channel
    // for this case - the background IIFE never completes (the generate never resolves).
    const { resourceId, eventsUrl } = await adapter.createResource(makeComposeSpec());
    expect(resourceId).toBe(resourceIdForLabel(`utter:resource:${EXPECTED_SLUG}`));
    expect(eventsUrl).toBe(`/resources/${resourceId}/events`);
  });

  it("the created resource is visible in listMarketplace + getResourceDetail (shared store)", async () => {
    const adapter = await makeLiveAdapter();
    const { resourceId } = await adapter.createResource(makeComposeSpec());
    // The upsert now happens in the background IIFE (after generate + the gate passes), so
    // drain the build channel to completion first - that guarantees the publish ran.
    await drainBuild(adapter, resourceId);

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

  it("records the SIWE creator so getResourceDetail returns it (dashboard ownership scope)", async () => {
    const adapter = await makeLiveAdapter();
    const CREATOR = "0x2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b";
    const { resourceId } = await adapter.createResource(makeComposeSpec(), { creator: CREATOR });
    await drainBuild(adapter, resourceId);
    // The dashboard keeps a card only when sameAddress(detail.creator, the authed creator).
    const detail = await adapter.getResourceDetail(resourceId);
    expect(detail.creator.toLowerCase()).toBe(CREATOR.toLowerCase());
  });

  it("falls back to the local-dev placeholder creator when none is passed (matches no real wallet)", async () => {
    const adapter = await makeLiveAdapter();
    const { resourceId } = await adapter.createResource(makeComposeSpec());
    await drainBuild(adapter, resourceId);
    const detail = await adapter.getResourceDetail(resourceId);
    expect(detail.creator).toBe("0x1111111111111111111111111111111111111111");
  });

  it("subscribeBuildEvents(newId) streams the success sequence with NO duplicate Generate/Publish/Live", async () => {
    const adapter = await makeLiveAdapter();
    // createResource emits the stages fire-and-forget, so await its quick return first; the
    // channel buffers earlier events, so a slightly-late subscriber still sees Generate.
    const { resourceId } = await adapter.createResource(makeComposeSpec());

    const collected: { stage: string; status: string }[] = [];
    // The channel completes after Live, so this loop terminates naturally (no hang). If
    // it hung, the test's own timeout would fail it.
    for await (const ev of adapter.subscribeBuildEvents(resourceId)) {
      collected.push({ stage: ev.stage, status: ev.status });
    }

    const stages = collected.map((e) => e.stage);
    // The full ordered sequence is present, starting at Generate and ending at Live, with
    // the local-sim Deploy/Verify/Mint contributed in the middle.
    expect(stages[0]).toBe("Generate");
    expect(stages.at(-1)).toBe("Live");
    expect(stages).toContain("Deploy");
    expect(stages).toContain("Verify");
    expect(stages).toContain("Mint");
    expect(stages).toContain("Publish");
    // No duplicate Generate/Publish/Live: exactly one running + one ok Generate, exactly
    // one Publish, exactly one Live. The local-sim branch must not re-emit them.
    expect(collected.filter((e) => e.stage === "Generate" && e.status === "running").length).toBe(1);
    expect(collected.filter((e) => e.stage === "Generate" && e.status === "ok").length).toBe(1);
    expect(stages.filter((s) => s === "Publish").length).toBe(1);
    expect(stages.filter((s) => s === "Live").length).toBe(1);

    // The record IS upserted (publish happened after the gate passed).
    await expect(adapter.getResourceDetail(resourceId)).resolves.toBeDefined();
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

  it("a validation failure streams a Generate:error and publishes nothing (no Publish/Live, no upsert)", async () => {
    // Generation moved into the background IIFE, so a four-gate failure no longer rejects
    // synchronously - createResource RESOLVES and the failure streams as a Generate:error.
    // Force a validation failure via an injected validate stub on a SEPARATE adapter so the
    // other cases keep the real four-gate validator.
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

    // createResource now RESOLVES (does not throw) and returns the deterministic identity.
    const { resourceId } = await adapter.createResource(makeComposeSpec());

    const collected: { stage: string; status: string; log: string }[] = [];
    // The channel still completes after the gate fail, so this loop terminates (no hang).
    for await (const ev of adapter.subscribeBuildEvents(resourceId)) {
      collected.push({ stage: ev.stage, status: ev.status, log: ev.log });
    }

    const stages = collected.map((e) => e.stage);
    expect(stages[0]).toBe("Generate");
    const genError = collected.find((e) => e.stage === "Generate" && e.status === "error");
    expect(genError).toBeDefined();
    // The streamed reason contains the gate, kind, and detail strings (the same reason the
    // old synchronous throw built).
    expect(genError?.log).toContain("g1");
    expect(genError?.log).toContain("forced");
    expect(genError?.log).toContain("forced failure for the test");
    // Reject-without-publish: NO Publish, NO Live, and the record was NOT upserted.
    expect(stages).not.toContain("Publish");
    expect(stages).not.toContain("Live");
    await expect(adapter.getResourceDetail(resourceId)).rejects.toThrow();
  });

  it("a generate THROW streams a Generate:error with the message + console.errors it (no upsert)", async () => {
    // A real generate throw (e.g. the live ClaudeGenerator failing) must stream the REAL
    // reason as a Generate:error and be logged server-side, never swallowed.
    const indexStore = new InMemoryIndexStore();
    for (const rec of seedRecords()) await indexStore.upsert(rec);
    const adapter = new LiveAdapter({
      publicClient: makeStubPublicClient(),
      indexStore,
      buildChannel: new BuildEventChannel(),
      generate: async () => {
        throw new Error("model unavailable");
      },
      validate: validateBundle,
      finalizeCard: finalizeAgentCard,
      runPlayground: runPlaygroundHarness,
      getRevenue: async () => ({ ...STUB_REVENUE, receipts: STUB_REVENUE.receipts.map((r) => ({ ...r })) }),
      buildCardUrl: (slug) => `https://${slug}.resources.example.com/.well-known/agent-card.json`,
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { resourceId } = await adapter.createResource(makeComposeSpec());

      const collected: { stage: string; status: string; log: string }[] = [];
      for await (const ev of adapter.subscribeBuildEvents(resourceId)) {
        collected.push({ stage: ev.stage, status: ev.status, log: ev.log });
      }

      const genError = collected.find((e) => e.stage === "Generate" && e.status === "error");
      expect(genError).toBeDefined();
      expect(genError?.log).toBe("model unavailable");
      // No Publish/Live and the record was NOT upserted.
      const stages = collected.map((e) => e.stage);
      expect(stages).not.toContain("Publish");
      expect(stages).not.toContain("Live");
      await expect(adapter.getResourceDetail(resourceId)).rejects.toThrow();
      // The real error was surfaced server-side.
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("getRevenue reads through the injected revenue seam (real pass-through)", async () => {
    const adapter = await makeLiveAdapter();
    const revenue = await adapter.getRevenue(FIXTURE_RESOURCE_ID);
    expect(revenue.calls).toBe(STUB_REVENUE.calls);
    expect(revenue.gross).toBe(STUB_REVENUE.gross);
    expect(revenue.creatorShare + revenue.platformShare).toBe(revenue.gross);
  });

  it("createResource derives the canonical keccak id (deterministic, no counter)", async () => {
    const adapter = await makeLiveAdapter();
    // The same prompt yields the same slug, and the slug yields the same canonical keccak
    // id via the shared resourceIdForLabel (no monotonic counter). The studio label scheme
    // is utter:resource:<slug>; the slug for this prompt is the kebab of the prompt text.
    const { resourceId } = await adapter.createResource(makeComposeSpec());
    const slug = "echo-the-caller-s-text-back-with-its-length";
    expect(resourceId).toBe(resourceIdForLabel(`utter:resource:${slug}`));
    expect(resourceId).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  it("a created resource's detail payout equals the canonical resourceId and the cardUrl is real-shaped", async () => {
    const adapter = await makeLiveAdapter();
    const { resourceId } = await adapter.createResource(makeComposeSpec());
    // The upsert now happens in the background IIFE; drain to completion so the publish ran.
    await drainBuild(adapter, resourceId);
    const detail = await adapter.getResourceDetail(resourceId);
    // payout is the bytes32 escrow target (the wallet signs this), == the resourceId.
    expect(detail.payout).toBe(resourceId);
    // The cardUrl comes from the injected DEPLOY_DOMAIN builder, not a hardcode in live.ts.
    expect(detail.cardUrl).toMatch(
      /^https:\/\/[a-z0-9-]+\.resources\.[a-z0-9.-]+\/\.well-known\/agent-card\.json$/,
    );
  });
});

describe("LiveAdapter create flow with the real deployer seam (injected deployBundle)", () => {
  /** The slug derived from the standard makeComposeSpec prompt (kebab of the prompt text). */
  const EXPECTED_SLUG = "echo-the-caller-s-text-back-with-its-length";

  it("streams Generate -> deployer events (Mint/Deploy/Verify) -> Publish -> Live", async () => {
    // Record the single argument the seam is called with, and yield three deployer events.
    let captured:
      | { bundle: Record<string, string>; slug: string; resourceLabel: string; pricing: unknown }
      | undefined;
    const deployBundle: LiveDeps["deployBundle"] = (params) => {
      captured = params;
      return (async function* (): AsyncGenerator<BuildEvent> {
        yield { stage: "Mint", status: "ok", log: "identity registered" };
        yield { stage: "Deploy", status: "ok", log: "sandbox launched" };
        yield { stage: "Verify", status: "ok", log: "gates passed" };
      })();
    };
    const adapter = await makeLiveAdapter(validateBundle, deployBundle);
    const { resourceId } = await adapter.createResource(makeComposeSpec());

    const collected: { stage: string; status: string }[] = [];
    for await (const ev of adapter.subscribeBuildEvents(resourceId)) {
      collected.push({ stage: ev.stage, status: ev.status });
    }

    // The full ordered sequence: Generate(run,ok) -> the three deployer events -> Publish -> Live.
    expect(collected).toEqual([
      { stage: "Generate", status: "running" },
      { stage: "Generate", status: "ok" },
      { stage: "Mint", status: "ok" },
      { stage: "Deploy", status: "ok" },
      { stage: "Verify", status: "ok" },
      { stage: "Publish", status: "ok" },
      { stage: "Live", status: "ok" },
    ]);

    // The deployer is POSTed the keystone resourceLabel and the conservative pricing.
    expect(captured?.resourceLabel).toBe(`utter:resource:${EXPECTED_SLUG}`);
    expect(captured?.slug).toBe(EXPECTED_SLUG);
    // The bundle handed to the deployer carries the FINALIZED card (payTo = resourceId), so the
    // sidecar serves a card whose escrow target binds to this resource (not the placeholder).
    const deployedCardJson = captured!.bundle["agent-card.json"];
    expect(deployedCardJson).toBeTypeOf("string");
    const deployedCard = JSON.parse(deployedCardJson!) as { x402?: { payTo?: unknown } };
    expect(deployedCard.x402?.payTo).toBe(resourceId);
    expect(captured?.pricing).toEqual({
      model: "metered",
      base: makeComposeSpec().basePrice.toString(),
      perKB: "0",
      computeMultiplier: "0",
      maxResponseBytes: 1048576,
    });
  });

  it("falls back to the LOCAL_REAL_BUILD_EVENTS stream when deployBundle is undefined", async () => {
    // The existing default (no deployBundle) keeps the local-sim sequence Generate..Live.
    const adapter = await makeLiveAdapter();
    const { resourceId } = await adapter.createResource(makeComposeSpec());

    const stages: string[] = [];
    for await (const ev of adapter.subscribeBuildEvents(resourceId)) {
      stages.push(ev.stage);
    }
    expect(stages[0]).toBe("Generate");
    expect(stages.at(-1)).toBe("Live");
    expect(stages).toContain("Deploy");
    expect(stages).toContain("Verify");
    expect(stages).toContain("Mint");
    expect(stages).toContain("Publish");
  });

  it("threads the SIWE creator (opts.creator) to the deployer as the on-chain split recipient", async () => {
    // The on-chain creator is the 70% payee. The studio must route it to the SIWE-authenticated
    // creator so a resource's earnings accrue to THEM, not the deployer admin/relayer key.
    let captured: { creator?: string } | undefined;
    const deployBundle: LiveDeps["deployBundle"] = (params) => {
      captured = params;
      return (async function* (): AsyncGenerator<BuildEvent> {
        yield { stage: "Deploy", status: "ok", log: "sandbox launched" };
      })();
    };
    const adapter = await makeLiveAdapter(validateBundle, deployBundle);
    const CREATOR = "0x3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c";
    const { resourceId } = await adapter.createResource(makeComposeSpec(), { creator: CREATOR });
    await drainBuild(adapter, resourceId);
    expect(captured?.creator).toBe(CREATOR);
  });

  it("omits the deployer creator when no SIWE creator is passed (fallback to RESOURCE_CREATOR/admin)", async () => {
    let captured: { creator?: string } | undefined;
    const deployBundle: LiveDeps["deployBundle"] = (params) => {
      captured = params;
      return (async function* (): AsyncGenerator<BuildEvent> {
        yield { stage: "Deploy", status: "ok", log: "sandbox launched" };
      })();
    };
    const adapter = await makeLiveAdapter(validateBundle, deployBundle);
    const { resourceId } = await adapter.createResource(makeComposeSpec());
    await drainBuild(adapter, resourceId);
    expect(captured?.creator).toBeUndefined();
  });

  it("a deployer throw surfaces a Deploy(error) and still completes the channel (no hang)", async () => {
    const SECRET_SHAPED = "Bearer sk_live_should_never_appear";
    const deployBundle: LiveDeps["deployBundle"] = () =>
      (async function* (): AsyncGenerator<BuildEvent> {
        yield { stage: "Mint", status: "ok", log: "identity registered" };
        // The streamDeploy errors are already bearer-free; this message is plain prose.
        throw new Error("deploy failed: build timed out");
      })();
    const adapter = await makeLiveAdapter(validateBundle, deployBundle);
    const { resourceId } = await adapter.createResource(makeComposeSpec());

    const collected: { stage: string; status: string; log: string }[] = [];
    // If the channel did not complete, this loop would hang and the test would time out.
    for await (const ev of adapter.subscribeBuildEvents(resourceId)) {
      collected.push({ stage: ev.stage, status: ev.status, log: ev.log });
    }

    const deployError = collected.find((e) => e.stage === "Deploy" && e.status === "error");
    expect(deployError).toBeDefined();
    expect(deployError?.log).toBe("deploy failed: build timed out");
    // No emitted log carries a secret-shaped string.
    for (const ev of collected) {
      expect(ev.log).not.toContain(SECRET_SHAPED);
    }
  });
});

describe("LiveAdapter create flow with the marketplace publish seam (injected publishToMarketplace)", () => {
  /** The slug derived from the standard makeComposeSpec prompt (kebab of the prompt text). */
  const EXPECTED_SLUG = "echo-the-caller-s-text-back-with-its-length";

  it("calls publishToMarketplace once with the right params and emits Publish:ok (marketplace) then Live:ok", async () => {
    // Capture the single argument the publish seam is called with, and report a listed
    // outcome. The card is parsed from the generated bundle's agent-card.json.
    let captured: import("../app/adapter/marketplace-client.server").PublishParams | undefined;
    let calls = 0;
    const publishToMarketplace: LiveDeps["publishToMarketplace"] = async (params) => {
      calls += 1;
      captured = params;
      return { listed: true, agentId: "7" };
    };
    const adapter = await makeLiveAdapter(validateBundle, undefined, publishToMarketplace);
    const { resourceId } = await adapter.createResource(makeComposeSpec());

    const collected: { stage: string; status: string; log: string }[] = [];
    for await (const ev of adapter.subscribeBuildEvents(resourceId)) {
      collected.push({ stage: ev.stage, status: ev.status, log: ev.log });
    }

    // Called exactly once, with the keystone resourceId/cardUrl, the prompt (moderation
    // input), category "data", the parsed A2A card, and the derived slug.
    expect(calls).toBe(1);
    expect(captured?.prompt).toBe(makeComposeSpec().prompt);
    expect(captured?.resourceId).toBe(resourceId);
    expect(captured?.category).toBe("data");
    expect(captured?.slug).toBe(EXPECTED_SLUG);
    expect(captured?.cardUrl).toMatch(/\/\.well-known\/agent-card\.json$/);
    // The card is the PARSED object (not the raw JSON string), so it is a plain object.
    expect(captured?.card).toBeTypeOf("object");
    expect(captured?.card).not.toBeNull();
    // The card's x402.payTo is FINALIZED to the resourceId (not the placeholder-<slug>), so the
    // marketplace's payTo-binding gate lists it instead of refusing it as a payment redirect.
    const publishedX402 = (captured?.card as { x402?: { payTo?: unknown } }).x402;
    expect(publishedX402?.payTo).toBe(resourceId);

    // The Publish stage reflects the marketplace listing, followed by Live.
    const publish = collected.find((e) => e.stage === "Publish");
    expect(publish?.status).toBe("ok");
    expect(publish?.log).toContain("marketplace");
    expect(collected.at(-1)?.stage).toBe("Live");
    expect(collected.at(-1)?.status).toBe("ok");
  });

  it("passes the SIWE creator to publishToMarketplace so the durable index carries the owner (restart-proof dashboard)", async () => {
    let captured: import("../app/adapter/marketplace-client.server").PublishParams | undefined;
    const publishToMarketplace: LiveDeps["publishToMarketplace"] = async (params) => {
      captured = params;
      return { listed: true, agentId: "7" };
    };
    const adapter = await makeLiveAdapter(validateBundle, undefined, publishToMarketplace);
    const CREATOR = "0x5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e";
    const { resourceId } = await adapter.createResource(makeComposeSpec(), { creator: CREATOR });
    await drainBuild(adapter, resourceId);
    // The same authenticated owner recorded on the local IndexRecord is persisted to the durable
    // marketplace index, so the dashboard's owned-resources view survives a studio restart.
    expect(captured?.creator).toBe(CREATOR);
  });

  it("emits Publish:error (bearer-free) and STILL emits Live:ok when publishToMarketplace throws", async () => {
    const SECRET_SHAPED = "Bearer sk_live_should_never_appear";
    const publishToMarketplace: LiveDeps["publishToMarketplace"] = async () => {
      // publishResource errors are already bearer-free; this stands in for one.
      throw new Error("marketplace blocked the resource (not listed): disallowed category");
    };
    const adapter = await makeLiveAdapter(validateBundle, undefined, publishToMarketplace);
    const { resourceId } = await adapter.createResource(makeComposeSpec());

    const collected: { stage: string; status: string; log: string }[] = [];
    for await (const ev of adapter.subscribeBuildEvents(resourceId)) {
      collected.push({ stage: ev.stage, status: ev.status, log: ev.log });
    }

    // A listing failure is NON-FATAL: Publish:error is emitted, and Live:ok STILL fires.
    const publish = collected.find((e) => e.stage === "Publish");
    expect(publish?.status).toBe("error");
    expect(publish?.log).toContain("blocked");
    const live = collected.find((e) => e.stage === "Live");
    expect(live?.status).toBe("ok");
    // No emitted log carries a secret-shaped string.
    for (const ev of collected) {
      expect(ev.log).not.toContain(SECRET_SHAPED);
    }
  });

  it("keeps the local-index Publish:ok path unchanged when publishToMarketplace is unbound", async () => {
    // The default (no publishToMarketplace) keeps the existing local-index listing event.
    const adapter = await makeLiveAdapter();
    const { resourceId } = await adapter.createResource(makeComposeSpec());

    const collected: { stage: string; status: string; log: string }[] = [];
    for await (const ev of adapter.subscribeBuildEvents(resourceId)) {
      collected.push({ stage: ev.stage, status: ev.status, log: ev.log });
    }

    const publish = collected.find((e) => e.stage === "Publish");
    expect(publish?.status).toBe("ok");
    expect(publish?.log).toBe("listed for discovery (shared local index)");
    expect(collected.at(-1)?.stage).toBe("Live");
  });
});

describe("LiveAdapter listMarketplace with the discovery read seam (injected listResources)", () => {
  /** A bytes32-shaped id that is NOT in the seeded fixture store, so a result containing it
   *  proves the records came from the live seam, not the seeded index. */
  const LIVE_ONLY_ID =
    "0x000000000000000000000000000000000000000000000000000000000000aa01" as const;

  /** Two live-source IndexRecords the injected listResources returns. Distinct from the
   *  seeded fixtures (different ids/slugs) so the assertion proves the live source, and one
   *  is category "data" + one "compute" so the filter assertion is meaningful. Money is
   *  base-unit bigint (no decimals literal); pricing stays string base units. */
  function liveRecords(): IndexRecord[] {
    return [
      {
        resourceId: LIVE_ONLY_ID as Hex,
        agentId: "42",
        slug: "live-weather",
        category: "data",
        pricing: { model: "metered", base: "20000", perKB: "0", max: "20000" },
        reputation: 9n,
        uptime: 1,
        health: { verified: true, score: 1 },
        bond: 7_000_000n,
        cardUrl: "https://live-weather.resources.example.com/.well-known/agent-card.json",
        active: true,
      },
      {
        resourceId:
          "0x000000000000000000000000000000000000000000000000000000000000aa02" as Hex,
        agentId: "43",
        slug: "live-summarize",
        category: "compute",
        pricing: { model: "metered", base: "30000", perKB: "0", max: "30000" },
        reputation: 4n,
        uptime: 1,
        health: { verified: true, score: 1 },
        bond: 6_000_000n,
        cardUrl: "https://live-summarize.resources.example.com/.well-known/agent-card.json",
        active: true,
      },
    ];
  }

  /** Build a LiveAdapter whose injected indexStore holds the SEEDED fixtures, with an
   *  optional listResources seam. When the seam is bound, listMarketplace must read it and
   *  IGNORE the seeded indexStore (the live marketplace is the source of discovery truth). */
  async function makeAdapterWithListResources(
    listResources?: LiveDeps["listResources"],
  ): Promise<LiveAdapter> {
    const indexStore = new InMemoryIndexStore();
    for (const rec of seedRecords()) await indexStore.upsert(rec);
    return new LiveAdapter({
      publicClient: makeStubPublicClient(),
      indexStore,
      buildChannel: new BuildEventChannel(),
      generate: scaffoldGenerate,
      validate: validateBundle,
      finalizeCard: finalizeAgentCard,
      runPlayground: runPlaygroundHarness,
      getRevenue: async () => ({ ...STUB_REVENUE, receipts: STUB_REVENUE.receipts.map((r) => ({ ...r })) }),
      buildCardUrl: (slug) => `https://${slug}.resources.example.com/.well-known/agent-card.json`,
      listResources,
    });
  }

  it("reads the live-source records (not the seeded store) when listResources is bound", async () => {
    let calls = 0;
    const adapter = await makeAdapterWithListResources(async () => {
      calls += 1;
      return liveRecords().map((r) => ({ ...r }));
    });

    const all = await adapter.listMarketplace({});
    // The live seam was used exactly once.
    expect(calls).toBe(1);
    // The result contains the live-only id and NOT the seeded fixture id (proving the
    // records came from the live marketplace SERVICE, not the seeded local index).
    const ids = all.map((c) => c.resourceId);
    expect(ids).toContain(LIVE_ONLY_ID);
    expect(ids).not.toContain(FIXTURE_RESOURCE_ID);
  });

  it("applies the SAME pure filterResources to the live-source records", async () => {
    const adapter = await makeAdapterWithListResources(async () => liveRecords().map((r) => ({ ...r })));
    const dataOnly = await adapter.listMarketplace({ category: "data" });
    // Only the category-data live record survives the shared filter.
    expect(dataOnly.length).toBe(1);
    expect(dataOnly[0]?.resourceId).toBe(LIVE_ONLY_ID);
    expect(dataOnly.every((c) => c.category === "data")).toBe(true);
  });

  it("falls back to the seeded indexStore when listResources is undefined (existing behavior)", async () => {
    const adapter = await makeAdapterWithListResources(undefined);
    const all = await adapter.listMarketplace({});
    // No live seam: the seeded fixtures are read exactly as today, and the live-only id is
    // absent.
    expect(all.map((c) => c.resourceId)).toContain(FIXTURE_RESOURCE_ID);
    expect(all.map((c) => c.resourceId)).not.toContain(LIVE_ONLY_ID);
  });

  it("getResourceDetail reads the DURABLE marketplace (listResources) when bound, carrying the creator", async () => {
    // After a studio restart the in-memory index is reseeded empty; a resource created before
    // the restart must still resolve its owner from the DURABLE marketplace so the dashboard's
    // ownership scope (sameAddress(detail.creator, the authed creator)) survives the restart.
    const OWNER = "0x9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a" as Hex;
    const durable = liveRecords();
    durable[0]!.creator = OWNER;
    const adapter = await makeAdapterWithListResources(async () => durable.map((r) => ({ ...r })));

    const detail = await adapter.getResourceDetail(LIVE_ONLY_ID);
    // LIVE_ONLY_ID is NOT in the seeded in-memory store, proving the record came from the
    // durable seam - and its creator is carried through recordToDetail for the ownership scope.
    expect(detail.resourceId).toBe(LIVE_ONLY_ID);
    expect(detail.creator.toLowerCase()).toBe(OWNER.toLowerCase());
  });

  it("getResourceDetail falls through to the local index for a fresh-create id not yet in the durable list", async () => {
    // A JUST-created resource is upserted to the in-memory store immediately but may not yet be
    // listed in the durable marketplace (publish is async/gate-guarded, or a listing failure is
    // non-fatal). getResourceDetail must still resolve it from the local index rather than 404.
    const adapter = await makeAdapterWithListResources(async () => []); // durable list empty
    const detail = await adapter.getResourceDetail(FIXTURE_RESOURCE_ID);
    expect(detail.resourceId).toBe(FIXTURE_RESOURCE_ID);
  });

  it("getResourceDetail falls through to the local index when the durable read THROWS (outage, not a 404)", async () => {
    // A marketplace OUTAGE must not turn an owned resource into a 404 (which would also block
    // requireResourceOwner-gated actions). listResources() is fail-loud; getResourceDetail must
    // catch it and resolve an in-memory hit instead of throwing.
    const adapter = await makeAdapterWithListResources(async () => {
      throw new Error("marketplace GET /resources could not be reached (ECONNREFUSED)");
    });
    const detail = await adapter.getResourceDetail(FIXTURE_RESOURCE_ID);
    expect(detail.resourceId).toBe(FIXTURE_RESOURCE_ID);
  });
});
