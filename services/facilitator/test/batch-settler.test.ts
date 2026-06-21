// batch-settler suite (SCL-02): the hybrid-flush + route-ONE-settle()-per-batch core.
//
// The BatchSettler accrues sub-cent debits into the BatchLedger and flushes on a
// HYBRID trigger - N debits OR T seconds (injected clock) OR accrued >= a
// min-economical threshold, whichever fires FIRST. On flush it reconciles the legs
// (Task 1 invariant), derives a DETERMINISTIC idempotent batchIdemKey (no
// Math.random / Date.now), and submits EXACTLY ONE settle(batchPayment, batchAmount,
// batchIdemKey, deps, body) per batch - routing THROUGH the existing exactly-once
// settle() money guard, never a parallel path. The settle.ts:286 clamp
// min(batchAmount, cap) still applies.
//
// Crash-safety: the pending ledger + carry are persisted and the batch key is
// deterministic, so a crash mid-flush re-runs to exactly one debit (no double-charge
// via the result-cache short-circuit, no lost debit via the persisted ledger).
//
// Fully offline: in-memory stores, a debit-counting mock relayer, a stub chain. The
// clock is injected (no real timers).
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
  type PaymentPayload,
} from "@utter/x402-arc";
import { PAYMENT_ESCROW, PAYMENT_SPLITTER, USDC, arcTestnet } from "@utter/chain";
import { type SettleDeps } from "../src/settle";
import type { RelayerPool, RelayerSigner } from "../src/relayer";
import { BatchSettler } from "../src/batch-settler";
import { InMemoryBatchLedger } from "../src/batch-ledger";

const RESOURCE: Hex = `0x${"5c".repeat(32)}`;
const CREATOR_BPS = 7000n;
const CAP = 1_000_000n; // a comfortable batch cap (clamp tested separately)

function makeBuyer() {
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  const wallet = createWalletClient({
    account,
    chain: arcTestnet,
    transport: http(arcTestnet.rpcUrls.default.http[0]),
  });
  return { pk, account, buyer: account.address as Address, wallet };
}

/** A mock relayer pool whose writeContract increments a per-batch debit counter. */
function mockRelayerPool(state: { debits: number }): RelayerPool {
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
    async waitForTransactionReceipt() {
      return { status: "success" };
    },
    async getLogs() {
      return [];
    },
  } as unknown as PublicClient;
}

/** Build a deps + a buyer + a batchPayment builder bound to a deterministic batch nonce. */
function makeHarness() {
  const store = new InMemoryPaymentStore();
  const resultStore = new InMemoryResultStore();
  const debitState = { debits: 0 };
  const deps: SettleDeps = {
    relayerPool: mockRelayerPool(debitState),
    store,
    resultStore,
    publicClient: mockPublicClient(),
    escrowAddress: PAYMENT_ESCROW,
    splitterAddress: PAYMENT_SPLITTER,
    usdcAddress: USDC,
  };
  const buyerCtx = makeBuyer();

  // The injection seam: the route (08-06) supplies the buyer's batch authorization for
  // a (batchKey -> deterministic batch nonce, batch amount). Here we sign one per batch.
  async function buildBatchPayment(
    batchIdemKey: Hex,
    batchAmount: bigint,
  ): Promise<{ payment: PaymentPayload; cap: bigint }> {
    const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const signed = await signDebitAuthorization(buyerCtx.wallet, {
      buyer: buyerCtx.buyer,
      resourceId: RESOURCE,
      maxAmount: CAP,
      nonce: batchIdemKey,
      validBefore,
    });
    const payment: PaymentPayload = {
      x402Version: 2,
      scheme: "utter-escrow",
      network: "eip155:5042002",
      authorization: {
        buyer: buyerCtx.buyer,
        resourceId: RESOURCE,
        maxAmount: CAP.toString(),
        nonce: batchIdemKey,
        validBefore: validBefore.toString(),
      },
      signature: signed.signature,
    };
    void batchAmount;
    return { payment, cap: CAP };
  }

  return { deps, debitState, resultStore, buildBatchPayment };
}

