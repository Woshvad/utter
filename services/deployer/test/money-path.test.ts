// money-path.test.ts - the AUTONOMOUS DEP-02 money-path proof (402 unpaid -> 200 paid).
//
// This deploys the Phase 2 echo bundle (`createEchoServer`) BEHIND the injected
// `requirePayment` escrow gate and proves the deployed resource's money path
// end-to-end against an IN-PROCESS facilitator + a MOCKED chain - mirroring the
// Phase 2 [02-06] echo-money-path pattern, now from the deployer's vantage point:
//
//   Test 1 (unpaid 402): POST /echo with no X-PAYMENT -> 402 with the resource's
//           `accepts` (cap / payTo / pricing).
//   Test 2 (paid 200): a funded buyer signs an X-PAYMENT -> 200 with the echoed body,
//           an X-PAYMENT-RESPONSE receipt, and EXACTLY ONE debit <= cap.
//
// AUTONOMOUS + OFFLINE: the facilitator is `createApp` mounted in-process and the
// gate's `fetcher` routes to its `request` handler; the relayer pool is mocked (it
// counts debits) and the public client returns a funded balance + an instant
// receipt. No live RPC. The LIVE HTTPS 402->200 over the `*.resources.<domain>`
// wildcard domain is OPERATOR-GATED (Plan 06) - this proves the in-process path.
import { describe, it, expect, beforeEach } from "vitest";
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
  signDebitAuthorization,
  encodePayment,
  type Pricing,
  type PaymentPayload,
  type FetchLike,
} from "@utter/x402-arc";
import { createApp } from "@utter/facilitator/app";
import { createInMemoryBuyerLock } from "@utter/facilitator/verify";
import type { RelayerPool, RelayerSigner } from "@utter/facilitator/relayer";
import { createEchoServer } from "@utter/x402-arc/examples/echo/server";

const RESOURCE: Hex = `0x${"e6".repeat(32)}`;
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

async function signedHeader(opts: {
  pk: Hex;
  buyer: Address;
  cap: bigint;
  nonce: Hex;
}): Promise<string> {
  const account = privateKeyToAccount(opts.pk);
  const wallet = createWalletClient({
    account,
    chain: arcTestnet,
    transport: http(arcTestnet.rpcUrls.default.http[0]),
  });
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

describe("deployer money-path (DEP-02 autonomous proof)", () => {
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

  function deployEcho(cap: bigint) {
    // The DEPLOYED resource = the echo bundle behind the injected gate. createEchoServer
    // mounts the EXACT Phase 2 requirePayment gate (the same gate injectGate wraps),
    // so this exercises the deployed-resource money path in-process.
    return createEchoServer({
      facilitatorUrl: "http://facilitator.test",
      resourceId: RESOURCE,
      cap,
      pricing: PRICING,
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      fetcher,
    });
  }

  it("Test 1 (unpaid 402): POST /echo without X-PAYMENT returns 402 with the resource accepts", async () => {
    const cap = 10_000n;
    const app = deployEcho(cap);
    const res = await app.request("/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });

    expect(res.status).toBe(402);
    const body = (await res.json()) as {
      accepts: Array<{ scheme: string; maxAmountRequired?: string; payTo?: string }>;
    };
    expect(body.accepts[0]?.scheme).toBe("utter-escrow");
    expect(body.accepts[0]?.maxAmountRequired).toBe(cap.toString());
    expect(body.accepts[0]?.payTo).toBe(RESOURCE);
    // The handler never ran -> no money moved (free-compute guard, T-03-24).
    expect(debitState.debits).toBe(0);
  });

  it("Test 2 (paid 200): a paid call returns 200 + receipt + exactly one debit <= cap", async () => {
    const cap = 10_000n;
    const nonce: Hex = `0x${"e2".repeat(32)}`;
    const app = deployEcho(cap);
    const header = await signedHeader({ pk, buyer, cap, nonce });

    const res = await app.request("/echo", {
      method: "POST",
      headers: { "content-type": "application/json", "X-PAYMENT": header },
      body: JSON.stringify({ text: "hello" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ echo: "hello", length: 5 });
    expect(res.headers.get("X-PAYMENT-RESPONSE")).toBeTruthy();
    // Exactly one on-chain debit (the LIVE Debited event is operator-gated, Plan 06).
    expect(debitState.debits).toBe(1);
    const stored = await resultStore.get(nonce);
    const amount = BigInt((stored!.receipt as { amount: string }).amount);
    expect(amount <= cap).toBe(true);
  });
});
