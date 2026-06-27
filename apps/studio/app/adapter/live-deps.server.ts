// live-deps.server.ts - the server-only LiveAdapter dependency bootstrap.
//
// This module is the ONLY place that reads process.env, builds the Arc public
// client, constructs and seeds the InMemoryIndexStore, and binds the playground
// harness. It is named `.server.ts` so Vite excludes it from the client bundle
// (mirrors the app/auth/*.server.ts convention), keeping node/chain code out of the
// browser graph. LiveAdapter takes these deps via a type-only import, so the class
// itself never statically pulls this server module (T-mdx-01).
//
// Money discipline: nothing here authors a money/identity value. The seeded index is
// a read-through-shaped LOCAL-DEV seed only, never a canonical money source. The
// escrow/decimals path goes through readUsdcBalance (runtime decimals()), not a
// literal. The seed projects the same FIXTURE_MARKETPLACE rows the FixtureAdapter
// filters, so live mode renders real-shaped reads against existing backend pieces.
import type { PublicClient } from "viem";
import { createArcPublicClient } from "@utter/chain";
import { resourceIdForLabel, ECHO_RESOURCE_LABEL } from "@utter/x402-arc";
import { InMemoryIndexStore, type IndexRecord, type IndexStore } from "@utter/marketplace";
import {
  selectGenerator,
  validateBundle,
  type Bundle,
  type ResourceSpec,
  type ValidationResult,
} from "@utter/ai-runtime";
import type { Pricing } from "@utter/x402-arc";
import { runPlaygroundHarness, type PlaygroundHarnessResult } from "./playground-harness.js";
import { BuildEventChannel } from "./build-channel.js";
import { streamDeploy } from "./deployer-client.server.js";
import { FIXTURE_MARKETPLACE } from "../fixtures/index.js";
import type { BuildEvent, Hex, RevenueSummary } from "./types.js";

/**
 * The injectable LiveAdapter read dependencies. Tests construct these directly with a
 * stub publicClient + a seeded InMemoryIndexStore + (optionally) the real harness;
 * production builds them from env via buildLiveDeps. Declaring the seam keeps the
 * LiveAdapter class free of any direct env / node import.
 */
export interface LiveDeps {
  /** The Arc public client the escrow read flows through (readUsdcBalance). */
  publicClient: PublicClient;
  /** The discovery index the marketplace + detail reads project from. A MODULE
   *  SINGLETON in production, so a resource createResource upserts is visible to a
   *  LATER request's listMarketplace/getResourceDetail (select.ts builds fresh deps
   *  per request, but they share this one store instance). */
  indexStore: IndexStore;
  /** The per-resource build-event channel createResource emits stages into and
   *  subscribeBuildEvents drains. A MODULE SINGLETON so the create action (one
   *  selectAdapter call) and the SSE route (a separate selectAdapter call) share the
   *  SAME channel and the buffered stages reach a late SSE subscriber. */
  buildChannel: BuildEventChannel;
  /** Scaffold-generate a bundle from a ResourceSpec (no ANTHROPIC key on the default
   *  path). Bound to selectGenerator(env).generate so the adapter stays env-free. */
  generate: (spec: ResourceSpec) => Promise<Bundle>;
  /** Four-gate validate a generated bundle before publish. Bound to validateBundle. */
  validate: (bundle: Bundle, spec: ResourceSpec) => Promise<ValidationResult>;
  /** The reserve-before-run playground harness, bound verbatim. */
  runPlayground: (resourceId: string, req: unknown) => Promise<PlaygroundHarnessResult>;
  /**
   * Aggregate the real per-resource revenue from the facilitator (STU-04). In production
   * this GETs FACILITATOR_URL/revenue/:resourceId and rebuilds a RevenueSummary from the
   * decimal-string amounts; a test injects a deterministic seam. FAIL-LOUD: a network
   * error or non-200 THROWS (a reachable-but-empty facilitator returns a valid zero
   * summary, but an unreachable one must never be masked as zero/fake data).
   */
  getRevenue: (resourceId: string) => Promise<RevenueSummary>;
  /**
   * Build the absolute agent-card URL for a discovery slug from the deploy domain.
   * Injected here (not read from process.env in live.ts) so the adapter stays env-free:
   * live.ts calls this for the cardUrl of a createResource record, and the seed uses the
   * same builder, so the studio's card origin matches the deployed resource's host. The
   * URL is local-dev-shaped when DEPLOY_DOMAIN is unset (the example.com fallback).
   */
  buildCardUrl: (slug: string) => string;
  /**
   * Stream a real deploy of a generated bundle through the increment-A deployer
   * (POST DEPLOYER_URL/deploy). Bound ONLY when both DEPLOYER_URL and DEPLOYER_AUTH_SECRET
   * are present; left undefined otherwise so createResource keeps its local-sim build
   * stream. createResource iterates the returned BuildEvents into the build channel; the
   * resourceLabel it passes is `utter:resource:<slug>` so the deployer-derived resourceId
   * equals the studio resourceId (the escrow/payTo keystone).
   */
  deployBundle?: (params: {
    bundle: Bundle;
    slug: string;
    resourceLabel: string;
    pricing: Pricing;
  }) => AsyncIterable<BuildEvent>;
}