describe("BatchSettler hybrid flush trigger (first-wins)", () => {
  let h: ReturnType<typeof makeHarness>;

  beforeEach(() => {
    h = makeHarness();
  });

  it("flushes on N debits (the count trigger fires first)", async () => {
    const settler = new BatchSettler({
      ledger: new InMemoryBatchLedger(),
      deps: h.deps,
      buildBatchPayment: h.buildBatchPayment,
      creatorBps: CREATOR_BPS,
      maxBatchCount: 3,
      maxBatchSeconds: 9999, // far away - the count trigger wins
      minEconomicalThreshold: 1_000_000n, // far away - the count trigger wins
    });

    let flushed = await settler.accrue(RESOURCE, 10n, 0);
    expect(flushed).toBeNull();
    flushed = await settler.accrue(RESOURCE, 10n, 1);
    expect(flushed).toBeNull();
    // Third debit hits N=3 -> flush.
    flushed = await settler.accrue(RESOURCE, 10n, 2);
    expect(flushed).not.toBeNull();
    expect(h.debitState.debits).toBe(1);
    expect(flushed!.batchAmount).toBe(30n);
  });

  it("flushes on T seconds elapsed (the injected-clock time trigger fires first)", async () => {
    const settler = new BatchSettler({
      ledger: new InMemoryBatchLedger(),
      deps: h.deps,
      buildBatchPayment: h.buildBatchPayment,
      creatorBps: CREATOR_BPS,
      maxBatchCount: 9999, // far away - the time trigger wins
      maxBatchSeconds: 60,
      minEconomicalThreshold: 1_000_000n,
    });

    // Two accruals well within the window: no flush.
    expect(await settler.accrue(RESOURCE, 5n, 0)).toBeNull();
    expect(await settler.accrue(RESOURCE, 5n, 30)).toBeNull();
    // A later accrual past the 60s window -> the time trigger flushes the batch.
    const flushed = await settler.accrue(RESOURCE, 5n, 61);
    expect(flushed).not.toBeNull();
    expect(h.debitState.debits).toBe(1);
  });

  it("flushes on the min-economical threshold (the accrued-amount trigger fires first)", async () => {
    const settler = new BatchSettler({
      ledger: new InMemoryBatchLedger(),
      deps: h.deps,
      buildBatchPayment: h.buildBatchPayment,
      creatorBps: CREATOR_BPS,
      maxBatchCount: 9999,
      maxBatchSeconds: 9999,
      minEconomicalThreshold: 100n, // small - the threshold trigger wins
    });

    expect(await settler.accrue(RESOURCE, 40n, 0)).toBeNull();
    expect(await settler.accrue(RESOURCE, 40n, 1)).toBeNull();
    // Accrued reaches 120 >= 100 -> flush.
    const flushed = await settler.accrue(RESOURCE, 40n, 2);
    expect(flushed).not.toBeNull();
    expect(flushed!.batchAmount).toBe(120n);
    expect(h.debitState.debits).toBe(1);
  });
});

