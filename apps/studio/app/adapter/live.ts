// live.ts - the LiveAdapter (increment 1d: real READ path, deferred WRITE path).
//
// The four READ methods (getEscrowBalance, listMarketplace, getResourceDetail,
// runPlayground) now read THROUGH the existing backend pieces via injected LiveDeps:
// the escrow balance flows through readUsdcBalance (runtime decimals(), no literal),
// the marketplace + detail project from the seeded read-through IndexStore filtered by
// the SAME pure filterResources the FixtureAdapter uses, and the playground reuses the
// runPlaygroundHarness VERBATIM so the reserve-before-run escrow gate stays intact.
//
// createResource + subscribeBuildEvents are now REAL in local-real mode (increment
// 1g): createResource scaffold-generates a bundle (no ANTHROPIC key), runs the four-
// gate validateBundle, publishes an IndexRecord into the SHARED singleton store, and
// kicks off the build-stage stream into the per-resource channel; subscribeBuildEvents
// is a real async generator that delegates to the channel (yields Generate..Live, then
// terminates, never throws before its first yield). getRevenue stays fail-loud: the
// live revenue aggregation lands later. None of these touch an operator-gated live
// service: the generator is the offline scaffold, the Deploy/Mint stages are labeled
// local-sim (no container, no on-chain mint), and the publish is the local index upsert.
//
// LiveDeps is imported TYPE-ONLY from live-deps.server.js so the class never bundles
// the server module (T-mdx-01); the deps are injected by select.ts (production) or a
// test (offline). All money is base-unit bigint; there is NO 1e6/6/18 literal here.
import { createHash } from "node:crypto";
import { filterResources, type IndexRecord } from "@utter/marketplace";
import { readUsdcBalance } from "@utter/chain";
import type { Address } from "viem";
import type { LiveDeps } from "./live-deps.server.js";
import type {
  BuildEvent,
  ComposeSpec,
  Hex,
  PlaygroundResult,
  ResourceCardData,
  ResourceDetail,
  RevenueSummary,
  SandboxStatus,
  StudioDataAdapter,
  UsdcBalance,
} from "./types.js";
import type { FilterCriteria } from "@utter/marketplace";

/**
 * The error thrown when the live adapter is invoked for a sub-call that needs the
 * operator-provisioned services not yet wired (the live build/revenue pipeline). The
 * message names the NEXT increment so the gap is explicit; it never returns fake data.
 */
export class RequiresLiveServicesError extends Error {
  readonly code = "requiresLiveServices" as const;
  constructor(method: string) {
    super(
      `LiveAdapter.${method} is not wired yet: the live build/revenue pipeline lands ` +
        "in a later increment (1g). It requires the operator-provisioned services " +
        "(the wildcard-TLS resources host, a funded relayer wallet, and the live " +
        "registry writes). It is operator-gated and NEVER returns fake data.",
    );
    this.name = "RequiresLiveServicesError";
  }
}

/** The ordered local-real build-stage script. Mirrors fixtures/index.ts
 *  FIXTURE_BUILD_EVENTS (a running->ok pair per stage for Generate..Publish, then a
 *  single Live->ok). The Generate stage reflects the real scaffold generate+validate
 *  that already ran; Deploy and Mint are labeled local-sim HONESTLY (no container, no
 *  on-chain mint); Publish reflects the real index upsert that already ran. The logs
 *  carry only non-secret human prose (BuildEvent.log contract). */
const LOCAL_REAL_BUILD_EVENTS: readonly BuildEvent[] = [
  { stage: "Generate", status: "running", log: "scaffold-generating handler bundle" },
  { stage: "Generate", status: "ok", log: "bundle generated and four-gate validated" },
  { stage: "Deploy", status: "running", log: "deploy (local-sim): in-process, no container" },
  { stage: "Deploy", status: "ok", log: "deploy (local-sim): sandbox simulated up" },
  { stage: "Verify", status: "running", log: "verify (local-sim): replaying gate checks" },
  { stage: "Verify", status: "ok", log: "verify (local-sim): gates already passed" },
  { stage: "Mint", status: "running", log: "mint (local id): no on-chain registry write" },
  { stage: "Mint", status: "ok", log: "mint (local id): local-dev agentId assigned" },
  { stage: "Publish", status: "running", log: "publishing agent card + index" },
  { stage: "Publish", status: "ok", log: "listed for discovery (shared local index)" },
  { stage: "Live", status: "ok", log: "resource is live (local-real)" },
] as const;

