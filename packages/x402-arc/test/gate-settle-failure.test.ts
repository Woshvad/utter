// gate settle-failure + priced declared-error suite (CR-01, CR-02, CR-03).
//
// These prove the gate FAILS CLOSED on the settle seam and never over-charges a
// declared error:
//   CR-01 - a non-200 /settle (or success:false / missing receipt) must NOT serve
//           the paid body with a 200 + receipt header: the gate returns 502 and
//           releases the reservation (no free-compute leak, no silent no-charge).
//   CR-02 - a THROWN /settle (network drop) must release the reservation too (no
//           dangling lock) and return 502.
//   CR-03 - a PRICED declared error charges min(errorPrice, cap), NEVER the full
//           cap; with no errorPrice it is free (release, zero debit).
//
// Fully offline: the gate's `fetcher` is a hand-rolled stub that records the
// /verify, /settle, and /release calls so we can assert the exact branch taken
// without a live facilitator or chain.
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  createWalletClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { USDC, PAYMENT_ESCROW, arcTestnet } from "@utter/chain";
import {
  buildClassifier,
  signDebitAuthorization,
  encodePayment,
  requirePayment,
  type Pricing,
  type AcceptsEntry,
  type PaymentPayload,
  type FetchLike,
} from "@utter/x402-arc";
import echoOpenapi from "../examples/echo/openapi.json" with { type: "json" };

const RESOURCE: Hex = `0x${"77".repeat(32)}`;
const MAX_TIMEOUT_SECONDS = 30;
const SETTLE_BUFFER_SECONDS = 90;

const BASE_PRICING: Pricing = {
  model: "metered",
  base: "5000",
  perKB: "100",
  computeMultiplier: "200",
  maxResponseBytes: 1_048_576,
};

interface RecordedCall {
  url: string;
  body: Record<string, unknown>;
}

/**
 * A stub facilitator fetcher. /verify always reserves; /settle and /release are
 * driven by the injected handlers so a test can force a failure mode. Every call
 * is recorded for assertions.
 */