/**
 * Resolve the agent-card URL for a slug from the deploy domain (server-side). Reads
 * DEPLOY_DOMAIN, computes the resources apex as `resources.<domain>`, and returns
 * `https://<slug>.<apex>/.well-known/agent-card.json`. A domain that already starts with
 * `resources.` is used as-is so a configured `resources.example.com` does not become a
 * double `resources.resources.` prefix. When DEPLOY_DOMAIN is unset the example.com
 * literal is the explicit local-dev fallback (never a production value). This is the only
 * place that reads the deploy domain; live.ts receives the bound buildCardUrl, not the env.
 */
export function resolveCardUrl(slug: string, env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.DEPLOY_DOMAIN && env.DEPLOY_DOMAIN.trim().length > 0
    ? env.DEPLOY_DOMAIN.trim()
    : "example.com";
  // Strip a trailing dot and any leading scheme/slashes an operator might paste in, then
  // guard the double-prefix: a domain already under the resources apex is used verbatim.
  const domain = raw.replace(/^https?:\/\//, "").replace(/\/+$/, "").replace(/\.+$/, "");
  const apex = domain.startsWith("resources.") ? domain : `resources.${domain}`;
  return `https://${slug}.${apex}/.well-known/agent-card.json`;
}

/**
 * The module-singleton IndexStore. Created and seeded once on first buildLiveDeps
 * call; every later call returns the SAME instance so a created resource persists
 * across per-request deps builds. This is the load-bearing visibility fix for 1g.
 */
let sharedStore: IndexStore | undefined;

/** Return the singleton IndexStore, seeding it with the projected fixture rows on the
 *  first call only (re-seeding on later calls would duplicate the seed). The env is
 *  threaded through so the seed builds real cardUrls from DEPLOY_DOMAIN. */
function getSharedIndexStore(env: NodeJS.ProcessEnv): IndexStore {
  if (!sharedStore) {
    const store = new InMemoryIndexStore();
    // Seed the local-dev index once. upsert resolves synchronously (Map.set) so the
    // entries are queryable by the time the adapter awaits list()/get(); we void the
    // promise rather than block, since buildLiveDeps stays synchronous.
    for (const rec of seedRecords(env)) {
      void store.upsert(rec);
    }
    sharedStore = store;
  }
  return sharedStore;
}

/**
 * The module-singleton BuildEventChannel. One shared channel so createResource (write,
 * in the create action's selectAdapter call) and subscribeBuildEvents (read, in the
 * SSE route's separate selectAdapter call) reach the same per-resource buffers.
 */
let sharedBuildChannel: BuildEventChannel | undefined;

/** Return the singleton BuildEventChannel, constructing it once on first call. */
function getSharedBuildChannel(): BuildEventChannel {
  if (!sharedBuildChannel) {
    sharedBuildChannel = new BuildEventChannel();
  }
  return sharedBuildChannel;
}

/** The seeded echo entry's discovery slug (the live-deployed echo resource's slug). */
const ECHO_SEED_SLUG = "echo";

/**
 * Project a FIXTURE_MARKETPLACE card row into the IndexRecord shape the store holds.
 * Mirrors the inline projection in fixture.ts listMarketplace exactly (resourceId,
 * agentId, slug, category, pricing copy, reputation, uptime, health, bond, cardUrl,
 * active). This is a LOCAL-DEV seed: the values are read-through-shaped fixture data,
 * never live money or identity. No 1e6/decimals literal in any amount path.
 *
 * The cardUrl is built from DEPLOY_DOMAIN via resolveCardUrl (example.com only as the
 * local-dev fallback), so the seeded card origin matches the deployed resource host.
 *
 * A seeded ECHO entry is prepended whose resourceId is the canonical keccak of
 * ECHO_RESOURCE_LABEL (== the deployer-registered id == the resource's RESOURCE_ID env,
 * RESOURCE-DEPLOY-DESIGN.md §5.5). This is what makes a studio pay reach the SAME live
 * resource the deployer registered: /resources/<that id> resolves the echo, and the
 * escrow target (payTo/payout) is that same bytes32.
 */
function seedRecords(env: NodeJS.ProcessEnv): IndexRecord[] {
  const echo: IndexRecord = {
    resourceId: resourceIdForLabel(ECHO_RESOURCE_LABEL),
    agentId: "0",
    slug: ECHO_SEED_SLUG,
    category: "data",
    // Metered echo pricing in base units (strings). No decimals literal.
    pricing: { model: "metered", base: "10000", perKB: "0", max: "10000" },
    reputation: 0n,
    uptime: 1,
    health: { verified: true, score: 1 },
    bond: 5_000_000n,
    cardUrl: resolveCardUrl(ECHO_SEED_SLUG, env),
    active: true,
  };
  const fixtures = FIXTURE_MARKETPLACE.map((c) => ({
    resourceId: c.resourceId,
    agentId: c.agentId,
    slug: c.slug,
    category: c.category,
    pricing: { ...c.pricing },
    reputation: c.reputation,
    uptime: c.uptime,
    health: { verified: c.uptime > 0, score: c.uptime },
    bond: c.bond,
    cardUrl: resolveCardUrl(c.slug, env),
    active: c.active,
  }));
  return [echo, ...fixtures];
}

/**
 * Build the real LiveDeps from the environment. Synchronous so select.ts can call it
 * inside its synchronous live branch:
 *   1. Build the Arc public client (createArcPublicClient honors ARC_RPC_URL).
 *   2. Reuse the MODULE-SINGLETON IndexStore (seeded once with the projected fixture
 *      rows). A resource createResource upserts into this store on one request is
 *      therefore visible to a LATER request's listMarketplace/getResourceDetail,
 *      because select.ts builds fresh deps per request but they all share this one
 *      store instance. The seed is local-dev-only and read-through-shaped, never a
 *      live money source.
 *   3. Reuse the MODULE-SINGLETON BuildEventChannel so the create action and the SSE
 *      route share the same per-resource stage buffers.
 *   4. Bind generate to selectGenerator(env).generate (scaffold by default, no
 *      ANTHROPIC key) and validate to validateBundle, so the adapter stays env-free.
 *   5. Bind runPlayground to runPlaygroundHarness verbatim (reused like the fixture),
 *      keeping the reserve-before-run escrow gate intact (T-mdx-02).
 */
/** The default facilitator base URL (mirrors the buyer/middleware in-process default). */
const DEFAULT_FACILITATOR_URL = "http://localhost:8787";

/** The facilitator's GET /revenue/:resourceId JSON shape (all amounts decimal strings). */
interface RevenueJson {
  resourceId: string;
  calls: number;
  gross: string;
  creatorShare: string;
  platformShare: string;
  refunds: string;
  receipts: Array<{ tx: string; kind: "settle" | "refund"; amount: string; idemKey: string }>;
}

/**
 * Fetch the real revenue summary for a resource from the facilitator, converting the
 * decimal-string amounts back to base-unit bigint. FAIL-LOUD: a network failure or a
 * non-200 throws a clear error - a live revenue read must never silently return fake or
 * zero data. (A reachable-but-empty facilitator legitimately returns a zero summary.)
 */
async function fetchRevenue(
  resourceId: string,
  facilitatorUrl: string,
): Promise<RevenueSummary> {
  const base = facilitatorUrl.replace(/\/+$/, "");
  const url = `${base}/revenue/${resourceId}`;
  let res: Response;
  try {
    res = await fetch(url, { method: "GET", headers: { accept: "application/json" } });
  } catch (err) {
    throw new Error(
      `live getRevenue: the facilitator at ${url} was unreachable (${(err as Error).message}); ` +
        "revenue is read fail-loud and never faked",
    );
  }
  if (!res.ok) {
    throw new Error(`live getRevenue: the facilitator at ${url} returned HTTP ${res.status}`);
  }
  const json = (await res.json()) as RevenueJson;
  return {
    resourceId: json.resourceId as Hex,
    calls: json.calls,
    gross: BigInt(json.gross),
    creatorShare: BigInt(json.creatorShare),
    platformShare: BigInt(json.platformShare),
    refunds: BigInt(json.refunds),
    receipts: json.receipts.map((r) => ({
      tx: r.tx as Hex,
      kind: r.kind,
      amount: BigInt(r.amount),
      idemKey: r.idemKey,
    })),
  };
}

export function buildLiveDeps(env: NodeJS.ProcessEnv = process.env): LiveDeps {
  const publicClient = createArcPublicClient(env.ARC_RPC_URL) as unknown as PublicClient;
  const facilitatorUrl = env.FACILITATOR_URL && env.FACILITATOR_URL.trim().length > 0
    ? env.FACILITATOR_URL.trim()
    : DEFAULT_FACILITATOR_URL;

  // Bind the real deploy seam ONLY when both the deployer URL and the bearer are set and
  // non-empty. Both must be present to enable real deploys; unset -> local-sim build
  // stream. The bearer is passed straight into streamDeploy's Authorization header and is
  // NEVER logged here (no console line includes authSecret).
  const deployerUrl = env.DEPLOYER_URL?.trim();
  const authSecret = env.DEPLOYER_AUTH_SECRET?.trim();
  const deployBundle =
    deployerUrl && authSecret
      ? (p: { bundle: Bundle; slug: string; resourceLabel: string; pricing: Pricing }) =>
          streamDeploy(p, { deployerUrl, authSecret })
      : undefined;

  return {
    publicClient,
    indexStore: getSharedIndexStore(env),
    buildChannel: getSharedBuildChannel(),
    // selectGenerator returns the scaffold backend whenever ANTHROPIC_API_KEY is
    // absent (the autonomous default), so generate stays offline with no model call.
    generate: (spec) => selectGenerator(env).generate(spec),
    validate: (bundle, spec) => validateBundle(bundle, spec),
    runPlayground: runPlaygroundHarness,
    // Real revenue aggregation: GET FACILITATOR_URL/revenue/:resourceId (fail-loud).
    getRevenue: (resourceId) => fetchRevenue(resourceId, facilitatorUrl),
    // Bind the cardUrl builder to this env so live.ts stays free of process.env. The
    // builder reads DEPLOY_DOMAIN (example.com only as the local-dev fallback).
    buildCardUrl: (slug) => resolveCardUrl(slug, env),
    // Real deploy seam: bound only when DEPLOYER_URL + DEPLOYER_AUTH_SECRET are both set.
    deployBundle,
  };
}
