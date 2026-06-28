// The marketplace server bootstrap. Mirrors the facilitator template
// (services/facilitator/src/server.ts): serves a Hono app via @hono/node-server
// and ends with the Windows-and-POSIX self-run guard.
//
// The marketplace needs no secrets, so (unlike the facilitator) it does NOT load
// dotenv: it boots with the in-memory IndexStore default. The dev runner loads the
// root .env.local for the children that need it. This host mounts the EXISTING
// createCardApp factory verbatim (the card route is never re-authored here) and adds
// a discovery route over the pure filterResources filter.
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { runGracefulShutdown } from "@utter/observability";
import { PublishRejected } from "@utter/staking";
// Extensionless relative specifiers (mirroring the facilitator server.ts template:
// ./app, ./relayer). The native ts-resolver hook rewrites extensionless `./foo` to
// `./foo.ts`; a literal `.js` specifier would pass through unrewritten and fail to
// resolve under --experimental-strip-types (there is no emitted .js sibling).
import { createCardApp } from "./card-route";
import { filterResources } from "./query";
import { InMemoryIndexStore } from "./index-store";
import { InMemoryCardStore } from "./card-store";
import { createPgStores } from "./stores/pg";
import { InMemoryModerationStore } from "./moderation/review-queue";
import type { ModerationStore } from "./moderation/review-queue";
import { createPublishPipeline, PublishBlocked, PublishHeldForReview, PublishUnverified } from "./publish";
import { createPublishPipelineDeps } from "./publish-deps";
import type { CardSource } from "./card-route";
import type { FilterCriteria } from "./query";
import type { IndexStore, Hex } from "./index-store";
import type { CardStore } from "./card-store";
import type { PublishPipeline, PublishRequest } from "./publish";

/** The route deps for the marketplace host. */
export interface MarketplaceAppDeps {
  indexStore: IndexStore;
  cardStore: CardStore;
  cardSource: CardSource;
  /** The composed publish pipeline POST /resources runs (MKT-03). */
  publishPipeline: PublishPipeline;
  /** The Bearer the authenticated POST /resources route checks; unset -> publish fails closed. */
  publishAuthSecret?: string;
  /**
   * Teardown for the durable stores (pg.end), called from graceful shutdown AFTER the
   * request drain. Undefined for the in-memory default (nothing to close), so dev/test
   * boot is byte-unchanged.
   */
  storesClose?: () => Promise<void>;
  /**
   * Readiness probe for GET /ready (a cheap SELECT 1 over the durable pg pool). When set
   * /ready resolves it; a throw becomes a value-free 503. Undefined for the in-memory
   * default, where /ready always reports ready (the autonomous suite stays green).
   */
  storeProbe?: () => Promise<void>;
}

/**
 * Constant-time Bearer check, mirroring the deployer server.ts posture EXACTLY. Reads
 * the token off the Authorization header, strips the `Bearer ` prefix, and compares it
 * to the secret with timingSafeEqual over equal-length Buffers. A length mismatch (or a
 * missing header) short-circuits to false WITHOUT calling timingSafeEqual (which throws
 * on unequal lengths). The secret/token is never logged.
 */
function bearerMatches(authHeader: string | undefined, secret: string): boolean {
  if (!authHeader) return false;
  const prefix = "Bearer ";
  if (!authHeader.startsWith(prefix)) return false;
  const token = authHeader.slice(prefix.length);
  const tokenBuf = Buffer.from(token, "utf8");
  const secretBuf = Buffer.from(secret, "utf8");
  // Length-mismatch short-circuit: timingSafeEqual throws on unequal-length Buffers.
  if (tokenBuf.length !== secretBuf.length) return false;
  return timingSafeEqual(tokenBuf, secretBuf);
}

