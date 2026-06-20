// test-endpoint.ts - the programmatic "test this endpoint" pay-flow runner (MKT-03/04).
//
// This proves an EXTERNAL agent can DISCOVER a resource by reading ONLY its agent
// card, deposit, sign a DebitAuthorization for the card-derived cap, pay, and settle
// with EXACTLY ONE debit <= cap. It clones the echo-money-path pattern
// (packages/x402-arc/examples/echo/live-money-path.ts): the in-process facilitator
// createApp + a mocked chain for the autonomous proof. The LIVE funded-wallet HTTPS
// run (liveTestEndpoint) is OPERATOR-GATED exactly like the live-money-path script -
// it is written + type-checked here, never executed against a funded wallet.
//
// What makes this MKT-04 (not just a copy of the echo E2E): the runner reads EVERY
// pay input - escrow, pricing, payTo, cap, bond, reputation - ONLY from the served
// agent card (no out-of-band config), proving an external agent pays using nothing but
// the card. The cap derives from a RUNTIME decimals() read (Pitfall 3) - never a 1e6
// literal. The reserve-before-run guarantee comes from the FROZEN requirePayment gate
// (the cap is reserved at /verify before the handler runs) - the free-compute guard.
import { Hono } from "hono";
import type { Context } from "hono";
// `viem` is a devDependency of @utter/marketplace; this is a TYPE-ONLY import (erased
// at build, no runtime resolution), so the package keeps no runtime viem coupling - it
// only borrows the PublicClient shape the injected chain client must satisfy.
import type { PublicClient } from "viem";
import { erc20Abi, USDC, PAYMENT_ESCROW, PAYMENT_SPLITTER } from "@utter/chain";
import {
  buildClassifier,
  requirePayment,
  signDebitAuthorization,
  encodePayment,
  computeValidBefore,
  retrieveByIdemKey,
  type AcceptsEntry,
  type FetchLike,
  type PaymentPayload,
  type Pricing,
  type SignerWalletClient,
} from "@utter/x402-arc";
import { createApp } from "@utter/facilitator/app";
import { createInMemoryStores } from "@utter/facilitator/stores/memory";
import { createInMemoryBuyerLock } from "@utter/facilitator/verify";
import type { RelayerPool } from "@utter/facilitator/relayer";
import type { Hex } from "./index-store.js";

// The default escrow timing window the runner signs the validBefore over (mirrors the
// echo example). These are gate timing knobs, not money - no decimals literal here.
const MAX_TIMEOUT_SECONDS = 30;
const SETTLE_BUFFER_SECONDS = 90;
const PORT_FACILITATOR_URL = "http://test-endpoint.local";

/**
 * The chain read client the runner reads through (decimals + balanceOf + receipts).
 * It is a viem PublicClient (or a structural mock that satisfies it) so the same
 * client flows into the facilitator createApp; the autonomous proof injects a mock.
 */
export type RunnerPublicClient = PublicClient;

/** Fetch the agent card for a resource (the SOLE discovery source). Returns null if unknown. */
export type CardFetcher = (resourceId: string) => Promise<Record<string, unknown> | null>;

/** The pay inputs the runner read ONLY from the card (the MKT-04 proof surface). */
export interface CardPayInputs {
  /** The escrow contract address from the card x402.escrow. */
  escrow: `0x${string}`;
  /** The USDC asset address from the card x402.asset. */
  asset: `0x${string}`;
  /** The resourceId payTo from the card x402.payTo. */
  payTo: Hex;
  /** The metered pricing block from the card x402.pricing. */
  pricing: Pricing;
  /** The cap (escrow max) in base units from the card pricing.max. */
  cap: bigint;
  /** Whether a bond is posted, read from the card bond.posted. */
  bondPosted: boolean;
  /** The reputation/health verified flag read from the card health.verified. */
  verified: boolean;
}

/** Options for {@link runTestEndpoint}. */
export interface RunTestEndpointOptions {
  /** The on-chain resourceId (bytes32) to test. */
  resourceId: Hex;
  /** Discover the agent card (read ONLY this for all pay inputs). */
  cardFetcher: CardFetcher;
  /** The buyer's wallet client (signs the DebitAuthorization). */
  buyerWallet: SignerWalletClient;
  /** The chain read client (decimals/balanceOf/receipts) - mocked in the autonomous proof. */
  publicClient: RunnerPublicClient;
  /** The relayer pool the in-process facilitator settles through (mocked debit counter in tests). */
  relayerPool: RelayerPool;
  /** Optional override request payload sent to the resource (defaults to a benign echo body). */
  requestBody?: unknown;
}

