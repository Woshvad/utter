// exactly-once suite (PAY-11): the money-path guarantee that a buyer who paid but
// lost the connection re-fetches the result WITHOUT paying again, and that exactly
// one on-chain debit ever lands per nonce.
//
// The disconnect is simulated by discarding settle's first return value (the buyer
// never saw it) and retrying by idemKey. The retry MUST short-circuit on the
// persisted result with NO second writeContract. `GET /results/:idemKey` is the
// recovery surface; here we assert the underlying resultStore that backs it.
//
// Fully offline: mocked relayer counts tx submissions, in-memory stores, stub
// public client (no live RPC).
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
  InMemoryRevenueLedger,
  signDebitAuthorization,
  type PaymentPayload,
} from "@utter/x402-arc";
import { PAYMENT_ESCROW, PAYMENT_SPLITTER, USDC, arcTestnet } from "@utter/chain";
import { settle, type SettleDeps } from "../src/settle";
import type { RelayerPool, RelayerSigner } from "../src/relayer";

const RESOURCE: Hex = `0x${"44".repeat(32)}`;

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
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 300);
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

function mockRelayerPool(state: { calls: number }): RelayerPool {
  const account = privateKeyToAccount(generatePrivateKey());
  const wallet = {
    chain: arcTestnet,
    async writeContract() {
      state.calls += 1;
      return ("0x" + "ef".repeat(32)) as Hex;
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
    async waitForTransactionReceipt() {
      return { status: "success" };
    },
    async getLogs() {
      return [];
    },
  } as unknown as PublicClient;
}

describe("exactly-once", () => {
  let store: InMemoryPaymentStore;
  let resultStore: InMemoryResultStore;
  let pk: Hex;
  let buyer: Address;

  beforeEach(() => {
    store = new InMemoryPaymentStore();
    resultStore = new InMemoryResultStore();
    pk = generatePrivateKey();
    buyer = privateKeyToAccount(pk).address;
  });

  it("settle resolves after disconnect; a retry by idemKey returns the cached receipt; exactly one debit", async () => {
    const nonce: Hex = `0x${"b1".repeat(32)}`;
    const cap = 10_000n;
    const amount = 3_000n;
    const payment = await escrowPayment({ pk, buyer, cap, nonce });
    const state = { calls: 0 };
    const deps: SettleDeps = {
      relayerPool: mockRelayerPool(state),
      store,
      resultStore,
      publicClient: mockPublicClient(),
      escrowAddress: PAYMENT_ESCROW,
      splitterAddress: PAYMENT_SPLITTER,
      usdcAddress: USDC,
    };

    // First settle: the debit lands and the result is persisted. SIMULATE DISCONNECT
    // by discarding the response the buyer never received.
    const firstReceipt = await settle(payment, amount, nonce, deps, {
      response: "{\"paid\":true}",
    });

    // The buyer retries by idemKey (never re-signs). The retry MUST serve from cache.
    const retry = await settle(payment, amount, nonce, deps, {
      response: "{\"paid\":true}",
    });

    // EXACTLY ONE on-chain debit across both attempts.
    expect(state.calls).toBe(1);
    // Identical receipt on the retry (no double-charge, no re-sign).
    expect(retry).toEqual(firstReceipt);
  });

  it("GET /results/:idemKey re-serves the paid result within TTL after disconnect; expired keys are gone", async () => {
    const nonce: Hex = `0x${"b2".repeat(32)}`;
    const cap = 10_000n;
    const payment = await escrowPayment({ pk, buyer, cap, nonce });
    const state = { calls: 0 };
    const deps: SettleDeps = {
      relayerPool: mockRelayerPool(state),
      store,
      resultStore,
      publicClient: mockPublicClient(),
      escrowAddress: PAYMENT_ESCROW,
      splitterAddress: PAYMENT_SPLITTER,
      usdcAddress: USDC,
      resultTtlSeconds: 1, // short TTL to prove expiry 404
    };

    await settle(payment, 2_000n, nonce, deps, { response: "{\"r\":1}" });

    // Within TTL: the result is recoverable (the GET /results/:idemKey path).
    const within = await resultStore.get(nonce);
    expect(within).not.toBeNull();
    expect(within?.response).toBe("{\"r\":1}");

    // After TTL: the key is gone (the 404 path). The in-memory store's lazy expiry
    // is measured from put-time + ttlSeconds, so a 0-second TTL expires the instant
    // any later get() runs (Date.now() has advanced past the put-time expiresAt).
    const expiredStore = new InMemoryResultStore();
    await expiredStore.put(
      { idemKey: nonce, response: "x", receipt: {}, storedAt: Date.now() },
      0,
    );
    expect(await expiredStore.get(nonce)).toBeNull();
  });

  it("settle < cap: debits min(computed, cap), never the full cap", async () => {
    const nonce: Hex = `0x${"b3".repeat(32)}`;
    const cap = 50_000n;
    const computed = 12_345n; // metered amount, well under cap
    const payment = await escrowPayment({ pk, buyer, cap, nonce });
    const state = { calls: 0 };
    const deps: SettleDeps = {
      relayerPool: mockRelayerPool(state),
      store,
      resultStore,
      publicClient: mockPublicClient(),
      escrowAddress: PAYMENT_ESCROW,
      splitterAddress: PAYMENT_SPLITTER,
      usdcAddress: USDC,
    };

    const receipt = await settle(payment, computed, nonce, deps);

    expect(receipt.amount).toBe("12345"); // < cap, charged the computed amount
    expect(state.calls).toBe(1);
  });

  it("records the settle into the optional revenue ledger; a retry never double-counts", async () => {
    const nonce: Hex = `0x${"b4".repeat(32)}`;
    const cap = 50_000n;
    const computed = 12_345n;
    const payment = await escrowPayment({ pk, buyer, cap, nonce });
    const state = { calls: 0 };
    const revenueLedger = new InMemoryRevenueLedger();
    const deps: SettleDeps = {
      relayerPool: mockRelayerPool(state),
      store,
      resultStore,
      publicClient: mockPublicClient(),
      escrowAddress: PAYMENT_ESCROW,
      splitterAddress: PAYMENT_SPLITTER,
      usdcAddress: USDC,
      revenueLedger,
    };

    // First settle records one row. The mock tx receipt carries no Debited logs, so the
    // legs fall back to recording the whole amount as the creator leg (the documented
    // single-payee fallback): amount === creatorShare + platformShare still holds.
    await settle(payment, computed, nonce, deps);
    const afterFirst = await revenueLedger.byResource(RESOURCE);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]?.amount).toBe(12_345n);
    expect(afterFirst[0]?.kind).toBe("settle");
    expect(afterFirst[0]!.creatorShare + afterFirst[0]!.platformShare).toBe(12_345n);

    // A retry by idemKey short-circuits on the cached result AND the ledger is idempotent
    // on idemKey, so the revenue is still exactly one row (no double-count).
    await settle(payment, computed, nonce, deps);
    expect(state.calls).toBe(1);
    expect(await revenueLedger.byResource(RESOURCE)).toHaveLength(1);
  });
});
