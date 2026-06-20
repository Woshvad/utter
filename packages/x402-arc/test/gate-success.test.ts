// gate-success suite (PAY-04): the escrow response gate against the REAL facilitator
// app mounted in-process. These prove the load-bearing money-path invariants:
//   Test 1 - no X-PAYMENT -> 402 with an `accepts` array advertising the escrow option.
//   Test 2 - RESERVE PRECEDES RUN: /verify is invoked BEFORE the handler body runs
//            (the free-compute hard rule; the handler never runs unverified).
//   Test 3 - a valid success -> 200 with the ORIGINAL body, an X-PAYMENT-RESPONSE
//            receipt header, and EXACTLY ONE debit at the facilitator with amount <= cap.
//   Test 4 - the client body equals the handler body byte-for-byte (clone-before-read).
//   Test 5 - retrieveByIdemKey(url, nonce) after a success returns the same receipt
//            with NO new debit.
//
// Fully offline: the facilitator's relayer pool is mocked (counts writeContract),
// the publicClient returns controlled balanceOf/usedNonce + an instant receipt, and
// the in-memory stores are the test default. The gate's `fetcher` is wired to the
// in-process Hono app's `request` so /verify and /settle exercise the real routes.
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
  retrieveByIdemKey,
  type Pricing,
  type AcceptsEntry,
  type PaymentPayload,
  type FetchLike,
} from "@utter/x402-arc";
import { createApp } from "@utter/facilitator/app";
import { createInMemoryBuyerLock } from "@utter/facilitator/verify";
import type { RelayerPool, RelayerSigner } from "@utter/facilitator/relayer";
import echoOpenapi from "../examples/echo/openapi.json" with { type: "json" };

const RESOURCE: Hex = `0x${"44".repeat(32)}`;
const MAX_TIMEOUT_SECONDS = 30;
const SETTLE_BUFFER_SECONDS = 90;
const PRICING: Pricing = {
  model: "metered",
  base: "5000",
  perKB: "100",
  computeMultiplier: "200",
  maxResponseBytes: 1_048_576,
};

/** A debit counter the mocked relayer increments per writeContract (one per settle). */
interface DebitState {
  debits: number;
}

/** A mocked relayer pool: writeContract counts debits and returns a fixed tx hash. */
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

/** A stub public client: a funded buyer, no used nonces, instant tx receipts. */
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

/** Build the facilitator app + a fetcher routing the gate's POSTs to it in-process. */
function makeFacilitator(deps: {
  store: InMemoryPaymentStore;
  resultStore: InMemoryResultStore;
  relayerPool: RelayerPool;
  publicClient: PublicClient;
}): { fetcher: FetchLike } {
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
  const fetcher: FetchLike = async (input, init) =>
    app.request(input, {
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
    });
  return { fetcher };
}

/** Build a wallet client for a fresh local account. */
function makeSigner(pk: Hex) {
  const account = privateKeyToAccount(pk);
  const wallet = createWalletClient({
    account,
    chain: arcTestnet,
    transport: http(arcTestnet.rpcUrls.default.http[0]),
  });
  return { account, wallet };
}

/** Build + sign an escrow PaymentPayload for a buyer, then base64 it for X-PAYMENT. */
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

/** The escrow `accepts` entry the gate quotes for this resource. */
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

/** Mount the gate in front of an echo handler; `onHandlerRun` fires when it executes. */
function makeGatedApp(opts: {
  cap: bigint;
  fetcher: FetchLike;
  onHandlerRun?: () => void;
  handlerBody?: string;
}): Hono {
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
  app.post("/echo", (c) => {
    opts.onHandlerRun?.();
    return c.body(opts.handlerBody ?? JSON.stringify({ echo: "hello", length: 5 }), 200, {
      "content-type": "application/json",
    });
  });
  return app;
}

