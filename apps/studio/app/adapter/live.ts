// live.ts - the LiveAdapter (increment 1d: real READ path, deferred WRITE path).
//
// The four READ methods (getEscrowBalance, listMarketplace, getResourceDetail,
// runPlayground) now read THROUGH the existing backend pieces via injected LiveDeps:
// the escrow balance flows through readUsdcBalance (runtime decimals(), no literal),
// the marketplace + detail project from the seeded read-through IndexStore filtered by
// the SAME pure filterResources the FixtureAdapter uses, and the playground reuses the
// runPlaygroundHarness VERBATIM so the reserve-before-run escrow gate stays intact.
//
// The three pipeline methods (createResource, subscribeBuildEvents, getRevenue) stay
// fail-loud: the live build/revenue pipeline lands in a later increment (1g). They
// NEVER return fake data; subscribeBuildEvents stays a real async generator that
// throws on first iteration, acceptable only while no live SSE route is exercised.
//
// LiveDeps is imported TYPE-ONLY from live-deps.server.js so the class never bundles
// the server module (T-mdx-01); the deps are injected by select.ts (production) or a
// test (offline). All money is base-unit bigint; there is NO 1e6/6/18 literal here.
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

  async createResource(_spec: ComposeSpec): Promise<{ resourceId: string; eventsUrl: string }> {
    // Deferred: the live compose/build pipeline lands in increment 1g.
    throw new RequiresLiveServicesError("createResource");
  }

  async *subscribeBuildEvents(_resourceId: string): AsyncIterable<BuildEvent> {
    // Deferred: a real async generator that throws on first iteration. This is
    // acceptable only while no live SSE route is exercised; the live build stream
    // lands in increment 1g.
    throw new RequiresLiveServicesError("subscribeBuildEvents");
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