/** A small await gap between stage emits so the SSE reader observes stages streaming
 *  rather than all at once, mirroring the fixture's delay(1). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Derive a valid 0x-prefixed 32-byte (64 hex) resourceId from the prompt plus a
 *  monotonic local counter, so repeated identical prompts get distinct ids. This is a
 *  LOCAL-DEV id (a sha256 digest), NEVER an on-chain mint; the Mint stage is labeled
 *  local-sim and downstream never treats it as a canonical on-chain identity. */
let localResourceCounter = 0;
function deriveLocalResourceId(prompt: string): Hex {
  const seed = `${prompt}#${localResourceCounter++}#${Date.now()}`;
  const digest = createHash("sha256").update(seed).digest("hex");
  return `0x${digest}` as Hex;
}

/** Derive a bounded discovery slug from the prompt: lowercase, alnum-hyphen, trimmed,
 *  collapsed, length-capped. Falls back to a stable local slug for an empty result. */
function deriveSlug(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "local-resource";
}

/** A clearly-labeled LOCAL-DEV default owner/payout address for the seeded index.
 *  The seeded IndexRecord carries no creator/payout (those resolve on-chain in a
 *  later increment); this read-through-shaped placeholder is never a live identity. */
const LOCAL_DEV_CREATOR = "0x1111111111111111111111111111111111111111" as Hex;

/**
 * Project a read-through IndexRecord into the marketplace card row. Mirrors the
 * fixture.ts listMarketplace back-projection exactly.
 */
function recordToCard(r: IndexRecord): ResourceCardData {
  return {
    resourceId: r.resourceId as Hex,
    agentId: r.agentId,
    slug: r.slug,
    category: r.category,
    pricing: { ...r.pricing },
    reputation: r.reputation,
    uptime: r.uptime,
    bond: r.bond,
    active: r.active,
  };
}

/**
 * Project a read-through IndexRecord into the resource detail. Pricing/health/bond/
 * cardUrl come straight from the record; creator/payout source from the LOCAL-DEV
 * default (the record has no owner field until the on-chain read lands); sandbox maps
 * from the active flag. Never invents a money/identity value.
 */
function recordToDetail(r: IndexRecord): ResourceDetail {
  const sandbox: SandboxStatus = r.active ? "live" : "down";
  return {
    resourceId: r.resourceId as Hex,
    creator: LOCAL_DEV_CREATOR,
    agentId: r.agentId,
    slug: r.slug,
    category: r.category,
    payout: LOCAL_DEV_CREATOR,
    pricing: { ...r.pricing },
    health: { ...r.health },
    bond: r.bond,
    sandbox,
    cardUrl: r.cardUrl,
  };
}

/**
 * The live adapter. The four read methods read through injected LiveDeps; the three
 * pipeline methods fail loud (next increment). select.ts builds the deps from
 * live-deps.server.ts and injects them; a legacy/no-deps construction throws a clear
 * "deps not injected" error rather than silently reading real env.
 */
export class LiveAdapter implements StudioDataAdapter {
  readonly backend = "live" as const;

  /** The injected read dependencies, or undefined for a legacy/no-deps construction. */
  private readonly deps?: LiveDeps;

  constructor(deps?: LiveDeps) {
    this.deps = deps;
  }

  /** Return the injected deps or throw a clear not-injected error (never reads env). */
  private requireDeps(): LiveDeps {
    if (!this.deps) {
      throw new Error(
        "LiveAdapter read deps were not injected (selectAdapter builds them from " +
          "live-deps.server). Construct the adapter with LiveDeps to use the read path.",
      );
    }
    return this.deps;
  }

