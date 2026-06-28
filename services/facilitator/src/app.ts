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
  type RevenueLedger,
  type SettlementEntry,
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
import { spendCapPreReserveGate } from "./spend-cap-gate";
import type { PayerScreen } from "./payer-screen";
import { routeDebit } from "./batch-route";
import type { BatchSettler } from "./batch-settler";
import type { SpendCapStore } from "@utter/data-proxy";
import { verifyResourceAuthToken } from "./resource-auth";

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

  /**
   * OPTIONAL per-resource revenue ledger. When set, a successful escrow /settle records
   * its on-chain split here and GET /revenue/:resourceId aggregates it for the studio
   * dashboard. UNSET (the default - and the ai-runtime G4 gate's createApp, which passes
   * none) leaves /revenue returning a valid ZERO summary and changes no money-path
   * behavior. Deliberately in-memory only (server.ts wires InMemoryRevenueLedger); a
   * durable pg/redis-backed ledger is a later increment.
   */
  revenueLedger?: RevenueLedger;

  // ---- CR-01: per-payer rolling-24h spend cap (the free-compute guard) ----
  /**
   * The rolling-24h spend store. When set (with `perPayerDayCap`), POST /verify runs
   * the deny-by-default spend-cap gate BEFORE verifyAndReserve so an over-cap payer is
   * rejected with ZERO reservation. UNSET (the default) = no spend cap (no-op), so
   * existing deployments and tests are unchanged.
   */
  spendCapStore?: SpendCapStore;
  /** The per-payer rolling-24h cap (USDC base-unit bigint). Required to arm the gate. */
  perPayerDayCap?: bigint;
  /** Injected clock (ms since epoch) for the spend-cap window + expiry. Defaults to Date.now. */
  now?: () => number;

  // ---- Compliance: payer (buyer) sanctions screening ----
  /**
   * OPTIONAL payer-address sanctions screen. When set, POST /verify screens the claimed
   * buyer address against it BEFORE the spend-cap gate and BEFORE the reserve, so a
   * screened payer makes NO reservation and consumes ZERO compute. A screened buyer is a
   * 403 `payer_screened`; a screen throw DENIES (fail-closed). UNSET (the default) = no
   * screening, so existing deployments and tests are unchanged. This is an address
   * DENYLIST screen (sanctions), NOT KYC. server.ts wires it from SANCTIONS_DENYLIST.
   */
  payerScreen?: PayerScreen;

  // ---- CR-02: sub-cent batching (route sub-threshold debits to a BatchSettler) ----
  /**
   * Per-resource BatchSettler registry. When set (with `minEconomicalAmount`), a
   * sub-threshold escrow /settle ACCRUES into the resource's BatchSettler (no immediate
   * on-chain debit) instead of settling immediately. UNSET = settle immediately as today.
   */
  batchSettler?: (resourceId: Hex) => BatchSettler;
  /** The min-economical threshold (USDC base-unit bigint): below it a debit batches. */
  minEconomicalAmount?: bigint;

  // ---- C1: per-resource caller auth on /verify, /settle, /release ----
  /**
   * The HMAC secret that verifies a caller's per-resource auth token. UNSET (the
   * default - and every existing in-process caller, which passes none) leaves the
   * routes OPEN exactly as before, so the in-process money path and the existing
   * tests are unchanged. server.ts reads FACILITATOR_AUTH_SECRET into this and arms
   * `authEnforced`; production fail-fasts when the secret is missing.
   */
  authSecret?: string;
  /**
   * Whether per-resource caller auth is ENFORCED. When true (with `authSecret`),
   * /verify, /settle, /release require a valid token bound to the operation's
   * resourceId: missing/invalid -> 401, resourceId mismatch -> 403. When false (the
   * default), the routes pass through unchanged (the current behavior).
   */
  authEnforced?: boolean;
}

/**
 * Read a caller's per-resource auth token from the request. Accepts either an
 * `Authorization: Bearer <token>` header or an `X-Resource-Auth: <token>` header.
 * Returns the raw token string, or null when neither header is present. NEVER logs
 * the token.
 */
