// handler-main.ts - the container entrypoint for the GATE-LESS echo HANDLER in the
// sidecar topology (Security review C1, wave BC1).
//
// This is what `node server.js` runs inside the UNTRUSTED handler image (the deployer
// bundles this file into a single self-contained server.js). It mounts the trusted
// echoHandler on /echo and /call with NO payment gate (the gate now lives in the
// separate trusted SIDECAR container, src/sidecar.ts) and serves a discoverable A2A
// agent card so agents can find the resource.
//
// SECURITY: unlike examples/echo/main.ts (the in-process single-container path that
// keeps its gate), this handler container holds NO facilitator config and NO
// caller-auth token. It reads only NON-secret discovery config (port, resourceId,
// cap, public pricing terms, timeout) - the values served in the agent card. It can
// never reach the facilitator, forge a strike, or self-settle: the sidecar owns the
// whole payment dance and reverse-proxies validated calls here. It NEVER logs a
// config value beyond the bound port.
//
// This is an ADDITIVE sibling entrypoint: examples/echo/main.ts (in-process gate)
// stays UNCHANGED for the Phase 1 trusted single-container path.
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Hex } from "viem";
import { USDC, PAYMENT_ESCROW } from "@utter/chain";
import type { Pricing } from "@utter/x402-arc";
import { echoHandler } from "./handler";

/** Read a required env var, failing fast (operator-friendly) when it is absent. */
function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || value.trim().length === 0) {
    // Mirror the echo bootstrap: a clear, actionable message; never the value.
    throw new Error(`set ${name} (required to serve the gate-less echo handler)`);
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
 * The NON-SECRET discovery config the gate-less handler reads from env. It carries
 * only the public values served in the agent card. It holds NO facilitatorUrl and
 * NO caller-auth token - the untrusted handler must never see facilitator config.
 */
export interface HandlerConfig {
  /** The port the server listens on (default 8080). */
  port: number;
  /** The resource being served (bytes32 Hex) - the card's x402.payTo. */
  resourceId: Hex;
  /** The signed spend cap advertised in the card's escrow block (USDC base units). */
  cap: bigint;
  /** The per-resource metered pricing advertised in the card. */
  pricing: Pricing;
  /** Max handler runtime the card advertises (seconds, default 30). */
  maxTimeoutSeconds: number;
}

/**
 * Resolve the gate-less handler config from env, failing fast on any missing required
 * var (mirrors echo's loadEchoConfig). It reads ONLY non-secret discovery values:
 *   PORT, RESOURCE_ID, CAP, PRICE_BASE/PRICE_PER_KB/PRICE_MAX, MAX_TIMEOUT_SECONDS.
 *
 * It deliberately reads NO FACILITATOR_URL and NO token: the handler holds no
 * facilitator config and no secret (the sidecar owns payment). RESOURCE_ID / CAP /
 * PRICE_* are public discovery values served in the card, already in the runner's
 * SERVICE_ENV_ALLOWLIST.
 */
export function loadHandlerConfig(env: NodeJS.ProcessEnv = process.env): HandlerConfig {
  const port = Number(env.PORT ?? "8080");
  const resourceId = requireEnv(env, "RESOURCE_ID") as Hex;
  const cap = requireBigIntEnv(env, "CAP");
  const maxTimeoutSeconds = Number(env.MAX_TIMEOUT_SECONDS ?? "30");

  const pricing: Pricing = {
    model: "metered",
    base: optionalBaseUnitsEnv(env, "PRICE_BASE"),
    perKB: optionalBaseUnitsEnv(env, "PRICE_PER_KB"),
    computeMultiplier: optionalBaseUnitsEnv(env, "PRICE_MAX"),
  };

  return { port, resourceId, cap, pricing, maxTimeoutSeconds };
}

/**
 * Build the discovery agent card from the NON-SECRET handler config. Identical shape
 * to echo's buildEchoAgentCard (which reads only resourceId/cap/pricing/timeout, never
 * facilitatorUrl) - the card advertises the deploy-final payTo + escrow pricing block.
 * asset/escrow come from @utter/chain (never re-literal'd).
 */
export function buildHandlerAgentCard(cfg: HandlerConfig): Record<string, unknown> {
  return {
    protocolVersion: "0.3.0",
    name: "echo",
    description: "Echo the input string back with its length.",
    version: "1.0.0",
    capabilities: { streaming: false },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      {
        id: "echo",
        name: "echo",
        description: "Echo the input string back with its length.",
        tags: ["utter", "x402"],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
    ],
    x402: {
      scheme: "utter-escrow",
      network: "eip155:5042002",
      chainId: 5042002,
      asset: USDC,
      escrow: PAYMENT_ESCROW,
      pricing: cfg.pricing,
      payTo: cfg.resourceId,
      maxAmountRequired: cfg.cap.toString(),
      maxTimeoutSeconds: cfg.maxTimeoutSeconds,
    },
    cache: { ttlSeconds: 30 },
  };
}

/**
 * Build the gate-less handler Hono app: the trusted echoHandler mounted on BOTH /echo
 * and /call with NO payment gate, plus the discoverable agent card. The sidecar owns
 * the gate and reverse-proxies validated calls here, so this app charges nothing and
 * reaches no facilitator. A plain POST runs the handler directly (no 402).
 */
export function buildHandlerApp(cfg: HandlerConfig): Hono {
  const app = new Hono();

  // No gate: the sidecar reserves/settles before proxying here. The handler shapes a
  // schema-valid response and never touches money (mirrors echo's route surface).
  app.post("/echo", (c) => echoHandler(c));
  app.post("/call", (c) => echoHandler(c));

  // Discoverable A2A card (free; agents resolve the resource's cardUrl from this).
  app.get("/.well-known/agent-card.json", (c) => c.json(buildHandlerAgentCard(cfg)));

  return app;
}

/** Boot the gate-less handler server on the configured port. */
export function start(): void {
  const cfg = loadHandlerConfig();
  const app = buildHandlerApp(cfg);
  // Log only the bound port - never a config value (and there is no secret to leak).
  console.log(`echo handler (gate-less) listening on :${cfg.port}`);
  serve({ fetch: app.fetch, port: cfg.port });
}

/**
 * Boot ONLY when this file is the executed entrypoint, NOT when a test imports the
 * factory. The deployer esbuilds this file to a CJS server.js where `require.main` is
 * this module; under the ESM/tsx test runner `require` is undefined, so importing
 * buildHandlerApp/loadHandlerConfig never boots a server. (echo's main.ts boots
 * unconditionally because its tests import from server.ts, not main.ts.)
 */
declare const require: NodeRequire | undefined;
declare const module: NodeModule | undefined;
if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  start();
}
