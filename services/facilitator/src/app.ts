// The facilitator Hono app (PAY-09): the four-route HTTP surface over the
// reservation + settle logic. The facilitator ONLY verifies and settles - it NEVER
// runs a handler (that is the resource server's job, behind the gate in Plan 05).
//
//   POST /verify           -> verifyAndReserve (Plan 03): the FREE-COMPUTE GUARD;
//                             reserves the cap before any handler can run.
//   POST /release          -> store.release; records a strike IFF a strikeReason is
//                             present (the facilitator store is the CANONICAL owner
//                             of the strike counter). A release WITHOUT a reason is
//                             the free / declared-error path and records NO strike.
//   POST /settle           -> settle (Task 1): one escrow debit (<=cap) or one exact
//                             transfer per nonce; idempotent; persist-before-respond.
//   GET  /results/:idemKey -> the persisted (response, receipt) within TTL, else 404
//                             (the post-disconnect recovery surface; no re-charge).
//
// Every inbound body is decoded/validated BEFORE use (ASVS V5): the X-PAYMENT-style
// payload goes through `decodePayment` (which throws on any malformed field), and
// the /release/:settle envelopes are shape-checked here. Malformed -> 400, never a
// coerced/partial object reaching the money path.
import { Hono } from "hono";
import { isHex, type Address, type Hex, type PublicClient } from "viem";
import {
  decodePayment,
  type PaymentStore,
  type ResultStore,
  type PaymentPayload,
} from "@utter/x402-arc";
import {
  verifyAndReserve,
  type PerBuyerLock,
  type VerifyRequirements,
} from "./verify";
import {
  settle,
  type ExactSettlePayload,
  type SettleResponseBody,
} from "./settle";
import type { RelayerPool } from "./relayer";

/** Everything the app's routes need injected (stores + chain + relayer + knobs). */
export interface AppDeps {
  /** The reservation/nonce/strike store (the facilitator-side strike owner). */
  store: PaymentStore;
  /** The persisted-result store (exactly-once / GET /results). */
  resultStore: ResultStore;
  /** The relayer signer pool (settle submits via this). */
  relayerPool: RelayerPool;
  /** The Arc public client (balance/nonce reads + tx receipt waits). */
  publicClient: PublicClient;
  /** The per-buyer serialization lock for /verify. */
  perBuyerLock: PerBuyerLock;
  /** The PaymentEscrow address. */
  escrowAddress: Address;
  /** The PaymentSplitter address (exact path). */
  splitterAddress: Address;
  /** The USDC token address (exact transferWithAuthorization target). */
  usdcAddress: Address;
  /** Reservation TTL term: the resource's max handler timeout (seconds). */
  maxTimeoutSeconds: number;
  /** Reservation TTL / validBefore buffer past the handler timeout (seconds). */
  settleBufferSeconds: number;
  /** Result retention TTL (seconds, default 24h). */
  resultTtlSeconds?: number;
}

