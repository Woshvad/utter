// main.ts - the container entrypoint for the DEPLOYED echo resource.
//
// This is what `node server.js` runs inside the sandboxed image (the deployer
// bundles this file into a single self-contained server.js). It reads its config
// from env, mounts the trusted echoHandler BEHIND the `requirePayment` escrow gate
// on both /echo and /call, serves a discoverable A2A agent card, and listens via
// @hono/node-server.
//
// SECURITY: this entrypoint reads only NON-secret operational config from env
// (facilitator URL, resourceId, cap, pricing terms). It holds no wallet key and
// reaches no chain directly - the gate owns reservation/settle against the
// facilitator. It NEVER logs a config value beyond the bound port. The handler
// runs SOLELY against reserved funds (the gate reserves the cap before next()).
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Hex } from "viem";
import { USDC, PAYMENT_ESCROW } from "@utter/chain";
import { requirePayment, type Pricing } from "@utter/x402-arc";
import { echoHandler } from "./handler";
import { buildEchoQuote, buildEchoClassifier } from "./server";

/** Read a required env var, failing fast (operator-friendly) when it is absent. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    // Mirror the facilitator bootstrap: a clear, actionable message; never the value.
    throw new Error(`set ${name} (required to serve the echo resource)`);
  }
  return value.trim();
}

/** Parse a base-units integer env var (USDC base units, decimal string) to bigint. */
function requireBigIntEnv(name: string): bigint {
  const raw = requireEnv(name);
  try {
    return BigInt(raw);
  } catch {
    throw new Error(`${name} must be an integer in USDC base units`);
  }
}

/** Read an optional base-units integer env var, defaulting to "0" when unset. */
function optionalBaseUnitsEnv(name: string): string {
  const raw = process.env[name];
  return raw && raw.trim().length > 0 ? raw.trim() : "0";
}

/** The fully-resolved echo config read from the environment. */
export interface EchoConfig {
  /** The port the server listens on (default 8080). */
  port: number;
  /** The facilitator base URL the gate POSTs verify/settle/release to. */
  facilitatorUrl: string;
  /** The resource being charged (bytes32 Hex) - the escrow payTo. */
  resourceId: Hex;
  /** The signed spend cap advertised in the 402 quote (USDC base units). */
  cap: bigint;
  /** The per-resource metered pricing (the escrow charge formula terms). */
  pricing: Pricing;
  /** Max handler runtime before the gate times out (seconds, default 30). */
  maxTimeoutSeconds: number;
}

/**
 * Resolve the echo config from env, failing fast on any missing required var. The
 * pricing terms map to the metered Pricing the gate charges against:
 *   PRICE_BASE -> base, PRICE_PER_KB -> perKB, PRICE_MAX -> the compute multiplier.
 * Optional terms default to "0" (free that term), so a minimal flat config works.
 */
export function loadEchoConfig(): EchoConfig {
  const port = Number(process.env.PORT ?? "8080");
  const facilitatorUrl = requireEnv("FACILITATOR_URL");
  const resourceId = requireEnv("RESOURCE_ID") as Hex;
  const cap = requireBigIntEnv("CAP");
  const maxTimeoutSeconds = Number(process.env.MAX_TIMEOUT_SECONDS ?? "30");

  const pricing: Pricing = {
    model: "metered",
    base: optionalBaseUnitsEnv("PRICE_BASE"),
    perKB: optionalBaseUnitsEnv("PRICE_PER_KB"),
    computeMultiplier: optionalBaseUnitsEnv("PRICE_MAX"),
  };

  return { port, facilitatorUrl, resourceId, cap, pricing, maxTimeoutSeconds };
}

/**
 * Build a minimal A2A agent card for the deployed echo carrying the REAL deploy-time
 * payTo (the resourceId) and the x402 escrow pricing block. We emit it directly here
 * (rather than ai-runtime's buildAgentCard, whose payTo is a pre-deploy placeholder)
 * so the served card is the deploy-final, discoverable shape. asset/escrow come from
 * @utter/chain (never re-literal'd).
 */
export function buildEchoAgentCard(cfg: EchoConfig): Record<string, unknown> {
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
 * Build the deployed echo Hono app: the trusted echoHandler mounted behind the
 * escrow gate on BOTH /echo (the live-deploy proof curls this) AND /call (the
 * studio POSTs this), plus a discoverable agent card. The gate reserves the cap
 * before the handler runs (the free-compute hard rule), classifies the response,
 * and settles / releases accordingly. The gate wiring matches createEchoServer;
 * only the route surface (adding /call) and the card differ.
 */
export function buildEchoApp(cfg: EchoConfig): Hono {
  const app = new Hono();
  const classifier = buildEchoClassifier();

  const gate = () =>
    requirePayment({
      facilitatorUrl: cfg.facilitatorUrl,
      quote: () =>
        buildEchoQuote({
          cap: cfg.cap,
          pricing: cfg.pricing,
          resourceId: cfg.resourceId,
          maxTimeoutSeconds: cfg.maxTimeoutSeconds,
        }),
      classifier,
      pricing: cfg.pricing,
      maxTimeoutSeconds: cfg.maxTimeoutSeconds,
    });

  // Mount the escrow gate IN FRONT of both echo routes (load-bearing: the handler
  // never runs against unreserved funds - the gate reserves first).
  app.use("/echo", gate());
  app.post("/echo", (c) => echoHandler(c));
  app.use("/call", gate());
  app.post("/call", (c) => echoHandler(c));

  // Discoverable A2A card (the studio resolves the resource's cardUrl from this).
  app.get("/.well-known/agent-card.json", (c) => c.json(buildEchoAgentCard(cfg)));

  return app;
}

/** Boot the deployed echo server on the configured port. */
export function start(): void {
  const cfg = loadEchoConfig();
  const app = buildEchoApp(cfg);
  // Log only the bound port - never a config value.
  console.log(`echo resource listening on :${cfg.port}`);
  serve({ fetch: app.fetch, port: cfg.port });
}

start();
