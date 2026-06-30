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
import {
  erc20Abi,
  USDC,
  PAYMENT_ESCROW,
  PAYMENT_SPLITTER,
  createArcPublicClient,
  createArcWalletClientFromKey,
} from "@utter/chain";
// validateAgentCard is the STRUCTURAL A2A-shape HARD gate run BEFORE any pay input
// is read from an UNTRUSTED card (already a marketplace dep, used in card-route/publish).
import { validateAgentCard } from "@utter/ai-runtime";
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

/** Case-insensitive 0x-address equality (addresses are not case-significant). */
function eqAddr(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The STRICT card reader for the buyer-side live runner. The deployed resource's
 * card is UNTRUSTED JSON crossing a trust boundary. This MIRRORS buyer-sdk's
 * discover.ts (the marketplace cannot import buyer-sdk: circular dep): it HARD-gates
 * on validateAgentCard, then PINS the money fields against the TRUSTED @utter/chain
 * constants BEFORE reading a single pay input (T-07-CARDPOISON / CR-01 / WR-05):
 *   - x402.escrow MUST equal the canonical PAYMENT_ESCROW (case-insensitive)
 *   - x402.asset MUST equal the canonical USDC (case-insensitive)
 *   - x402.payTo MUST be a well-formed bytes32 resourceId
 *   - pricing.max MUST be a plain base-unit integer (`^\d+$`) BEFORE BigInt() so a
 *     poisoned non-numeric cap yields a clean rejection, never a raw SyntaxError
 * A card that fails any check throws and NEVER pays. The EXISTING (trusting)
 * readCardInputs stays UNCHANGED for the in-process runTestEndpoint proof.
 *
 * H4: when an `expectedResourceId` is supplied (the resource the caller asked to pay),
 * the card's x402.payTo is BOUND to it (case-insensitive bytes32 compare), mirroring the
 * buyer-sdk discover() fix. validateAgentCard + the bytes32 shape check only prove payTo
 * is well-formed; a poisoned card for a desirable endpoint could carry a valid bytes32
 * payTo pointing at an ATTACKER resource split, so binding it to the intended resourceId
 * refuses to pay before any signature is produced. With no expectedResourceId the resolved
 * payTo is returned to the caller for confirmation (no independent id to bind against).
 */
function readCardInputsStrict(
  card: Record<string, unknown>,
  expectedResourceId?: Hex,
): CardPayInputs {
  // (1) HARD GATE - validate BEFORE trusting. An invalid/poisoned card throws here
  // and NO pay input below is read (a poisoned card never pays).
  const check = validateAgentCard(card);
  if (!check.valid) {
    throw new Error(
      `liveTestEndpoint: invalid agent card (never pays): ${JSON.stringify(check.errors)}`,
    );
  }

  const x402 = (card.x402 as Record<string, unknown> | undefined) ?? {};
  const pricingRaw = (x402.pricing as Record<string, unknown> | undefined) ?? {};
  const health = (card.health as Record<string, unknown> | undefined) ?? {};
  const bond = (card.bond as Record<string, unknown> | undefined) ?? {};
  const pricing: Pricing = {
    model: "metered",
    base: typeof pricingRaw.base === "string" ? pricingRaw.base : "0",
    perKB: typeof pricingRaw.perKB === "string" ? pricingRaw.perKB : "0",
    // The card's ProjectedPricing carries no computeMultiplier; a 0 compute term keeps
    // the metered amount bounded by the signed cap regardless (deterministic + safe).
    computeMultiplier:
      typeof pricingRaw.computeMultiplier === "string" ? pricingRaw.computeMultiplier : "0",
    maxResponseBytes:
      typeof pricingRaw.maxResponseBytes === "number" ? pricingRaw.maxResponseBytes : 1_048_576,
  };

  // (2) WR-05: the cap string is UNTRUSTED. Validate it is a plain base-unit integer
  // BEFORE BigInt() so a hostile non-numeric pricing.max ("1e9", "0x10", " 5 ", "abc")
  // yields a clean rejection (fail-closed: never pays), not a raw SyntaxError.
  const capRaw = typeof pricingRaw.max === "string" ? pricingRaw.max : "0";
  if (!/^\d+$/.test(capRaw)) {
    throw new Error(
      `liveTestEndpoint: card pricing.max ${JSON.stringify(capRaw)} is not a base-unit ` +
        `integer (refusing to pay)`,
    );
  }

  // (3) CR-01: PIN the money fields against the TRUSTED on-chain constants. A
  // structurally valid card can still carry an attacker-chosen escrow/asset/payTo;
  // reject any card whose escrow != the canonical PaymentEscrow or asset != the
  // canonical USDC, and require payTo to be a well-formed bytes32. After this gate the
  // buyer only ever signs a DebitAuthorization whose verifyingContract is the real
  // escrow and whose payTo came solely from the pinned card.
  const escrow = x402.escrow;
  const asset = x402.asset;
  const payTo = x402.payTo;
  if (typeof escrow !== "string" || !eqAddr(escrow, PAYMENT_ESCROW)) {
    throw new Error(
      "liveTestEndpoint: card escrow does not match the trusted PaymentEscrow (refusing to pay)",
    );
  }
  if (typeof asset !== "string" || !eqAddr(asset, USDC)) {
    throw new Error(
      "liveTestEndpoint: card asset does not match the trusted USDC (refusing to pay)",
    );
  }
  if (typeof payTo !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(payTo)) {
    throw new Error("liveTestEndpoint: card payTo is not a bytes32 resourceId (refusing to pay)");
  }

  // (4) H4: BIND payTo to the requested resourceId when the caller named one. A
  // structurally valid bytes32 payTo can still point at an ATTACKER resource split; if
  // the caller asked to pay a specific resourceId we refuse unless the card's payTo
  // equals it (case-insensitive). With no expectedResourceId there is no independent id
  // to bind against, so the resolved payTo is returned for the caller to confirm.
  if (expectedResourceId !== undefined && !eqAddr(payTo, expectedResourceId)) {
    throw new Error(
      `liveTestEndpoint: card payTo ${payTo} does not match the requested resourceId ` +
        `${expectedResourceId} (refusing to pay)`,
    );
  }

  return {
    escrow: escrow as `0x${string}`,
    asset: asset as `0x${string}`,
    payTo: payTo as Hex,
    pricing,
    cap: BigInt(capRaw),
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

// --- The buyer-side live runner (implemented; injectable seams; offline-proven) -----
//
// liveTestEndpoint runs the SAME pay flow over a DEPLOYED HTTPS endpoint, but it is the
// BUYER-SIDE HALF only: it pays a resource whose gate already calls the DEPLOYED
// facilitator (which owns the relayer and settles). So there is NO relayer here - just
// discover -> runtime decimals -> GET 402 -> sign DebitAuthorization(cap) -> POST
// X-PAYMENT -> 200 + receipt. The chain/wallet/fetch are INJECTABLE seams: the offline
// test injects an in-process gated endpoint + a mock chain + an ephemeral wallet,
// proving the orchestration WITHOUT a real tx. The operator path builds the real funded
// wallet + real Arc client + global fetch from env and broadcasts a real debit. The
// live on-chain broadcast is operator-armed via TEST_BUYER_PRIVATE_KEY + a deployed
// resource; with no injected wallet AND no funded key the runner throws
// RequiresFundedWalletError before any network or chain call, so the autonomous suite
// (which never sets the key) can never broadcast a tx. The buyer key is read only from
// env (.env.local) and is NEVER logged or placed in a thrown message.

/** Thrown when liveTestEndpoint is invoked without an injected wallet AND no funded buyer key. */
export class RequiresFundedWalletError extends Error {
  readonly code = "requiresFundedWallet" as const;
  constructor() {
    super(
      "liveTestEndpoint requires a funded buyer EOA (TEST_BUYER_PRIVATE_KEY in " +
        ".env.local) and a DEPLOYED resource over HTTPS, or an injected buyer wallet + " +
        "public client. The live funded-wallet pay flow is operator-gated; it is NOT run " +
        "autonomously.",
    );
    this.name = "RequiresFundedWalletError";
  }
}

/** A minimal HTTP fetch shape (injectable; defaults to the global fetch in the operator path). */
type HttpFetch = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<Response>;

/** Options for the buyer-side live run (the deployed card + pay URLs, plus offline seams). */
export interface LiveTestEndpointOptions {
  /** The deployed resource's agent-card URL (the discovery source). */
  cardUrl: string;
  /** The deployed resource's pay URL (the full POST target, e.g. .../call). */
  endpointUrl: string;
  /**
   * The on-chain resourceId the caller intends to pay (bytes32). When set, the discovered
   * card's x402.payTo is BOUND to it (H4): a poisoned card whose payTo points at an
   * attacker resource split is refused before any signature. Omitted -> the card is
   * trusted by its URL and the resolved payTo is returned for the caller to confirm.
   */
  resourceId?: Hex;
  /** Optional override request payload sent to the resource (defaults to a benign echo body). */
  requestBody?: unknown;
  /** The env carrying the funded buyer key (read ONLY from .env.local; never logged). */
  env?: NodeJS.ProcessEnv;
  /** Injectable HTTP transport (the OFFLINE test seam). Omitted -> the global fetch. */
  fetcher?: HttpFetch;
  /** Injectable chain read client (the OFFLINE test seam). Omitted -> built real from env. */
  publicClient?: RunnerPublicClient;
  /** Injectable buyer wallet (the OFFLINE test seam). Omitted -> built real from the funded key. */
  buyerWallet?: SignerWalletClient;
}

/** The A2A card path suffix (EXACTLY this - never agent.json; Pitfall 5). */
const CARD_PATH = "/.well-known/agent-card.json";

/**
 * The buyer-side live "test this endpoint" run. It discovers the deployed resource's
 * card, validates + pins it (readCardInputsStrict: a poisoned card throws and NEVER
 * pays), derives token precision from a RUNTIME decimals() read (no decimals literal in
 * any amount path), then runs GET 402 -> signDebitAuthorization(cap) -> POST X-PAYMENT
 * -> 200 + the X-PAYMENT-RESPONSE receipt against the DEPLOYED gate (which owns the
 * relayer and enforces reserve-before-run / exactly-once - unchanged here). The signed
 * maxAmount is the card cap, so the on-chain debit is min(computed, cap).
 *
 * Seams: the offline test injects fetcher + publicClient + buyerWallet to prove the
 * orchestration with NO real tx. The operator path omits them: it builds the real funded
 * wallet from TEST_BUYER_PRIVATE_KEY + a real Arc public client + the global fetch and
 * broadcasts a real debit. With no injected wallet AND no funded key it throws
 * RequiresFundedWalletError BEFORE any network or chain call (the autonomous guard).
 */
export async function liveTestEndpoint(
  opts: LiveTestEndpointOptions,
): Promise<TestEndpointResult> {
  const env = opts.env ?? process.env;
  const fetcher: HttpFetch =
    opts.fetcher ?? ((input, init) => fetch(input, init as RequestInit));

  // (0) Resolve the buyer wallet + chain read client. If either is missing we build it
  // from the operator-provided funded key; with NO key AND nothing injected we throw
  // BEFORE any network or chain call so the autonomous suite can never broadcast a tx.
  // RELAYER_SIGNER_KEYS is NOT needed here - the DEPLOYED facilitator owns the relayer;
  // this is buyer-side only. The key is read only from env and is never logged.
  let buyerWallet = opts.buyerWallet;
  let publicClient = opts.publicClient;
  if (!buyerWallet || !publicClient) {
    const key = env.TEST_BUYER_PRIVATE_KEY?.trim();
    if (!key) throw new RequiresFundedWalletError();
    const rpc = env.ARC_RPC_URL;
    publicClient = publicClient ?? (createArcPublicClient(rpc) as RunnerPublicClient);
    buyerWallet = buyerWallet ?? createArcWalletClientFromKey(key as Hex, rpc);
  }

  // (1) DISCOVER - fetch the deployed resource's card (the SOLE source of every pay
  // input). Append the A2A card path only if absent (mirrors discover.ts).
  const cardUrl = opts.cardUrl.endsWith(CARD_PATH) ? opts.cardUrl : opts.cardUrl + CARD_PATH;
  const res = await fetcher(cardUrl, { method: "GET" });
  if (res.status !== 200) {
    throw new Error(`liveTestEndpoint: ${opts.cardUrl} is not discoverable (status ${res.status})`);
  }
  const card = (await res.json()) as Record<string, unknown>;
  // VALIDATE + PIN BEFORE any pay input is used (T-07-CARDPOISON). A poisoned card
  // throws here and the buyer never signs or pays. When the caller named a resourceId the
  // payTo is BOUND to it (H4: a mismatched recipient is refused before any signature).
  const cardInputs = readCardInputsStrict(card, opts.resourceId);

  // (2) CAP + runtime decimals (Pitfall 3 - never a decimals literal in the amount
  // path). The cap value is the card's base-unit pricing.max; the runtime decimals()
  // read is the precision witness that token precision is resolved at runtime, not 6.
  const decimals = (await publicClient.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "decimals",
  })) as number;
  void (10n ** BigInt(decimals));
  const cap = cardInputs.cap;
  if (cap <= 0n) {
    throw new Error(`liveTestEndpoint: card pricing.max ${cap} is not a positive cap`);
  }

  // (3) The request payload (a benign echo body unless overridden).
  const reqInit = {
    method: "POST",
    headers: { "content-type": "application/json" } as Record<string, string>,
    body: JSON.stringify(opts.requestBody ?? { text: "hello" }),
  };

  // (3a) GET with no X-PAYMENT -> expect 402 with the accepts quote (sanity).
  const unpaid = await fetcher(opts.endpointUrl, reqInit);
  if (unpaid.status !== 402) {
    throw new Error(`liveTestEndpoint: expected 402 on the unpaid call, got ${unpaid.status}`);
  }

  // (3b) Sign the DebitAuthorization for the CARD-DERIVED cap and the discovered payTo.
  // The signed maxAmount is the cap, so the deployed gate debits min(computed, cap).
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

  // (3c) Re-POST with X-PAYMENT -> 200 + the X-PAYMENT-RESPONSE receipt. The DEPLOYED
  // gate + facilitator trigger the single escrow debit via /settle (the only money move).
  const paidRes = await fetcher(opts.endpointUrl, {
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
  }

  // `recovered` is null here: the disconnect-recovery assertion is a
  // runTestEndpoint-internal-store check; the DEPLOYED facilitator's /results is not
  // addressed by this buyer-side runner (exactly-once is enforced by the deployed gate).
  return {
    paid: status === 200,
    status,
    cap,
    debitAmount,
    idemKey: nonce,
    receipt,
    cardInputs,
    recovered: null,
  };
}