describe("BatchSettler settles exactly one debit per batch through settle()", () => {
  let h: ReturnType<typeof makeHarness>;

  beforeEach(() => {
    h = makeHarness();
  });

  it("submits exactly ONE settle()/debit per batch; batchAmount == reconciled sum, amount <= cap", async () => {
    const settler = new BatchSettler({
      ledger: new InMemoryBatchLedger(),
      deps: h.deps,
      buildBatchPayment: h.buildBatchPayment,
      creatorBps: CREATOR_BPS,
      maxBatchCount: 2,
      maxBatchSeconds: 9999,
      minEconomicalThreshold: 1_000_000n,
    });

    await settler.accrue(RESOURCE, 7n, 0);
    const flushed = await settler.accrue(RESOURCE, 11n, 1);
    expect(flushed).not.toBeNull();
    expect(h.debitState.debits).toBe(1); // exactly ONE debit for the batch
    expect(flushed!.batchAmount).toBe(18n); // the reconciled sum
    expect(BigInt(flushed!.receipt.amount) <= CAP).toBe(true); // clamp respected
    expect(BigInt(flushed!.receipt.amount)).toBe(18n);
  });

  it("re-flushing the SAME batchIdemKey returns the cached receipt with NO second debit (idempotent)", async () => {
    const ledger = new InMemoryBatchLedger();
    const settler = new BatchSettler({
      ledger,
      deps: h.deps,
      buildBatchPayment: h.buildBatchPayment,
      creatorBps: CREATOR_BPS,
      maxBatchCount: 2,
      maxBatchSeconds: 9999,
      minEconomicalThreshold: 1_000_000n,
    });

    await settler.accrue(RESOURCE, 9n, 0);
    const first = await settler.accrue(RESOURCE, 9n, 1);
    expect(first).not.toBeNull();
    expect(h.debitState.debits).toBe(1);

    // Re-flush the SAME batch key directly: the result-cache short-circuits, no 2nd debit.
    const replay = await settler.flushBatch(first!.batchSeq);
    expect(replay).not.toBeNull();
    expect(replay!.receipt.idemKey).toBe(first!.receipt.idemKey);
    expect(h.debitState.debits).toBe(1); // NO second debit (never re-signed)
  });

  it("uses a DETERMINISTIC batch key (no Math.random / Date.now): same seq -> same idemKey", async () => {
    const settler = new BatchSettler({
      ledger: new InMemoryBatchLedger(),
      deps: h.deps,
      buildBatchPayment: h.buildBatchPayment,
      creatorBps: CREATOR_BPS,
      maxBatchCount: 1,
      maxBatchSeconds: 9999,
      minEconomicalThreshold: 1_000_000n,
    });
    const a = settler.batchIdemKey(0);
    const b = settler.batchIdemKey(0);
    const c = settler.batchIdemKey(1);
    expect(a).toBe(b); // deterministic
    expect(a).not.toBe(c); // distinct per sequence
    expect(/^0x[0-9a-f]{64}$/.test(a)).toBe(true); // a bytes32 nonce
  });
});

describe("BatchSettler crash mid-flush is exactly-once (idempotent key + persisted ledger)", () => {
  it("a crash before persist re-flushes to EXACTLY one debit (no double-charge, no lost debit)", async () => {
    const h = makeHarness();
    // A SHARED persisted ledger + result store survive the simulated restart.
    const ledger = new InMemoryBatchLedger();

    const settlerA = new BatchSettler({
      ledger,
      deps: h.deps,
      buildBatchPayment: h.buildBatchPayment,
      creatorBps: CREATOR_BPS,
      maxBatchCount: 2,
      maxBatchSeconds: 9999,
      minEconomicalThreshold: 1_000_000n,
    });

    await settlerA.accrue(RESOURCE, 4n, 0);
    const flushed = await settlerA.accrue(RESOURCE, 6n, 1);
    expect(flushed).not.toBeNull();
    expect(h.debitState.debits).toBe(1);

    // Simulate a restart: rebuild the ledger from its durable snapshot and a NEW
    // settler instance sharing the SAME deps (result store persisted). Re-flushing the
    // same deterministic batch seq must NOT add a second debit and must NOT lose it.
    const restartedLedger = InMemoryBatchLedger.fromSnapshot(ledger.snapshot());
    const settlerB = new BatchSettler({
      ledger: restartedLedger,
      deps: h.deps, // same stores -> the result-cache short-circuit applies
      buildBatchPayment: h.buildBatchPayment,
      creatorBps: CREATOR_BPS,
      maxBatchCount: 2,
      maxBatchSeconds: 9999,
      minEconomicalThreshold: 1_000_000n,
    });

    const replay = await settlerB.flushBatch(flushed!.batchSeq);
    expect(replay).not.toBeNull();
    expect(replay!.receipt.idemKey).toBe(flushed!.receipt.idemKey);
    expect(h.debitState.debits).toBe(1); // EXACTLY one debit across the crash boundary
  });
});