function stubFetcher(opts: {
  settle: (body: Record<string, unknown>) => Promise<Response>;
  calls: RecordedCall[];
}): FetchLike {
  return async (input, init) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    opts.calls.push({ url, body });
    if (url.includes("/verify")) {
      return new Response(JSON.stringify({ valid: true, payer: "0x0" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/release")) {
      return new Response(JSON.stringify({ released: true, struck: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/settle")) {
      return opts.settle(body);
    }
    return new Response("{}", { status: 404 });
  };
}

function makeSigner(pk: Hex) {
  const account = privateKeyToAccount(pk);
  const wallet = createWalletClient({
    account,
    chain: arcTestnet,
    transport: http(arcTestnet.rpcUrls.default.http[0]),
  });
  return { account, wallet };
}

async function signedHeader(opts: { pk: Hex; buyer: Address; cap: bigint; nonce: Hex }): Promise<string> {
  const { wallet } = makeSigner(opts.pk);
  const validBefore = BigInt(
    Math.floor(Date.now() / 1000) + MAX_TIMEOUT_SECONDS + SETTLE_BUFFER_SECONDS,
  );
  const signed = await signDebitAuthorization(wallet, {
    buyer: opts.buyer,
    resourceId: RESOURCE,
    maxAmount: opts.cap,
    nonce: opts.nonce,
    validBefore,
  });
  const payload: PaymentPayload = {
    x402Version: 2,
    scheme: "utter-escrow",
    network: "eip155:5042002",
    authorization: {
      buyer: opts.buyer,
      resourceId: RESOURCE,
      maxAmount: opts.cap.toString(),
      nonce: opts.nonce,
      validBefore: validBefore.toString(),
    },
    signature: signed.signature,
  };
  return encodePayment(payload);
}

function quote(cap: bigint): AcceptsEntry {
  return {
    scheme: "utter-escrow",
    network: "eip155:5042002",
    asset: USDC,
    escrow: PAYMENT_ESCROW,
    maxAmountRequired: cap.toString(),
    payTo: RESOURCE,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    pricing: BASE_PRICING,
  };
}

function makeGatedApp(opts: {
  cap: bigint;
  fetcher: FetchLike;
  handlerBody: string;
  pricing?: Pricing;
  errorPolicy?: "free" | "priced";
}): Hono {
  const classifier = buildClassifier({ ...(echoOpenapi as Record<string, unknown>) });
  const app = new Hono();
  app.use(
    "/echo",
    requirePayment({
      facilitatorUrl: "http://facilitator.test",
      quote: () => quote(opts.cap),
      classifier,
      pricing: opts.pricing ?? BASE_PRICING,
      errorPolicy: opts.errorPolicy,
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      fetcher: opts.fetcher,
    }),
  );
  app.post("/echo", (c) =>
    c.body(opts.handlerBody, 200, { "content-type": "application/json" }),
  );
  return app;
}

function successBody(): string {
  return JSON.stringify({ echo: "hello", length: 5 });
}

function declaredErrorBody(): string {
  return JSON.stringify({ error: "text must be a string", code: "BAD_INPUT" });
}

describe("gate settle-failure + priced declared-error", () => {
  // CR-01: a non-200 /settle must fail closed (502 + release), not serve the body.
  it("CR-01: non-200 /settle returns 502, releases, and sets NO receipt header", async () => {
    const calls: RecordedCall[] = [];
    const fetcher = stubFetcher({
      calls,
      settle: async () =>
        new Response(JSON.stringify({ success: false, reason: "relayer_oog" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    });
    const pk = generatePrivateKey();
    const buyer = privateKeyToAccount(pk).address;
    const app = makeGatedApp({ cap: 10_000n, fetcher, handlerBody: successBody() });
    const header = await signedHeader({ pk, buyer, cap: 10_000n, nonce: `0x${"e1".repeat(32)}` });
    const res = await app.request("/echo", { method: "POST", headers: { "X-PAYMENT": header } });

    expect(res.status).toBe(502);
    expect(res.headers.get("X-PAYMENT-RESPONSE")).toBeNull();
    const releaseCall = calls.find((c) => c.url.includes("/release"));
    expect(releaseCall).toBeDefined();
    expect(releaseCall!.body.strikeReason).toBe("settle_failed");
  });

  // CR-01: a 200 with success:false or no receipt is also a failure.
  it("CR-01: 200 /settle with success:false fails closed (502 + release)", async () => {
    const calls: RecordedCall[] = [];
    const fetcher = stubFetcher({
      calls,
      settle: async () =>
        new Response(JSON.stringify({ success: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const pk = generatePrivateKey();
    const buyer = privateKeyToAccount(pk).address;
    const app = makeGatedApp({ cap: 10_000n, fetcher, handlerBody: successBody() });
    const header = await signedHeader({ pk, buyer, cap: 10_000n, nonce: `0x${"e2".repeat(32)}` });
    const res = await app.request("/echo", { method: "POST", headers: { "X-PAYMENT": header } });

    expect(res.status).toBe(502);
    expect(res.headers.get("X-PAYMENT-RESPONSE")).toBeNull();
    expect(calls.some((c) => c.url.includes("/release"))).toBe(true);
  });

  // CR-02: a THROWN /settle (network drop) must release and 502, never dangle.
  it("CR-02: a thrown /settle releases the reservation and returns 502", async () => {
    const calls: RecordedCall[] = [];
    const fetcher = stubFetcher({
      calls,
      settle: async () => {
        throw new Error("network drop to facilitator");
      },
    });
    const pk = generatePrivateKey();
    const buyer = privateKeyToAccount(pk).address;
    const app = makeGatedApp({ cap: 10_000n, fetcher, handlerBody: successBody() });
    const header = await signedHeader({ pk, buyer, cap: 10_000n, nonce: `0x${"e3".repeat(32)}` });
    const res = await app.request("/echo", { method: "POST", headers: { "X-PAYMENT": header } });

    expect(res.status).toBe(502);
    expect(res.headers.get("X-PAYMENT-RESPONSE")).toBeNull();
    const releaseCall = calls.find((c) => c.url.includes("/release"));
    expect(releaseCall).toBeDefined();
    expect(releaseCall!.body.strikeReason).toBe("settle_failed");
  });

  // Positive control: a genuine 200 + receipt serves the body with the receipt header.
  it("a successful /settle serves the body with the receipt header", async () => {
    const calls: RecordedCall[] = [];
    const fetcher = stubFetcher({
      calls,
      settle: async (body) =>
        new Response(
          JSON.stringify({
            success: true,
            receipt: { tx: `0x${"00".repeat(32)}`, amount: String(body.amount), idemKey: body.idemKey },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    const pk = generatePrivateKey();
    const buyer = privateKeyToAccount(pk).address;
    const app = makeGatedApp({ cap: 10_000n, fetcher, handlerBody: successBody() });
    const header = await signedHeader({ pk, buyer, cap: 10_000n, nonce: `0x${"e4".repeat(32)}` });
    const res = await app.request("/echo", { method: "POST", headers: { "X-PAYMENT": header } });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-PAYMENT-RESPONSE")).toBeTruthy();
    expect(await res.text()).toBe(successBody());
    expect(calls.some((c) => c.url.includes("/release"))).toBe(false);
  });

  // CR-03: a PRICED declared error charges min(errorPrice, cap), NEVER the cap.
  it("CR-03: priced declared error settles min(errorPrice, cap), not the cap", async () => {
    const calls: RecordedCall[] = [];
    let settledAmount: string | undefined;
    const fetcher = stubFetcher({
      calls,
      settle: async (body) => {
        settledAmount = String(body.amount);
        return new Response(
          JSON.stringify({ success: true, receipt: { amount: String(body.amount), idemKey: body.idemKey } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const pk = generatePrivateKey();
    const buyer = privateKeyToAccount(pk).address;
    const cap = 10_000n;
    const pricing: Pricing = { ...BASE_PRICING, errorPrice: "750" };
    const app = makeGatedApp({
      cap,
      fetcher,
      handlerBody: declaredErrorBody(),
      pricing,
      errorPolicy: "priced",
    });
    const header = await signedHeader({ pk, buyer, cap, nonce: `0x${"e5".repeat(32)}` });
    const res = await app.request("/echo", { method: "POST", headers: { "X-PAYMENT": header } });

    expect(res.status).toBe(200);
    // The error price (750) is charged, NOT the full cap (10000).
    expect(settledAmount).toBe("750");
  });

  // CR-03: an errorPrice ABOVE the cap is clamped to the cap (never exceeds it).
  it("CR-03: priced declared error clamps errorPrice to cap", async () => {
    const calls: RecordedCall[] = [];
    let settledAmount: string | undefined;
    const fetcher = stubFetcher({
      calls,
      settle: async (body) => {
        settledAmount = String(body.amount);
        return new Response(
          JSON.stringify({ success: true, receipt: { amount: String(body.amount), idemKey: body.idemKey } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const pk = generatePrivateKey();
    const buyer = privateKeyToAccount(pk).address;
    const cap = 500n;
    const pricing: Pricing = { ...BASE_PRICING, errorPrice: "9999" };
    const app = makeGatedApp({
      cap,
      fetcher,
      handlerBody: declaredErrorBody(),
      pricing,
      errorPolicy: "priced",
    });
    const header = await signedHeader({ pk, buyer, cap, nonce: `0x${"e6".repeat(32)}` });
    const res = await app.request("/echo", { method: "POST", headers: { "X-PAYMENT": header } });

    expect(res.status).toBe(200);
    expect(settledAmount).toBe("500"); // clamped to cap, never 9999
  });

  // CR-03: a priced policy with NO errorPrice is free (release, no settle).
  it("CR-03: priced declared error with no errorPrice releases (no debit)", async () => {
    const calls: RecordedCall[] = [];
    const fetcher = stubFetcher({
      calls,
      settle: async () => {
        throw new Error("settle should not be called for a free priced error");
      },
    });
    const pk = generatePrivateKey();
    const buyer = privateKeyToAccount(pk).address;
    const app = makeGatedApp({
      cap: 10_000n,
      fetcher,
      handlerBody: declaredErrorBody(),
      errorPolicy: "priced",
    });
    const header = await signedHeader({ pk, buyer, cap: 10_000n, nonce: `0x${"e7".repeat(32)}` });
    const res = await app.request("/echo", { method: "POST", headers: { "X-PAYMENT": header } });

    expect(res.status).toBe(200);
    expect(calls.some((c) => c.url.includes("/settle"))).toBe(false);
    const releaseCall = calls.find((c) => c.url.includes("/release"));
    expect(releaseCall).toBeDefined();
    // No strikeReason on a declared-error release (bad input never strikes).
    expect(releaseCall!.body.strikeReason).toBeUndefined();
  });
});
