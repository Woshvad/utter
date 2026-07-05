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
//     They are matched EXACTLY, not by prefix: a route under a free path is gated, so
//     an adversary handler cannot mint a free-compute route under a free prefix (#3).
//   - the proxy STRIPS x-payment (consumed by the gate) and authorization (never
//     forward a bearer to the untrusted handler) before reaching HANDLER_URL.
//   - the proxy ABORTS the upstream fetch at the gate deadline so a hung handler
//     request is cancelled, not leaked (#4); the abort rejection still propagates so
//     the gate's own `withTimeout(next())` releases "timeout" -> 504, no debit.
//   - the proxy reads the upstream body with a BOUNDED reader (MAX_RESPONSE_BYTES or
//     a hard default) so an adversary handler cannot OOM the sidecar; an oversize body
//     THROWS -> the gate maps it to a malfunction (release + strike -> 502, NEVER a
//     debit) (#5). A body within the cap is returned with the upstream status +
//     headers preserved so the gate's clone-read, classification, and byte-length
//     metering are identical to the in-process path (a declared-error 400 survives).
//     A fetch rejection (handler down) still propagates so the gate maps it to
//     "handler_error" -> 502. Swallowing any of these would regress strike/release.
import { Hono } from "hono";
import type { Context } from "hono";
import type { Hex } from "viem";
import { USDC, PAYMENT_ESCROW } from "@utter/chain";
import { requirePayment, type ErrorPolicy } from "./gate";
import { buildClassifier, type ClassifyResponse } from "./classify";
import type { AcceptsEntry, Pricing } from "./accepts";
import type { FetchLike } from "./idempotency";

/**
 * The default EXACT paths that BYPASS the gate. Discovery (the A2A agent card) and
 * health must never be paywalled or agents cannot find / probe the resource. These
 * are matched EXACTLY (not by prefix): a route UNDER one of these (e.g.
 * `/.well-known/run`, `/health/work`) is gated, so an adversary handler cannot mint a
 * free-compute route by living under a free prefix (review #3). A deployer narrows
 * this further per resource via the FREE_PATHS env (still exact entries).
 */
/** The A2A discovery card path. This is the one free path the trusted sidecar serves ITSELF
 *  (when a card is configured) rather than proxying to the untrusted handler, which has no
 *  card route. Agents and the marketplace publish probe fetch this for discovery. */
export const AGENT_CARD_PATH = "/.well-known/agent-card.json";

export const DEFAULT_FREE_PATHS = [
  AGENT_CARD_PATH,
  "/health",
  "/healthz",
] as const;

/**
 * The hard default cap on a proxied handler response body (bytes). Used by the
 * bounded proxy read when `pricing.maxResponseBytes` is not configured, so an
 * adversary handler can never OOM the sidecar with an unbounded body (review #5).
 */
export const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

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
  /** EXACT paths that bypass the gate; default {@link DEFAULT_FREE_PATHS}. */
  freePaths?: string[];
  /**
   * The resource's A2A agent card as a JSON STRING. When set, the sidecar serves it DIRECTLY
   * at {@link AGENT_CARD_PATH} (GET) instead of proxying that free path to the untrusted
   * handler, which has no card route (so proxying it 404s and discovery + the marketplace
   * publish probe fail). It is public platform metadata (the finalized agent-card.json from the
   * gated bundle), never a secret. Absent (echo/dev) -> the card path proxies as before.
   */
  agentCard?: string;
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

/**
 * True when `path` EXACTLY matches a configured free path (bypass the gate). Only the
 * listed exact paths bypass: a route under a free path (e.g. `/health/work` under
 * `/health`) is NOT free and runs the gate (review #3 - no prefix free-compute).
 */
export function isFreePath(path: string, freePaths: readonly string[]): boolean {
  return freePaths.includes(path);
}

/**
 * Reverse-proxy the current request to the gate-less handler container and return
 * the upstream Response UNCHANGED. This is the ONLY behavioral change versus the
 * in-process `gated.route("/", resourceApp)`: the downstream is a separate container
 * reached over HTTP instead of an in-process Hono route.
 *
 * Buffering the upstream body into a fresh Response with the SAME status + headers
 * preserves it byte-for-byte for the client. That keeps the gate's
 * `c.res.clone().text()`, classification, and `Buffer.byteLength` metering identical
 * to the in-process path (a declared-error HTTP 400 + body survives intact).
 *
 * Two safety bounds are added versus a naive pass-through (reviews #4, #5), neither
 * of which changes the gate's outcome:
 *   - An AbortController aborts the in-flight upstream fetch at the gate deadline
 *     (`maxTimeoutSeconds`) so a hung handler request is CANCELLED, not leaked. The
 *     abort rejects the fetch, which PROPAGATES (never swallowed) exactly like a hung
 *     handler - the gate's own `withTimeout(next())` fires at the same deadline and
 *     releases "timeout" -> 504, no debit. The point is to free the upstream socket.
 *   - The upstream body is read with a BOUNDED reader capped at `maxBytes`. An
 *     oversize body THROWS, which the gate maps to a malfunction (release WITH a
 *     strikeReason -> 502, NEVER a debit) - the same path a non-conforming body takes
 *     - so an adversary handler cannot OOM the sidecar with a huge body. A body
 *     within the cap is returned with the upstream status + headers intact.
 */