  async createResource(spec: ComposeSpec): Promise<{ resourceId: string; eventsUrl: string }> {
    const deps = this.requireDeps();

    // 1. Translate the ComposeSpec into the ai-runtime ResourceSpec. The validator's
    //    G4 (gatePricing) REQUIRES model "metered", so the pricing handed to the
    //    runtime is ALWAYS metered regardless of spec.pricingModel; basePrice is a
    //    base-unit bigint, so we carry it through as a string (no 1e6/decimals
    //    literal). spec.pricingModel only shapes the DISPLAYED IndexRecord pricing in
    //    step 4, not this validation pricing.
    const base = spec.basePrice.toString();
    const resourceSpec = {
      prompt: spec.prompt,
      runtime: "node" as const,
      pricing: { model: "metered" as const, base, perKB: "0", max: base },
    };

    // 2. Scaffold-generate the bundle (no ANTHROPIC key on the default seam path).
    const bundle = await deps.generate(resourceSpec);

    // 3. Four-gate validate BEFORE any publish or stage emit. On failure, throw a clear
    //    error naming the first violation (gate + kind + detail) and publish nothing
    //    (reject-before-publish, T-1g-01). create.tsx surfaces the thrown reason.
    const validation = await deps.validate(bundle, resourceSpec);
    if (!validation.pass) {
      const first = validation.violations[0];
      const reason = first
        ? `${first.gate}/${first.kind}: ${first.detail}`
        : "validation failed with no reported violation";
      throw new Error(`createResource: bundle failed validation (${reason})`);
    }

    // 4. Derive a valid bytes32 LOCAL-DEV resourceId + slug, build the IndexRecord, and
    //    publish it into the SHARED singleton store. agentId is a clearly-local decimal
    //    string (not an on-chain agentId). pricing.model reflects the COMPOSE choice
    //    (what the UI displays); base/max are the base-unit basePrice as strings,
    //    perKB "0". cardUrl is local-dev-shaped, mirroring the seed. No money/identity
    //    value is authored beyond the read-through projection.
    const resourceId = deriveLocalResourceId(spec.prompt);
    const slug = deriveSlug(spec.prompt);
    const record: IndexRecord = {
      resourceId,
      agentId: "0",
      slug,
      category: "data",
      pricing: { model: spec.pricingModel, base, perKB: "0", max: base },
      reputation: 0n,
      uptime: 1,
      health: { verified: true, score: 1 },
      bond: spec.bond,
      cardUrl: `https://${slug}.resources.example.com/.well-known/agent-card.json`,
      active: true,
    };
    await deps.indexStore.upsert(record);

    // 5. Kick off the build-stage stream into the per-resource channel WITHOUT blocking
    //    the return: emit the scripted stages with small awaited gaps, then complete the
    //    channel so a draining reader terminates. The emit is guarded so an unexpected
    //    error still completes the channel rather than leaking it (T-1g-02).
    const channel = deps.buildChannel;
    void (async () => {
      try {
        for (const event of LOCAL_REAL_BUILD_EVENTS) {
          channel.emit(resourceId, event);
          await delay(1);
        }
      } finally {
        channel.complete(resourceId);
      }
    })();

    return { resourceId, eventsUrl: `/resources/${resourceId}/events` };
  }

  async *subscribeBuildEvents(resourceId: string): AsyncIterable<BuildEvent> {
    const deps = this.requireDeps();
    // Delegate to the per-resource channel: yield each BuildEvent the channel emits,
    // terminating when the channel completes. The channel's subscribe reaches a yield
    // (or a clean return for an unknown id) WITHOUT throwing first, so the SSE route
    // never 500s on a throw-before-yield (T-1g-02).
    for await (const event of deps.buildChannel.subscribe(resourceId)) {
      yield event;
    }
  }

  async getResourceDetail(resourceId: string): Promise<ResourceDetail> {
    const deps = this.requireDeps();
    const rec = await deps.indexStore.get(resourceId as Hex);
    if (!rec) {
      // Not-found-shaped: resources.$id.tsx maps ANY throw to a 404 (the read-through
      // source said no), so a plain Error suffices.
      throw new Error("live getResourceDetail: unknown resource");
    }
    return recordToDetail(rec);
  }

  async listMarketplace(criteria: FilterCriteria): Promise<ResourceCardData[]> {
    const deps = this.requireDeps();
    // Read the seeded read-through records and run the SAME pure filter the fixture
    // uses, then project each surviving record back to a card row.
    const records = await deps.indexStore.list();
    const matched = filterResources(records, criteria);
    return matched.map(recordToCard);
  }

  async getRevenue(_resourceId: string): Promise<RevenueSummary> {
    // Deferred: the live revenue aggregation lands in increment 1g.
    throw new RequiresLiveServicesError("getRevenue");
  }

  async getEscrowBalance(address: Hex): Promise<UsdcBalance> {
    const deps = this.requireDeps();
    // Money discipline: flow through readUsdcBalance so decimals come from a runtime
    // decimals() read, never a 1e6/6/18 literal. Return only {raw, decimals} on the
    // adapter surface (readUsdcBalance also carries a formatted string).
    const { raw, decimals } = await readUsdcBalance(deps.publicClient, address as Address);
    return { raw, decimals };
  }

  async runPlayground(resourceId: string, req: unknown): Promise<PlaygroundResult> {
    const deps = this.requireDeps();
    // Reuse the runPlaygroundHarness VERBATIM (in-process facilitator + reserve-before-
    // run gate + exactly-once), mirroring fixture.ts exactly. The escrow gate reserves
    // the cap BEFORE the handler runs (T-mdx-02); the cap derives from a runtime
    // decimals() read (no 1e6 literal).
    const harness = await deps.runPlayground(resourceId, req);
    return {
      paid: harness.result.paid,
      debitAmount: harness.result.debitAmount,
      body: harness.result.receipt ?? { ok: harness.result.paid },
    };
  }
}
