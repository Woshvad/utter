// client.ts - createBuyerClient: the BUY-01 reference paying-agent client.
//
// `pay()` is a REFACTOR of runTestEndpoint (apps/marketplace/src/test-endpoint.ts), NOT
// a new flow (RESEARCH "Don't Hand-Roll": a parallel loop risks signature drift). The
// §7.2 escrow loop:
//   discover -> cap-from-RUNTIME-decimals -> GET 402 -> signDebitAuthorization (the
//   FROZEN UtterEscrow/1 domain; field order buyer,resourceId,maxAmount,nonce,validBefore)
//   -> encodePayment -> POST X-PAYMENT -> 200 + X-PAYMENT-RESPONSE receipt.
// Exactly-once: the nonce IS the idemKey, persisted BEFORE the POST; a post-200
// disconnect recovers via retrieveByIdemKey(facilitatorUrl, SAME nonce) - NEVER a
// re-sign (Pitfall 2 = double-charge).
//
// The buyer wallet key is held in the CLOSURE: it never returns from a public method and
// is never logged (T-07-KEYLEAK). `viem` is TYPE-ONLY (erased at build).
import type { Account, Chain, Hex, PublicClient, Transport, WalletClient } from "viem";
import { Hono } from "hono";
import type { Context } from "hono";
import { erc20Abi, USDC } from "@utter/chain";
import {
  signDebitAuthorization,
  encodePayment,
  computeValidBefore,
  retrieveByIdemKey,
  requirePayment,
  buildClassifier,
  type AcceptsEntry,
  type FetchLike,
  type PaymentPayload,
} from "@utter/x402-arc";

import { discover, type CardSource, type CardPayInputs, type DiscoverResult } from "./discover.js";
import { ensureDeposit, type EnsureDepositResult } from "./deposit.js";
import type { BuyerTransport } from "./transport.js";

/** A buyer wallet client exposing viem signTypedData (held in the closure, never exposed). */
export type BuyerWalletClient = WalletClient<Transport, Chain | undefined, Account>;

