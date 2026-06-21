// CR-02 integration suite: routeDebit WIRED into the live POST /settle path (driven
// through createApp, not routeDebit in isolation).
//
// A sub-cent /settle (debit < minEconomicalAmount) must ACCRUE into the resource's
// BatchSettler with ZERO immediate on-chain relayer debit; accumulating sub-cent settles
// to the BatchSettler trigger must yield EXACTLY ONE batched on-chain debit equal to the
// reconciled sum. An at/above-threshold /settle settles immediately as before. This is
// the regression guard for the orphaned-batch false-green: an unwired route (the bug)
// FAILS this test because every sub-cent /settle would debit immediately.
//
// Fully offline: in-memory stores + batch ledger, stub publicClient, debit-counting
// mock relayer, injected clock.
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
import { PAYMENT_ESCROW, PAYMENT_SPLITTER, USDC, arcTestnet } from "@utter/chain";
import { createApp, type AppDeps } from "../src/app";
import { createInMemoryBuyerLock } from "../src/verify";
import type { RelayerPool, RelayerSigner } from "../src/relayer";
import type { SettleDeps } from "../src/settle";
import { BatchSettler } from "../src/batch-settler";
import { InMemoryBatchLedger } from "../src/batch-ledger";

const RESOURCE: Hex = `0x${"8a".repeat(32)}`;
const CREATOR_BPS = 7000n;
const MAX_TIMEOUT_SECONDS = 30;
const SETTLE_BUFFER_SECONDS = 90;
const MIN_ECONOMICAL = 1000n; // below this a debit batches (injected threshold, no literal)

interface DebitState {
  debits: number;
}