async function proxyToHandler(
  c: Context,
  handlerUrl: string,
  handlerFetch: typeof fetch,
  maxTimeoutSeconds: number,
  maxBytes: number,
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

  // Abort the upstream fetch at the gate deadline so a hung handler request is
  // cancelled rather than left holding a socket. The rejection is NOT swallowed: it
  // propagates to the gate like any hung-handler failure (#4).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), maxTimeoutSeconds * 1000);
  try {
    const upstream = await handlerFetch(target, {
      method,
      headers,
      body,
      signal: controller.signal,
    });

    // Read the upstream body with a BOUNDED reader so an adversary handler cannot OOM
    // the sidecar with a huge body. An oversize body THROWS -> the gate classifies it
    // a malfunction (release + strike -> 502, never debit) (#5).
    const buffered = await readBounded(upstream, maxBytes);

    // Preserve the upstream status + headers so a declared-error 400 still surfaces
    // and the gate's clone-read + byte-length metering see the bounded body intact.
    // Copy the bounded Buffer into a fresh Uint8Array before constructing the body: a
    // Node Buffer is typed Uint8Array<ArrayBufferLike>, which DOM's BodyInit rejects,
    // whereas new Uint8Array(buffered) is a concrete Uint8Array<ArrayBuffer> that
    // satisfies BodyInit under both the node and DOM type libs. The copy also detaches
    // from Node's shared Buffer pool, so only the logical bytes are sent. Same bytes.
    return new Response(new Uint8Array(buffered), {
      status: upstream.status,
      headers: upstream.headers,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read a Response body into a Buffer, aborting + THROWING if it exceeds `maxBytes`.
 * The throw flows to the gate's malfunction path (release + 502, never a debit), so
 * an oversize handler response is treated as a broken endpoint, not an OOM. Reads via
 * the Web Streams reader (a built-in - no new dependency); when there is no body
 * stream (e.g. an empty response) it returns an empty Buffer.
 */
async function readBounded(res: Response, maxBytes: number): Promise<Buffer> {
  if (!res.body) {
    return Buffer.alloc(0);
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          // Oversize: stop reading, release the upstream stream, and throw so the
          // gate maps it to a malfunction. Never the body or a byte count is logged.
          throw new Error("handler response exceeds MAX_RESPONSE_BYTES");
        }
        chunks.push(value);
      }
    }
  } finally {
    // Cancel any remaining upstream stream (frees the socket on the oversize throw).
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks, total);
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
  // The bounded proxy read cap: the configured MAX_RESPONSE_BYTES (which also caps the
  // metering size term) or the hard default. Once fix F2 emits MAX_RESPONSE_BYTES from
  // the deployer, the same value reaches the gate's computeMeteredAmount.
  const maxResponseBytes = cfg.pricing.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

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
      // Serve the resource's OWN A2A agent card directly from the trusted sidecar when one is
      // configured: the untrusted handler has no card route, so proxying the free card path to
      // it 404s and agents + the marketplace publish probe cannot discover the resource. Only a
      // GET of the EXACT card path is served here (still a free, never-paywalled path); every
      // other free path (e.g. /health) still bypasses to the proxy below, unchanged. Absent
      // agentCard (echo/dev) -> the card path proxies exactly as before.
      if (cfg.agentCard && c.req.method === "GET" && c.req.path === AGENT_CARD_PATH) {
        return c.body(cfg.agentCard, 200, { "content-type": "application/json" });
      }
      return next();
    }
    return gate(c, next);
  });

  // Catch-all reverse proxy to the gate-less handler container. The proxy aborts the
  // upstream fetch at the gate deadline and reads the body bounded by maxResponseBytes.
  app.all("*", async (c) =>
    proxyToHandler(c, cfg.handlerUrl, handlerFetch, cfg.maxTimeoutSeconds, maxResponseBytes),
  );

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

  // Optional MAX_RESPONSE_BYTES: caps the metering size term AND bounds the proxy
  // read (#5). Only a positive integer is honored; anything else (absent, zero,
  // negative, non-numeric) leaves it undefined so the size term stays uncapped and
  // the proxy read falls back to DEFAULT_MAX_RESPONSE_BYTES. Fix F2 makes the
  // deployer always emit it so the configured cap reaches the gate's metering.
  const maxBytesRaw = env.MAX_RESPONSE_BYTES;
  if (maxBytesRaw && maxBytesRaw.trim().length > 0) {
    const parsed = Number(maxBytesRaw.trim());
    if (Number.isInteger(parsed) && parsed > 0) {
      pricing.maxResponseBytes = parsed;
    }
  }

  // Optional per-resource caller-auth token (present in production, absent in dev).
  const tokenRaw = env.SIDECAR_FACILITATOR_TOKEN;
  const facilitatorToken =
    tokenRaw && tokenRaw.trim().length > 0 ? tokenRaw.trim() : undefined;

  // Optional A2A agent card (JSON string) the sidecar serves at AGENT_CARD_PATH. Validate it
  // parses as JSON so a malformed card fails fast at boot rather than serving garbage the
  // discovery probe would reject; the raw string is kept + served verbatim (byte-preserving).
  // Absent -> the card path proxies to the handler as before.
  const agentCardRaw = env.AGENT_CARD_JSON;
  let agentCard: string | undefined;
  if (agentCardRaw && agentCardRaw.trim().length > 0) {
    try {
      JSON.parse(agentCardRaw);
      agentCard = agentCardRaw;
    } catch {
      throw new Error(
        "AGENT_CARD_JSON is not valid JSON (the served agent card must be a JSON object)",
      );
    }
  }

  // Optional CSV of EXACT free paths (a per-resource override); default the minimal
  // discovery/health set. Each entry is matched exactly, never by prefix (#3).
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
      // buildClassifier discovers the resource-named *Success/*Error component
      // schemas by suffix, so a generated bundle's CLASSIFIER_SCHEMA (e.g.
      // ResourceSuccess/ResourceError) loads without explicit refs.
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
    agentCard,
    port,
  };
}
