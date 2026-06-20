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
// the canonical, durable strike owner). There is intentionally NO local strike-
// recording call in this file: the gate drives strikes ONLY via /release.
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

/**
 * Release a reservation at the facilitator. When `strikeReason` is provided this is
 * the MALFUNCTION/timeout path - the facilitator `/release` route records the strike
 * against the resource on its own (canonical) store. WITHOUT a `strikeReason` it is
 * the free / declared-error path: release only, NO strike. The gate NEVER records a
 * strike locally - it drives the strike exclusively through this route.
 */
async function release(
  fetcher: FetchLike,
  facilitator: string,
  payment: PaymentPayload,
  resourceId: Hex,
  strikeReason?: string,
): Promise<void> {
  const body: Record<string, unknown> = {
    idemKey: payment.authorization.nonce as Hex,
  };
  if (strikeReason) {
    body.strikeReason = strikeReason;
    // The facilitator requires the resourceId to attribute the strike.
    body.resourceId = resourceId;
  }
  await postJson(fetcher, `${facilitator}/release`, body);
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
    // A timeout is a MALFUNCTION: release the reservation WITH a strikeReason
    // ("timeout") - the facilitator-side store records the strike - and return 504.
    // The gate NEVER debits a timed-out call and NEVER records a strike locally.
    const start = Date.now();
    try {
      await withTimeout(next(), opts.maxTimeoutSeconds * 1000);
    } catch (err) {
      if (err === TIMEOUT_SENTINEL) {
        await release(fetcher, facilitator, payment, accepts.payTo, "timeout");
        return c.json({ error: "endpoint_timeout" }, 504);
      }
      // A genuine handler throw is also a malfunction (never charge a broken handler).
      await release(fetcher, facilitator, payment, accepts.payTo, "handler_error");
      return c.json({ error: "handler_error" }, 502);
    }
    const handlerMs = Date.now() - start;

    // (5) Buffer the body WITHOUT consuming the stream returned to the client.
    const body = await c.res.clone().text();

    // (6) Classify the cloned body and act on the class.
    const kind = opts.classifier(body);

    // Settle `amount` for this nonce and FAIL CLOSED: a thrown call, a non-200,
    // an unsuccessful body, or a missing receipt all release the reservation (so
    // the buyer's cap is never left locked) and surface a 502. The receipt header
    // is set ONLY when the debit genuinely landed. This closes the free-compute /
    // silent-no-charge leak (CR-01) and the dangling-reservation leak (CR-02): a
    // settle failure is a facilitator/relayer malfunction (NOT the buyer's fault),
    // so the release carries the "settle_failed" strike reason but never a debit.
    const settleOrRelease = async (amount: bigint, responseBody: string): Promise<void> => {
      let settle: { status: number; json: Record<string, unknown> };
      try {
        settle = await postJson(fetcher, `${facilitator}/settle`, {
          payment,
          amount: amount.toString(),
          idemKey: payment.authorization.nonce as Hex,
          response: responseBody,
        });
      } catch {
        await release(fetcher, facilitator, payment, accepts.payTo, "settle_failed");
        c.res = c.json({ error: "settlement_failed" }, 502);
        return;
      }
      if (settle.status !== 200 || settle.json.success !== true || !settle.json.receipt) {
        await release(fetcher, facilitator, payment, accepts.payTo, "settle_failed");
        c.res = c.json({ error: "settlement_failed" }, 502);
        return;
      }
      c.header("X-PAYMENT-RESPONSE", b64(settle.json.receipt));
    };

    if (kind === "success") {
      // SUCCESS: debit min(computed, cap) and expose the receipt. The ORIGINAL body
      // still streams to the client (it was never consumed - clone-before-read).
      const cap = BigInt(payment.authorization.maxAmount);
      const bodyBytes = Buffer.byteLength(body, "utf8");
      const amount = computeMeteredAmount(opts.pricing, bodyBytes, handlerMs, cap);
      await settleOrRelease(amount, body);
      return;
    }

    if (kind === "declared_error" && errorPolicy === "free") {
      // DECLARED ERROR (bad buyer input) under the FREE policy: release the
      // reservation WITHOUT a strikeReason - NO charge, NO strike (the wrongful-
      // strike guard) - and serve the ORIGINAL handler body unchanged.
      await release(fetcher, facilitator, payment, accepts.payTo);
      return;
    }

    if (kind === "declared_error") {
      // PRICED declared error (bad buyer input; STILL no strike - bad input never
      // strikes the creator). Charge min(errorPrice, cap) - NEVER the full cap (a
      // declared error is not a metered success). When no errorPrice is configured
      // (absent or "0") this is FREE: release WITHOUT a strikeReason, no debit.
      const cap = BigInt(payment.authorization.maxAmount);
      let errorPrice = 0n;
      try {
        errorPrice = BigInt(opts.pricing.errorPrice ?? "0");
      } catch {
        errorPrice = 0n;
      }
      if (errorPrice <= 0n) {
        // No error price set: a priced policy with no price is treated as free.
        await release(fetcher, facilitator, payment, accepts.payTo);
        return;
      }
      const amount = errorPrice < cap ? errorPrice : cap;
      await settleOrRelease(amount, body);
      return;
    }

    // MALFUNCTION (response matched neither schema): release WITH a strikeReason -
    // the facilitator-side store records the strike (canonical owner) - NEVER debit,
    // and replace the body with a 502 (the buyer is not charged for a broken endpoint).
    await release(fetcher, facilitator, payment, accepts.payTo, "invalid_output");
    c.res = c.json({ error: "response_failed_validation" }, 502);
    return;
  });
}
