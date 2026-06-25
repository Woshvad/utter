// sidecar.ts - the standalone SIDECAR gate-server (Security review C1).
//
// C1 finding: today the escrow gate runs IN-PROCESS inside the untrusted handler
// container (services/deployer/src/inject-x402.ts + examples/echo/main.ts), so the
// adversary's generated code shares the process + network namespace with the gate
// and could open its own socket to the facilitator to forge strikes or self-settle.
//
// The fix is a SIDECAR: a separate, trusted container that runs the UNCHANGED
// `requirePayment` gate and reverse-proxies paid routes to a gate-less handler
// container at HANDLER_URL. Only the sidecar reaches the facilitator; the untrusted
// handler never sees the facilitator, the caller-auth token, or the buyer payment.
//
// This file is a thin WRAPPER over the EXACT Phase 2 gate. Like inject-x402.ts says
// (lines 11-14): the gate config is identical, only the downstream transport differs
// - here it is a reverse-proxy fetch to a separate container instead of an in-process
// Hono route. There are NO edits to gate.ts: the gate is reused verbatim and the only
// change versus the in-process `gated.route("/", resourceApp)` is the catch-all proxy.
//
// SECURITY invariants enforced here:
//   - FREE paths (agent-card, health) BYPASS the gate so discovery is never paywalled.
//   - the proxy STRIPS x-payment (consumed by the gate) and authorization (never
//     forward a bearer to the untrusted handler) before reaching HANDLER_URL.
//   - the proxy returns the upstream Response UNCHANGED (status + headers + body) so
//     the gate's clone-read, classification, and byte-length metering are identical to
//     the in-process path, AND it NEVER imposes its own timeout or swallows a
//     handler throw: the gate's `withTimeout(next())` owns the deadline (a slow
//     handler -> gate timeout -> release "timeout" -> 504) and a fetch rejection
//     propagates so the gate maps it to "handler_error" -> 502. Swallowing either
//     would regress the strike/release semantics.
import { Hono } from "hono";
import type { Context } from "hono";
import type { Hex } from "viem";
import { USDC, PAYMENT_ESCROW } from "@utter/chain";
import { requirePayment, type ErrorPolicy } from "./gate";
import { buildClassifier, type ClassifyResponse } from "./classify";
import type { AcceptsEntry, Pricing } from "./accepts";
import type { FetchLike } from "./idempotency";

/**
 * The default path PREFIXES that BYPASS the gate. Discovery (the A2A agent card) and
 * health must never be paywalled or agents cannot find / probe the resource.
 */
export const DEFAULT_FREE_PATHS = ["/.well-known/", "/health"] as const;

/**
 * The permissive default classifier for a resource with NO declared openapi schema:
 * any non-empty, parseable body is a `success` (chargeable); an empty/unparseable
 * body is a `malfunction` (release + strike, never debit). Lifted verbatim from the
 * deployer's inject-x402.ts so x402-arc owns the canonical logic and does NOT depend
 * on the deployer. A resource without a schema pays on any real response and never
 * wrongly strikes its creator; a schema'd resource (CLASSIFIER_SCHEMA) keeps the
 * declared-error-is-free distinction via `buildClassifier`.
 */
export function permissiveClassifier(body: unknown): "success" | "declared_error" | "malfunction" {
  let value: unknown = body;
  if (typeof body === "string") {
    if (body.trim().length === 0) return "malfunction";
    try {
      value = JSON.parse(body);
    } catch {
      return "malfunction";
    }
  }
  if (value === null || value === undefined) return "malfunction";
  return "success";
}

/** The fully-resolved sidecar config (env-loaded by {@link loadSidecarConfig}). */
export interface SidecarConfig {
  /** The facilitator base URL the gate POSTs /verify /settle /release to. */
  facilitatorUrl: string;
  /** The resource being charged (bytes32 Hex) - the escrow `payTo`. */
  resourceId: Hex;
  /** The signed spend cap advertised in the 402 quote (USDC base units). */
  cap: bigint;
  /** The per-resource metered pricing (the escrow charge formula terms). */
  pricing: Pricing;
  /** Max handler runtime before the gate times out (seconds). */
  maxTimeoutSeconds: number;
  /** Where the untrusted handler container listens (e.g. http://slug-handler:8080). */
  handlerUrl: string;
  /**
   * The OPTIONAL per-resource caller-auth token (C1) the gate presents to the
   * facilitator. Present in production, absent in dev. Never logged.
   */
  facilitatorToken?: string;
  /** The response classifier; defaults to {@link permissiveClassifier}. */
  classifier?: ClassifyResponse;
  /** Declared-error policy (default `free` - no charge, no strike). */
  errorPolicy?: ErrorPolicy;
  /** Path PREFIXES that bypass the gate; default {@link DEFAULT_FREE_PATHS}. */
  freePaths?: string[];
  /** The port the entrypoint server listens on (default 8080). */
  port: number;
}

