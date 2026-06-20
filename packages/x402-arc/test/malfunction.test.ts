// malfunction suite (PAY-05): a handler whose output matches NEITHER the success
// nor the declared-error schema (or that times out) must NEVER be charged. The gate
// POSTs /release WITH a strikeReason; the FACILITATOR-SIDE store records the strike
// (the canonical owner - the gate records none locally), and the gate returns
// 502 (malfunction) / 504 (timeout) with ZERO debits.
//
//   Test 1 - malfunction body -> /release WITH strikeReason, 502, zero debits, the
//            facilitator strike count incremented.
//   Test 2 - timeout (handler exceeds maxTimeoutSeconds) -> /release WITH
//            strikeReason "timeout", 504, zero debits, facilitator strike incremented.
//   Test 3 - declared-error + malfunction on the same resource end with EXACTLY ONE
//            strike (only the malfunction) - the wrongful-strike guard.
//
// Fully offline: mocked relayer (counts debits), stub publicClient, in-memory stores.
// The strike count is read from the FACILITATOR store (where /release records it).
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  createWalletClient,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { PAYMENT_ESCROW, PAYMENT_SPLITTER, USDC, arcTestnet } from "@utter/chain";
import {
  InMemoryPaymentStore,
  InMemoryResultStore,
  buildClassifier,
  signDebitAuthorization,
  encodePayment,
  requirePayment,
  type Pricing,
  type AcceptsEntry,
  type PaymentPayload,
  type FetchLike,
} from "@utter/x402-arc";
import { createApp } from "@utter/facilitator/app";
import { createInMemoryBuyerLock } from "@utter/facilitator/verify";
import type { RelayerPool, RelayerSigner } from "@utter/facilitator/relayer";
import echoOpenapi from "../examples/echo/openapi.json" with { type: "json" };

const RESOURCE: Hex = `0x${"55".repeat(32)}`;
const MAX_TIMEOUT_SECONDS = 1; // 1s so the timeout case is fast
const SETTLE_BUFFER_SECONDS = 90;
const PRICING: Pricing = {
  model: "metered",
  base: "5000",
  perKB: "100",
  computeMultiplier: "200",
  maxResponseBytes: 1_048_576,
};

interface DebitState {
  debits: number;
}

function mockRelayerPool(state: DebitState): RelayerPool {
  const account = privateKeyToAccount(generatePrivateKey());
  const wallet = {
    chain: arcTestnet,
    async writeContract() {
      state.debits += 1;
      return ("0x" + "ab".repeat(32)) as Hex;
    },
  } as unknown as RelayerSigner["wallet"];
  const signer: RelayerSigner = {
    address: account.address,
    account,
    wallet,
    nonceManager: undefined as never,
  };
  return {
    signers: [signer],
    pickSigner: () => signer,
    reserveNonce: async () => 0,
    resyncNonce: async () => {},
    checkBalances: async () => [],
  };
}

function mockPublicClient(opts: { balances: Record<string, bigint> }): PublicClient {
  return {
    async readContract({ functionName, args }: { functionName: string; args: readonly unknown[] }) {
      if (functionName === "balanceOf") {
        return opts.balances[(args[0] as string).toLowerCase()] ?? 0n;
      }
      if (functionName === "usedNonce") return false;
      throw new Error(`mockPublicClient: unexpected functionName ${functionName}`);
    },
    async waitForTransactionReceipt() {
      return { status: "success" };
    },
  } as unknown as PublicClient;
}

function makeFacilitatorFetcher(deps: {
  store: InMemoryPaymentStore;
  resultStore: InMemoryResultStore;
  relayerPool: RelayerPool;
  publicClient: PublicClient;
}): FetchLike {
  const app = createApp({
    store: deps.store,
    resultStore: deps.resultStore,
    relayerPool: deps.relayerPool,
    publicClient: deps.publicClient,
    perBuyerLock: createInMemoryBuyerLock(),
    escrowAddress: PAYMENT_ESCROW,
    splitterAddress: PAYMENT_SPLITTER,
    usdcAddress: USDC,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    settleBufferSeconds: SETTLE_BUFFER_SECONDS,
  });
  return async (input, init) =>
    app.request(input, { method: init?.method, headers: init?.headers, body: init?.body });
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
    pricing: PRICING,
  };
}

