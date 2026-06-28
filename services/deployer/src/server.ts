// The deployer control-plane server bootstrap. Mirrors the facilitator template
// (services/facilitator/src/server.ts): loads `.env.local`, builds the stores,
// serves a Hono app via @hono/node-server, and ends with the Windows-and-POSIX
// self-run guard.
//
// The deployer is a toolkit of factories with NO single createApp, so this file
// composes a MINIMAL control plane over the in-memory stores. Boot is side-effect
// free against live deps: it reads no secrets, opens no dockerode connection, and
// starts NO reconcile loop (the reconcile loop calls dockerode and is operator-gated
// and live). It surfaces the desired-state deployment records read-through AND the
// authenticated, gate-first SSE POST /deploy seam the studio control plane (increment
// B) pushes a GENERATED (untrusted) bundle through.
//
// SECURITY (POST /deploy is a NEW authenticated remote attack surface that runs
// UNTRUSTED bundles):
//   - Auth FAILS CLOSED: an unset/blank DEPLOYER_AUTH_SECRET -> 503 (deploy disabled,
//     never an open endpoint); a missing/wrong Bearer -> 401. The token is compared in
//     constant time (node:crypto timingSafeEqual over equal-length Buffers; a length
//     mismatch short-circuits to unauthorized, never calling timingSafeEqual on
//     unequal lengths, which throws). The secret/token is NEVER logged.
//   - The bundle's slug / on-chain resourceId / pricing are NEVER taken from the
//     bundle; they are TRUSTED fields off the authenticated request. ONLY openapi.json
//     is read FROM the bundle (the classifier schema; empty-paths fallback when absent).
//   - gateGeneratedBundle runs PRE-STREAM: a rejected bundle returns 400 and NEVER
//     starts a stream or calls deploy.
//   - The SSE error frame carries err.message ONLY (no stack, no secret).
import { config as loadEnv } from "dotenv";
import { pathToFileURL } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { resourceIdForLabel, type Pricing } from "@utter/x402-arc";
import { createInMemoryStores } from "./stores/memory";
import type { DeployerStores } from "./stores/memory";
import { createRedisStores } from "./stores/redis";
import {
  deployGatedBundle,
  type DeployProgressEvent,
  type LiveDeployResult,
} from "./live-deploy";
import { validateSlug } from "./traefik-config";
import { gateGeneratedBundle, BundleGateError } from "./gate-bundle";
import { recordDeployment } from "./record-deploy";

loadEnv({ path: ".env.local" });

/**
 * The POST /deploy request body. The bundle's handler.ts is UNTRUSTED generated code;
 * slug / resourceLabel / pricing / maxTimeoutSeconds / freePaths are TRUSTED fields the
 * authenticated caller chooses, NEVER taken from the bundle. ONLY openapi.json is read
 * FROM the bundle.
 */
export interface DeployRequest {
  /** The generated (untrusted) bundle: POSIX-key -> file contents. */
  bundle: Record<string, string>;
  /** The resource slug (derives the route + container names). TRUSTED. */
  slug: string;
  /** The on-chain resource-id label (defaults to slug). TRUSTED. */
  resourceLabel?: string;
  /** The per-resource metered pricing. TRUSTED. */
  pricing: Pricing;
  /** Max handler runtime before the gate times out (seconds; default 30). TRUSTED. */
  maxTimeoutSeconds?: number;
  /** The free routes the sidecar bypasses the gate on (default the A2A card). TRUSTED. */
  freePaths?: string[];
}

/** The route deps for the deployer control plane. */
export interface DeployerAppDeps {
  stores: DeployerStores;
  /**
   * The deploy function POST /deploy drives. INJECTABLE (tests pass a fake; the real
   * deploy only runs on the gVisor host). Absent -> the default impl that maps a
   * DeployRequest to deployGatedBundle.
   */
  deploy?: (
    req: DeployRequest,
    onProgress: (e: DeployProgressEvent) => void,
  ) => Promise<LiveDeployResult>;
  /**
   * The shared-secret Bearer the POST /deploy route checks. Read from
   * DEPLOYER_AUTH_SECRET in buildDepsFromEnv; absent/blank -> the route fails closed
   * (503). NEVER logged.
   */
  authSecret?: string;
}

/**
 * The default POST /deploy impl: map a DeployRequest to deployGatedBundle params. slug /
 * resourceId / pricing come ONLY from the request; ONLY the bundle's openapi.json is read
 * (the classifier schema; empty-paths fallback when absent). The real deploy runs ONLY on
 * the gVisor host (deployGatedBundle host-gates docker); off-host it fails loud.
 */
