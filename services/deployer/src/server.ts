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
import {
  runGracefulShutdown,
  JsonLogger,
  stdoutSink,
  selectReconcileEventSink,
  type ReconcileEventSink,
  type ReconcileAlertEvent,
} from "@utter/observability";
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
import { SlugConflictError } from "./stores/memory";
import {
  resolveDockerHandle,
  listResourceContainers,
  reapResourceContainer,
  reapOrphanPairNetworks,
  type DockerHandle,
} from "./orchestrate";
import {
  createReconcileLoop,
  type ReconcileLoop,
  type ReconcileErrorEvent,
} from "./reconcile";
import { DEFAULT_RUNAWAY_POLICY } from "./reaper";

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

  // GET /ready - the store-aware readiness probe. The deployer is a HOST process (no
  // Dockerfile, no compose service), so it gets no image HEALTHCHECK; instead the host
  // supervisor (systemd) should health-probe http://127.0.0.1:8788/ready to gate the
  // deployer behind store reachability. It returns 200 {ready:true} only when the
  // durable store is reachable, 503 {ready:false} when the probe throws, and 200
  // {ready:true} when no probe is wired (the in-memory dev/test default), so local up
  // and the autonomous suite stay green. The 503 path is VALUE-FREE: the catch swallows
  // the error so a connection string in err.message can never reach the response body.
  app.get("/ready", async (c) => {
    const probe = deps.stores.probe;
    if (!probe) return c.json({ ready: true }, 200);
    try {
      await probe();
      return c.json({ ready: true }, 200);
    } catch {
      return c.json({ ready: false }, 503);
    }
  });

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
      // WRITE-THEN-LAUNCH (subtask 7): write a "deploying" record BEFORE launch so a
      // reconcile tick during the launch window treats the launching containers as
      // desired (not orphans to reap). A SlugConflictError here means the slug is owned
      // by a DIFFERENT resourceId (M5): ABORT the deploy - emit an error frame and never
      // call deploy. Any OTHER store error is best-effort (the loop just will not track
      // the in-flight deploy): log non-secret and proceed.
      try {
        await recordDeployment(deps.stores.deployments, {
          resourceId,
          slug: req.slug,
          status: "deploying",
        });
      } catch (preErr) {
        if (preErr instanceof SlugConflictError) {
          enqueue({
            phase: "error",
            status: "error",
            message: preErr.message,
          });
          await writeQueue;
          return;
        }
        console.error(
          "pre-launch deployment record write failed (proceeding best-effort)",
          preErr instanceof Error ? preErr.message : preErr,
        );
      }

      let sawDone = false;
      try {
        const result = await deploy(req, (e) => {
          if (e.phase === "done") sawDone = true;
          enqueue(e);
        });
        // BEST-EFFORT desired-state persist (only reached when deploy RESOLVED). This
        // flips the "deploying" record to "running" (an idempotent redeploy of the just-
        // written record). The resource is already live, so a store failure must NOT turn
        // a successful deploy into a reported failure: it is logged non-secret and the
        // done frame still emits.
        try {
          await recordDeployment(deps.stores.deployments, {
            resourceId,
            slug: req.slug,
            status: "running",
          });
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
        // The deploy threw: mark the record "failed" (best-effort, in its OWN try/catch
        // so it never masks the original deploy error) so reconcile excludes it from
        // desired-running and reaps any partial containers. THEN emit the error frame.
        try {
          await recordDeployment(deps.stores.deployments, {
            resourceId,
            slug: req.slug,
            status: "failed",
          });
        } catch (storeErr) {
          console.error(
            "deploy failed and marking the deployment failed also failed",
            storeErr instanceof Error ? storeErr.message : storeErr,
          );
        }
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

/**
 * Build the host-gated reconcile loop over a real docker handle + the deployer deps.
 *
 * It wires the EXISTING authoritative container/network ops from orchestrate.ts into
 * createReconcileLoop: listResourceContainers (actual state), reapResourceContainer
 * (orphan + runaway reap, T-03-19 / H4), reapOrphanPairNetworks (pairnet GC, mwb), and
 * the deployments store (desired state). The runaway pass uses DEFAULT_RUNAWAY_POLICY.
 *
 * DELIBERATELY NO launchContainer: untrusted generated code is NEVER auto-relaunched (a
 * generated bundle cannot be re-run without its ephemeral bundle). The loop's job here is
 * orphan-container reap + runaway quarantine + stale-deploying quarantine + pairnet GC
 * only; it REPORTS toLaunch drift but never acts on it. RECONCILE_INTERVAL_MS (default
 * 15000) sets the tick interval; DEPLOY_TIMEOUT_MS (default 600000, 10 min) sets the
 * stale-deploying quarantine window - a record stuck at "deploying" past it (a crash
 * before the deploy resolved) is flipped to "failed" so its partial container is reaped;
 * MAX_CONCURRENT_RESOURCES, when set, caps running resources (but with no launch hook it
 * only ever affects reporting). All values are host-capacity numbers, never money literals.
 *
 * Exported + parameterized on docker/deps/env so it is unit-testable with fakes; start()
 * passes the real handle only on the gVisor host.
 */
export function buildReconcileLoop(
  docker: DockerHandle,
  deps: DeployerAppDeps,
  env: NodeJS.ProcessEnv,
): ReconcileLoop {
  // Structured JSON-lines logger pinned to this component. Distinct from the OBS-02
  // money-path StructuredLogger; this is operational logging only (counts + the typed
  // non-secret reconcile fields).
  const logger = new JsonLogger(stdoutSink, { service: "deployer", component: "reconcile" });
  // Best-effort reconcile alert sink. ALERT_WEBHOOK_URL unset/blank -> a pure no-op
  // (no fetch, no network) so the autonomous suite never reaches a network path.
  const eventSink = selectReconcileEventSink(env, logger);

  return createReconcileLoop({
    store: deps.stores.deployments,
    listContainers: () => listResourceContainers(docker),
    reapContainer: (c) => reapResourceContainer(docker, c),
    reapOrphanNetworks: () => reapOrphanPairNetworks(docker),
    intervalMs: Number(env.RECONCILE_INTERVAL_MS ?? "15000"),
    // Stale-deploying quarantine window (crash recovery). 10 min default - far above a
    // real gVisor deploy, so a slow-but-live deploy is never wrongly failed. now is left
    // unset here so it defaults to Date.now in prod (tests inject a pinned clock).
    deployTimeoutMs: Number(env.DEPLOY_TIMEOUT_MS ?? "600000"),
    runawayPolicy: DEFAULT_RUNAWAY_POLICY,
    // reconcile.ts calls onError INLINE inside a tick, so this handler MUST NEVER throw
    // back into the loop: handleReconcileError wraps its whole body in try/catch.
    onError: (e) => handleReconcileError(e, logger, eventSink),
    // onTick logs counts only (never the records, which could carry resource detail).
    onTick: (r) =>
      logger.info("reconcile tick", {
        healthy: r.healthy,
        toLaunch: r.toLaunch.length,
        toReap: r.toReap.length,
      }),
    ...(env.MAX_CONCURRENT_RESOURCES
      ? { maxConcurrent: Number(env.MAX_CONCURRENT_RESOURCES) }
      : {}),
  });
}

/**
 * Map a reconcile phase to its security-relevant alert kind. The reconcile phases
 * (reap / runaway / capacity / tick / launch / deploy-timeout) map 1:1 onto the alert
 * kinds the webhook sink forwards. A pure function so the mapping is unit-testable in
 * isolation.
 */
function reconcilePhaseToAlertKind(phase: ReconcileErrorEvent["phase"]): ReconcileAlertEvent["kind"] {
  switch (phase) {
    case "reap":
      return "reap_failure";
    case "runaway":
      return "runaway_quarantine";
    case "capacity":
      return "capacity_defer";
    case "tick":
      return "tick_failure";
    case "launch":
      return "launch_failure";
    case "deploy-timeout":
      return "deploy_timeout";
  }
}

/**
 * The reconcile onError handler used by buildReconcileLoop. It (a) logs the event via
 * the JSON-lines logger (only the typed non-secret fields: phase / containerId /
 * resourceId / message) and (b) maps the phase to a ReconcileAlertEvent and emits it to
 * the event sink. reconcile.ts calls onError INLINE inside a tick, so the WHOLE body is
 * wrapped in try/catch: a failure here (a logger or sink throw) must NEVER propagate
 * back into the loop. Exported so a test can drive the mapping with a CaptureReconcileSink.
 */
export function handleReconcileError(
  e: ReconcileErrorEvent,
  logger: JsonLogger,
  eventSink: ReconcileEventSink,
): void {
  try {
    // Forward ONLY the typed reconcile fields (reconcile.ts documents these as never
    // carrying secret material). No addresses, keys, tokens, or credential URLs.
    logger.warn("reconcile event", {
      phase: e.phase,
      containerId: e.containerId,
      resourceId: e.resourceId,
      message: e.message,
    });
    eventSink.emit({
      kind: reconcilePhaseToAlertKind(e.phase),
      phase: e.phase,
      message: e.message,
      containerId: e.containerId,
      resourceId: e.resourceId,
      ts: Date.now(),
    });
  } catch {
    // Inline inside a tick: never throw back into the loop.
  }
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
  // Capture the serve() handle (previously discarded) so graceful shutdown can drain an
  // in-flight POST /deploy stream before closing the store client.
  const server = serve({ fetch: app.fetch, hostname, port });

  // HOST-GATED reconcile loop bootstrap (DEP-05 / T-03-19): start the orphan-reap +
  // runaway-quarantine + pairnet-GC loop ONLY on the provisioned gVisor host
  // (UTTER_SANDBOX_HOST=1) with a real docker handle. resolveDockerHandle() already
  // returns undefined unless UTTER_SANDBOX_HOST=1, so off-host (dev/test) the loop is
  // never built and boot is byte-unchanged - no dockerode connection, no interval. The
  // loop interval is unref'd (reconcile.ts) so it never keeps the process alive. We
  // never store the handle to a closure for relaunch: the loop only reaps + GCs.
  //
  // `loop` is hoisted to function scope so the shutdown closure below can stop it after
  // the request drain and before the store client closes (so no tick fires a store call
  // against a closing client). loop?.stop() is idempotent and a no-op when undefined.
  let loop: ReconcileLoop | undefined;
  const docker = process.env.UTTER_SANDBOX_HOST === "1" ? resolveDockerHandle() : undefined;
  if (docker) {
    loop = buildReconcileLoop(docker, deps, process.env);
    loop.start();
    const intervalMs = Number(process.env.RECONCILE_INTERVAL_MS ?? "15000");
    // Non-secret: interval only (no env values, no secrets).
    console.log(`reconcile loop started, interval ${intervalMs}ms`);
  } else {
    console.log("reconcile loop not started (no sandbox host)");
  }

  // Graceful shutdown: drain in-flight requests, THEN stop the reconcile loop, THEN close
  // the store client. The store close is guarded with typeof so the in-memory default
  // (no close) is skipped, leaving dev/test boot byte-unchanged.
  const drainTimeoutMs = Number(process.env.SHUTDOWN_DRAIN_MS ?? "10000");
  const closeables: Array<() => Promise<void>> = [];
  if (typeof deps.stores.close === "function") {
    const storesClose = deps.stores.close;
    closeables.push(() => storesClose());
  }
  runGracefulShutdown({
    server,
    drainTimeoutMs,
    // Await loop.stop() so the live reconcile tick settles BEFORE the closeable quits
    // redis: no in-flight store call survives into the client close (the loop's own
    // documented invariant). loop?.stop() is idempotent and a no-op when undefined.
    beforeClosePools: async () => {
      await loop?.stop();
    },
    closeables,
  }).register();
}

// Boot when run directly (node src/server.ts), not when imported by a test.
// pathToFileURL normalizes process.argv[1] to the same WHATWG file:// href that
// import.meta.url carries, so the direct-run check fires on Windows and POSIX alike.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}