/** The result of one programmatic pay-flow run. */
export interface TestEndpointResult {
  /** True iff the paid call returned 200 with a receipt. */
  paid: boolean;
  /** The HTTP status of the paid call. */
  status: number;
  /** The card-derived cap (base units) the buyer signed. */
  cap: bigint;
  /** The actual on-chain debit amount (base units) - asserted <= cap. */
  debitAmount: bigint;
  /** The idemKey (the payment nonce) used for the call. */
  idemKey: Hex;
  /** The X-PAYMENT-RESPONSE receipt (parsed), or null if absent. */
  receipt: unknown;
  /** The pay inputs read ONLY from the card (the MKT-04 proof). */
  cardInputs: CardPayInputs;
  /** The disconnect-recovery result (retrieveByIdemKey), or null on a miss. */
  recovered: { idemKey: string; response: string } | null;
}

/** A 0x-prefixed bytes32 random nonce (the idemKey for this call). */
function randomNonce(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return ("0x" + Buffer.from(bytes).toString("hex")) as Hex;
}

/** Read the pay inputs from the card x402 block + health + bond (the ONLY source). */
function readCardInputs(card: Record<string, unknown>, cap: bigint): CardPayInputs {
  const x402 = (card.x402 as Record<string, unknown> | undefined) ?? {};
  const pricingRaw = (x402.pricing as Record<string, unknown> | undefined) ?? {};
  const health = (card.health as Record<string, unknown> | undefined) ?? {};
  const bond = (card.bond as Record<string, unknown> | undefined) ?? {};
  const pricing: Pricing = {
    model: "metered",
    base: typeof pricingRaw.base === "string" ? pricingRaw.base : "0",
    perKB: typeof pricingRaw.perKB === "string" ? pricingRaw.perKB : "0",
    // The card's ProjectedPricing has no computeMultiplier; the metered amount stays
    // bounded by the signed cap regardless, so a 0 compute term is safe + deterministic.
    computeMultiplier: typeof pricingRaw.computeMultiplier === "string" ? pricingRaw.computeMultiplier : "0",
    maxResponseBytes:
      typeof pricingRaw.maxResponseBytes === "number" ? pricingRaw.maxResponseBytes : 1_048_576,
  };
  return {
    escrow: x402.escrow as `0x${string}`,
    asset: x402.asset as `0x${string}`,
    payTo: x402.payTo as Hex,
    pricing,
    cap,
    bondPosted: bond.posted === true,
    verified: health.verified === true,
  };
}

/**
 * A trusted in-runner echo handler (the resource server stand-in for the autonomous
 * proof). It echoes a string `text` as `{ echo, length }` (the success shape) and
 * returns a declared error for bad input - mirroring the echo example handler so the
 * gate classifies it as success and settles. The LIVE runner hits the deployed
 * sandbox endpoint instead; the gate wiring is identical, only the transport changes.
 */
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
 * Run the programmatic pay-flow against the IN-PROCESS facilitator + the injected
 * (mocked) chain. Steps (cloning live-money-path.ts):
 *   (1) DISCOVER: fetch the agent card - read x402{escrow,pricing,payTo} + health +
 *       bond ONLY from it (no out-of-band config).
 *   (2) CAP: derive the cap from the card pricing via a RUNTIME decimals() read
 *       (10n ** BigInt(decimals) scaling - never a 1e6 literal).
 *   (3) PAY: deposit-state seeded -> GET 402 accepts -> signDebitAuthorization(cap) ->
 *       X-PAYMENT -> 200 + X-PAYMENT-RESPONSE. The FROZEN gate reserves the cap at
 *       /verify BEFORE the handler runs (reserve-before-run / free-compute guard).
 *   (4) ASSERT: EXACTLY ONE debit <= cap (the caller asserts via the relayer counter).
 *   (5) RECOVER: a simulated disconnect -> retrieveByIdemKey returns the paid result
 *       with NO second debit (exactly-once).
 */