/** Decode a request body into a typed PaymentPayload, or null if malformed. */
function decodePaymentBody(value: unknown): PaymentPayload | null {
  // The payload may arrive as the base64 X-PAYMENT string, or as the already-parsed
  // object (JSON body). Normalize to the validated PaymentPayload via decodePayment.
  try {
    if (typeof value === "string") return decodePayment(value);
    if (value && typeof value === "object") {
      // Re-encode the object through the codec so EVERY field is validated the same
      // way as the wire path (never trust a hand-built object on the money path).
      const encoded = Buffer.from(JSON.stringify(value), "utf8").toString("base64");
      return decodePayment(encoded);
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Build the facilitator Hono app. All money-path logic lives in the injected deps;
 * the routes only decode, dispatch, and shape the JSON response.
 */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  // POST /verify - the FREE-COMPUTE GUARD. Body: { payment, resourceId, maxTimeoutSeconds? }.
  app.post("/verify", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ valid: false, reason: "bad_request" }, 400);

    const payment = decodePaymentBody(body.payment ?? body);
    if (!payment) return c.json({ valid: false, reason: "bad_payment" }, 400);

    const resourceId =
      typeof body.resourceId === "string" && isHex(body.resourceId)
        ? (body.resourceId as Hex)
        : (payment.authorization.resourceId as Hex);

    const requirements: VerifyRequirements = {
      resourceId,
      maxTimeoutSeconds:
        typeof body.maxTimeoutSeconds === "number"
          ? body.maxTimeoutSeconds
          : deps.maxTimeoutSeconds,
    };

    const result = await verifyAndReserve(payment, requirements, {
      store: deps.store,
      publicClient: deps.publicClient,
      escrowAddress: deps.escrowAddress,
      perBuyerLock: deps.perBuyerLock,
      maxTimeoutSeconds: requirements.maxTimeoutSeconds,
      settleBufferSeconds: deps.settleBufferSeconds,
    });
    return c.json(result, result.valid ? 200 : 402);
  });

  // POST /release - free a reservation. CANONICAL strike-recording path: records a
  // strike IFF a strikeReason is present; a release without one records NO strike.
  app.post("/release", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ released: false, reason: "bad_request" }, 400);

    const idemKey = body.idemKey;
    if (typeof idemKey !== "string" || !isHex(idemKey)) {
      return c.json({ released: false, reason: "bad_idemKey" }, 400);
    }

    await deps.store.release(idemKey as Hex);

    // A strikeReason makes this the malfunction path: record a strike against the
    // resource (the facilitator store is the canonical, durable strike owner).
    const strikeReason = body.strikeReason;
    let struck = false;
    if (typeof strikeReason === "string" && strikeReason.length > 0) {
      const resourceId = body.resourceId;
      if (typeof resourceId !== "string" || !isHex(resourceId)) {
        return c.json({ released: true, reason: "bad_resourceId_for_strike" }, 400);
      }
      await deps.store.recordStrike(resourceId as Hex, strikeReason);
      struck = true;
    }

    return c.json({ released: true, struck }, 200);
  });

  // POST /settle - one escrow debit (<=cap) or one exact transfer per nonce.
  app.post("/settle", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ success: false, reason: "bad_request" }, 400);

    const settleDeps = {
      relayerPool: deps.relayerPool,
      store: deps.store,
      resultStore: deps.resultStore,
      publicClient: deps.publicClient,
      escrowAddress: deps.escrowAddress,
      splitterAddress: deps.splitterAddress,
      usdcAddress: deps.usdcAddress,
      resultTtlSeconds: deps.resultTtlSeconds,
    };

    const responseBody: SettleResponseBody = {
      response: typeof body.response === "string" ? body.response : "",
    };

    // exact scheme: the body carries a pre-signed ExactSettlePayload.
    if (body.scheme === "exact") {
      const exact = body as unknown as ExactSettlePayload;
      if (!exact.signed || typeof exact.signed !== "object") {
        return c.json({ success: false, reason: "bad_exact_payload" }, 400);
      }
      const idemKey = exact.signed.authorization?.nonce;
      if (typeof idemKey !== "string" || !isHex(idemKey)) {
        return c.json({ success: false, reason: "bad_idemKey" }, 400);
      }
      const receipt = await settle(exact, 0n, idemKey as Hex, settleDeps, responseBody);
      return c.json({ success: true, receipt }, 200);
    }

    // escrow scheme: validate the payment + parse the metered amount.
    const payment = decodePaymentBody(body.payment ?? body);
    if (!payment) return c.json({ success: false, reason: "bad_payment" }, 400);

    let amount: bigint;
    try {
      amount = BigInt(String(body.amount ?? payment.authorization.maxAmount));
    } catch {
      return c.json({ success: false, reason: "bad_amount" }, 400);
    }
    if (amount < 0n) return c.json({ success: false, reason: "bad_amount" }, 400);

    const idemKey = payment.authorization.nonce as Hex;
    const receipt = await settle(payment, amount, idemKey, settleDeps, responseBody);
    return c.json({ success: true, receipt }, 200);
  });

  // GET /results/:idemKey - re-serve a persisted paid result within TTL; else 404.
  app.get("/results/:idemKey", async (c) => {
    const idemKey = c.req.param("idemKey");
    if (!isHex(idemKey)) return c.json({ reason: "bad_idemKey" }, 400);
    const stored = await deps.resultStore.get(idemKey as Hex);
    if (!stored) return c.json({ reason: "not_found" }, 404);
    return c.json({ response: stored.response, receipt: stored.receipt }, 200);
  });

  return app;
}
