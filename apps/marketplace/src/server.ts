// The marketplace server bootstrap. Mirrors the facilitator template
// (services/facilitator/src/server.ts): serves a Hono app via @hono/node-server
// and ends with the Windows-and-POSIX self-run guard.
//
// The marketplace needs no secrets, so (unlike the facilitator) it does NOT load
// dotenv: it boots with the in-memory IndexStore default. The dev runner loads the
// root .env.local for the children that need it. This host mounts the EXISTING
// createCardApp factory verbatim (the card route is never re-authored here) and adds
// a discovery route over the pure filterResources filter.
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
// Extensionless relative specifiers (mirroring the facilitator server.ts template:
// ./app, ./relayer). The native ts-resolver hook rewrites extensionless `./foo` to
// `./foo.ts`; a literal `.js` specifier would pass through unrewritten and fail to
// resolve under --experimental-strip-types (there is no emitted .js sibling).
import { createCardApp } from "./card-route";
import { filterResources } from "./query";
import { InMemoryIndexStore } from "./index-store";
import { InMemoryCardStore } from "./card-store";
import type { CardSource } from "./card-route";
import type { FilterCriteria } from "./query";
import type { IndexStore, Hex } from "./index-store";
import type { CardStore } from "./card-store";

/** The route deps for the marketplace host. */
export interface MarketplaceAppDeps {
  indexStore: IndexStore;
  cardStore: CardStore;
  cardSource: CardSource;
}

/**
 * Build the marketplace route deps. The autonomous/dev default is the in-memory
 * IndexStore (empty at boot) with a CardSource backed by that store: an unknown
 * resource resolves to null, which createCardApp serves as a 404. The future
 * Postgres adapter implements the same IndexStore contract, so this swaps by env.
 */
export function buildDepsFromEnv(): MarketplaceAppDeps {
  const indexStore = new InMemoryIndexStore();
  const cardStore = new InMemoryCardStore();
  const cardSource: CardSource = {
    async getCard(resourceId) {
      // Serve the FINALIZED card the publish pipeline persisted to the CardStore. The
      // store is empty at boot, so an unknown resource is null -> 404 via createCardApp;
      // a published resource resolves its finalized card here (re-validated at the route).
      return (await cardStore.get(resourceId as Hex)) ?? null;
    },
  };
  return { indexStore, cardStore, cardSource };
}

/**
 * Build the marketplace Hono app:
 *   - mounts the EXISTING createCardApp under / so
 *     GET /:resourceId/.well-known/agent-card.json works verbatim;
 *   - GET /health      -> { ok: true, service: "marketplace" };
 *   - GET /resources   -> the pure filterResources discovery filter over the index.
 */
export function createMarketplaceApp(deps: MarketplaceAppDeps): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true, service: "marketplace" }));

  app.get("/resources", async (c) => {
    // Read only the known discovery criteria. bigint criteria are token base units
    // parsed from the string query param ONLY when present (never a 1e6 literal).
    const criteria: FilterCriteria = {};
    const category = c.req.query("category");
    if (category !== undefined) criteria.category = category;
    const active = c.req.query("active");
    if (active !== undefined) criteria.active = active === "true";
    const minBond = c.req.query("minBond");
    if (minBond !== undefined) criteria.minBond = BigInt(minBond);
    const maxBasePrice = c.req.query("maxBasePrice");
    if (maxBasePrice !== undefined) criteria.maxBasePrice = BigInt(maxBasePrice);

    const records = await deps.indexStore.list();
    const filtered = filterResources(records, criteria);
    // reputation + bond are bigint (not JSON-serializable); surface as base-units
    // strings so discovery output stays lossless.
    const safe = filtered.map((r) => ({
      ...r,
      reputation: r.reputation.toString(),
      bond: r.bond.toString(),
    }));
    return c.json(safe);
  });

  // Mount the existing finalized-card route verbatim (never re-author the card).
  app.route("/", createCardApp({ source: deps.cardSource }));

  return app;
}

/** Start the marketplace HTTP server on the given port (default 8789). */
export function start(port = Number(process.env.PORT ?? "8789")): void {
  const deps = buildDepsFromEnv();
  const app = createMarketplaceApp(deps);
  // Log only the service name + port (no env values; mirror the facilitator).
  console.log(`marketplace listening on :${port}`);
  serve({ fetch: app.fetch, port });
}

// Boot when run directly (node src/server.ts), not when imported by a test.
// pathToFileURL normalizes process.argv[1] to the same WHATWG file:// href that
// import.meta.url carries, so the direct-run check fires on Windows and POSIX alike.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}