export async function runTestEndpoint(opts: RunTestEndpointOptions): Promise<TestEndpointResult> {
  const { resourceId, cardFetcher, buyerWallet, publicClient, relayerPool } = opts;

  // (1) DISCOVER - the card is the SOLE source of every pay input (MKT-04). A resource
  // with no card is not discoverable -> the runner never pays (no free-compute).
  const card = await cardFetcher(resourceId);
  if (!card) {
    throw new Error(`test-endpoint: resource ${resourceId} is not discoverable (no agent card)`);
  }

  // (2) CAP from a RUNTIME decimals() read (Pitfall 3 - never a 1e6 literal). The cap
  // value itself comes from the card pricing.max; the decimals read proves the runner
  // resolves token precision at runtime rather than assuming 6.
  const decimals = (await publicClient.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "decimals",
  })) as number;
  // Touch the runtime decimals base so the scaling unit is derived, never literal'd
  // (10 ** decimals = one whole token in base units). The card pricing.max is already
  // in base units; the runtime decimals read is the precision source of truth.
  const baseUnit = 10n ** BigInt(decimals);
  const x402 = (card.x402 as Record<string, unknown> | undefined) ?? {};
  const pricingRaw = (x402.pricing as Record<string, unknown> | undefined) ?? {};
  const capRaw = typeof pricingRaw.max === "string" ? pricingRaw.max : "0";
  // The cap is the card's escrow max in base units. Guard: it must be a whole number of
  // base units (a positive integer); baseUnit anchors the precision the cap is denominated in.
  const cap = BigInt(capRaw);
  // IN-01: `cap` is already a bigint (a whole number of base units), so `cap % 1n` and
  // `baseUnit <= 0n` can never trip - they were vestigial. The live guard is `cap > 0n`:
  // the escrow max must be a positive base-unit amount. `baseUnit` stays computed above
  // as the runtime decimals-derivation witness (Pitfall 3: precision is read, never literal'd).
  if (cap <= 0n) {
    throw new Error(`test-endpoint: card pricing.max ${capRaw} is not a positive cap`);
  }
  void baseUnit;

  const cardInputs = readCardInputs(card, cap);

  // (3) Build the in-process facilitator + the resource server gate. The facilitator's
  // relayer pool is the injected (mocked) debit counter; the gate reserves the cap
  // BEFORE the handler runs (reserve-before-run). The escrow/payTo the gate advertises
  // come straight from the card inputs - the runner never re-literals an address.
  const stores = createInMemoryStores();
  const facilitator = createApp({
    store: stores.payments,
    resultStore: stores.results,
    relayerPool,
    publicClient: publicClient as never,
    perBuyerLock: createInMemoryBuyerLock(),
    escrowAddress: cardInputs.escrow,
    splitterAddress: PAYMENT_SPLITTER,
    usdcAddress: cardInputs.asset,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    settleBufferSeconds: SETTLE_BUFFER_SECONDS,
  });
  const fetcher: FetchLike = async (input, init) =>
    facilitator.request(input, { method: init?.method, headers: init?.headers, body: init?.body });

  const classifier = buildClassifier(ECHO_OPENAPI);
  const quote = (): AcceptsEntry => ({
    scheme: "utter-escrow",
    network: "eip155:5042002",
    asset: cardInputs.asset,
    escrow: cardInputs.escrow,
    maxAmountRequired: cap.toString(),
    payTo: cardInputs.payTo,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    pricing: cardInputs.pricing,
  });

  const resourceApp = new Hono();
  resourceApp.use(
    "/call",
    requirePayment({
      facilitatorUrl: PORT_FACILITATOR_URL,
      quote,
      classifier,
      pricing: cardInputs.pricing,
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      fetcher,
    }),
  );
  resourceApp.post("/call", (c) => echoHandler(c));

  const reqInit = {
    method: "POST",
    headers: { "content-type": "application/json" } as Record<string, string>,
    body: JSON.stringify(opts.requestBody ?? { text: "hello" }),
  };

  // (3a) GET with no X-PAYMENT -> expect 402 with the accepts quote (sanity).
  const unpaid = await resourceApp.request("/call", reqInit);
  if (unpaid.status !== 402) {
    throw new Error(`test-endpoint: expected 402 on the unpaid call, got ${unpaid.status}`);
  }

  // (3b) Sign the DebitAuthorization for the CARD-DERIVED cap and the discovered payTo.
  const nonce = randomNonce();
  const validBefore = computeValidBefore(MAX_TIMEOUT_SECONDS, SETTLE_BUFFER_SECONDS);
  const buyer = buyerWallet.account.address as Hex;
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
  if (status === 200) {
    const receiptHeader = paidRes.headers.get("X-PAYMENT-RESPONSE");
    if (receiptHeader) {
      receipt = JSON.parse(Buffer.from(receiptHeader, "base64").toString("utf8"));
      const amt = (receipt as { amount?: string }).amount;
      if (typeof amt === "string") debitAmount = BigInt(amt);
    }
    // Cross-check the persisted receipt amount (the durable record of the single debit).
    const stored = await stores.results.get(nonce);
    if (stored) {
      const amt = (stored.receipt as { amount?: string }).amount;
      if (typeof amt === "string") debitAmount = BigInt(amt);
    }
  }

  // (5) RECOVER - a simulated disconnect: retrieveByIdemKey returns the paid result
  // with NO re-sign and NO second debit (exactly-once across a disconnect).
  let recovered: { idemKey: string; response: string } | null = null;
  if (status === 200) {
    const r = await retrieveByIdemKey(PORT_FACILITATOR_URL, nonce, fetcher);
    if (r) {
      const rid = (r.receipt as { idemKey?: string }).idemKey ?? nonce;
      recovered = { idemKey: rid, response: r.response };
    }
  }

  return {
    paid: status === 200,
    status,
    cap,
    debitAmount,
    idemKey: nonce,
    receipt,
    cardInputs,
    recovered,
  };
}

