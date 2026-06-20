// idempotent suite (PAY-08, PAY-09, PAY-11): /settle submits EXACTLY ONE on-chain
// tx per nonce and is idempotent on the nonce. These run fully offline: a mocked
// relayer pool counts writeContract calls (and can simulate a NonceUsed revert),
// the in-memory PaymentStore/ResultStore are the test default, and a stubbed
// publicClient returns controlled receipts + Debited logs (no live RPC).
//
// Proven here: a single escrow debit (Test 1), idempotent repeat -> SAME receipt,
// exactly one writeContract (Test 2), the exact path -> scheme:"exact" (Test 3),
// and the NonceUsed retry-after-crash rebuilds the receipt from the Debited event
// with NO second tx (Test 4).
import { describe, it, expect, beforeEach } from "vitest";
import {
  createWalletClient,
  http,
  encodeEventTopics,
  encodeAbiParameters,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  InMemoryPaymentStore,
  InMemoryResultStore,
  signDebitAuthorization,
  signExactTransfer,
  type PaymentPayload,
} from "@utter/x402-arc";
import {
  PAYMENT_ESCROW,
  PAYMENT_SPLITTER,
  USDC,
  arcTestnet,
  escrowAbi,
} from "@utter/chain";
import { settle, type ExactSettlePayload, type SettleDeps } from "../src/settle";
import type { RelayerPool, RelayerSigner } from "../src/relayer";

const RESOURCE: Hex = `0x${"33".repeat(32)}`;

/** Build a wallet client for a fresh local account (to produce a real signature). */
function makeSigner(pk: Hex) {
  const account = privateKeyToAccount(pk);
  const wallet = createWalletClient({
    account,
    chain: arcTestnet,
    transport: http(arcTestnet.rpcUrls.default.http[0]),
  });
  return { account, wallet };
}

/** A signed escrow PaymentPayload for a buyer. */
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

/**
 * A mocked relayer pool. `writeContract` increments a shared counter and returns a
 * deterministic tx hash; if `revertWith` is set the NEXT writeContract throws it
 * (to simulate the on-chain NonceUsed replay guard tripping on a retry).
 */
