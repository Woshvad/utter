// CR-01 integration suite: the spend-cap gate WIRED into the live POST /verify path
// (driven through createApp, not the helper in isolation).
//
// The free-compute guard MUST hold END TO END: an over-cap payer hitting the live
// /verify is rejected 402 over_cap with the reservation store showing ZERO reservations
// (no cap reserved, no compute would run), while an under-cap payer reserves normally.
// This is the regression guard for the Phase 6/7 "built-and-tested-but-not-wired"
// false-green: the gate is exercised through the real Hono route + AppDeps, so an
// unwired gate (the bug) FAILS this test.
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

describe("CR-01: spend-cap gate wired into the live POST /verify (free-compute guard)", () => {
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
      // The gate is ARMED: a store + a per-payer cap are configured.
      spendCapStore,
      perPayerDayCap: PER_PAYER_DAY_CAP,
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
    app = buildApp();
  });

  it("DENIES an over-cap payer at /verify (402 over_cap) with ZERO reservations (free-compute holds end-to-end)", async () => {
    // Pre-fill the payer's 24h window to the cap so the next call is over-cap.
    await spendCapStore.recordSpend(buyer.toLowerCase(), PER_PAYER_DAY_CAP, Math.floor(Date.now() / 1000));

    const nonce: Hex = `0x${"d1".repeat(32)}`;
    // This call's maxAmount cap would push the payer over the rolling-24h cap.
    const payment = await escrowPayment({ pk, buyer, cap: 200_000n, nonce });

    const res = await postVerify(payment);

    expect(res.status).toBe(402);
    const json = (await res.json()) as { valid: boolean; reason: string };
    expect(json.valid).toBe(false);
    expect(json.reason).toBe("over_cap");
    // THE GUARD: NO reservation was created - the over-cap payer consumed zero compute.
    expect(await store.isNoncePending(nonce)).toBe(false);
    expect(await store.outstandingReserved(buyer)).toBe(0n);
  });

  it("ALLOWS an under-cap payer at /verify (200) and reserves the cap normally", async () => {
    const nonce: Hex = `0x${"d2".repeat(32)}`;
    const cap = 300_000n; // well under the 1 USDC per-payer cap
    const payment = await escrowPayment({ pk, buyer, cap, nonce });

    const res = await postVerify(payment);

    expect(res.status).toBe(200);
    const json = (await res.json()) as { valid: boolean };
    expect(json.valid).toBe(true);
    // The reservation exists (the under-cap call reserved the cap normally).
    expect(await store.isNoncePending(nonce)).toBe(true);
    expect(await store.outstandingReserved(buyer)).toBe(cap);
    // The spend is now held against the payer's window for the next gate check.
    const rolling = await spendCapStore.recordSpend(buyer.toLowerCase(), 0n, Math.floor(Date.now() / 1000));
    expect(rolling).toBe(cap);
  });

  it("is a NO-OP when the gate is unconfigured: /verify reserves without any cap check (back-compat)", async () => {
    // No spendCapStore / perPayerDayCap -> the gate is not armed (existing behavior).
    app = buildApp({ spendCapStore: undefined, perPayerDayCap: undefined });
    const nonce: Hex = `0x${"d3".repeat(32)}`;
    // An amount that WOULD be over the cap if the (now-unarmed) gate ran.
    const payment = await escrowPayment({ pk, buyer, cap: 5_000_000n, nonce });

    const res = await postVerify(payment);

    expect(res.status).toBe(200);
    expect(await store.isNoncePending(nonce)).toBe(true);
  });
});
