// Batch-route tests (SCL-02 integration): the min-economical threshold branch that
// lands the Plan 08-03 BatchSettler into the live settle path.
//
// routeDebit sends a computed debit to EXACTLY ONE of two paths:
//   - debit <  minEconomical -> batchSettler.accrue(...)  (sub-cent: accrued, NO
//     immediate on-chain debit; the debit-counting mock relayer records zero for it),
//   - debit >= minEconomical -> settle()                  (immediate, one debit, clamp).
//
// A mutually-exclusive branch (threat T-08-ROUTEDOUBLE: never both). Accumulating
// sub-cent debits to the BatchSettler trigger yields EXACTLY ONE batched on-chain debit
// equal to the reconciled sum (sum(legs)==sum(debits) end-to-end through the route).
//
// Fully offline: in-memory stores, a debit-counting mock relayer, a stub chain, an
// injected clock. The threshold is injected config (no magic decimals literal); the
// `now` is injected (no Date.now / Math.random in the route).
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
import { routeDebit } from "../src/batch-route";

const RESOURCE: Hex = `0x${"5c".repeat(32)}`;
const CREATOR_BPS = 7000n;
const CAP = 1_000_000n;
const MIN_ECONOMICAL = 1000n; // injected threshold: below this a debit batches.

function makeBuyer() {
  const account = privateKeyToAccount(generatePrivateKey());
  const wallet = createWalletClient({
    account,
    chain: arcTestnet,
    transport: http(arcTestnet.rpcUrls.default.http[0]),
  });
  return { account, buyer: account.address as Address, wallet };
}

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

  /** Sign a fresh per-nonce escrow authorization (used by both the immediate + batch paths). */
  async function signPayment(nonce: Hex): Promise<{ payment: PaymentPayload; cap: bigint }> {
    const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const signed = await signDebitAuthorization(buyerCtx.wallet, {
      buyer: buyerCtx.buyer,
      resourceId: RESOURCE,
      maxAmount: CAP,
      nonce,
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
        nonce,
        validBefore: validBefore.toString(),
      },
      signature: signed.signature,
    };
    return { payment, cap: CAP };
  }

  const buildBatchPayment = (batchIdemKey: Hex, _amount: bigint) => signPayment(batchIdemKey);

  function makeSettler(over: Partial<{ maxBatchCount: number; minEconomicalThreshold: bigint }> = {}) {
    return new BatchSettler({
      ledger: new InMemoryBatchLedger(),
      deps,
      buildBatchPayment,
      resourceId: RESOURCE,
      creatorBps: CREATOR_BPS,
      maxBatchCount: over.maxBatchCount ?? 3,
      maxBatchSeconds: 9999,
      minEconomicalThreshold: over.minEconomicalThreshold ?? 1_000_000n,
    });
  }

  return { deps, debitState, resultStore, signPayment, makeSettler };
}

describe("routeDebit: sub-cent debits accrue (no immediate on-chain debit)", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });

  it("routes a BELOW-threshold debit into BatchSettler.accrue with ZERO immediate debit", async () => {
    const settler = h.makeSettler({ maxBatchCount: 3 });
    const { payment } = await h.signPayment(`0x${"a1".repeat(32)}`);

    const outcome = await routeDebit({
      debit: 10n, // < MIN_ECONOMICAL
      minEconomical: MIN_ECONOMICAL,
      resourceId: RESOURCE,
      now: 0,
      batchSettler: settler,
      settle: { payment, amount: 10n, idemKey: `0x${"a1".repeat(32)}`, deps: h.deps },
    });

    expect(outcome.path).toBe("batched");
    // NO immediate on-chain debit for a sub-cent call.
    expect(h.debitState.debits).toBe(0);
    // The flush has not fired yet (only one accrual, N=3).
    expect(outcome.flush).toBeNull();
  });

  it("routes an AT/ABOVE-threshold debit into an immediate settle() (exactly one debit, clamp respected)", async () => {
    const settler = h.makeSettler();
    const nonce = `0x${"b2".repeat(32)}` as Hex;
    const { payment } = await h.signPayment(nonce);
    // Reserve the nonce so settle's path is clean (mirrors the live reserve-precedes-settle).
    await h.deps.store.reserve({ idemKey: nonce, buyer: payment.authorization.buyer as Address, cap: CAP, resourceId: RESOURCE, expiresAt: Date.now() + 60_000 });

    const outcome = await routeDebit({
      debit: 5000n, // >= MIN_ECONOMICAL
      minEconomical: MIN_ECONOMICAL,
      resourceId: RESOURCE,
      now: 0,
      batchSettler: settler,
      settle: { payment, amount: 5000n, idemKey: nonce, deps: h.deps },
    });

    expect(outcome.path).toBe("immediate");
    expect(h.debitState.debits).toBe(1); // exactly one immediate debit
    expect(outcome.receipt).toBeDefined();
    expect(BigInt(outcome.receipt!.amount) <= CAP).toBe(true); // clamp respected
    expect(BigInt(outcome.receipt!.amount)).toBe(5000n);
  });

  it("sends a debit to EXACTLY ONE path (no double-settle): below batches, never settles immediately", async () => {
    const settler = h.makeSettler({ maxBatchCount: 3 });
    const { payment } = await h.signPayment(`0x${"c3".repeat(32)}`);
    const outcome = await routeDebit({
      debit: 1n,
      minEconomical: MIN_ECONOMICAL,
      resourceId: RESOURCE,
      now: 0,
      batchSettler: settler,
      settle: { payment, amount: 1n, idemKey: `0x${"c3".repeat(32)}`, deps: h.deps },
    });
    expect(outcome.path).toBe("batched");
    expect(outcome.receipt).toBeUndefined(); // the batch path returns no immediate receipt
    expect(h.debitState.debits).toBe(0);
  });
});

describe("routeDebit: accrued sub-cent debits reconcile to ONE batched debit (end-to-end)", () => {
  it("accumulating sub-cent debits to the trigger yields exactly ONE debit == sum(legs)", async () => {
    const h = makeHarness();
    const settler = h.makeSettler({ maxBatchCount: 3 });

    const legs = [40n, 70n, 130n]; // three sub-cent debits (< MIN_ECONOMICAL each)
    let lastFlush = null as Awaited<ReturnType<typeof routeDebit>>["flush"];
    for (let i = 0; i < legs.length; i++) {
      const nonce = `0x${(0x10 + i).toString(16).padStart(2, "0").repeat(32)}` as Hex;
      const { payment } = await h.signPayment(nonce);
      const outcome = await routeDebit({
        debit: legs[i]!,
        minEconomical: MIN_ECONOMICAL,
        resourceId: RESOURCE,
        now: i,
        batchSettler: settler,
        settle: { payment, amount: legs[i]!, idemKey: nonce, deps: h.deps },
      });
      expect(outcome.path).toBe("batched");
      lastFlush = outcome.flush;
    }

    // The third accrual hit N=3 -> exactly ONE batched on-chain debit.
    expect(h.debitState.debits).toBe(1);
    expect(lastFlush).not.toBeNull();
    const expectedSum = legs.reduce((a, b) => a + b, 0n);
    // sum(legs) == the batched debit amount (reconciliation end-to-end through the route).
    expect(lastFlush!.batchAmount).toBe(expectedSum);
    expect(BigInt(lastFlush!.receipt.amount)).toBe(expectedSum);
    // The reconciled creator + treasury legs + carry sum back to the accrued total.
    const r = lastFlush!.reconciliation;
    expect(r.creatorLeg + r.treasuryLeg).toBe(expectedSum);
  });
});