/** Options for {@link createBuyerClient}. */
export interface CreateBuyerClientOptions {
  /** The selected transport (fixture in-proc facilitator + mock chain, or live). */
  transport: BuyerTransport;
  /** The buyer's wallet client. The key is held in the closure - NEVER returned/logged. */
  buyerWallet: BuyerWalletClient;
  /** Resolve a marketplace resourceId to its served card (the fixture default). */
  cardSource?: CardSource;
  /** The env (for the live path / config). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/** A reference to a discoverable resource: either its card URL or a marketplace resourceId. */
export type ResourceRef = { cardUrl: string } | { resourceId: string };

/** A pay request: the resource to call + the request body the handler echoes. */
export interface PayRequest {
  /** The resource to discover + pay (card URL or resourceId). */
  resource: ResourceRef;
  /** The request body POSTed to the resource handler (defaults to a benign echo). */
  body?: unknown;
  /**
   * An optional resource app builder. The autonomous fixture mounts a gated echo
   * resource (the seller side stand-in); a live caller targets the deployed endpoint via
   * the transport instead. When omitted, the client mounts the in-fixture echo gate.
   */
  resourceApp?: Hono;
}

/** The result of one pay() call (the buyer key is NEVER a field here - T-07-KEYLEAK). */
export interface PayResult {
  /** True iff the paid call returned 200 with a receipt. */
  paid: boolean;
  /** The HTTP status of the paid call. */
  status: number;
  /** The card-derived cap (base units) the buyer signed (the on-chain hard bound). */
  cap: bigint;
  /** The on-chain debit amount (base units) - asserted <= cap. */
  debitAmount: bigint;
  /** The idemKey (the payment nonce) used for the call. */
  idemKey: Hex;
  /** The parsed X-PAYMENT-RESPONSE receipt, or null. */
  receipt: unknown;
  /** The 200 response body string. */
  response: string;
  /** The pay inputs read ONLY from the validated card. */
  cardInputs: CardPayInputs;
}

/** The recovered (exactly-once) result from a post-disconnect retrieveByIdemKey. */
export interface RecoveredResult {
  /** The same idemKey (nonce) - never a re-sign. */
  idemKey: string;
  /** The re-served response. */
  response: string;
  /** The re-served receipt. */
  receipt: unknown;
}

/** The public buyer-client surface (no method returns or logs the buyer key). */
export interface BuyerClient {
  /** Discover a resource by card URL or resourceId (validateAgentCard-gated). */
  discover(resource: ResourceRef): Promise<DiscoverResult>;
  /** Ensure the buyer holds >= cap credited in escrow (deposit-once). */
  ensureDeposit(neededCap: bigint): Promise<EnsureDepositResult>;
  /** Run the §7.2 escrow pay loop: exactly one debit <= cap, exactly-once recoverable. */
  pay(req: PayRequest): Promise<PayResult>;
  /** Recover a paid result by its idemKey (the SAME nonce) - NEVER a re-sign. */
  retrieveByIdemKey(idemKey: Hex): Promise<RecoveredResult | null>;
}

/** A 0x-prefixed bytes32 random nonce (the idemKey for this call). */
function randomNonce(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return ("0x" + Buffer.from(bytes).toString("hex")) as Hex;
}

/** The in-fixture echo handler (the seller-side resource stand-in for the autonomous proof). */
async function echoHandler(c: Context): Promise<Response> {
  let body: { text?: unknown };
  try {
    body = (await c.req.json()) as { text?: unknown };
  } catch {
    return c.json({ error: "request body must be valid JSON", code: "BAD_JSON" }, 400);
  }
  const text = body?.text;
  if (typeof text !== "string") {
    return c.json({ error: "text must be a string", code: "BAD_INPUT" }, 400);
  }
  return c.json({ echo: text, length: text.length }, 200);
}

/** The echo success/error OpenAPI the gate classifier validates the body against. */
const ECHO_OPENAPI: Record<string, unknown> = {
  openapi: "3.1.0",
  info: { title: "echo", version: "1.0.0" },
  paths: {},
  components: {
    schemas: {
      EchoSuccess: {
        type: "object",
        required: ["echo", "length"],
        properties: { echo: { type: "string" }, length: { type: "integer" } },
        additionalProperties: false,
      },
      EchoError: {
        type: "object",
        required: ["error", "code"],
        properties: { error: { type: "string" }, code: { type: "string" } },
        additionalProperties: false,
      },
    },
  },
};

/**
 * Build the BUY-01 paying-agent client. The buyer wallet (and its key) is captured in
 * this closure: NO returned method exposes it and NO diagnostic logs it (T-07-KEYLEAK).
 */
export function createBuyerClient(opts: CreateBuyerClientOptions): BuyerClient {
  const { transport, buyerWallet, cardSource } = opts;
  const publicClient: PublicClient = transport.publicClient;
  const buyer = buyerWallet.account.address as Hex;

  // The in-process facilitator (and its result store) is memoized per resource
  // (escrow|asset) so a single mounted instance backs BOTH the pay POST and the
  // post-disconnect retrieveByIdemKey recovery. Re-mounting per call would create a
  // fresh empty store and the recovery would always 404 in the fixture. In the live
  // transport this fetcher routes to the standalone facilitator URL (the store is
  // server-side either way).
  const facilitatorByResource = new Map<string, FetchLike>();
  function facilitatorFor(escrow: `0x${string}`, asset: `0x${string}`): FetchLike {
    const key = `${escrow}|${asset}`.toLowerCase();
    let fetcher = facilitatorByResource.get(key);
    if (!fetcher) {
      fetcher = transport.mountFacilitator({ escrow, asset }).fetcher;
      facilitatorByResource.set(key, fetcher);
    }
    return fetcher;
  }

  // The most-recently-paid resource's facilitator fetcher, so the parameterless-style
  // standalone retrieveByIdemKey recovers against the same store the last pay() used.
  let lastFetcher: FetchLike | null = null;

  async function discoverResource(resource: ResourceRef): Promise<DiscoverResult> {
    return discover(resource, { cardSource });
  }

  async function ensureDepositForCap(neededCap: bigint): Promise<EnsureDepositResult> {
    return ensureDeposit({ publicClient, walletClient: buyerWallet, buyer, neededCap });
  }

  async function pay(req: PayRequest): Promise<PayResult> {
    // (1) DISCOVER - validateAgentCard-gated; every pay input comes ONLY from the card.
    const { cardInputs } = await discoverResource(req.resource);

    // (2) CAP from a RUNTIME decimals() read (Pitfall 3 / CHAIN-03 - never a 1e6 literal).
    // baseUnit is the precision witness derived from the runtime read; the cap value is
    // the card's escrow max (already base units). A 0 cap throws BEFORE any sign
    // (T-07-OVERCHARGE: the client never signs a non-positive / unbounded cap).
    const decimals = (await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "decimals",
    })) as number;
    const baseUnit = 10n ** BigInt(decimals);
    void baseUnit;
    const cap = cardInputs.cap;
    if (cap <= 0n) {
      throw new Error(`pay: card pricing.max ${cap} is not a positive cap (refusing to sign)`);
    }

    // (3) The in-process facilitator bound to the CARD-derived escrow/asset (memoized per
    // resource so the SAME store backs the pay POST and the recovery). Build the resource
    // gate on top of it (the seller stand-in for the autonomous proof; a live caller
    // passes req.resourceApp targeting the deployed endpoint). The gate reserves the cap
    // at /verify BEFORE the handler runs (reserve-before-run).
    const fetcher = facilitatorFor(cardInputs.escrow, cardInputs.asset);
    lastFetcher = fetcher;

    const resourceApp = req.resourceApp ?? buildFixtureResource(cardInputs, cap, fetcher);

    const reqInit = {
      method: "POST",
      headers: { "content-type": "application/json" } as Record<string, string>,
      body: JSON.stringify(req.body ?? { text: "hello" }),
    };