function defaultDeploy(
  req: DeployRequest,
  onProgress: (e: DeployProgressEvent) => void,
): Promise<LiveDeployResult> {
  const slug = validateSlug(req.slug);
  const resourceId = resourceIdForLabel(req.resourceLabel?.trim() || req.slug);
  const bundleOpenapi = req.bundle["openapi.json"];
  const classifierSchema =
    bundleOpenapi && bundleOpenapi.trim().length > 0
      ? bundleOpenapi
      : JSON.stringify({ openapi: "3.1.0", paths: {} });
  return deployGatedBundle(
    {
      bundle: req.bundle,
      resourceId,
      slug,
      pricing: req.pricing,
      maxTimeoutSeconds: req.maxTimeoutSeconds ?? 30,
      freePaths: req.freePaths ?? ["/.well-known/agent-card.json"],
      classifierSchema,
    },
    fetch,
    { onProgress },
  );
}

/**
 * Constant-time Bearer check. Reads the token off the Authorization header, strips the
 * `Bearer ` prefix, and compares it to the secret with timingSafeEqual over equal-length
 * Buffers. A length mismatch (or a missing header) short-circuits to false WITHOUT calling
 * timingSafeEqual (which throws on unequal lengths). The secret/token is never logged.
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

/**
 * Resolve the deployer stores from the environment, fail-closed on durability in
 * production (mirrors the facilitator's resolveAuthConfig fail-closed style).
 *
 * REDIS_URL set + non-empty -> the durable Redis-backed adapter (the deployment
 * records that drive the reconcile loop AND the M5 slug-uniqueness reverse index
 * survive a restart). Otherwise, in production we THROW at boot: an in-memory store
 * loses every record + the M5 guard on restart, so silently running ephemeral in
 * prod is a correctness/security regression (a freed slug could be re-allocated to a
 * different resourceId, re-opening the cross-tenant pairnet co-tenancy HIGH). In
 * dev/test (NODE_ENV !== "production") the in-memory adapter stays the default so the
 * autonomous suite needs no Redis. REDIS_URL may carry credentials and is NEVER
 * logged or echoed in the error.
 */
export function resolveDeployerStores(env: NodeJS.ProcessEnv): DeployerStores {
  const redisUrl = (env.REDIS_URL ?? "").trim();
  if (redisUrl.length > 0) {
    return createRedisStores({ redisUrl });
  }
  if (env.NODE_ENV === "production") {
    throw new Error(
      "REDIS_URL must be set in production: the deployer's deployment records and " +
        "the M5 slug-uniqueness guard must be durable; an in-memory store loses " +
        "every record and the guard on restart.",
    );
  }
  return createInMemoryStores();
}

/**
 * Build the deployer route deps from the environment. Stores come from
 * resolveDeployerStores (Redis when REDIS_URL is set; in-memory dev/test default;
 * fail-closed in production with no REDIS_URL) - the SAME contract either adapter
 * implements, so this swaps by env without touching routes. The deploy function is
 * left undefined so the route uses defaultDeploy; authSecret reads
 * DEPLOYER_AUTH_SECRET (never hardcoded; absent -> POST /deploy fails closed).
 */
export function buildDepsFromEnv(): DeployerAppDeps {
  return {
    stores: resolveDeployerStores(process.env),
    authSecret: process.env.DEPLOYER_AUTH_SECRET,
  };
}