function mockRelayerPool(state: { calls: number; revertWith?: Error }): RelayerPool {
  const account = privateKeyToAccount(generatePrivateKey());
  const wallet = {
    chain: arcTestnet,
    async writeContract() {
      state.calls += 1;
      if (state.revertWith) {
        const e = state.revertWith;
        state.revertWith = undefined;
        throw e;
      }
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

/**
 * A stub public client: `waitForTransactionReceipt` resolves immediately, and
 * `getLogs` returns the seeded Debited logs (used by the NonceUsed rebuild path).
 */
function mockPublicClient(opts: {
  debited?: { buyer: Address; amount: bigint; nonce: Hex; tx: Hex };
}): PublicClient {
  function debitedLog() {
    if (!opts.debited) return null;
    const topics = encodeEventTopics({
      abi: escrowAbi,
      eventName: "Debited",
      args: { resourceId: RESOURCE, buyer: opts.debited.buyer },
    });
    const data = encodeAbiParameters(
      [
        { name: "amount", type: "uint256" },
        { name: "toCreator", type: "uint256" },
        { name: "toTreasury", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
      [opts.debited.amount, 0n, opts.debited.amount, opts.debited.nonce],
    );
    return { address: PAYMENT_ESCROW, data, topics, transactionHash: opts.debited.tx };
  }
  return {
    async waitForTransactionReceipt() {
      return { status: "success" };
    },
    async getBlockNumber() {
      return 10_000n;
    },
    async getTransactionReceipt() {
      const log = debitedLog();
      return { logs: log ? [log] : [] };
    },
    async getLogs() {
      if (!opts.debited) return [];
      // Build the Debited log by hand (viem 2.52.2 has no encodeEventLog): the
      // indexed fields (resourceId, buyer) become topics; the non-indexed fields
      // (amount, toCreator, toTreasury, nonce) become the data payload. This is the
      // exact shape decodeEventLog (used in settle.ts) parses.
      const topics = encodeEventTopics({
        abi: escrowAbi,
        eventName: "Debited",
        args: { resourceId: RESOURCE, buyer: opts.debited.buyer },
      });
      const data = encodeAbiParameters(
        [
          { name: "amount", type: "uint256" },
          { name: "toCreator", type: "uint256" },
          { name: "toTreasury", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
        [opts.debited.amount, 0n, opts.debited.amount, opts.debited.nonce],
      );
      return [
        {
          address: PAYMENT_ESCROW,
          data,
          topics,
          transactionHash: opts.debited.tx,
        },
      ];
    },
  } as unknown as PublicClient;
}

function makeDeps(overrides: Partial<SettleDeps> & Pick<SettleDeps, "relayerPool" | "publicClient" | "store" | "resultStore">): SettleDeps {
  return {
    escrowAddress: PAYMENT_ESCROW,
    splitterAddress: PAYMENT_SPLITTER,
    usdcAddress: USDC,
    ...overrides,
  };
}

describe("idempotent", () => {
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

  it("Test 1 (escrow settle): one debit, receipt returned, persisted before resolve", async () => {
    const nonce: Hex = `0x${"a1".repeat(32)}`;
    const cap = 10_000n;
    const amount = 4_000n; // < cap
    const payment = await escrowPayment({ pk, buyer, cap, nonce });
    const state = { calls: 0 };
    const deps = makeDeps({
      relayerPool: mockRelayerPool(state),
      publicClient: mockPublicClient({}),
      store,
      resultStore,
    });

    const receipt = await settle(payment, amount, nonce, deps, { response: "{\"ok\":true}" });

    expect(state.calls).toBe(1);
    expect(receipt.scheme).toBe("utter-escrow");
    expect(receipt.payer.toLowerCase()).toBe(buyer.toLowerCase());
    expect(receipt.amount).toBe("4000"); // min(computed, cap)
    expect(receipt.idemKey).toBe(nonce);
    // Persist-before-respond: the result is populated at the moment settle resolves.
    const stored = await resultStore.get(nonce);
    expect(stored).not.toBeNull();
    expect(stored?.response).toBe("{\"ok\":true}");
    expect((stored?.receipt as { tx: string }).tx).toBe(receipt.tx);
    // The reservation/nonce is consumed (marked spent).
    expect(await store.isNoncePending(nonce)).toBe(false);
  });

  it("Test 2 (idempotent repeat): same idemKey returns the SAME receipt, exactly one tx", async () => {
    const nonce: Hex = `0x${"a2".repeat(32)}`;
    const cap = 10_000n;
    const payment = await escrowPayment({ pk, buyer, cap, nonce });
    const state = { calls: 0 };
    const deps = makeDeps({
      relayerPool: mockRelayerPool(state),
      publicClient: mockPublicClient({}),
      store,
      resultStore,
    });

    const first = await settle(payment, 5_000n, nonce, deps);
    const second = await settle(payment, 5_000n, nonce, deps);

    // Exactly one on-chain tx across two settles of the same nonce.
    expect(state.calls).toBe(1);
    // The SAME receipt is returned (cache short-circuit, no re-sign, no second tx).
    expect(second).toEqual(first);
  });

  it("Test 3 (exact settle): submits transferWithAuthorization, scheme:exact", async () => {
    const nonce: Hex = `0x${"a3".repeat(32)}`;
    const { wallet } = makeSigner(pk);
    const signed = await signExactTransfer(wallet, {
      from: buyer,
      to: PAYMENT_SPLITTER,
      value: 7_000n,
      validAfter: 0n,
      validBefore: BigInt(Math.floor(Date.now() / 1000) + 300),
      nonce,
    });
    const exact: ExactSettlePayload = { scheme: "exact", signed };
    const state = { calls: 0 };
    const deps = makeDeps({
      relayerPool: mockRelayerPool(state),
      publicClient: mockPublicClient({}),
      store,
      resultStore,
    });

    const receipt = await settle(exact, 0n, nonce, deps);

    expect(state.calls).toBe(1);
    expect(receipt.scheme).toBe("exact");
    expect(receipt.payer.toLowerCase()).toBe(buyer.toLowerCase());
    expect(receipt.amount).toBe("7000");
    expect(await resultStore.get(nonce)).not.toBeNull();
  });

  it("Test 4 (on-chain NonceUsed rebuild): retry rebuilds the receipt from the Debited event, NO second tx", async () => {
    const nonce: Hex = `0x${"a4".repeat(32)}`;
    const cap = 10_000n;
    const amount = 6_000n;
    const payment = await escrowPayment({ pk, buyer, cap, nonce });
    const tx: Hex = `0x${"cd".repeat(32)}`;
    // The relayer write REVERTS with NonceUsed (retry after crash). settle must read
    // the Debited event and rebuild the identical receipt instead of resubmitting.
    const state = { calls: 0, revertWith: new Error("execution reverted: NonceUsed()") };
    const deps = makeDeps({
      relayerPool: mockRelayerPool(state),
      publicClient: mockPublicClient({ debited: { buyer, amount, nonce, tx } }),
      store,
      resultStore,
    });

    const receipt = await settle(payment, amount, nonce, deps);

    // Exactly one writeContract ATTEMPT (which reverted) and NO retry submission.
    expect(state.calls).toBe(1);
    expect(receipt.scheme).toBe("utter-escrow");
    expect(receipt.amount).toBe("6000");
    expect(receipt.tx).toBe(tx); // rebuilt from the on-chain Debited event
    expect(receipt.idemKey).toBe(nonce);
    // Persisted so a later retry by idemKey serves from cache.
    expect(await resultStore.get(nonce)).not.toBeNull();
  });

  // WR-02: when a settle tx hash was persisted, the NonceUsed rebuild reads THAT
  // single tx receipt (getTransactionReceipt) and never falls back to a getLogs
  // history scan. We seed the stored tx and assert getLogs is NOT called.
  it("Test 5 (WR-02 bounded rebuild): rebuild uses the stored txHash, not a full getLogs scan", async () => {
    const nonce: Hex = `0x${"a5".repeat(32)}`;
    const cap = 10_000n;
    const amount = 6_000n;
    const tx: Hex = `0x${"de".repeat(32)}`;
    const payment = await escrowPayment({ pk, buyer, cap, nonce });

    // Pre-seed the nonce->txHash mapping as if the first (crashed) settle broadcast
    // it before dying. The retry's writeContract reverts with NonceUsed.
    await store.recordSettleTx(nonce, tx);

    let getLogsCalls = 0;
    let getTxReceiptCalls = 0;
    const topics = encodeEventTopics({
      abi: escrowAbi,
      eventName: "Debited",
      args: { resourceId: RESOURCE, buyer },
    });
    const data = encodeAbiParameters(
      [
        { name: "amount", type: "uint256" },
        { name: "toCreator", type: "uint256" },
        { name: "toTreasury", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
      [amount, 0n, amount, nonce],
    );
    const trackingClient = {
      async waitForTransactionReceipt() {
        return { status: "success" };
      },
      async getBlockNumber() {
        return 10_000n;
      },
      async getTransactionReceipt({ hash }: { hash: Hex }) {
        getTxReceiptCalls += 1;
        expect(hash).toBe(tx); // reads exactly the stored tx
        return { logs: [{ address: PAYMENT_ESCROW, data, topics, transactionHash: tx }] };
      },
      async getLogs() {
        getLogsCalls += 1;
        return [];
      },
    } as unknown as PublicClient;

    const state = { calls: 0, revertWith: new Error("execution reverted: NonceUsed()") };
    const deps = makeDeps({
      relayerPool: mockRelayerPool(state),
      publicClient: trackingClient,
      store,
      resultStore,
    });

    const receipt = await settle(payment, amount, nonce, deps);

    expect(receipt.tx).toBe(tx);
    expect(receipt.amount).toBe("6000");
    // The PRIMARY path read the single stored-tx receipt; NO history scan happened.
    expect(getTxReceiptCalls).toBe(1);
    expect(getLogsCalls).toBe(0);
  });
});
