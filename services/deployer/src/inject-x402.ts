// inject-x402.ts - in-process x402 injection (DEP-01).
//
// At deploy the deployer wraps a generated resource's Hono app in the EXACT Phase 2
// `requirePayment` escrow gate (@utter/x402-arc) - it NEVER re-implements the gate.
// The gate is configured with THIS resource's pricing + escrow/splitter target
// (resourceId as the escrow `payTo`) + the facilitator URL, so the deployed
// resource 402-challenges, reserves the cap at the facilitator BEFORE the handler
// runs (the free-compute hard rule, CLAUDE.md §19 / T-03-15), then settles or
// releases per the classifier - identical semantics to the Phase 2 echo demo.
//
// In-process is the DEFAULT (CONTEXT "## Deploy Plane" / SPEC §9.3: in-process or
// sidecar). A sidecar variant mounts the same `requirePayment` middleware in a
// standalone proxy in front of the resource container; the gate config is identical,
// only the transport differs. We ship the in-process injection here.
//
// The 402 quote is built per-resource (this resource's cap/payTo/pricing) the same
// way the echo demo's `buildEchoQuote` does - it carries the signed cap as
// `maxAmountRequired`, the resourceId as `payTo`, and the metered `pricing`, with
// the USDC asset + PaymentEscrow imported from @utter/chain (never re-literal'd).
import { Hono } from "hono";
import type { Hex } from "viem";
import { USDC, PAYMENT_ESCROW } from "@utter/chain";
import {
  requirePayment,
  type AcceptsEntry,
  type ClassifyResponse,
  type ErrorPolicy,
  type FetchLike,
  type Pricing,
} from "@utter/x402-arc";

/** Per-resource configuration for the injected escrow gate. */
export interface InjectGateConfig {
  /** The facilitator base URL the gate POSTs /verify /settle /release to. */
  facilitatorUrl: string;
  /** The resource being charged (bytes32 Hex) - the escrow `payTo` / splitter target. */
  resourceId: Hex;
  /** The signed spend cap advertised in the 402 quote (USDC base units, bigint). */
  cap: bigint;
  /** This resource's metered pricing (the escrow charge formula terms). */
  pricing: Pricing;
  /** Max handler runtime before the gate times out (seconds). */
  maxTimeoutSeconds: number;
  /**
   * The response classifier (normally built from the resource's openapi.json via
   * `buildClassifier`). Defaults to a permissive classifier that treats any
   * non-empty parseable body as a success - a resource WITHOUT a declared schema
   * still pays on a real response and never wrongly strikes its creator.
   */
  classifier?: ClassifyResponse;
  /** Declared-error policy (default `free` - no charge, no strike). */
  errorPolicy?: ErrorPolicy;
  /** A `fetch`-like override (tests inject an in-process facilitator / stub). */
  fetcher?: FetchLike;
  /**
   * The route pattern the gate mounts on. Defaults to `*` (the whole resource app
   * is paywalled). A resource that exposes a free health route can narrow this.
   */
  route?: string;
}

/**
 * The default classifier for a resource with no declared openapi schema: any
 * non-empty, parseable body is a `success` (chargeable); an empty/unparseable body
 * is a `malfunction` (release + strike, never debit). This mirrors the Phase 2
 * success/malfunction split without assuming a declared-error schema, so an
 * un-annotated resource still pays on a genuine response and a broken/empty one
 * never charges the buyer.
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

/**
 * Build the per-resource 402 `accepts` entry (the advertised escrow option) the
 * gate serves on a challenge. Carries THIS resource's signed cap, metered pricing,
 * and resourceId as `payTo`; USDC + PaymentEscrow come from @utter/chain. Same shape
 * the echo demo's `buildEchoQuote` produces - per-resource, never a shared global.
 */
export function buildResourceQuote(cfg: InjectGateConfig): AcceptsEntry {
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
 * Inject the Phase 2 `requirePayment` escrow gate IN FRONT of a resource's Hono
 * app (in-process x402 injection, DEP-01). Returns a NEW gated app that mounts the
 * escrow middleware first and then routes everything to the untrusted resource app.
 *
 * The wrapper is load-bearing: Hono runs middleware/handlers in REGISTRATION order,
 * so the only way to guarantee the gate sits in front of an already-built resource
 * app is to register the gate on a fresh app BEFORE mounting the resource under it.
 * After this call an unpaid request 402-challenges with this resource's
 * cap/payTo/pricing, and a paid request reserves the cap at `facilitatorUrl` BEFORE
 * the resource handler runs (the free-compute guard, T-03-15). The gate is the
 * Phase 2 middleware verbatim - this function only supplies the per-resource config
 * (it NEVER re-implements the payment dance).
 */
export function injectGate(resourceApp: Hono, cfg: InjectGateConfig): Hono {
  const classifier = cfg.classifier ?? permissiveClassifier;
  const gated = new Hono();
  // Register the gate FIRST so it short-circuits on 402 / failed verification - the
  // untrusted resource handler never runs against unreserved funds.
  gated.use(
    cfg.route ?? "*",
    requirePayment({
      facilitatorUrl: cfg.facilitatorUrl,
      quote: () => buildResourceQuote(cfg),
      classifier,
      pricing: cfg.pricing,
      maxTimeoutSeconds: cfg.maxTimeoutSeconds,
      errorPolicy: cfg.errorPolicy,
      fetcher: cfg.fetcher,
    }),
  );
  // Mount the untrusted resource app behind the gate.
  gated.route("/", resourceApp);
  return gated;
}