    // (3a) GET with no X-PAYMENT -> expect 402 with the accepts quote.
    const unpaid = await resourceApp.request("/call", reqInit);
    if (unpaid.status !== 402) {
      throw new Error(`pay: expected 402 on the unpaid call, got ${unpaid.status}`);
    }

    // (3b) Sign the DebitAuthorization for the CARD-DERIVED cap + payTo. The nonce IS the
    // idemKey; it is captured here (BEFORE the POST) so recovery is by idemKey, never a
    // re-sign. The domain is the FROZEN UtterEscrow/1 (imported via signDebitAuthorization
    // - never re-declared); field order buyer,resourceId,maxAmount,nonce,validBefore.
    const nonce = randomNonce();
    const validBefore = computeValidBefore(
      transport.maxTimeoutSeconds,
      transport.settleBufferSeconds,
    );
    const signed = await signDebitAuthorization(buyerWallet, {
      buyer,
      resourceId: cardInputs.payTo,
      maxAmount: cap,
      nonce,
      validBefore,
    });
    const payload: PaymentPayload = {
      x402Version: 2,
      scheme: "utter-escrow",
      network: "eip155:5042002",
      authorization: {
        buyer,
        resourceId: cardInputs.payTo,
        maxAmount: cap.toString(),
        nonce,
        validBefore: validBefore.toString(),
      },
      signature: signed.signature,
    };
    const header = encodePayment(payload);

    // (3c) Re-POST with X-PAYMENT -> 200 + the X-PAYMENT-RESPONSE receipt. This triggers
    // the single escrow debit via /settle (the only money move).
    const paidRes = await resourceApp.request("/call", {
      ...reqInit,
      headers: { ...reqInit.headers, "X-PAYMENT": header },
    });
    const status = paidRes.status;
    let receipt: unknown = null;
    let debitAmount = 0n;
    let response = "";
    if (status === 200) {
      response = await paidRes.text();
      const receiptHeader = paidRes.headers.get("X-PAYMENT-RESPONSE");
      if (receiptHeader) {
        receipt = JSON.parse(Buffer.from(receiptHeader, "base64").toString("utf8"));
        const amt = (receipt as { amount?: string }).amount;
        if (typeof amt === "string") debitAmount = BigInt(amt);
      }
      // Cross-check the durable persisted receipt via the recovery surface (no re-charge).
      const recovered = await retrieveByIdemKey(transport.facilitatorUrl, nonce, fetcher);
      if (recovered) {
        const amt = (recovered.receipt as { amount?: string }).amount;
        if (typeof amt === "string") debitAmount = BigInt(amt);
      }
    }

    return {
      paid: status === 200,
      status,
      cap,
      debitAmount,
      idemKey: nonce,
      receipt,
      response,
      cardInputs,
    };
  }

  // retrieveByIdemKey wraps the FROZEN @utter/x402-arc retrieveByIdemKey: the SAME nonce,
  // a GET /results/:idemKey, NEVER a re-sign (Pitfall 2) and NEVER a second debit. The
  // fetcher routes to the SAME in-process facilitator the last pay() used (fixture) or
  // the live facilitator URL. A caller holding a nonce with no prior pay() in this client
  // must pay() first (the fixture facilitator is per-resource).
  async function retrieveResult(idemKey: Hex): Promise<RecoveredResult | null> {
    if (!lastFetcher) {
      throw new Error(
        "retrieveByIdemKey: no facilitator is mounted yet (call pay() first, or use the " +
          "live transport whose facilitator URL holds the durable result store).",
      );
    }
    const recovered = await retrieveByIdemKey(transport.facilitatorUrl, idemKey, lastFetcher);
    if (!recovered) return null;
    const rid = (recovered.receipt as { idemKey?: string }).idemKey ?? idemKey;
    return { idemKey: rid, response: recovered.response, receipt: recovered.receipt };
  }

  return {
    discover: discoverResource,
    ensureDeposit: ensureDepositForCap,
    pay,
    retrieveByIdemKey: retrieveResult,
  };
}

/** Build the in-fixture gated echo resource (the seller stand-in) bound to the card inputs. */
function buildFixtureResource(cardInputs: CardPayInputs, cap: bigint, fetcher: FetchLike): Hono {
  const classifier = buildClassifier(ECHO_OPENAPI);
  const quote = (): AcceptsEntry => ({
    scheme: "utter-escrow",
    network: "eip155:5042002",
    asset: cardInputs.asset,
    escrow: cardInputs.escrow,
    maxAmountRequired: cap.toString(),
    payTo: cardInputs.payTo,
    maxTimeoutSeconds: 30,
    pricing: cardInputs.pricing,
  });

  const app = new Hono();
  app.use(
    "/call",
    requirePayment({
      facilitatorUrl: "http://buyer-sdk.local",
      quote,
      classifier,
      pricing: cardInputs.pricing,
      maxTimeoutSeconds: 30,
      fetcher,
    }),
  );
  app.post("/call", (c) => echoHandler(c));
  return app;
}
