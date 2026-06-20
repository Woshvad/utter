// server.ts - the echo demo app: the trusted echoHandler mounted BEHIND the
// `requirePayment` escrow gate (PAY-12, the integrating wave).
//
// This is the resource server in the money path. The gate sits in front of the
// handler and owns the whole payment dance:
//   1. no X-PAYMENT -> 402 with the `accepts` quote (buildAccepts).
//   2. X-PAYMENT present -> POST /verify (RESERVE the cap) BEFORE the handler runs.
//   3. run echoHandler under the timeout.
//   4. classify the body against the echo openapi.json (success | declared_error |
//      malfunction) and settle / release / release+strike accordingly.
//
// For the autonomous E2E the facilitator is `createApp` mounted in-process and the
// gate's `fetcher` is wired to its `request` handler (no live RPC - the chain is
// mocked in the test). For the live run, point `facilitatorUrl` at the standalone
// facilitator (services/facilitator) and drop the injected `fetcher`. Either way the
// gate wiring here is identical - only the transport changes.
import { Hono } from "hono";
import type { Hex } from "viem";
import { USDC, PAYMENT_ESCROW } from "@utter/chain";
import {
  buildClassifier,
  requirePayment,
  type AcceptsEntry,
  type ClassifyResponse,
  type FetchLike,
  type Pricing,
} from "@utter/x402-arc";
import { echoHandler, echoMalfunctionHandler } from "./handler";
import echoOpenapi from "./openapi.json" with { type: "json" };

/** Options for {@link createEchoServer}. */
export interface CreateEchoServerOpts {
  /** The facilitator base URL the gate POSTs /verify /settle /release to. */
  facilitatorUrl: string;
  /** The resource being charged (bytes32) - the escrow `payTo`. */
  resourceId: Hex;
  /** The signed spend cap advertised in the 402 quote (USDC base units). */
  cap: bigint;
  /** The per-resource metered pricing (the escrow charge formula terms). */
  pricing: Pricing;
  /** Max handler runtime before the gate times out (seconds). */
  maxTimeoutSeconds: number;
  /** A `fetch`-like override (the in-process facilitator app in the E2E). */
  fetcher?: FetchLike;
  /**
   * Mount the TEST-ONLY malfunction handler instead of the real echo handler, to
   * drive the malfunction branch (release + strike + NO debit). Default false.
   */
  malfunction?: boolean;
}

/**
 * Build the echo `accepts` entry the gate serves on a 402 (the advertised escrow
 * option). It carries the signed cap, the metered pricing, and the resourceId as
 * `payTo`. The USDC asset + PaymentEscrow are imported from @utter/chain.
 */
export function buildEchoQuote(opts: {
  cap: bigint;
  pricing: Pricing;
  resourceId: Hex;
  maxTimeoutSeconds: number;
}): AcceptsEntry {
  return {
    scheme: "utter-escrow",
    network: "eip155:5042002",
    asset: USDC,
    escrow: PAYMENT_ESCROW,
    maxAmountRequired: opts.cap.toString(),
    payTo: opts.resourceId,
    maxTimeoutSeconds: opts.maxTimeoutSeconds,
    pricing: opts.pricing,
  };
}

/** Build the echo response classifier from the bundled echo openapi.json. */
export function buildEchoClassifier(): ClassifyResponse {
  // Clone the doc - buildClassifier mutates `$id` on the object it is given.
  return buildClassifier({ ...(echoOpenapi as Record<string, unknown>) });
}

/**
 * Build the echo Hono app: the trusted echoHandler mounted behind `requirePayment`.
 * The gate 402-challenges, reserves the cap, runs the handler, classifies the body,
 * and settles (success) / releases (declared error) / releases + strikes
 * (malfunction). This is the PAY-12 money-path demo.
 */
export function createEchoServer(opts: CreateEchoServerOpts): Hono {
  const app = new Hono();
  const classifier = buildEchoClassifier();

  // Mount the escrow gate IN FRONT of the echo route (load-bearing: the handler
  // never runs against unreserved funds - the gate reserves first).
  app.use(
    "/echo",
    requirePayment({
      facilitatorUrl: opts.facilitatorUrl,
      quote: () =>
        buildEchoQuote({
          cap: opts.cap,
          pricing: opts.pricing,
          resourceId: opts.resourceId,
          maxTimeoutSeconds: opts.maxTimeoutSeconds,
        }),
      classifier,
      pricing: opts.pricing,
      maxTimeoutSeconds: opts.maxTimeoutSeconds,
      fetcher: opts.fetcher,
    }),
  );

  // The trusted in-process handler (or the test-only malfunction variant).
  app.post("/echo", (c) =>
    opts.malfunction ? echoMalfunctionHandler(c) : echoHandler(c),
  );

  return app;
}