/** Injected dependencies for {@link createSidecarGateApp} (both default to fetch). */
export interface SidecarDeps {
  /** The fetcher the GATE uses to reach the facilitator (the gate's `fetcher` seam). */
  facilitatorFetcher?: FetchLike;
  /** The fetcher the REVERSE-PROXY uses to reach the handler container. */
  handlerFetcher?: typeof fetch;
}

/**
 * Build the per-resource 402 `accepts` entry (the advertised escrow option). Same
 * literal-free shape inject-x402's `buildResourceQuote` and the echo demo build:
 * USDC + PaymentEscrow come from @utter/chain, never re-literal'd.
 */
function buildSidecarQuote(cfg: SidecarConfig): AcceptsEntry {
  return {
    scheme: "utter-escrow",
    network: "eip155:5042002",
    asset: USDC,
    escrow: PAYMENT_ESCROW,
    maxAmountRequired: cfg.cap.toString(),
    payTo: cfg.resourceId,
    maxTimeoutSeconds: cfg.maxTimeoutSeconds,
    pricing: cfg.pricing,
  };
}

/** True when `path` starts with any configured free prefix (bypass the gate). */
export function isFreePath(path: string, freePaths: readonly string[]): boolean {
  return freePaths.some((prefix) => path.startsWith(prefix));
}

/**
 * Reverse-proxy the current request to the gate-less handler container and return
 * the upstream Response UNCHANGED. This is the ONLY behavioral change versus the
 * in-process `gated.route("/", resourceApp)`: the downstream is a separate container
 * reached over HTTP instead of an in-process Hono route.
 *
 * Returning the upstream Response directly makes Hono set `c.res` to it, so the
 * status + headers + body are preserved byte-for-byte. That keeps the gate's
 * `c.res.clone().text()`, classification, and `Buffer.byteLength` metering identical
 * to the in-process path (a declared-error HTTP 400 + body survives intact).
 *
 * It deliberately does NOT impose a timeout and does NOT catch/swallow: the gate's
 * `withTimeout(next())` owns the deadline (slow handler -> gate timeout -> release
 * "timeout" -> 504) and a fetch rejection PROPAGATES so the gate maps it to
 * "handler_error" -> 502. Swallowing either regresses the strike/release semantics.
 */
async function proxyToHandler(
  c: Context,
  handlerUrl: string,
  handlerFetch: typeof fetch,
): Promise<Response> {
  // Preserve the path + query string against the handler base URL.
  const inbound = new URL(c.req.url);
  const target = new URL(c.req.path + inbound.search, handlerUrl);

  // Copy inbound headers, then strip the ones that must NOT reach the untrusted
  // handler or that the runtime will recompute. x-payment was consumed by the gate;
  // authorization (the caller-auth bearer) must never be forwarded downstream.
  const headers = new Headers(c.req.raw.headers);
  headers.delete("x-payment");
  headers.delete("authorization");
  headers.delete("host");
  headers.delete("content-length");
  headers.delete("connection");

  // Forward a body for methods that carry one; GET/HEAD never do.
  const method = c.req.method;
  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody ? await c.req.arrayBuffer() : undefined;

  // No timeout, no try/catch here on purpose (see the doc comment): a rejection
  // propagates to the gate so it releases + strikes "handler_error" -> 502.
  const upstream = await handlerFetch(target, { method, headers, body });
  return upstream;
}

/**
 * Build the standalone sidecar gate app: the UNCHANGED `requirePayment` gate mounted
 * in front of a reverse-proxy to a separate HANDLER_URL container. FREE paths bypass
 * the gate; paid paths run the gate, which reserves the cap before proxying, then
 * classifies + settles/releases on the proxied response exactly as the in-process
 * gate does.
 *
 * The gate is reused VERBATIM (no gate.ts edits): only the downstream transport
 * differs (a cross-container fetch instead of an in-process Hono route), mirroring
 * inject-x402.ts lines 11-14.
 */
export function createSidecarGateApp(cfg: SidecarConfig, deps: SidecarDeps = {}): Hono {
  const classifier = cfg.classifier ?? permissiveClassifier;
  const freePaths = cfg.freePaths ?? [...DEFAULT_FREE_PATHS];
  const handlerFetch = deps.handlerFetcher ?? fetch;

  const gate = requirePayment({
    facilitatorUrl: cfg.facilitatorUrl,
    quote: () => buildSidecarQuote(cfg),
    classifier,
    pricing: cfg.pricing,
    maxTimeoutSeconds: cfg.maxTimeoutSeconds,
    errorPolicy: cfg.errorPolicy,
    fetcher: deps.facilitatorFetcher,
    // C1: present the per-resource caller-auth token to the facilitator via the gate
    // seam (resolved per request). Undefined in dev -> no auth header is sent.
    facilitatorToken: () => cfg.facilitatorToken,
  });

  const app = new Hono();

  // Conditional gate: FREE paths skip it (discovery never paywalled); everything
  // else runs the gate, which short-circuits 402 / failed verify and otherwise
  // calls next() -> the catch-all proxy below.
  app.use("*", async (c, next) => {
    if (isFreePath(c.req.path, freePaths)) {
      return next();
    }
    return gate(c, next);
  });

  // Catch-all reverse proxy to the gate-less handler container.
  app.all("*", async (c) => proxyToHandler(c, cfg.handlerUrl, handlerFetch));

  return app;
}

