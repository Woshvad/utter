// Compliance integration suite: the payer sanctions screen WIRED into the live POST
// /verify path (driven through createApp, not the screen in isolation).
//
// The free-compute ordering MUST hold END TO END: a screened (sanctioned) buyer hitting
// the live /verify is rejected 403 payer_screened with the reservation store showing ZERO
// reservations (no cap reserved, no compute would run) AND no spend recorded when a
// spend-cap store is also present (the screen runs BEFORE both). An allowed buyer proceeds
// to a normal 200 reserve. A screen whose isAllowed THROWS denies (fail-closed) with no
// reservation. This is the regression guard against an unwired screen (a false-green) and
// against the screen accidentally landing AFTER the reserve/spend-cap.
//
// Fully offline: in-memory stores + spend-cap store, stub publicClient, mocked relayer.
import { describe, it, expect, beforeEach } from "vitest";
import {
  createWalletClient,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  InMemoryPaymentStore,
  InMemoryResultStore,
  signDebitAuthorization,
  encodePayment,
  type PaymentPayload,
} from "@utter/x402-arc";
import { InMemorySpendCapStore } from "@utter/data-proxy";
import { PAYMENT_ESCROW, PAYMENT_SPLITTER, USDC, arcTestnet } from "@utter/chain";
import { createApp, type AppDeps } from "../src/app";
import { createInMemoryBuyerLock } from "../src/verify";
import { createPayerScreenFromList, type PayerScreen } from "../src/payer-screen";
import type { RelayerPool, RelayerSigner } from "../src/relayer";

const RESOURCE: Hex = `0x${"77".repeat(32)}`;
const MAX_TIMEOUT_SECONDS = 30;
const SETTLE_BUFFER_SECONDS = 90;
const PER_PAYER_DAY_CAP = 1_000_000n; // 1 USDC at 6dp (read at runtime, never hardcoded)