describe("gate-success", () => {
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
    fetcher = makeFacilitator({
      store,
      resultStore,
      relayerPool: mockRelayerPool(debitState),
      publicClient: mockPublicClient({ balances: { [buyer.toLowerCase()]: 1_000_000n } }),
    }).fetcher;
  });

  it("Test 1 (402 challenge): no X-PAYMENT returns 402 with an escrow accepts entry", async () => {
    const app = makeGatedApp({ cap: 10_000n, fetcher });
    const res = await app.request("/echo", { method: "POST" });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { accepts: AcceptsEntry[] };
    expect(Array.isArray(body.accepts)).toBe(true);
    expect(body.accepts[0]?.scheme).toBe("utter-escrow");
    expect(body.accepts[0]?.network).toBe("eip155:5042002");
    expect(body.accepts[0]?.maxAmountRequired).toBe("10000");
    expect(debitState.debits).toBe(0);
  });

  it("Test 2 (reserve before run): /verify (reservation) runs BEFORE the handler", async () => {
    const events: string[] = [];
    const order = { verified: false };
    // Wrap the fetcher to record when /verify completes.
    const trackingFetcher: FetchLike = async (input, init) => {
      const res = await fetcher(input, init);
      if (input.includes("/verify")) {
        order.verified = true;
        events.push("verify");
      }
      return res;
    };
    const app = makeGatedApp({
      cap: 10_000n,
      fetcher: trackingFetcher,
      onHandlerRun: () => {
        // The handler must only ever run AFTER a successful /verify reservation.
        expect(order.verified).toBe(true);
        events.push("handler");
      },
    });
    const header = await signedHeader({ pk, buyer, cap: 10_000n, nonce: `0x${"b1".repeat(32)}` });
    const res = await app.request("/echo", { method: "POST", headers: { "X-PAYMENT": header } });
    expect(res.status).toBe(200);
    expect(events).toEqual(["verify", "handler"]);
  });

  it("Test 3 (success settle): 200 + receipt header + exactly one debit <= cap", async () => {
    const cap = 10_000n;
    const app = makeGatedApp({ cap, fetcher });
    const header = await signedHeader({ pk, buyer, cap, nonce: `0x${"b3".repeat(32)}` });
    const res = await app.request("/echo", { method: "POST", headers: { "X-PAYMENT": header } });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-PAYMENT-RESPONSE")).toBeTruthy();
    expect(debitState.debits).toBe(1);
    // The persisted receipt records amount <= cap.
    const stored = await resultStore.get(`0x${"b3".repeat(32)}`);
    expect(stored).not.toBeNull();
    const amount = BigInt((stored!.receipt as { amount: string }).amount);
    expect(amount <= cap).toBe(true);
  });

  it("Test 4 (body not consumed): client body equals the handler body byte-for-byte", async () => {
    const cap = 10_000n;
    const handlerBody = JSON.stringify({ echo: "exact-bytes-here", length: 16 });
    const app = makeGatedApp({ cap, fetcher, handlerBody });
    const header = await signedHeader({ pk, buyer, cap, nonce: `0x${"b4".repeat(32)}` });
    const res = await app.request("/echo", { method: "POST", headers: { "X-PAYMENT": header } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(handlerBody);
  });

  it("Test 5 (idempotent retrieve): retrieveByIdemKey returns the same receipt, no new debit", async () => {
    const cap = 10_000n;
    const nonce: Hex = `0x${"b5".repeat(32)}`;
    const app = makeGatedApp({ cap, fetcher });
    const header = await signedHeader({ pk, buyer, cap, nonce });
    const res = await app.request("/echo", { method: "POST", headers: { "X-PAYMENT": header } });
    expect(res.status).toBe(200);
    expect(debitState.debits).toBe(1);

    const retrieved = await retrieveByIdemKey("http://facilitator.test", nonce, fetcher);
    expect(retrieved).not.toBeNull();
    expect((retrieved!.receipt as { idemKey: string }).idemKey).toBe(nonce);
    // No second debit on retrieval (the buyer never re-signs).
    expect(debitState.debits).toBe(1);
  });
});
