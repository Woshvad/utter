// live.ts - the LiveAdapter (increment 1d: real READ path, deferred WRITE path).
//
// The four READ methods (getEscrowBalance, listMarketplace, getResourceDetail,
// runPlayground) now read THROUGH the existing backend pieces via injected LiveDeps:
// the escrow balance flows through readUsdcBalance (runtime decimals(), no literal),
// the marketplace + detail project from the seeded read-through IndexStore filtered by
// the SAME pure filterResources the FixtureAdapter uses, and the playground reuses the
// runPlaygroundHarness VERBATIM so the reserve-before-run escrow gate stays intact.
//
// createResource + subscribeBuildEvents are REAL in local-real mode: createResource
// computes the deterministic identity (slug -> keccak resourceId) UP FRONT and RETURNS
// { resourceId, eventsUrl } IMMEDIATELY, before any generate/validate/upsert. The real
// work runs in the background IIFE, emitting into the per-resource channel: it generates
// the bundle (real AI generation can take tens of seconds), runs the four-gate
// validateBundle, publishes an IndexRecord into the SHARED singleton store only after the
// gate passes, then deploys. The real generation/validation outcome streams as stage
// events, including the REAL error reason (a generate throw or a gate fail surfaces as a
// Generate:error stage, never swallowed). subscribeBuildEvents is a real async generator
// that delegates to the channel (yields the streamed stages, then terminates, never
// throws before its first yield). getRevenue now reads REAL aggregated revenue through
// the injected seam (an HTTP GET to the facilitator's /revenue/:resourceId), fail-loud on
// an unreachable facilitator. None of these touch an operator-gated live service: the
// generator is the offline scaffold, the Deploy/Mint stages are labeled local-sim (no
// container, no on-chain mint), and the publish is the local index upsert.
//
// LiveDeps is imported TYPE-ONLY from live-deps.server.js so the class never bundles
// the server module (T-mdx-01); the deps are injected by select.ts (production) or a
// test (offline). All money is base-unit bigint; there is NO 1e6/6/18 literal here.
import { resourceIdForLabel, type Pricing } from "@utter/x402-arc";
import { filterResources, type IndexRecord } from "@utter/marketplace";
import { readUsdcBalance, readEscrowBalance, readBondStatus } from "@utter/chain";
import type { Address } from "viem";
import type { LiveDeps } from "./live-deps.server.js";
import type {
  BondStatusView,
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

/** The ordered local-sim DEPLOY stages (Deploy/Verify/Mint only). These are the stages
 *  the local-sim branch contributes when no real deployer seam is bound. Generate (the
 *  real scaffold generate + four-gate validate) and Publish/Live are emitted ONCE by the
 *  background IIFE around this slice, so they are NOT included here (that would double
 *  them). Deploy and Mint are labeled local-sim HONESTLY (no container, no on-chain mint).
 *  The logs carry only non-secret human prose (BuildEvent.log contract). */
const LOCAL_SIM_DEPLOY_EVENTS: readonly BuildEvent[] = [
  { stage: "Deploy", status: "running", log: "deploy (local-sim): in-process, no container" },
  { stage: "Deploy", status: "ok", log: "deploy (local-sim): sandbox simulated up" },
  { stage: "Verify", status: "running", log: "verify (local-sim): replaying gate checks" },
  { stage: "Verify", status: "ok", log: "verify (local-sim): gates already passed" },
  { stage: "Mint", status: "running", log: "mint (local id): no on-chain registry write" },
  { stage: "Mint", status: "ok", log: "mint (local id): local-dev agentId assigned" },
] as const;

/** A small await gap between stage emits so the SSE reader observes stages streaming
 *  rather than all at once, mirroring the fixture's delay(1). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The studio label scheme for a created resource: a stable, colon-namespaced
 *  `utter:resource:<slug>` string (matching the shared scheme in @utter/x402-arc's
 *  resource-id helper). The resourceId is the keccak of this label via the SAME shared
 *  resourceIdForLabel the deployer registers with, so the studio's displayed/escrow id
 *  equals the deployer-registered id and the resource's RESOURCE_ID env when the slugs
 *  agree (RESOURCE-DEPLOY-DESIGN.md §5.5). The keccak of a stable label is deterministic
 *  by design, so there is no counter: the same slug always yields the same canonical id. */
function labelForSlug(slug: string): string {
  return `utter:resource:${slug}`;
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
 * cardUrl come straight from the record; sandbox maps from the active flag.
 *
 * payout is set to the canonical bytes32 resourceId: that is the escrow target the
 * wallet signs (PaymentEscrow.debit keys settlement off the resourceId, not a creator
 * EOA), so the served card's pay target must be the same id the registry registered
 * (RESOURCE-DEPLOY-DESIGN.md §5.4b). creator stays a real owner address: the registry
 * stores creator and resourceId separately, and the ownership gate compares creator
 * against the SIWE-authenticated account. Never invents a money/identity value.
 */
function recordToDetail(r: IndexRecord): ResourceDetail {
  const sandbox: SandboxStatus = r.active ? "live" : "down";
  return {
    resourceId: r.resourceId as Hex,
    creator: LOCAL_DEV_CREATOR,
    agentId: r.agentId,
    slug: r.slug,
    category: r.category,
    payout: r.resourceId as Hex,
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

    // 1. Compute the deterministic identity + params UP FRONT, WITHOUT the bundle. None
    //    of this needs the generated bundle, so it can run before (and return ahead of)
    //    the tens-of-seconds real generation. The validator's G4 (gatePricing) REQUIRES
    //    model "metered", so the pricing handed to the runtime is ALWAYS metered
    //    regardless of spec.pricingModel; basePrice is a base-unit bigint, so we carry it
    //    through as a string (no 1e6/decimals literal). spec.pricingModel only shapes the
    //    DISPLAYED IndexRecord pricing, not this validation pricing.
    const base = spec.basePrice.toString();
    const resourceSpec = {
      prompt: spec.prompt,
      runtime: "node" as const,
      pricing: { model: "metered" as const, base, perKB: "0", max: base },
    };

    // Derive the slug, then the CANONICAL keccak resourceId via the shared
    // resourceIdForLabel over the studio label scheme (utter:resource:<slug>). The id is
    // the same shared-helper keccak the deployer registers with, so the studio's id agrees
    // with the deployer-registered id and the resource's RESOURCE_ID env (§5.5). It is
    // deterministic by design (no counter), so it can be derived from the slug alone -
    // before any bundle exists. This is the escrow/payTo keystone; do not change it.
    const slug = deriveSlug(spec.prompt);
    const resourceId = resourceIdForLabel(labelForSlug(slug));

    // Build the IndexRecord that will be published ONLY after the four-gate validate
    // passes (the upsert happens inside the background IIFE). agentId is a clearly-local
    // decimal string (not an on-chain agentId). pricing.model reflects the COMPOSE choice
    // (what the UI displays); base/max are the base-unit basePrice as strings, perKB "0".
    // cardUrl is built from the injected DEPLOY_DOMAIN builder (example.com only as the
    // dev fallback), so the studio card origin matches the deployed resource host. No
    // money/identity value is authored beyond the read-through projection.
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
      cardUrl: deps.buildCardUrl(slug),
      active: true,
    };

    // The conservative pricing the deployer is POSTed. The studio captures only the base
    // price today, so perKB and computeMultiplier are "0" (the deployer applies no
    // surprise per-KB or per-compute charge) and maxResponseBytes is 1048576 (1 MiB,
    // mirroring the echo's MAX_RESPONSE_BYTES). Richer pricing capture is a follow-up.
    // base is already a base-unit string and 1048576 is a byte count, so there is no
    // 1e6/decimals money literal here.
    const deployerPricing: Pricing = {
      model: "metered",
      base: spec.basePrice.toString(),
      perKB: "0",
      computeMultiplier: "0",
      maxResponseBytes: 1048576,
    };

    // 2. Do generate + validate + upsert + deploy + publish + live INSIDE the background
    //    IIFE, emitting into the per-resource channel. The method returns BEFORE this runs
    //    (see the return below), so a tens-of-seconds real generation never blocks the
    //    form POST; the page flips to the build stream and watches the stages arrive. The
    //    channel BUFFERS for the late subscriber (same as the deploy stages today), so a
    //    slightly-late reader still sees Generate. The finally ALWAYS completes the channel
    //    so a throw, a gate fail, or a never-done stream still terminates a draining reader
    //    (no hang/leak, T-1g-02).
    const channel = deps.buildChannel;
    const deployBundle = deps.deployBundle;
    const publishToMarketplace = deps.publishToMarketplace;
    void (async () => {
      try {
        // Generate running first (one event), then the real generate + four-gate validate.
        // Wrap generation + validation in an INNER try/catch so a real throw (e.g. the
        // ClaudeGenerator failing) streams the REAL reason as a Generate:error and returns
        // without upsert/deploy, never swallowed into an opaque field error.
        channel.emit(resourceId, { stage: "Generate", status: "running", log: "generating handler bundle" });
        let bundle;
        try {
          bundle = await deps.generate(resourceSpec);
          const validation = await deps.validate(bundle, resourceSpec);
          if (!validation.pass) {
            // A four-gate failure: emit the SAME reason string the old synchronous throw
            // built (gate/kind: detail), publish NOTHING, deploy NOTHING
            // (reject-without-publish, T-1g-01), and return - the finally completes the
            // channel so the reader terminates.
            const first = validation.violations[0];
            const reason = first
              ? `${first.gate}/${first.kind}: ${first.detail}`
              : "validation failed with no reported violation";
            channel.emit(resourceId, {
              stage: "Generate",
              status: "error",
              log: `bundle failed validation (${reason})`,
            });
            return;
          }
        } catch (err) {
          // A real generate/validate throw streams its message as a Generate:error so the
          // operator sees the real reason at the first stage instead of a blind hang. Log
          // it server-side too. No upsert, no deploy; the finally completes the channel.
          console.error("createResource generation failed", err);
          channel.emit(resourceId, {
            stage: "Generate",
            status: "error",
            log: (err as Error).message,
          });
          return;
        }

        // The gate passed: publish the IndexRecord into the SHARED singleton store (publish
        // ONLY after the gate passes), then mark Generate done (one ok event).
        await deps.indexStore.upsert(record);
        channel.emit(resourceId, { stage: "Generate", status: "ok", log: "bundle generated and four-gate validated" });

        // 3. The deploy section, in its OWN try/catch so a deployer failure surfaces a
        //    Deploy(error) (preserving the existing contract) while a generation failure
        //    surfaces a Generate(error). When the real deployer seam is bound (DEPLOYER_URL
        //    + DEPLOYER_AUTH_SECRET set) the Deploy/Verify/Mint stages come from the
        //    deployer's stream; otherwise the local-sim Deploy/Verify/Mint stages are
        //    emitted. Publish + Live are emitted ONCE at the end.
        try {
          if (deployBundle) {
            // The resourceLabel is utter:resource:<slug> so the deployer-derived resourceId
            // (resourceIdForLabel(resourceLabel)) equals the studio resourceId above (the
            // escrow/payTo keystone). The conservative pricing avoids any overcharge.
            for await (const ev of deployBundle({
              bundle,
              slug,
              resourceLabel: labelForSlug(slug),
              pricing: deployerPricing,
            })) {
              channel.emit(resourceId, ev);
            }
          } else {
            // The local-sim branch contributes ONLY Deploy/Verify/Mint (Generate and
            // Publish/Live are emitted once, around this slice, so they are not doubled).
            for (const event of LOCAL_SIM_DEPLOY_EVENTS) {
              channel.emit(resourceId, event);
              await delay(1);
            }
          }
          // Publish + Live remain studio-side, emitted ONCE after the deploy branch (the
          // deployer covers register/build/launch/route/verify/probe -> Mint/Deploy/Verify).
          //
          // When the marketplace publish seam is bound, list the resource in the
          // marketplace SERVICE (the A2A discovery surface agents hit): parse the built A2A
          // card from the generated bundle (the platform-overwritten agent-card.json) and
          // POST it. This runs in its OWN try/catch: a listing failure (a publish throw OR
          // a card-parse failure) is NON-FATAL - the resource is deployed and reachable, so
          // it surfaces a Publish:error (bearer-free) and CONTINUES to Live. When the seam
          // is unbound, keep the existing local-index Publish:ok event verbatim.
          if (publishToMarketplace) {
            try {
              const cardJson = bundle["agent-card.json"];
              if (typeof cardJson !== "string") {
                throw new Error("generated bundle is missing agent-card.json");
              }
              const card = JSON.parse(cardJson) as Record<string, unknown>;
              await publishToMarketplace({
                prompt: spec.prompt,
                resourceId,
                category: "data",
                card,
                cardUrl: record.cardUrl,
                slug,
              });
              channel.emit(resourceId, { stage: "Publish", status: "ok", log: "listed for discovery (marketplace)" });
            } catch (err) {
              // The publishResource errors are already bearer-free, and a card-parse error
              // carries no secret, so the message is safe to surface as a log. The Live emit
              // below still fires (a listing failure must not block a live resource).
              channel.emit(resourceId, {
                stage: "Publish",
                status: "error",
                log: (err as Error).message,
              });
            }
          } else {
            channel.emit(resourceId, { stage: "Publish", status: "ok", log: "listed for discovery (shared local index)" });
          }
          channel.emit(resourceId, { stage: "Live", status: "ok", log: "resource is live" });
        } catch (err) {
          // A deployer failure surfaces a Deploy(error) into the channel. streamDeploy's
          // errors are already bearer-free, so the message is safe to surface as a log. The
          // finally below still completes the channel so a draining reader terminates.
          channel.emit(resourceId, {
            stage: "Deploy",
            status: "error",
            log: (err as Error).message,
          });
        }
      } finally {
        channel.complete(resourceId);
      }
    })();

    // 4. RETURN { resourceId, eventsUrl } IMMEDIATELY, before any generate/validate/upsert
    //    (those run in the background IIFE above). The SSE route subscribes the
    //    module-singleton buildChannel by resourceId and the channel BUFFERS for the late
    //    subscriber, so background-emitted events are still delivered.
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
    // When the discovery read seam is bound (MARKETPLACE_URL set) the records come from the
    // live marketplace SERVICE (its public GET /resources); otherwise they come from the
    // seeded local-dev index. The SAME pure filterResources + recordToCard projection
    // applies to both, so the discover UI is identical in shape either way.
    const records = deps.listResources
      ? await deps.listResources()
      : await deps.indexStore.list();
    const matched = filterResources(records, criteria);
    return matched.map(recordToCard);
  }

  async getRevenue(resourceId: string): Promise<RevenueSummary> {
    // Real revenue aggregation: the injected seam GETs the facilitator's
    // /revenue/:resourceId and rebuilds a RevenueSummary from the decimal-string amounts
    // (base-unit bigint). It is FAIL-LOUD - an unreachable facilitator throws rather than
    // returning fake/zero data; a reachable-but-empty one returns a valid zero summary.
    return this.requireDeps().getRevenue(resourceId);
  }

  async getEscrowBalance(address: Hex): Promise<UsdcBalance> {
    const deps = this.requireDeps();
    // Money discipline: flow through readUsdcBalance so decimals come from a runtime
    // decimals() read, never a 1e6/6/18 literal. Return only {raw, decimals} on the
    // adapter surface (readUsdcBalance also carries a formatted string).
    const { raw, decimals } = await readUsdcBalance(deps.publicClient, address as Address);
    return { raw, decimals };
  }

  async getAccruedEarnings(address: Hex): Promise<UsdcBalance> {
    const deps = this.requireDeps();
    // The ACCRUED internal escrow balance (PaymentEscrow.balanceOf), the withdrawable
    // amount escrow.withdraw pays out - DISTINCT from getEscrowBalance's wallet USDC.
    // Money discipline: flow through readEscrowBalance so decimals come from a runtime
    // decimals() read, never a 1e6/6/18 literal. Return only {raw, decimals} on the
    // adapter surface (readEscrowBalance also carries a formatted string).
    const { raw, decimals } = await readEscrowBalance(deps.publicClient, address as Address);
    return { raw, decimals };
  }

  async getBondStatus(resourceId: Hex): Promise<BondStatusView> {
    const deps = this.requireDeps();
    // The resource's on-chain bond status (StakingVault bonds/bondOwner/cooldownEnds).
    // Money discipline: flow through readBondStatus so decimals come from a runtime
    // decimals() read, never a 1e6/6/18 literal; posted stays base-unit bigint. The UI
    // derives can-request / can-claim from owner + cooldownEnds + now, but the on-chain
    // COOLDOWN / NotBondOwner / WithdrawNotRequested guards are the real boundary.
    const s = await readBondStatus(deps.publicClient, resourceId as Hex);
    return {
      posted: s.amount,
      owner: s.owner as Hex,
      cooldownEnds: s.cooldownEnds,
      decimals: s.decimals,
    };
  }

  async runPlayground(resourceId: string, req: unknown): Promise<PlaygroundResult> {
    const deps = this.requireDeps();
    // deps.runPlayground is the RESOLVED harness (resolvePlaygroundHarness): the in-process
    // mock by default (the dev/demo/"test it" path, mirroring fixture.ts), or the real
    // liveTestEndpoint buyer pay flow when PLAYGROUND_HARNESS=live. Both keep
    // reserve-before-run + exactly-once: the escrow gate reserves the cap BEFORE the handler
    // runs (T-mdx-02) and the cap derives from a runtime decimals() read (no 1e6 literal).
    const harness = await deps.runPlayground(resourceId, req);
    return {
      paid: harness.result.paid,
      debitAmount: harness.result.debitAmount,
      body: harness.result.receipt ?? { ok: harness.result.paid },
    };
  }
}