function mockRelayerPool(): RelayerPool {
  const account = privateKeyToAccount(generatePrivateKey());
  const wallet = {
    chain: arcTestnet,
    async writeContract() {
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

function mockPublicClient(balances: Record<string, bigint>): PublicClient {
  return {
    async readContract({ functionName, args }: { functionName: string; args: readonly unknown[] }) {
      if (functionName === "balanceOf") {
        return balances[(args[0] as string).toLowerCase()] ?? 0n;
      }
      if (functionName === "usedNonce") return false;
      throw new Error(`mockPublicClient: unexpected functionName ${functionName}`);
    },
    async waitForTransactionReceipt() {
      return { status: "success" };
    },
  } as unknown as PublicClient;
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

async function escrowPayment(opts: {
  pk: Hex;
  buyer: Address;
  cap: bigint;
  nonce: Hex;
}): Promise<PaymentPayload> {
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
  return {
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
}

/** A screen whose isAllowed always throws (a feed read failure) - the gate must DENY. */
const throwingScreen: PayerScreen = {
  async isAllowed(): Promise<boolean> {
    throw new Error("sanctions feed unavailable");
  },
};

describe("Compliance: payer sanctions screen wired into the live POST /verify", () => {
  let store: InMemoryPaymentStore;
  let spendCapStore: InMemorySpendCapStore;
  let pk: Hex;
  let buyer: Address;
  let app: ReturnType<typeof createApp>;

  function buildApp(extra: Partial<AppDeps> = {}): ReturnType<typeof createApp> {
    return createApp({
      store,
      resultStore: new InMemoryResultStore(),
      relayerPool: mockRelayerPool(),
      publicClient: mockPublicClient({ [buyer.toLowerCase()]: 50_000_000n }),
      perBuyerLock: createInMemoryBuyerLock(),
      escrowAddress: PAYMENT_ESCROW,
      splitterAddress: PAYMENT_SPLITTER,
      usdcAddress: USDC,
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      settleBufferSeconds: SETTLE_BUFFER_SECONDS,
      ...extra,
    });
  }

  async function postVerify(payment: PaymentPayload): Promise<Response> {
    return app.request("/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payment: encodePayment(payment), resourceId: RESOURCE }),
    });
  }

  beforeEach(() => {
    store = new InMemoryPaymentStore();
    spendCapStore = new InMemorySpendCapStore();
    pk = generatePrivateKey();
    buyer = privateKeyToAccount(pk).address;
  });

  it("DENIES a screened buyer at /verify (403 payer_screened) with ZERO reservation", async () => {
    // The screen denies exactly this buyer.
    app = buildApp({ payerScreen: createPayerScreenFromList([buyer]) });
    const nonce: Hex = `0x${"e1".repeat(32)}`;
    const payment = await escrowPayment({ pk, buyer, cap: 300_000n, nonce });

    const res = await postVerify(payment);

    expect(res.status).toBe(403);
    const json = (await res.json()) as { valid: boolean; reason: string };
    expect(json.valid).toBe(false);
    expect(json.reason).toBe("payer_screened");
    // THE GUARD: NO reservation was created - the screened payer consumed zero compute.
    expect(await store.isNoncePending(nonce)).toBe(false);
    expect(await store.outstandingReserved(buyer)).toBe(0n);
  });

  it("a screened buyer records NO spend even when a spend-cap store is present (screen runs BEFORE the cap)", async () => {
    app = buildApp({
      payerScreen: createPayerScreenFromList([buyer]),
      spendCapStore,
      perPayerDayCap: PER_PAYER_DAY_CAP,
    });
    const nonce: Hex = `0x${"e2".repeat(32)}`;
    const payment = await escrowPayment({ pk, buyer, cap: 300_000n, nonce });

    const res = await postVerify(payment);

    expect(res.status).toBe(403);
    const json = (await res.json()) as { reason: string };
    expect(json.reason).toBe("payer_screened");
    // No reservation, and no spend held against the payer's rolling-24h window: the
    // screen short-circuited BEFORE the spend-cap gate's tryRecordSpend.
    expect(await store.isNoncePending(nonce)).toBe(false);
    const rolling = await spendCapStore.recordSpend(
      buyer.toLowerCase(),
      0n,
      Math.floor(Date.now() / 1000),
    );
    expect(rolling).toBe(0n);
  });

  it("ALLOWS a non-screened buyer at /verify (200) and reserves normally", async () => {
    // The denylist holds a DIFFERENT address; this buyer is allowed.
    const other = "0x000000000000000000000000000000000000dead";
    app = buildApp({ payerScreen: createPayerScreenFromList([other]) });
    const nonce: Hex = `0x${"e3".repeat(32)}`;
    const cap = 300_000n;
    const payment = await escrowPayment({ pk, buyer, cap, nonce });

    const res = await postVerify(payment);

    expect(res.status).toBe(200);
    const json = (await res.json()) as { valid: boolean };
    expect(json.valid).toBe(true);
    expect(await store.isNoncePending(nonce)).toBe(true);
    expect(await store.outstandingReserved(buyer)).toBe(cap);
  });

  it("DENIES (fail-closed) when the screen THROWS, with ZERO reservation", async () => {
    app = buildApp({ payerScreen: throwingScreen });
    const nonce: Hex = `0x${"e4".repeat(32)}`;
    const payment = await escrowPayment({ pk, buyer, cap: 300_000n, nonce });

    const res = await postVerify(payment);

    expect(res.status).toBe(403);
    const json = (await res.json()) as { reason: string };
    expect(json.reason).toBe("payer_screened");
    // A screen outage must NOT open an unscreened reserve.
    expect(await store.isNoncePending(nonce)).toBe(false);
    expect(await store.outstandingReserved(buyer)).toBe(0n);
  });

  it("is a NO-OP when no screen is configured: /verify reserves as before (back-compat)", async () => {
    app = buildApp(); // no payerScreen
    const nonce: Hex = `0x${"e5".repeat(32)}`;
    const payment = await escrowPayment({ pk, buyer, cap: 300_000n, nonce });

    const res = await postVerify(payment);

    expect(res.status).toBe(200);
    expect(await store.isNoncePending(nonce)).toBe(true);
  });
});
