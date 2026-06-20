// verify-reserve suite (PAY-02): /verify signature + on-chain balance + free-nonce
// gate, then the off-chain reservation. The RESERVE-PRECEDES-RUN hard rule
// (CLAUDE.md §19): verifyAndReserve only ever reserves; no handler runs here and
// none can. These tests run fully offline - the in-memory PaymentStore plus a
// stubbed publicClient returning controlled balanceOf/usedNonce values (no live
// RPC). The on-chain `debit` revert is the FINAL backstop; this off-chain
// accounting is defense in depth, proven here against concurrent AND sequential
// over-reservation.
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
  signDebitAuthorization,
  type PaymentStore,
  type PaymentPayload,
} from "@utter/x402-arc";
import { PAYMENT_ESCROW, arcTestnet } from "@utter/chain";
import { verifyAndReserve, createInMemoryBuyerLock } from "../src/verify";

const RESOURCE: Hex = `0x${"22".repeat(32)}`;
const MAX_TIMEOUT_SECONDS = 30;
const SETTLE_BUFFER_SECONDS = 90;

/**
 * A minimal mock of the on-chain PaymentEscrow reads `verifyAndReserve` makes:
 * `balanceOf(buyer)` and `usedNonce(nonce)`. We return controlled values so the
 * reservation logic is exercised with no RPC. Shaped as a Viem `readContract`
 * dispatcher keyed on functionName.
 */
function mockEscrowClient(opts: {
  balances: Record<string, bigint>;
  usedNonces?: Set<string>;
}): PublicClient {
  const used = opts.usedNonces ?? new Set<string>();
  return {
    async readContract({ functionName, args }: { functionName: string; args: readonly unknown[] }) {
      if (functionName === "balanceOf") {
        const owner = (args[0] as string).toLowerCase();
        return opts.balances[owner] ?? 0n;
      }
      if (functionName === "usedNonce") {
        return used.has((args[0] as string).toLowerCase());
      }
      throw new Error(`mockEscrowClient: unexpected functionName ${functionName}`);
    },
  } as unknown as PublicClient;
}

/** Build a wallet client for a fresh local account (used to produce a real signature). */
function makeSigner(pk: Hex) {
  const account = privateKeyToAccount(pk);
  const wallet = createWalletClient({
    account,
    chain: arcTestnet,
    transport: http(arcTestnet.rpcUrls.default.http[0]),
  });
  return { account, wallet };
}

/** Build a signed PaymentPayload for a buyer. */
async function signedPayment(opts: {
  pk: Hex;
  buyer: Address;
  cap: bigint;
  nonce: Hex;
  resourceId?: Hex;
}): Promise<PaymentPayload> {
  const { wallet } = makeSigner(opts.pk);
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + MAX_TIMEOUT_SECONDS + SETTLE_BUFFER_SECONDS);
  const signed = await signDebitAuthorization(wallet, {
    buyer: opts.buyer,
    resourceId: opts.resourceId ?? RESOURCE,
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
      resourceId: opts.resourceId ?? RESOURCE,
      maxAmount: opts.cap.toString(),
      nonce: opts.nonce,
      validBefore: validBefore.toString(),
    },
    signature: signed.signature,
  };
}

function deps(store: PaymentStore, client: PublicClient) {
  return {
    store,
    publicClient: client,
    escrowAddress: PAYMENT_ESCROW,
    perBuyerLock: createInMemoryBuyerLock(),
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    settleBufferSeconds: SETTLE_BUFFER_SECONDS,
  };
}

const requirements = {
  resourceId: RESOURCE,
  maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
};