/** Read a required env var, failing fast (operator-friendly) when it is absent. */
function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || value.trim().length === 0) {
    // Mirror the echo bootstrap: a clear, actionable message; never the value.
    throw new Error(`set ${name} (required to serve the sidecar gate)`);
  }
  return value.trim();
}

/** Parse a base-units integer env var (USDC base units, decimal string) to bigint. */
function requireBigIntEnv(env: NodeJS.ProcessEnv, name: string): bigint {
  const raw = requireEnv(env, name);
  try {
    return BigInt(raw);
  } catch {
    throw new Error(`${name} must be an integer in USDC base units`);
  }
}

/** Read an optional base-units integer env var, defaulting to "0" when unset. */
function optionalBaseUnitsEnv(env: NodeJS.ProcessEnv, name: string): string {
  const raw = env[name];
  return raw && raw.trim().length > 0 ? raw.trim() : "0";
}

/**
 * Resolve the sidecar config from env, failing fast on any missing required var
 * (mirrors echo's `loadEchoConfig`). The pricing terms map identically to echo:
 *   PRICE_BASE -> base, PRICE_PER_KB -> perKB, PRICE_MAX -> the compute multiplier.
 *
 * CLASSIFIER_SCHEMA (optional): a JSON string of the resource's response schema. When
 * set it is compiled via `buildClassifier`; a malformed schema FAILS FAST (a
 * misconfigured classifier must NOT silently fall back to permissive and start
 * charging declared-errors). When unset, the permissive default applies.
 *
 * NEVER logs a secret/token/config value (the entrypoint logs only the bound port).
 */
export function loadSidecarConfig(env: NodeJS.ProcessEnv = process.env): SidecarConfig {
  const port = Number(env.PORT ?? "8080");
  const facilitatorUrl = requireEnv(env, "FACILITATOR_URL");
  const resourceId = requireEnv(env, "RESOURCE_ID") as Hex;
  const cap = requireBigIntEnv(env, "CAP");
  const handlerUrl = requireEnv(env, "HANDLER_URL");
  const maxTimeoutSeconds = Number(env.MAX_TIMEOUT_SECONDS ?? "30");

  const pricing: Pricing = {
    model: "metered",
    base: optionalBaseUnitsEnv(env, "PRICE_BASE"),
    perKB: optionalBaseUnitsEnv(env, "PRICE_PER_KB"),
    computeMultiplier: optionalBaseUnitsEnv(env, "PRICE_MAX"),
  };

  // Optional per-resource caller-auth token (present in production, absent in dev).
  const tokenRaw = env.SIDECAR_FACILITATOR_TOKEN;
  const facilitatorToken =
    tokenRaw && tokenRaw.trim().length > 0 ? tokenRaw.trim() : undefined;

  // Optional CSV of free path prefixes; default the two discovery/health prefixes.
  const freePathsRaw = env.FREE_PATHS;
  const freePaths =
    freePathsRaw && freePathsRaw.trim().length > 0
      ? freePathsRaw
          .split(",")
          .map((p) => p.trim())
          .filter((p) => p.length > 0)
      : [...DEFAULT_FREE_PATHS];

  // Optional declared schema -> a strict classifier; a malformed schema fails fast.
  const schemaRaw = env.CLASSIFIER_SCHEMA;
  let classifier: ClassifyResponse | undefined;
  if (schemaRaw && schemaRaw.trim().length > 0) {
    try {
      const openapi = JSON.parse(schemaRaw) as Record<string, unknown>;
      classifier = buildClassifier(openapi);
    } catch (err) {
      // A misconfigured classifier must NOT silently go permissive (that would
      // charge declared-errors). Fail fast with a clear, value-free message.
      throw new Error(
        `CLASSIFIER_SCHEMA is not a valid response schema: ${
          err instanceof Error ? err.message : "parse/compile failed"
        }`,
      );
    }
  }

  return {
    facilitatorUrl,
    resourceId,
    cap,
    pricing,
    maxTimeoutSeconds,
    handlerUrl,
    facilitatorToken,
    classifier,
    freePaths,
    port,
  };
}
