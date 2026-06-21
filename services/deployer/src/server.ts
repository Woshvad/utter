// The deployer control-plane server bootstrap. Mirrors the facilitator template
// (services/facilitator/src/server.ts): loads `.env.local`, builds the stores,
// serves a Hono app via @hono/node-server, and ends with the Windows-and-POSIX
// self-run guard.
//
// The deployer is a toolkit of factories with NO single createApp, so this file
// composes a MINIMAL control plane over the in-memory stores. Boot is side-effect
// free against live deps: it reads no secrets, opens no dockerode connection, and
// starts NO reconcile loop (the reconcile loop calls dockerode and is operator-gated
// and live). It only surfaces the desired-state deployment records read-through.
import { config as loadEnv } from "dotenv";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createInMemoryStores } from "./stores/memory";
import type { DeployerStores } from "./stores/memory";

loadEnv({ path: ".env.local" });

/** The route deps for the deployer control plane. */
export interface DeployerAppDeps {
  stores: DeployerStores;
}

/**
 * Build the deployer route deps from the environment. The autonomous/dev default is
 * the in-memory stores (no Redis, no dockerode, no secrets) - the SAME contract the
 * future Redis adapter implements, so this swaps by env without touching routes.
 */
export function buildDepsFromEnv(): DeployerAppDeps {
  return {
    stores: createInMemoryStores(),
  };
}

/**
 * Build the minimal deployer control-plane Hono app. Two read-only routes:
 *   GET /health      -> { ok: true, service: "deployer" }
 *   GET /deployments -> the desired-state deployment records (read-through)
 * No route touches a live/operator-gated dep; the dockerode reconcile loop is NOT
 * started here.
 */
export function createDeployerApp(deps: DeployerAppDeps): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true, service: "deployer" }));

  app.get("/deployments", async (c) => {
    const records = await deps.stores.deployments.list();
    // bigint cap is not JSON-serializable; surface it as a base-units string so the
    // read-through stays lossless without a 1e6 decimals literal.
    const safe = records.map((r) => ({
      ...r,
      cap: r.cap !== undefined ? r.cap.toString() : undefined,
    }));
    return c.json(safe);
  });

  return app;
}

/** Start the deployer HTTP server on the given port (default 8788). */
export function start(port = Number(process.env.PORT ?? "8788")): void {
  const deps = buildDepsFromEnv();
  const app = createDeployerApp(deps);
  // Log only the service name + port (no env values; mirror the facilitator).
  console.log(`deployer listening on :${port}`);
  serve({ fetch: app.fetch, port });
}

// Boot when run directly (node src/server.ts), not when imported by a test.
// pathToFileURL normalizes process.argv[1] to the same WHATWG file:// href that
// import.meta.url carries, so the direct-run check fires on Windows and POSIX alike.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}
