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
import { InMemoryIndexStore, type IndexRecord, type IndexStore } from "@utter/marketplace";
import { runPlaygroundHarness, type PlaygroundHarnessResult } from "./playground-harness.js";
import { FIXTURE_MARKETPLACE } from "../fixtures/index.js";

/**
 * The injectable LiveAdapter read dependencies. Tests construct these directly with a
 * stub publicClient + a seeded InMemoryIndexStore + (optionally) the real harness;
 * production builds them from env via buildLiveDeps. Declaring the seam keeps the
 * LiveAdapter class free of any direct env / node import.
 */
export interface LiveDeps {
  /** The Arc public client the escrow read flows through (readUsdcBalance). */
  publicClient: PublicClient;
  /** The discovery index the marketplace + detail reads project from. */
  indexStore: IndexStore;
  /** The reserve-before-run playground harness, bound verbatim. */
  runPlayground: (resourceId: string, req: unknown) => Promise<PlaygroundHarnessResult>;
}

/**
 * Project a FIXTURE_MARKETPLACE card row into the IndexRecord shape the store holds.
 * Mirrors the inline projection in fixture.ts listMarketplace exactly (resourceId,
 * agentId, slug, category, pricing copy, reputation, uptime, health, bond, cardUrl,
 * active). This is a LOCAL-DEV seed: the values are read-through-shaped fixture data,
 * never live money or identity. No 1e6/decimals literal in any amount path.
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

/**
 * Build the real LiveDeps from the environment. Synchronous so select.ts can call it
 * inside its synchronous live branch:
 *   1. Build the Arc public client (createArcPublicClient honors ARC_RPC_URL).
 *   2. Construct an InMemoryIndexStore and seed it with the projected fixture rows.
 *      InMemoryIndexStore.upsert sets a Map entry before its promise settles, so the
 *      records are present synchronously enough for the adapter's later list()/get()
 *      reads. The seed is local-dev-only and read-through-shaped, never a live money
 *      source.
 *   3. Bind runPlayground to runPlaygroundHarness verbatim (reused like the fixture),
 *      keeping the reserve-before-run escrow gate intact (T-mdx-02).
 */
export function buildLiveDeps(env: NodeJS.ProcessEnv = process.env): LiveDeps {
  const publicClient = createArcPublicClient(env.ARC_RPC_URL) as unknown as PublicClient;

  const indexStore = new InMemoryIndexStore();
  // Seed the local-dev index. upsert resolves synchronously (Map.set) so the entries
  // are queryable by the time the adapter awaits list()/get(); we still void the
  // promise rather than block, since buildLiveDeps must stay synchronous.
  for (const rec of seedRecords()) {
    void indexStore.upsert(rec);
  }

  return {
    publicClient,
    indexStore,
    runPlayground: runPlaygroundHarness,
  };
}