/**
 * Build the deployer control-plane Hono app:
 *   GET  /health      -> { ok: true, service: "deployer" }
 *   GET  /deployments -> the desired-state deployment records (read-through)
 *   POST /deploy      -> authenticated, gate-first SSE deploy of a GENERATED bundle
 * The GET routes touch no live/operator-gated dep. POST /deploy authenticates, validates,
 * gates PRE-STREAM, then streams DeployProgressEvent frames; the real deploy runs only on
 * the gVisor host (tests inject a fake).
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

  app.post("/deploy", async (c) => {
    // (a) AUTH FAIL-CLOSED, before body parse / gate / deploy.
    const secret = deps.authSecret?.trim();
    if (!secret) {
      return c.json({ error: "deploy disabled: DEPLOYER_AUTH_SECRET unset" }, 503);
    }
    if (!bearerMatches(c.req.header("authorization"), secret)) {
      return c.json({ error: "unauthorized" }, 401);
    }

    // (b) Parse + validate the body. ALL failures are pre-stream JSON 400s.
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const b = body as Partial<DeployRequest> | null;
    if (
      !b ||
      typeof b.bundle !== "object" ||
      b.bundle === null ||
      typeof b.bundle["handler.ts"] !== "string" ||
      b.bundle["handler.ts"].trim().length === 0
    ) {
      return c.json({ error: "missing handler.ts" }, 400);
    }
    if (typeof b.slug !== "string") {
      return c.json({ error: "invalid slug" }, 400);
    }
    try {
      validateSlug(b.slug);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "invalid slug" }, 400);
    }
    const pricing = b.pricing;
    if (
      !pricing ||
      typeof pricing.base !== "string" ||
      typeof pricing.perKB !== "string" ||
      typeof pricing.computeMultiplier !== "string"
    ) {
      return c.json({ error: "invalid pricing" }, 400);
    }

    // (c) PRE-STREAM GATE. A rejected bundle returns 400 and NEVER starts a stream or
    // calls deploy. (Defense in depth: deployGatedBundle re-gates before any write/build.)
    try {
      gateGeneratedBundle(b.bundle);
    } catch (e) {
      if (e instanceof BundleGateError) {
        return c.json(
          { error: "bundle rejected", violations: e.violations.map((v) => v.rule) },
          400,
        );
      }
      throw e;
    }

    // The validated, TRUSTED request. slug / resourceLabel / pricing come from the
    // authenticated caller; ONLY the bundle's openapi is read downstream.
    const req: DeployRequest = {
      bundle: b.bundle,
      slug: b.slug,
      resourceLabel: b.resourceLabel,
      pricing,
      maxTimeoutSeconds: b.maxTimeoutSeconds,
      freePaths: b.freePaths,
    };

    // The on-chain resource id, derived with the SAME label-or-slug rule defaultDeploy
    // uses, so the persisted record's resourceId matches the deployed resource exactly.
    const resourceId = resourceIdForLabel(b.resourceLabel?.trim() || b.slug);

    // (d) STREAM the progress events. The error frame carries err.message ONLY (no stack,
    // no secret). streamSSE closes the stream when the callback returns.
    //
    // onProgress is a SYNCHRONOUS callback, but stream.writeSSE is async. We chain the
    // writes through a serial promise queue so they flush IN ORDER, then await the tail
    // of the queue before the callback returns (and the stream closes). Awaiting the tail
    // is what guarantees every queued frame is written before close - a fire-and-forget
    // write would be silently dropped when the writer closes underneath it.
    const deploy = deps.deploy ?? defaultDeploy;
    return streamSSE(c, async (stream) => {
      let writeQueue: Promise<void> = Promise.resolve();
      const enqueue = (e: DeployProgressEvent): void => {
        writeQueue = writeQueue.then(() => stream.writeSSE({ data: JSON.stringify(e) }));
      };
      let sawDone = false;
      try {
        const result = await deploy(req, (e) => {
          if (e.phase === "done") sawDone = true;
          enqueue(e);
        });
        // BEST-EFFORT desired-state persist (only reached when deploy RESOLVED; a deploy
        // that threw is in the catch and writes no record). The resource is already live,
        // so a store failure must NOT turn a successful deploy into a reported failure: it
        // is logged non-secret and the done frame still emits.
        try {
          await recordDeployment(deps.stores.deployments, { resourceId, slug: req.slug });
        } catch (storeErr) {
          console.error(
            "deploy succeeded but recording the deployment failed",
            storeErr instanceof Error ? storeErr.message : storeErr,
          );
        }
        if (!sawDone) {
          enqueue({ phase: "done", status: "ok", message: "deploy complete", result });
        }
      } catch (err) {
        enqueue({
          phase: "error",
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      // Drain the queue before returning so streamSSE does not close mid-flush.
      await writeQueue;
    });
  });

  return app;
}

/** Start the deployer HTTP server on the given port (default 8788). */
export function start(port = Number(process.env.PORT ?? "8788")): void {
  const deps = buildDepsFromEnv();
  const app = createDeployerApp(deps);
  // Bind all interfaces (0.0.0.0) by default so the studio CONTAINER can reach this HOST
  // process via host.docker.internal (the docker bridge gateway). A 127.0.0.1-only bind
  // would refuse the container's connection - the "deploy: fetch failed" (ECONNREFUSED)
  // symptom. The port must still be firewalled off the public internet (compose note) and
  // every /deploy call is Bearer-authed + gate-first. HOST overrides the bind for an
  // operator who pins it to the docker bridge IP. Log only host:port (no env values).
  const hostname = process.env.HOST?.trim() || "0.0.0.0";
  console.log(`deployer listening on ${hostname}:${port}`);
  serve({ fetch: app.fetch, hostname, port });
}

// Boot when run directly (node src/server.ts), not when imported by a test.
// pathToFileURL normalizes process.argv[1] to the same WHATWG file:// href that
// import.meta.url carries, so the direct-run check fires on Windows and POSIX alike.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}