/** True iff value is a 0x-prefixed 32-byte (64 hex char) string (a resourceId/bytes32). */
function isBytes32Hex(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

/** True iff value is a plain object (a card / nested object), not null or an array. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True iff value is a syntactically valid http(s) URL string (the served cardUrl). */
function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Shape-validate an untrusted JSON body into a PublishRequest, or return null when any
 * required field is missing/malformed (the route maps null -> 400). Money/identity is
 * never authored here: reputation is parsed from a decimal string to a BigInt only when
 * present, and the card/pricing are passed through to the pipeline unchanged.
 */
function parsePublishRequest(body: unknown): PublishRequest | null {
  if (!isObject(body)) return null;
  const { prompt, resourceId, category, card, cardUrl, slug, reputation } = body;
  if (typeof prompt !== "string" || prompt.length === 0) return null;
  if (!isBytes32Hex(resourceId)) return null;
  if (typeof category !== "string" || category.length === 0) return null;
  if (!isObject(card)) return null;
  if (!isHttpUrl(cardUrl)) return null;
  if (slug !== undefined && typeof slug !== "string") return null;

  const req: PublishRequest = { prompt, resourceId, category, card, cardUrl };
  if (typeof slug === "string") req.slug = slug;
  if (reputation !== undefined) {
    if (typeof reputation !== "string") return null;
    try {
      req.reputation = BigInt(reputation);
    } catch {
      return null;
    }
  }
  return req;
}

/**
 * Resolve the marketplace index + card + moderation stores from the environment,
 * fail-closed on durability in production (mirrors the deployer's resolveDeployerStores
 * style).
 *
 * DATABASE_URL set + non-empty -> the durable Postgres-backed adapters (the discovery
 * index, the served finalized cards, AND the moderation decision log + review queue all
 * survive a restart, so a deployed resource never silently drops out of agent discovery
 * and a held-for-review resource never silently drops out of the queue). Otherwise, in
 * production we THROW at boot: an in-memory store loses every listing, served card, and
 * pending review on restart, so silently running ephemeral in prod is a correctness
 * regression. In dev/test (NODE_ENV !== "production") the in-memory adapters stay the
 * default so the autonomous suite needs no Postgres. DATABASE_URL may carry credentials
 * and is NEVER logged or echoed in the error.
 */
export function resolveMarketplaceStores(env: NodeJS.ProcessEnv): {
  indexStore: IndexStore;
  cardStore: CardStore;
  moderationStore: ModerationStore;
  /**
   * Teardown for the durable Postgres adapter (pg.end), threaded to graceful shutdown.
   * Undefined for the in-memory branch (nothing to close), so dev/test boot is unchanged.
   */
  close?: () => Promise<void>;
  /**
   * Readiness probe (a cheap SELECT 1 over the durable pg pool), threaded to GET /ready.
   * Undefined for the in-memory branch, where /ready always reports ready in dev/test.
   */
  probe?: () => Promise<void>;
} {
  const databaseUrl = (env.DATABASE_URL ?? "").trim();
  if (databaseUrl.length > 0) {
    return createPgStores({ databaseUrl });
  }
  if (env.NODE_ENV === "production") {
    throw new Error(
      "DATABASE_URL must be set in production: the marketplace index, served " +
        "cards, and moderation queue must be durable; an in-memory store drops " +
        "every listing on restart.",
    );
  }
  return {
    indexStore: new InMemoryIndexStore(),
    cardStore: new InMemoryCardStore(),
    moderationStore: new InMemoryModerationStore(),
    // The in-memory backend is always reachable, so /ready reports ready in dev/test.
    probe: async () => {},
  };
}

/**
 * Build the marketplace route deps. Stores come from resolveMarketplaceStores
 * (Postgres when DATABASE_URL is set; in-memory dev/test default; fail-closed in
 * production with no DATABASE_URL) - the SAME IndexStore / CardStore contract either
 * adapter implements, so this swaps by env without touching route logic. The CardSource
 * reads through the resolved cardStore: an unknown resource resolves to null, which
 * createCardApp serves as a 404; a published resource resolves its finalized card.
 */
export function buildDepsFromEnv(): MarketplaceAppDeps {
  const { indexStore, cardStore, moderationStore, close, probe } =
    resolveMarketplaceStores(process.env);
  const cardSource: CardSource = {
    async getCard(resourceId) {
      // Serve the FINALIZED card the publish pipeline persisted to the CardStore. The
      // store is empty at boot, so an unknown resource is null -> 404 via createCardApp;
      // a published resource resolves its finalized card here (re-validated at the route).
      return (await cardStore.get(resourceId as Hex)) ?? null;
    },
  };
  // The SAME indexStore + cardStore instances back GET /resources, the card route, AND
  // the publish pipeline, so a successful publish is immediately discoverable + servable.
  const publishPipeline = createPublishPipeline(
    createPublishPipelineDeps(process.env, { indexStore, cardStore, moderationStore }),
  );
  return {
    indexStore,
    cardStore,
    cardSource,
    publishPipeline,
    publishAuthSecret: process.env.MARKETPLACE_AUTH_SECRET,
    // Undefined for the in-memory branch (no close), so dev/test boot is byte-unchanged.
    storesClose: close,
    // The readiness probe (durable: a SELECT 1; in-memory: a resolving no-op).
    storeProbe: probe,
  };
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

  // GET /ready - the store-aware readiness probe (a cheap SELECT 1 over the durable pg
  // pool). It returns 200 {ready:true} only when the backend is reachable, 503
  // {ready:false} when the probe throws, and 200 {ready:true} when no probe is wired
  // (the in-memory dev/test default), so local up and the autonomous suite stay green.
  // The 503 path is VALUE-FREE: the catch swallows the error so a connection string in
  // err.message can never reach the response body. Registered BEFORE the createCardApp
  // mount (mirroring /resources) so the card catch-all never shadows it.
  app.get("/ready", async (c) => {
    if (!deps.storeProbe) return c.json({ ready: true }, 200);
    try {
      await deps.storeProbe();
      return c.json({ ready: true }, 200);
    } catch {
      return c.json({ ready: false }, 503);
    }
  });

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

  // POST /resources - the authenticated publish endpoint (MKT-03). It runs the publish
  // pipeline (moderation -> bond -> probe -> mint -> index) and, on success, persists
  // the finalized card + index record so the resource is immediately discoverable +
  // servable. Registered BEFORE the createCardApp mount so it owns the POST verb.
  app.post("/resources", async (c) => {
    // (a) AUTH FAIL-CLOSED, before body parse / pipeline run. An unset/blank secret is
    // never an open publish endpoint; the Bearer is constant-time compared, never logged.
    const secret = deps.publishAuthSecret?.trim();
    if (!secret) {
      return c.json({ error: "publish disabled: MARKETPLACE_AUTH_SECRET unset" }, 503);
    }
    if (!bearerMatches(c.req.header("authorization"), secret)) {
      return c.json({ error: "unauthorized" }, 401);
    }

    // (b) Parse + shape-validate the body into a PublishRequest. A bad body -> 400.
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "bad_request" }, 400);
    }
    const req = parsePublishRequest(body);
    if (!req) return c.json({ error: "bad_request" }, 400);

    // (c) Run the pipeline. Map each gate failure to its status by instanceof; rethrow
    // anything else so a real server fault surfaces as a 500 via Hono.
    try {
      const result = await deps.publishPipeline.publishResource(req);
      return c.json(
        {
          listed: true,
          resourceId: req.resourceId,
          agentId: result.agentId.toString(),
          cardUrl: req.cardUrl,
        },
        201,
      );
    } catch (e) {
      if (e instanceof PublishBlocked) {
        return c.json({ error: "blocked", reason: e.reason }, 403);
      }
      if (e instanceof PublishHeldForReview) {
        return c.json({ status: "review", reason: e.reason }, 202);
      }
      if (e instanceof PublishUnverified) {
        return c.json({ error: "unverified", reason: e.reason }, 422);
      }
      if (e instanceof PublishRejected) {
        return c.json({ error: "rejected", reason: e.message }, 422);
      }
      throw e;
    }
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
  // Capture the serve() handle (previously discarded) so graceful shutdown can drain
  // in-flight requests before closing the durable stores. The only closeable is the
  // store pool teardown, undefined for the in-memory default (so it is skipped).
  const server = serve({ fetch: app.fetch, port });
  const drainTimeoutMs = Number(process.env.SHUTDOWN_DRAIN_MS ?? "10000");
  const closeables: Array<() => Promise<void>> = [];
  if (deps.storesClose) closeables.push(deps.storesClose);
  runGracefulShutdown({ server, drainTimeoutMs, closeables }).register();
}

// Boot when run directly (node src/server.ts), not when imported by a test.
// pathToFileURL normalizes process.argv[1] to the same WHATWG file:// href that
// import.meta.url carries, so the direct-run check fires on Windows and POSIX alike.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}