/** Mount the gate in front of a handler that returns `handlerBody` (or sleeps). */
function makeGatedApp(opts: { cap: bigint; fetcher: FetchLike; handlerBody?: string; sleepMs?: number }): Hono {
  const classifier = buildClassifier({ ...(echoOpenapi as Record<string, unknown>) });
  const app = new Hono();
  app.use(
    "/echo",
    requirePayment({
      facilitatorUrl: "http://facilitator.test",
      quote: () => quote(opts.cap),
      classifier,
      pricing: PRICING,
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      fetcher: opts.fetcher,
    }),
  );
  app.post("/echo", async (c) => {
    if (opts.sleepMs) await new Promise((r) => setTimeout(r, opts.sleepMs));
    return c.body(opts.handlerBody ?? JSON.stringify({ echo: "hello", length: 5 }), 200, {
      "content-type": "application/json",
    });
  });
  return app;
}

describe("malfunction", () => {
  let store: InMemoryPaymentStore;
  let resultStore: InMemoryResultStore;
  let pk: Hex;
  let buyer: Address;
  let debitState: DebitState;
  let fetcher: FetchLike;

  beforeEach(() => {
    store = new InMemoryPaymentStore();
    resultStore = new InMemoryResultStore();
    pk = generatePrivateKey();
    buyer = privateKeyToAccount(pk).address;
    debitState = { debits: 0 };
    fetcher = makeFacilitatorFetcher({
      store,
      resultStore,
      relayerPool: mockRelayerPool(debitState),
      publicClient: mockPublicClient({ balances: { [buyer.toLowerCase()]: 1_000_000n } }),
    });
  });

  it("Test 1 (malfunction): /release WITH strikeReason, 502, zero debits, strike recorded", async () => {
    // A body matching neither schema -> malfunction.
    const malformed = JSON.stringify({ unexpected: "field", length: "not-an-integer" });
    const app = makeGatedApp({ cap: 10_000n, fetcher, handlerBody: malformed });
    const header = await signedHeader({ pk, buyer, cap: 10_000n, nonce: `0x${"c1".repeat(32)}` });
    const res = await app.request("/echo", { method: "POST", headers: { "X-PAYMENT": header } });

    expect(res.status).toBe(502);
    expect(debitState.debits).toBe(0);
    // The strike is recorded on the FACILITATOR-SIDE store (via /release), not the gate.
    expect(await store.getStrikes(RESOURCE)).toBe(1);
  });

  it("Test 2 (timeout): /release WITH strikeReason 'timeout', 504, zero debits, strike recorded", async () => {
    // Handler sleeps past maxTimeoutSeconds (1s) -> the gate times out.
    const app = makeGatedApp({ cap: 10_000n, fetcher, sleepMs: 1_200 });
    const header = await signedHeader({ pk, buyer, cap: 10_000n, nonce: `0x${"c2".repeat(32)}` });
    const res = await app.request("/echo", { method: "POST", headers: { "X-PAYMENT": header } });

    expect(res.status).toBe(504);
    expect(debitState.debits).toBe(0);
    expect(await store.getStrikes(RESOURCE)).toBe(1);
  });

  it("Test 3 (declared-error vs malfunction): exactly ONE strike across both calls", async () => {
    // Call A: a declared error (free policy) -> no strike, no debit.
    const declaredErrorBody = JSON.stringify({ error: "text must be a string", code: "BAD_INPUT" });
    const appA = makeGatedApp({ cap: 10_000n, fetcher, handlerBody: declaredErrorBody });
    const headerA = await signedHeader({ pk, buyer, cap: 10_000n, nonce: `0x${"c3".repeat(32)}` });
    const resA = await appA.request("/echo", { method: "POST", headers: { "X-PAYMENT": headerA } });
    expect(resA.status).toBe(200);

    // Call B: a malfunction -> exactly one strike total.
    const malformed = JSON.stringify({ unexpected: "field", length: "not-an-integer" });
    const appB = makeGatedApp({ cap: 10_000n, fetcher, handlerBody: malformed });
    const headerB = await signedHeader({ pk, buyer, cap: 10_000n, nonce: `0x${"c4".repeat(32)}` });
    const resB = await appB.request("/echo", { method: "POST", headers: { "X-PAYMENT": headerB } });
    expect(resB.status).toBe(502);

    // A buyer's bad input never wrongfully strikes the creator: only the malfunction struck.
    expect(await store.getStrikes(RESOURCE)).toBe(1);
    expect(debitState.debits).toBe(0);
  });
});