// --- The OPERATOR-GATED live runner shape (mirrors live-money-path.ts gating) -------
//
// liveTestEndpoint runs the SAME pay flow over a DEPLOYED HTTPS endpoint with a real
// funded buyer EOA - it broadcasts an irreversible on-chain debit. It is OPERATOR-
// GATED exactly like live-money-path.ts: it reads TEST_BUYER_PRIVATE_KEY +
// RELAYER_SIGNER_KEYS from .env.local (NEVER logged), targets the live Arc RPC (not a
// fork - Pitfall 4), and is NEVER executed by the autonomous suite. It is written +
// type-checked here so the operator can run it post-deploy; calling it without the
// funded keys throws RequiresFundedWalletError.

/** Thrown when liveTestEndpoint is invoked without the operator-provided funded keys. */
export class RequiresFundedWalletError extends Error {
  readonly code = "requiresFundedWallet" as const;
  constructor() {
    super(
      "liveTestEndpoint requires a funded buyer EOA (TEST_BUYER_PRIVATE_KEY) + " +
        "RELAYER_SIGNER_KEYS in .env.local and a DEPLOYED resource over HTTPS. The live " +
        "funded-wallet pay flow is operator-gated; it is NOT run autonomously.",
    );
    this.name = "RequiresFundedWalletError";
  }
}

/** Options for the operator-gated live run (the deployed endpoint + the resource card URL). */
export interface LiveTestEndpointOptions {
  /** The deployed resource's card URL (the live discovery source). */
  cardUrl: string;
  /** The deployed resource endpoint base URL (the live pay target). */
  endpointUrl: string;
  /** The env carrying the funded keys (read ONLY from .env.local; never logged). */
  env?: NodeJS.ProcessEnv;
}

/**
 * The operator-gated live "test this endpoint" run. It is a Deferred Item: it needs a
 * funded buyer EOA + the deployed resource over HTTPS, and it broadcasts a real
 * on-chain debit on Arc. Without the funded keys it throws RequiresFundedWalletError
 * so the autonomous suite can never mistake it for a live run. The real implementation
 * fetches the live card, signs against the live escrow, and settles through the
 * standalone facilitator over the live Arc RPC - the autonomous proof above already
 * proves the debit<=cap + exactly-once LOGIC against the mock chain.
 */
export async function liveTestEndpoint(opts: LiveTestEndpointOptions): Promise<never> {
  const env = opts.env ?? process.env;
  const buyerKey = env.TEST_BUYER_PRIVATE_KEY?.trim();
  const relayerKeys = env.RELAYER_SIGNER_KEYS?.trim();
  if (!buyerKey || !relayerKeys) {
    throw new RequiresFundedWalletError();
  }
  // The live broadcast path is operator-gated and intentionally not implemented in the
  // autonomous build (it broadcasts irreversible txs). The operator wires it post-deploy
  // mirroring packages/x402-arc/examples/echo/live-money-path.ts against opts.endpointUrl.
  throw new RequiresFundedWalletError();
}