describe("verify-reserve", () => {
  let store: InMemoryPaymentStore;
  let pk: Hex;
  let buyer: Address;

  beforeEach(() => {
    store = new InMemoryPaymentStore();
    pk = generatePrivateKey();
    buyer = privateKeyToAccount(pk).address;
  });

  it("Test 1 (valid path): valid sig + sufficient balance + free nonce reserves the cap", async () => {
    const nonce: Hex = `0x${"01".repeat(32)}`;
    const cap = 10_000n;
    const payment = await signedPayment({ pk, buyer, cap, nonce });
    const client = mockEscrowClient({ balances: { [buyer.toLowerCase()]: 50_000n } });

    const res = await verifyAndReserve(payment, requirements, deps(store, client));

    expect(res.valid).toBe(true);
    expect(res.payer?.toLowerCase()).toBe(buyer.toLowerCase());
    // The reservation lock is present afterward (reserve happened).
    expect(await store.isNoncePending(nonce)).toBe(true);
    expect(await store.outstandingReserved(buyer)).toBe(cap);
  });

  it("Test 2 (bad signature): a signature from a different key is rejected with NO reservation", async () => {
    const nonce: Hex = `0x${"02".repeat(32)}`;
    const cap = 10_000n;
    // Sign with a DIFFERENT key than the claimed buyer.
    const attackerPk = generatePrivateKey();
    const payment = await signedPayment({ pk: attackerPk, buyer, cap, nonce });
    const client = mockEscrowClient({ balances: { [buyer.toLowerCase()]: 50_000n } });

    const res = await verifyAndReserve(payment, requirements, deps(store, client));

    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/sig/i);
    expect(await store.isNoncePending(nonce)).toBe(false);
  });

  it("Test 3 (insufficient balance): balance < cap is rejected with NO reservation", async () => {
    const nonce: Hex = `0x${"03".repeat(32)}`;
    const cap = 10_000n;
    const payment = await signedPayment({ pk, buyer, cap, nonce });
    const client = mockEscrowClient({ balances: { [buyer.toLowerCase()]: 9_999n } });

    const res = await verifyAndReserve(payment, requirements, deps(store, client));

    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/balance|insufficient/i);
    expect(await store.isNoncePending(nonce)).toBe(false);
  });

  it("Test 4 (used/pending nonce): an already-pending nonce does not double-reserve", async () => {
    const nonce: Hex = `0x${"04".repeat(32)}`;
    const cap = 10_000n;
    const client = mockEscrowClient({ balances: { [buyer.toLowerCase()]: 50_000n } });

    // First verify reserves.
    const first = await verifyAndReserve(
      await signedPayment({ pk, buyer, cap, nonce }),
      requirements,
      deps(store, client),
    );
    expect(first.valid).toBe(true);

    // A second verify on the SAME nonce is rejected (store-pending) - no double reserve.
    const second = await verifyAndReserve(
      await signedPayment({ pk, buyer, cap, nonce }),
      requirements,
      deps(store, client),
    );
    expect(second.valid).toBe(false);
    expect(second.reason).toMatch(/nonce/i);
    expect(await store.outstandingReserved(buyer)).toBe(cap); // still just one

    // Likewise an on-chain usedNonce=true is rejected.
    const onchainUsedNonce: Hex = `0x${"05".repeat(32)}`;
    const usedClient = mockEscrowClient({
      balances: { [buyer.toLowerCase()]: 50_000n },
      usedNonces: new Set([onchainUsedNonce.toLowerCase()]),
    });
    const third = await verifyAndReserve(
      await signedPayment({ pk, buyer, cap, nonce: onchainUsedNonce }),
      requirements,
      deps(store, usedClient),
    );
    expect(third.valid).toBe(false);
    expect(third.reason).toMatch(/nonce/i);
    expect(await store.isNoncePending(onchainUsedNonce)).toBe(false);
  });

  it("Test 5 (per-buyer serialization): two concurrent verifies for one balance grant exactly one", async () => {
    const cap = 10_000n;
    // Balance large enough for ONE cap only.
    const client = mockEscrowClient({ balances: { [buyer.toLowerCase()]: 12_000n } });
    const sharedDeps = deps(store, client); // shared perBuyerLock -> serialized

    const nonceA: Hex = `0x${"0a".repeat(32)}`;
    const nonceB: Hex = `0x${"0b".repeat(32)}`;
    const [resA, resB] = await Promise.all([
      verifyAndReserve(await signedPayment({ pk, buyer, cap, nonce: nonceA }), requirements, sharedDeps),
      verifyAndReserve(await signedPayment({ pk, buyer, cap, nonce: nonceB }), requirements, sharedDeps),
    ]);

    const wins = [resA, resB].filter((r) => r.valid).length;
    expect(wins, "exactly one of two concurrent same-buyer verifies must win").toBe(1);
    expect(await store.outstandingReserved(buyer)).toBe(cap);
  });

  it("Test 6 (sequential reservation accounting): two sequential verifies, different nonces, one balance -> second rejected at /verify", async () => {
    const cap = 10_000n;
    // Balance sufficient for ONE cap only.
    const client = mockEscrowClient({ balances: { [buyer.toLowerCase()]: 15_000n } });
    const sharedDeps = deps(store, client);

    const nonceA: Hex = `0x${"1a".repeat(32)}`;
    const nonceB: Hex = `0x${"1b".repeat(32)}`;

    const first = await verifyAndReserve(
      await signedPayment({ pk, buyer, cap, nonce: nonceA }),
      requirements,
      sharedDeps,
    );
    expect(first.valid).toBe(true);

    // SEQUENTIAL second verify with a DIFFERENT nonce. available = 15000 - 10000 = 5000 < cap
    // -> rejected AT /verify (outstanding-reservation accounting), NOT granted then failed at settle.
    const second = await verifyAndReserve(
      await signedPayment({ pk, buyer, cap, nonce: nonceB }),
      requirements,
      sharedDeps,
    );
    expect(second.valid).toBe(false);
    expect(second.reason).toMatch(/balance|insufficient|available/i);

    // Exactly one reservation remains.
    expect(await store.isNoncePending(nonceA)).toBe(true);
    expect(await store.isNoncePending(nonceB)).toBe(false);
    expect(await store.outstandingReserved(buyer)).toBe(cap);
  });
});
