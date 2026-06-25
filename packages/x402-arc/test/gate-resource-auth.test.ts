// gate-resource-auth suite (Security review C1): the gate presents the optional
// per-resource caller-auth token on its facilitator fetches, and is fully
// backward-compatible when no token is configured.
//
//   With `facilitatorToken` -> /verify, /settle, /release carry
//     `Authorization: Bearer <token>`.
//   Without it -> NO Authorization header is sent (existing callers unaffected).
//
// Fully offline: a stub fetcher captures the headers on each facilitator call and
// returns canned success JSON, so no chain/relayer/network is exercised. The gate's
// money-path ordering is covered by the existing gate-success suite; this isolates
// the header behavior.
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { Address, Hex } from "viem";
import { PAYMENT_ESCROW, USDC } from "@utter/chain";
import {
  requirePayment,
  encodePayment,
  type AcceptsEntry,
  type PaymentPayload,
  type Pricing,
  type FetchLike,
} from "../src/index";

const RESOURCE: Hex = `0x${"44".repeat(32)}`;
const BUYER = "0x00000000000000000000000000000000000000aa" as Address;
const MAX_TIMEOUT_SECONDS = 30;
const PRICING: Pricing = {
  model: "metered",
  base: "5000",
  perKB: "100",
  computeMultiplier: "200",
  maxResponseBytes: 1_048_576,
};

/** Record the Authorization header seen on each facilitator path. */
interface Captured {
  authByPath: Record<string, string | undefined>;
}

/** A stub fetcher that records the auth header per facilitator path + returns success. */
function capturingFetcher(captured: Captured): FetchLike {
  return async (input, init) => {
    const path = input.includes("/verify")
      ? "verify"
      : input.includes("/settle")
        ? "settle"
        : input.includes("/release")
          ? "release"
          : "other";
    captured.authByPath[path] = init?.headers?.["Authorization"];
    if (path === "verify") {
      return { status: 200, json: async () => ({ valid: true }) };
    }
    if (path === "settle") {
      return {
        status: 200,
        json: async () => ({ success: true, receipt: { idemKey: "x", amount: "1" } }),
      };
    }
    // release + anything else
    return { status: 200, json: async () => ({ released: true }) };
  };
}

/** A minimal unsigned escrow payload (the gate only decodes shape for these tests). */
function paymentHeader(nonce: Hex): string {
  const payload: PaymentPayload = {
    x402Version: 2,
    scheme: "utter-escrow",
    network: "eip155:5042002",
    authorization: {
      buyer: BUYER,
      resourceId: RESOURCE,
      maxAmount: "10000",
      nonce,
      validBefore: String(Math.floor(Date.now() / 1000) + 3600),
    },
    signature: `0x${"00".repeat(65)}`,
  };
  return encodePayment(payload);
}

function quote(): AcceptsEntry {
  return {
    scheme: "utter-escrow",
    network: "eip155:5042002",
    asset: USDC,
    escrow: PAYMENT_ESCROW,
    maxAmountRequired: "10000",
    payTo: RESOURCE,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    pricing: PRICING,
  };
}

/** Mount the gate over an echo handler that returns a success-classified body. */
function makeApp(opts: { fetcher: FetchLike; facilitatorToken?: string }): Hono {
  const app = new Hono();
  app.use(
    "/echo",
    requirePayment({
      facilitatorUrl: "http://facilitator.test",
      quote,
      // A trivial classifier: always success (so the settle path is exercised).
      classifier: () => "success",
      pricing: PRICING,
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      fetcher: opts.fetcher,
      facilitatorToken: opts.facilitatorToken,
    }),
  );
  app.post("/echo", (c) =>
    c.body(JSON.stringify({ echo: "hi", length: 2 }), 200, {
      "content-type": "application/json",
    }),
  );
  return app;
}

describe("gate per-resource caller-auth header", () => {
  it("sends Authorization: Bearer <token> on /verify and /settle when configured", async () => {
    const captured: Captured = { authByPath: {} };
    const app = makeApp({ fetcher: capturingFetcher(captured), facilitatorToken: "tok-abc" });
    const res = await app.request("/echo", {
      method: "POST",
      headers: { "X-PAYMENT": paymentHeader(`0x${"c1".repeat(32)}`) },
    });
    expect(res.status).toBe(200);
    expect(captured.authByPath.verify).toBe("Bearer tok-abc");
    expect(captured.authByPath.settle).toBe("Bearer tok-abc");
  });

  it("resolves a () => string token provider per request", async () => {
    const captured: Captured = { authByPath: {} };
    const app = makeApp({
      fetcher: capturingFetcher(captured),
      facilitatorToken: undefined,
    });
    // Re-mount with a provider.
    const app2 = new Hono();
    app2.use(
      "/echo",
      requirePayment({
        facilitatorUrl: "http://facilitator.test",
        quote,
        classifier: () => "success",
        pricing: PRICING,
        maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
        fetcher: capturingFetcher(captured),
        facilitatorToken: () => "tok-from-provider",
      }),
    );
    app2.post("/echo", (c) =>
      c.body(JSON.stringify({ echo: "hi", length: 2 }), 200, {
        "content-type": "application/json",
      }),
    );
    void app;
    const res = await app2.request("/echo", {
      method: "POST",
      headers: { "X-PAYMENT": paymentHeader(`0x${"c2".repeat(32)}`) },
    });
    expect(res.status).toBe(200);
    expect(captured.authByPath.verify).toBe("Bearer tok-from-provider");
  });

  it("sends NO Authorization header when no token is configured (backward-compatible)", async () => {
    const captured: Captured = { authByPath: {} };
    const app = makeApp({ fetcher: capturingFetcher(captured) });
    const res = await app.request("/echo", {
      method: "POST",
      headers: { "X-PAYMENT": paymentHeader(`0x${"c3".repeat(32)}`) },
    });
    expect(res.status).toBe(200);
    expect(captured.authByPath.verify).toBeUndefined();
    expect(captured.authByPath.settle).toBeUndefined();
  });
});
