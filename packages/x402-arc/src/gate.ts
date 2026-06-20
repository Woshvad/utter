// gate.ts - the `requirePayment` escrow response gate (PAY-04/05/06, RESEARCH
// Pattern 1). This is where the FREE-COMPUTE hard rule (CLAUDE.md §19) is enforced
// in the request path and where the WRONGFUL-STRIKE distinction lands.
//
// Order is LOAD-BEARING:
//   1. No `X-PAYMENT` header        -> 402 { accepts: [quote(c)] }.
//   2. `decodePayment(header)`       -> validate the untrusted payload (ASVS V5).
//   3. `await POST /verify`          -> RESERVE the cap. If invalid -> 402.
//   4. ONLY THEN run the handler under a timeout (`withTimeout(next(), ...)`).
//      The handler runs SOLELY against reserved funds - never before /verify.
//   5. `const body = await c.res.clone().text()` - CLONE first, never consume the
//      stream the client receives (Pitfall 2).
//   6. classify(body):
//        success        -> amount = computeMeteredAmount(min,cap); POST /settle;
//                          set X-PAYMENT-RESPONSE receipt header; serve the body.
//        declared_error -> (free policy) POST /release WITHOUT a strikeReason;
//                          serve the body; charge nothing; NO strike.
//        malfunction    -> POST /release WITH a strikeReason; 502; never debit.
//        timeout        -> POST /release WITH strikeReason "timeout"; 504; never debit.
//
// The gate NEVER records a strike locally - strikes are recorded by the facilitator
// `/release` route WHEN a `strikeReason` is present (the facilitator-side store is
// the canonical, durable strike owner). There is intentionally NO `recordStrike`
// call in this file.
import { createMiddleware } from "hono/factory";
import type { Hex } from "viem";
import type { Context } from "hono";
import { decodePayment, type PaymentPayload } from "./codec";
import { computeMeteredAmount } from "./metering";
import type { ResponseClass } from "./classify";
import type { AcceptsEntry, Pricing } from "./accepts";
import type { FetchLike } from "./idempotency";

/** The error policy for a declared (bad-buyer-input) error. `free` = no charge, no strike. */
export type ErrorPolicy = "free" | "priced";

/** Options for {@link requirePayment}. */
export interface RequirePaymentOpts {
  /** The facilitator base URL (no trailing slash) the gate POSTs verify/settle/release to. */
  facilitatorUrl: string;
  /**
   * Build the 402 `accepts` entry for this request (the advertised escrow option).
   * Carries the signed cap (`maxAmountRequired`), `pricing`, `payTo` (resourceId),
   * and `maxTimeoutSeconds`.
   */
  quote: (c: Context) => AcceptsEntry;
  /** Classify a response body: success | declared_error | malfunction. */
  classifier: (body: unknown) => ResponseClass;
  /** Per-resource metered pricing (the escrow charge formula terms). */
  pricing: Pricing;
  /** Declared-error policy. Default `free` (release, no strike) per CONTEXT line 88. */
  errorPolicy?: ErrorPolicy;
  /** Max handler runtime before the gate times out (seconds). */
  maxTimeoutSeconds: number;
  /** A `fetch`-like function (default global `fetch`); tests inject the in-process app. */
  fetcher?: FetchLike;
}

/** Base64-encode an arbitrary JSON receipt for the X-PAYMENT-RESPONSE header. */
function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

/** POST a JSON body to a facilitator route and parse the JSON response. */
async function postJson(
  fetcher: FetchLike,
  url: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetcher(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

/** Race a promise against a timeout; reject with a sentinel on expiry. */
const TIMEOUT_SENTINEL = Symbol("gate-timeout");
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(TIMEOUT_SENTINEL), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Build the `requirePayment` Hono middleware (the escrow response gate). Mount it
 * BEFORE the resource handler: it 402-challenges, reserves the cap at the
 * facilitator BEFORE the handler runs, classifies a cloned response body, and on a
 * valid success debits `min(computed, cap)` and sets the `X-PAYMENT-RESPONSE`
 * receipt header (declared-error / malfunction branches land in Task 2).
 */
export function requirePayment(opts: RequirePaymentOpts) {
  const fetcher: FetchLike = opts.fetcher ?? (globalThis.fetch as unknown as FetchLike);
  const facilitator = opts.facilitatorUrl.replace(/\/$/, "");
  const errorPolicy: ErrorPolicy = opts.errorPolicy ?? "free";

  return createMiddleware(async (c, next) => {
    // (1) No payment -> 402 challenge advertising the escrow accepts entry.
    const header = c.req.header("X-PAYMENT");
    const accepts = opts.quote(c);
    if (!header) {
      return c.json({ x402Version: 2, error: "X-PAYMENT header is required", accepts: [accepts] }, 402);
    }

    // (2) Decode + VALIDATE the untrusted X-PAYMENT payload (ASVS V5; throws on
    // any malformed field). A bad header is a 402, not a 500.
    let payment: PaymentPayload;
    try {
      payment = decodePayment(header);
    } catch {
      return c.json({ x402Version: 2, error: "invalid X-PAYMENT payload", accepts: [accepts] }, 402);
    }

    // (3) RESERVE the cap BEFORE the handler runs (the free-compute hard rule).
    const verify = await postJson(fetcher, `${facilitator}/verify`, {
      payment,
      resourceId: accepts.payTo,
      maxTimeoutSeconds: opts.maxTimeoutSeconds,
    });
    if (verify.status !== 200 || verify.json.valid !== true) {
      return c.json(
        { x402Version: 2, error: String(verify.json.reason ?? "payment_not_verified"), accepts: [accepts] },
        402,
      );
    }

    // (4) ONLY NOW run the handler - funds are reserved. Bound it by the timeout.
    const start = Date.now();
    await withTimeout(next(), opts.maxTimeoutSeconds * 1000);
    const handlerMs = Date.now() - start;

    // (5) Buffer the body WITHOUT consuming the stream returned to the client.
    const body = await c.res.clone().text();

    // (6) Classify and act. Task 1 implements the success branch; the non-success
    // branches (declared_error / malfunction) are added in Task 2.
    const kind = opts.classifier(body);

    if (kind === "success") {
      const cap = BigInt(payment.authorization.maxAmount);
      const bodyBytes = Buffer.byteLength(body, "utf8");
      const amount = computeMeteredAmount(opts.pricing, bodyBytes, handlerMs, cap);
      const settle = await postJson(fetcher, `${facilitator}/settle`, {
        payment,
        amount: amount.toString(),
        idemKey: payment.authorization.nonce as Hex,
        response: body,
      });
      // The persisted result + the on-chain debit happened facilitator-side; expose
      // the receipt to the buyer. The ORIGINAL body still streams to the client.
      c.header("X-PAYMENT-RESPONSE", b64(settle.json.receipt ?? settle.json));
      return;
    }

    // Non-success branches arrive in Task 2; until then treat as a malfunction-safe
    // default (release the reservation, never debit) so no path charges by accident.
    await postJson(fetcher, `${facilitator}/release`, {
      idemKey: payment.authorization.nonce as Hex,
    });
    c.res = c.json({ error: "response_failed_validation" }, 502);
    return;
  });
}