function readAuthToken(c: { req: { header(name: string): string | undefined } }): string | null {
  const bearer = c.req.header("Authorization");
  if (typeof bearer === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(bearer.trim());
    if (match && match[1]) return match[1].trim();
  }
  const direct = c.req.header("X-Resource-Auth");
  if (typeof direct === "string" && direct.trim().length > 0) return direct.trim();
  return null;
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

  // C1 per-resource caller-auth guard. Enforced ONLY when armed (authEnforced +
  // authSecret); otherwise it is a no-op so the in-process money path and the
  // existing tests pass through unchanged. When enforced it requires a token bound
  // to the operation's resourceId: a missing/invalid token is a 401, a token bound
  // to a DIFFERENT resourceId is a 403. Returns null when the caller may proceed,
  // or a typed denial the route turns into the JSON error response. NEVER logs the
  // token or the secret.
  type AuthDenial = { status: 401 | 403; reason: "unauthorized" | "forbidden_resource" };
  const authEnforced = deps.authEnforced === true && !!deps.authSecret;
  function checkResourceAuth(
    c: { req: { header(name: string): string | undefined } },
    resourceId: Hex,
  ): AuthDenial | null {
    if (!authEnforced) return null;
    const token = readAuthToken(c);
    if (!token) return { status: 401, reason: "unauthorized" };
    const claim = verifyResourceAuthToken(token, deps.authSecret as string);
    if (!claim) return { status: 401, reason: "unauthorized" };
    // Compare the bound resourceId to the operation's resourceId (case-insensitive
    // hex). A token for resource X presented on an op for resource Y is a 403.
    if (claim.resourceId.toLowerCase() !== resourceId.toLowerCase()) {
      return { status: 403, reason: "forbidden_resource" };
    }
    return null;
  }

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

    // C1: a caller may only verify against the resourceId its token is bound to.
    const denied = checkResourceAuth(c, resourceId);
    if (denied) return c.json({ valid: false, reason: denied.reason }, denied.status);

    const requirements: VerifyRequirements = {
      resourceId,
      maxTimeoutSeconds:
        typeof body.maxTimeoutSeconds === "number"
          ? body.maxTimeoutSeconds
          : deps.maxTimeoutSeconds,
    };

    // The reserve step (verifyAndReserve) - the FREE-COMPUTE GUARD. Bound here so the
    // spend-cap gate (CR-01) can run it ONLY on a spend-cap allow, and so the unconfigured
    // path calls it directly (unchanged behavior).
    const doReserve = () =>
      verifyAndReserve(payment, requirements, {
        store: deps.store,
        publicClient: deps.publicClient,
        escrowAddress: deps.escrowAddress,
        perBuyerLock: deps.perBuyerLock,
        maxTimeoutSeconds: requirements.maxTimeoutSeconds,
        settleBufferSeconds: deps.settleBufferSeconds,
      });

    // Compliance: payer sanctions screen. When a screen is configured, deny a sanctioned
    // buyer BEFORE the spend-cap gate and BEFORE the reserve so a screened payer makes NO
    // reservation and consumes ZERO compute. A screen throw DENIES (fail-closed): a feed
    // read failure must never open an unscreened money path. Screens the CLAIMED buyer
    // (the same key the spend-cap gate uses); the real signer is screened when it reserves
    // as itself, and a forged clean-buyer claim fails the signature check at reserve. A
    // no-op when unconfigured. Never logs the address.
    if (deps.payerScreen) {
      const buyer = (payment.authorization.buyer as string).toLowerCase();
      let allowed = false;
      try {
        allowed = await deps.payerScreen.isAllowed(buyer);
      } catch {
        allowed = false; // fail-closed: a screen error denies
      }
      if (!allowed) return c.json({ valid: false, reason: "payer_screened" }, 403);
    }

    // CR-01: per-payer rolling-24h spend cap. When a store + cap are configured, run the
    // deny-by-default gate BEFORE the reserve so an over-cap payer consumes ZERO compute
    // (NO reservation). A no-op when unconfigured (the gate is not armed).
    if (deps.spendCapStore && deps.perPayerDayCap !== undefined) {
      const nowMs = (deps.now ?? Date.now)();
      const gate = await spendCapPreReserveGate(
        {
          payer: (payment.authorization.buyer as string).toLowerCase(),
          amount: BigInt(payment.authorization.maxAmount),
          cap: deps.perPayerDayCap,
          store: deps.spendCapStore,
          now: Math.floor(nowMs / 1000),
        },
        { reserve: doReserve, handler: async () => undefined },
      );
      if (gate.decision === "deny") {
        // Over-cap: rejected with NO reservation (the free-compute guard holds).
        return c.json({ valid: false, reason: "over_cap" }, 402);
      }
      const reserved = gate.reserve!;
      return c.json(reserved, reserved.valid ? 200 : 402);
    }

    const result = await doReserve();
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

    // C1: authorize the caller against the release's resourceId BEFORE freeing the
    // reservation or recording a strike (so a peer cannot forge a strike / replay a
    // release on a resource it does not own). When enforced the body MUST carry the
    // resourceId to authorize against; a missing one is a 400 (we cannot bind auth).
    if (authEnforced) {
      const rid = body.resourceId;
      if (typeof rid !== "string" || !isHex(rid)) {
        return c.json({ released: false, reason: "bad_resourceId" }, 400);
      }
      const denied = checkResourceAuth(c, rid as Hex);
      if (denied) return c.json({ released: false, reason: denied.reason }, denied.status);
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
      // Optional revenue ledger: a successful escrow settle records its on-chain split.
      revenueLedger: deps.revenueLedger,
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
      // C1: authorize the caller against the exact transfer's resourceId. The exact
      // (EIP-3009) authorization carries NO resourceId (it is FLAT-only), so the
      // settle envelope MUST carry it at the top level (body.resourceId) when auth
      // is enforced; a missing one is a 400 (we cannot bind auth).
      if (authEnforced) {
        const exactResourceId = body.resourceId;
        if (typeof exactResourceId !== "string" || !isHex(exactResourceId)) {
          return c.json({ success: false, reason: "bad_resourceId" }, 400);
        }
        const denied = checkResourceAuth(c, exactResourceId as Hex);
        if (denied) return c.json({ success: false, reason: denied.reason }, denied.status);
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
    const settleResourceId = payment.authorization.resourceId as Hex;

    // C1: a caller may only settle against the resourceId its token is bound to.
    const settleDenied = checkResourceAuth(c, settleResourceId);
    if (settleDenied) {
      return c.json({ success: false, reason: settleDenied.reason }, settleDenied.status);
    }

    // CR-04: RESERVE-PRECEDES-SETTLE. Reject a settle for a nonce that holds no live
    // reservation AND has no cached result - so an unreserved (replayed) authorization
    // can never trigger a debit by hitting /settle directly. A legitimately
    // reserved-then-settled nonce is the cache short-circuit (handled inside settle).
    const pending = await deps.store.isNoncePending(idemKey);
    const alreadySettled = await deps.resultStore.get(idemKey);
    if (!pending && !alreadySettled) {
      return c.json({ success: false, reason: "no_reservation" }, 409);
    }

    // WR-04: re-check the authorization is unexpired at settle entry. Between /verify
    // and /settle (handler runtime + queueing) it can expire; rather than let the
    // on-chain debit revert opaquely (unmatched by the NonceUsed rebuild path), reject
    // cleanly and release the reservation so the buyer's cap is freed.
    let validBefore: bigint;
    try {
      validBefore = BigInt(payment.authorization.validBefore);
    } catch {
      return c.json({ success: false, reason: "bad_authorization" }, 400);
    }
    const nowMsSettle = (deps.now ?? Date.now)();
    if (validBefore <= BigInt(Math.floor(nowMsSettle / 1000)) && !alreadySettled) {
      await deps.store.release(idemKey);
      return c.json({ success: false, reason: "expired" }, 402);
    }

    // CR-02: route through the min-economical threshold when batching is configured. A
    // sub-threshold debit ACCRUES into the resource's BatchSettler (NO immediate on-chain
    // debit - the batch flushes one settle() later); an at/above-threshold debit settles
    // immediately via the SAME settle() money guard. A no-op (immediate settle) when
    // batching is unconfigured - the existing behavior. The reserve-precedes-settle and
    // expiry checks above still gate BOTH paths (no unreserved/expired auth accrues).
    if (deps.batchSettler && deps.minEconomicalAmount !== undefined) {
      const routed = await routeDebit({
        debit: amount,
        minEconomical: deps.minEconomicalAmount,
        resourceId: settleResourceId,
        now: Math.floor(nowMsSettle / 1000),
        batchSettler: deps.batchSettler(settleResourceId),
        settle: { payment, amount, idemKey, deps: settleDeps, body: responseBody },
      });
      if (routed.path === "batched") {
        // Accrued with NO immediate on-chain debit; the flush (if this accrual tripped a
        // trigger) carries the batched receipt, else it settles on a later accrual.
        return c.json(
          { success: true, batched: true, receipt: routed.flush?.receipt ?? null },
          200,
        );
      }
      return c.json({ success: true, receipt: routed.receipt }, 200);
    }

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

  // GET /revenue/:resourceId - the studio revenue projection (STU-04). Aggregates the
  // optional revenue ledger's per-resource settlement rows into the RevenueSummary JSON
  // shape, serializing every base-unit amount as a DECIMAL STRING (bigint never crosses
  // JSON as a number). When no ledger is wired or a resource has no rows, returns a
  // valid ZERO summary (200, never an error) so the dashboard always gets a real shape.
  app.get("/revenue/:resourceId", async (c) => {
    const resourceId = c.req.param("resourceId");
    // bytes32: 0x + exactly 64 hex chars (the on-chain resourceId shape).
    if (!isHex(resourceId) || !/^0x[0-9a-fA-F]{64}$/.test(resourceId)) {
      return c.json({ reason: "bad_resourceId" }, 400);
    }
    const entries: SettlementEntry[] = deps.revenueLedger
      ? await deps.revenueLedger.byResource(resourceId as Hex)
      : [];

    let calls = 0;
    let gross = 0n;
    let creatorShare = 0n;
    let platformShare = 0n;
    let refunds = 0n;
    const receipts = entries.map((e) => {
      if (e.kind === "settle") {
        calls += 1;
        gross += e.amount;
        creatorShare += e.creatorShare;
        platformShare += e.platformShare;
      } else {
        refunds += e.amount;
      }
      return {
        tx: e.tx,
        kind: e.kind,
        amount: e.amount.toString(),
        idemKey: e.idemKey,
      };
    });

    return c.json(
      {
        resourceId,
        calls,
        gross: gross.toString(),
        creatorShare: creatorShare.toString(),
        platformShare: platformShare.toString(),
        refunds: refunds.toString(),
        receipts,
      },
      200,
    );
  });

  return app;
}