function mockRelayerPool(state: DebitState): RelayerPool {
  const account = privateKeyToAccount(generatePrivateKey());
  const wallet = {
    chain: arcTestnet,
    async writeContract() {
      state.debits += 1;
      return ("0x" + "cd".repeat(32)) as Hex;
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

function mockPublicClient(): PublicClient {
  return {
    async readContract({ functionName }: { functionName: string }) {
      if (functionName === "balanceOf") return 50_000_000n;
      if (functionName === "usedNonce") return false;
      throw new Error(`mockPublicClient: unexpected functionName ${functionName}`);
    },
    async waitForTransactionReceipt() {
      return { status: "success" };
    },
    async getLogs() {
      return [];
    },
  } as unknown as PublicClient;
}

function makeBuyer() {
  const account = privateKeyToAccount(generatePrivateKey());
  const wallet = createWalletClient({
    account,
    chain: arcTestnet,
    transport: http(arcTestnet.rpcUrls.default.http[0]),
  });
  return { account, buyer: account.address as Address, wallet };
}

describe("CR-02: routeDebit wired into the live POST /settle (sub-cent batching)", () => {
  let store: InMemoryPaymentStore;
  let resultStore: InMemoryResultStore;
  let debitState: DebitState;
  let settleDeps: SettleDeps;
  let buyerCtx: ReturnType<typeof makeBuyer>;
  let settler: BatchSettler;
  let app: ReturnType<typeof createApp>;

  /** Sign a fresh per-nonce escrow authorization for the shared buyer. */
  async function signPayment(nonce: Hex, cap: bigint): Promise<PaymentPayload> {
    const validBefore = BigInt(
      Math.floor(Date.now() / 1000) + MAX_TIMEOUT_SECONDS + SETTLE_BUFFER_SECONDS,
    );
    const signed = await signDebitAuthorization(buyerCtx.wallet, {
      buyer: buyerCtx.buyer,
      resourceId: RESOURCE,
      maxAmount: cap,
      nonce,
      validBefore,
    });
    return {
      x402Version: 2,
      scheme: "utter-escrow",
      network: "eip155:5042002",
      authorization: {
        buyer: buyerCtx.buyer,
        resourceId: RESOURCE,
        maxAmount: cap.toString(),
        nonce,
        validBefore: validBefore.toString(),
      },
      signature: signed.signature,
    };
  }

  /** Reserve the nonce (so the reserve-precedes-settle guard passes), then POST /settle. */
  async function reserveAndSettle(payment: PaymentPayload, amount: bigint): Promise<Response> {
    await store.reserve({
      idemKey: payment.authorization.nonce as Hex,
      buyer: payment.authorization.buyer as Address,
      cap: BigInt(payment.authorization.maxAmount),
      resourceId: RESOURCE,
      expiresAt: Date.now() + 60_000,
    });
    return app.request("/settle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payment: encodePayment(payment), amount: amount.toString(), response: "{}" }),
    });
  }

  function buildApp(extra: Partial<AppDeps> = {}): ReturnType<typeof createApp> {
    return createApp({
      store,
      resultStore,
      relayerPool: mockRelayerPool(debitState),
      publicClient: mockPublicClient(),
      perBuyerLock: createInMemoryBuyerLock(),
      escrowAddress: PAYMENT_ESCROW,
      splitterAddress: PAYMENT_SPLITTER,
      usdcAddress: USDC,
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      settleBufferSeconds: SETTLE_BUFFER_SECONDS,
      // CR-02 ARMED: a per-resource BatchSettler registry + the min-economical threshold.
      batchSettler: () => settler,
      minEconomicalAmount: MIN_ECONOMICAL,
      ...extra,
    });
  }

  beforeEach(() => {
    store = new InMemoryPaymentStore();
    resultStore = new InMemoryResultStore();
    debitState = { debits: 0 };
    buyerCtx = makeBuyer();
    settleDeps = {
      relayerPool: mockRelayerPool(debitState),
      store,
      resultStore,
      publicClient: mockPublicClient(),
      escrowAddress: PAYMENT_ESCROW,
      splitterAddress: PAYMENT_SPLITTER,
      usdcAddress: USDC,
    };
    // The BatchSettler flushes at N=3 debits; each flush builds a fresh batch authorization.
    settler = new BatchSettler({
      ledger: new InMemoryBatchLedger(),
      deps: settleDeps,
      buildBatchPayment: async (batchIdemKey, amount) => ({
        payment: await signPayment(batchIdemKey, 1_000_000n),
        cap: 1_000_000n,
      }),
      resourceId: RESOURCE,
      creatorBps: CREATOR_BPS,
      maxBatchCount: 3,
      maxBatchSeconds: 9999,
      minEconomicalThreshold: 1_000_000n,
    });
    app = buildApp();
  });

  it("a sub-cent /settle ACCRUES with ZERO immediate on-chain debit (BatchSettler in the live path)", async () => {
    const nonce: Hex = `0x${"e1".repeat(32)}`;
    const payment = await signPayment(nonce, 1_000_000n);

    const res = await reserveAndSettle(payment, 10n); // 10 < MIN_ECONOMICAL -> batch

    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; batched?: boolean };
    expect(json.success).toBe(true);
    expect(json.batched).toBe(true);
    // THE GUARD: no immediate on-chain relayer debit for a sub-cent settle.
    expect(debitState.debits).toBe(0);
  });

  it("at/above-threshold /settle settles IMMEDIATELY (exactly one on-chain debit)", async () => {
    const nonce: Hex = `0x${"e2".repeat(32)}`;
    const payment = await signPayment(nonce, 1_000_000n);

    const res = await reserveAndSettle(payment, 5000n); // 5000 >= MIN_ECONOMICAL -> immediate

    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; receipt?: { amount: string } };
    expect(json.success).toBe(true);
    expect(json.receipt).toBeDefined();
    expect(debitState.debits).toBe(1);
    expect(BigInt(json.receipt!.amount)).toBe(5000n);
  });

  it("accumulating sub-cent /settle to the trigger yields EXACTLY ONE batched debit == the reconciled sum", async () => {
    const legs = [40n, 70n, 130n]; // three sub-cent debits (< MIN_ECONOMICAL each)
    for (let i = 0; i < legs.length; i++) {
      const nonce = `0x${(0xe3 + i).toString(16).padStart(2, "0").repeat(32)}` as Hex;
      const payment = await signPayment(nonce, 1_000_000n);
      const res = await reserveAndSettle(payment, legs[i]!);
      expect(res.status).toBe(200);
    }
    // The third accrual hit N=3 -> EXACTLY ONE batched on-chain debit (not three).
    expect(debitState.debits).toBe(1);
    // The batched debit equals the reconciled sum of the sub-cent debits.
    const expectedSum = legs.reduce((a, b) => a + b, 0n);
    const stored = await resultStore.get(/* the batch nonce */ (await firstBatchNonce()));
    expect(stored).not.toBeNull();
    expect(BigInt((stored!.receipt as { amount: string }).amount)).toBe(expectedSum);
  });

  it("is a NO-OP when batching is unconfigured: a sub-cent /settle settles immediately (back-compat)", async () => {
    app = buildApp({ batchSettler: undefined, minEconomicalAmount: undefined });
    const nonce: Hex = `0x${"ef".repeat(32)}`;
    const payment = await signPayment(nonce, 1_000_000n);

    const res = await reserveAndSettle(payment, 10n); // sub-cent, but batching OFF
    expect(res.status).toBe(200);
    // With batching unconfigured the debit settles immediately (the existing behavior).
    expect(debitState.debits).toBe(1);
  });

  /** The deterministic batch nonce of the first (seq 0) batch, for the result-store read. */
  async function firstBatchNonce(): Promise<Hex> {
    return settler.batchIdemKey(0);
  }
});
