// declared-error suite (PAY-06): a VALID declared error (the resource's own bad-
// buyer-input schema) under the FREE error policy must release the reservation
// WITHOUT a strikeReason - so the buyer is charged NOTHING (zero debits) and the
// creator is NOT struck (the wrongful-strike guard) - and the ORIGINAL handler body
// is served unchanged (200).
//
//   Test 1 - declared error (free) -> 200, ZERO debits, ZERO strikes, body served.
//   Test 2 - the served body equals the handler's declared-error body byte-for-byte
//            (clone-before-read holds on the non-success path too).
//
// Fully offline: mocked relayer (counts debits), stub publicClient, in-memory stores;
// the strike count is read from the FACILITATOR store (where /release would record it).
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

const RESOURCE: Hex = `0x${"66".repeat(32)}`;
const MAX_TIMEOUT_SECONDS = 30;
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

function makeGatedApp(opts: { cap: bigint; fetcher: FetchLike; handlerBody: string }): Hono {
  const classifier = buildClassifier({ ...(echoOpenapi as Record<string, unknown>) });
  const app = new Hono();
  app.use(
    "/echo",
    requirePayment({
      facilitatorUrl: "http://facilitator.test",
      quote: () => quote(opts.cap),
      classifier,
      pricing: PRICING,
      errorPolicy: "free",
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      fetcher: opts.fetcher,
    }),
  );
  app.post("/echo", (c) =>
    c.body(opts.handlerBody, 200, { "content-type": "application/json" }),
  );
  return app;
}

describe("declared-error", () => {
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

  it("Test 1 (declared error, free): 200, zero debits, zero strikes, body served", async () => {
    const declaredErrorBody = JSON.stringify({ error: "text must be a string", code: "BAD_INPUT" });
    const app = makeGatedApp({ cap: 10_000n, fetcher, handlerBody: declaredErrorBody });
    const header = await signedHeader({ pk, buyer, cap: 10_000n, nonce: `0x${"d1".repeat(32)}` });
    const res = await app.request("/echo", { method: "POST", headers: { "X-PAYMENT": header } });

    expect(res.status).toBe(200);
    expect(debitState.debits).toBe(0);
    expect(await store.getStrikes(RESOURCE)).toBe(0);
    // No receipt header: the buyer was not charged.
    expect(res.headers.get("X-PAYMENT-RESPONSE")).toBeNull();
  });

  it("Test 2 (body served intact): the declared-error body is returned byte-for-byte", async () => {
    const declaredErrorBody = JSON.stringify({ error: "exact declared error bytes", code: "BAD_INPUT" });
    const app = makeGatedApp({ cap: 10_000n, fetcher, handlerBody: declaredErrorBody });
    const header = await signedHeader({ pk, buyer, cap: 10_000n, nonce: `0x${"d2".repeat(32)}` });
    const res = await app.request("/echo", { method: "POST", headers: { "X-PAYMENT": header } });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(declaredErrorBody);
    expect(debitState.debits).toBe(0);
    expect(await store.getStrikes(RESOURCE)).toBe(0);
  });
});
