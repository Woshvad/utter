// inject.test.ts - the in-process x402 injection (DEP-01).
//
// Proves the deployer wraps an arbitrary resource Hono app in the EXACT Phase 2
// `requirePayment` escrow gate (reuse, never re-implement), configured with THIS
// resource's pricing + escrow/splitter target + facilitator URL, so:
//   1. an unpaid request 402s with this resource's cap (maxAmountRequired), payTo
//      (resourceId), and pricing in the accepts body,
//   2. the injected gate POSTs to the configured facilitatorUrl on a paid attempt
//      (asserted via the injected fetcher - no live chain),
//   3. the gate sits IN FRONT of the handler: the handler never runs unpaid (the
//      402 short-circuits before next()), closing the free-compute vector (T-03-15),
//   4. two resources injected with different pricing/escrow produce DIFFERENT 402
//      quotes (per-resource config, not a global).
//
// AUTONOMOUS + OFFLINE: the unpaid 402 path never touches the facilitator, so no
// chain mock is needed there. The "facilitatorUrl is hit" assertion uses a stub
// fetcher that records the URL (the verify route logic itself is proven by the
// Phase 2 echo-money-path suite; here we assert the INJECTION wiring).
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { Hex } from "viem";
import type { Pricing, FetchLike } from "@utter/x402-arc";
import { injectGate } from "../src/inject-x402";

const RESOURCE_A: Hex = `0x${"a1".repeat(32)}`;
const RESOURCE_B: Hex = `0x${"b2".repeat(32)}`;
const MAX_TIMEOUT_SECONDS = 30;

const PRICING_A: Pricing = {
  model: "metered",
  base: "5000",
  perKB: "100",
  computeMultiplier: "200",
  maxResponseBytes: 1_048_576,
};

const PRICING_B: Pricing = {
  model: "metered",
  base: "9000",
  perKB: "250",
  computeMultiplier: "400",
};

/** A trivial untrusted resource app: a single route that records when it ran. */
function makeResourceApp(onRun: () => void): Hono {
  const app = new Hono();
  app.post("/*", (c) => {
    onRun();
    return c.json({ ok: true });
  });
  return app;
}

/** A stub fetcher that records every URL the gate POSTs to (no real facilitator). */
function recordingFetcher(): { fetcher: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const fetcher: FetchLike = async (input) => {
    urls.push(String(input));
    // The gate calls /verify first; fail verification so the handler never runs and
    // the test stays offline. A 402-on-verify is the gate's documented branch.
    return new Response(JSON.stringify({ valid: false, reason: "stub" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetcher, urls };
}

describe("injectGate (in-process x402 injection, DEP-01)", () => {
  it("402s an unpaid request with THIS resource's cap, payTo, and pricing", async () => {
    let ran = false;
    const resourceApp = makeResourceApp(() => {
      ran = true;
    });
    const app = injectGate(resourceApp, {
      facilitatorUrl: "http://facilitator.test",
      resourceId: RESOURCE_A,
      cap: 12_345n,
      pricing: PRICING_A,
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    });

    const res = await app.request("/anything", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });

    expect(res.status).toBe(402);
    const body = (await res.json()) as {
      x402Version: number;
      accepts: Array<{
        scheme: string;
        maxAmountRequired?: string;
        payTo: string;
        pricing?: Pricing;
      }>;
    };
    expect(body.x402Version).toBe(2);
    const entry = body.accepts[0];
    expect(entry?.scheme).toBe("utter-escrow");
    expect(entry?.maxAmountRequired).toBe("12345");
    expect(entry?.payTo).toBe(RESOURCE_A);
    expect(entry?.pricing).toEqual(PRICING_A);
    // The handler never ran unpaid (free-compute guard, T-03-15).
    expect(ran).toBe(false);
  });

  it("POSTs to the configured facilitatorUrl on a paid attempt (verify reserve)", async () => {
    let ran = false;
    const resourceApp = makeResourceApp(() => {
      ran = true;
    });
    const { fetcher, urls } = recordingFetcher();
    const app = injectGate(resourceApp, {
      facilitatorUrl: "http://facilitator.test",
      resourceId: RESOURCE_A,
      cap: 10_000n,
      pricing: PRICING_A,
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      fetcher,
    });

    // A syntactically-valid (but unverifiable) X-PAYMENT header drives the gate past
    // the decode step to the /verify POST. The stub fetcher fails verification, so
    // the handler still never runs - but the facilitatorUrl WAS hit.
    const header = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        scheme: "utter-escrow",
        network: "eip155:5042002",
        authorization: {
          buyer: `0x${"cd".repeat(20)}`,
          resourceId: RESOURCE_A,
          maxAmount: "10000",
          nonce: `0x${"ef".repeat(32)}`,
          validBefore: String(Math.floor(Date.now() / 1000) + 120),
        },
        signature: `0x${"11".repeat(65)}`,
      }),
      "utf8",
    ).toString("base64");

    const res = await app.request("/anything", {
      method: "POST",
      headers: { "content-type": "application/json", "X-PAYMENT": header },
      body: JSON.stringify({ text: "hi" }),
    });

    // The gate hit the configured facilitator /verify route.
    expect(urls.some((u) => u === "http://facilitator.test/verify")).toBe(true);
    // Verification failed -> 402, handler still never ran (reserve-before-run).
    expect(res.status).toBe(402);
    expect(ran).toBe(false);
  });

  it("two resources injected with different pricing/escrow produce different 402 quotes", async () => {
    const appA = injectGate(makeResourceApp(() => {}), {
      facilitatorUrl: "http://facilitator.test",
      resourceId: RESOURCE_A,
      cap: 10_000n,
      pricing: PRICING_A,
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    });
    const appB = injectGate(makeResourceApp(() => {}), {
      facilitatorUrl: "http://facilitator.test",
      resourceId: RESOURCE_B,
      cap: 99_000n,
      pricing: PRICING_B,
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    });

    const reqInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    };
    const resA = await appA.request("/x", reqInit);
    const resB = await appB.request("/x", reqInit);
    const bodyA = (await resA.json()) as { accepts: Array<{ payTo: string; maxAmountRequired?: string; pricing?: Pricing }> };
    const bodyB = (await resB.json()) as { accepts: Array<{ payTo: string; maxAmountRequired?: string; pricing?: Pricing }> };

    expect(bodyA.accepts[0]?.payTo).toBe(RESOURCE_A);
    expect(bodyB.accepts[0]?.payTo).toBe(RESOURCE_B);
    expect(bodyA.accepts[0]?.maxAmountRequired).toBe("10000");
    expect(bodyB.accepts[0]?.maxAmountRequired).toBe("99000");
    expect(bodyA.accepts[0]?.pricing).toEqual(PRICING_A);
    expect(bodyB.accepts[0]?.pricing).toEqual(PRICING_B);
    // The two quotes are genuinely distinct (per-resource, not a shared global).
    expect(bodyA.accepts[0]?.payTo).not.toBe(bodyB.accepts[0]?.payTo);
  });
});
