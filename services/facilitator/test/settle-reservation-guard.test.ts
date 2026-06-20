// settle reservation-guard suite (CR-04, WR-04): the /settle route re-asserts
// reserve-precedes-settle and re-checks expiry, so an unreserved (replayed)
// authorization can never trigger a debit by hitting /settle directly.
//
//   CR-04 - POST /settle for a nonce with NO live reservation and no cached result
//           is rejected 409 { reason: "no_reservation" } with ZERO on-chain debits.
//   CR-04 - POST /settle for a RESERVED nonce settles normally (the gate path).
//   WR-04 - POST /settle for a reserved-but-EXPIRED authorization is rejected 402
//           { reason: "expired" }, the reservation released, ZERO debits.
//
// Fully offline: mocked relayer counts writeContract, stub publicClient, in-memory
// stores. We hit the real Hono app route (not settle() directly) so the route-level
// guards are exercised end to end.
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
import { createApp } from "../src/app";
import { createInMemoryBuyerLock } from "../src/verify";
import type { RelayerPool, RelayerSigner } from "../src/relayer";

const RESOURCE: Hex = `0x${"55".repeat(32)}`;
const MAX_TIMEOUT_SECONDS = 30;
const SETTLE_BUFFER_SECONDS = 90;

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
  validBefore?: bigint;
}): Promise<PaymentPayload> {
  const { wallet } = makeSigner(opts.pk);
  const validBefore =
    opts.validBefore ??
    BigInt(Math.floor(Date.now() / 1000) + MAX_TIMEOUT_SECONDS + SETTLE_BUFFER_SECONDS);
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

describe("settle reservation-guard", () => {
  let store: InMemoryPaymentStore;
  let resultStore: InMemoryResultStore;
  let debitState: DebitState;
  let pk: Hex;
  let buyer: Address;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    store = new InMemoryPaymentStore();
    resultStore = new InMemoryResultStore();
    debitState = { debits: 0 };
    pk = generatePrivateKey();
    buyer = privateKeyToAccount(pk).address;
    app = createApp({
      store,
      resultStore,
      relayerPool: mockRelayerPool(debitState),
      publicClient: mockPublicClient({ balances: { [buyer.toLowerCase()]: 1_000_000n } }),
      perBuyerLock: createInMemoryBuyerLock(),
      escrowAddress: PAYMENT_ESCROW,
      splitterAddress: PAYMENT_SPLITTER,
      usdcAddress: USDC,
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      settleBufferSeconds: SETTLE_BUFFER_SECONDS,
    });
  });

  async function postSettle(payment: PaymentPayload, amount: bigint): Promise<Response> {
    return app.request("/settle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payment: encodePayment(payment), amount: amount.toString(), response: "{}" }),
    });
  }

  // CR-04: an UNRESERVED nonce hitting /settle directly is rejected 409, no debit.
  it("CR-04: /settle without a prior reservation is rejected 409 no_reservation, zero debits", async () => {
    const nonce: Hex = `0x${"c1".repeat(32)}`;
    const payment = await escrowPayment({ pk, buyer, cap: 10_000n, nonce });

    const res = await postSettle(payment, 5_000n);

    expect(res.status).toBe(409);
    const json = (await res.json()) as { success: boolean; reason: string };
    expect(json.success).toBe(false);
    expect(json.reason).toBe("no_reservation");
    expect(debitState.debits).toBe(0);
  });

  // CR-04: a RESERVED nonce settles normally (the legitimate gate path).
  it("CR-04: /settle for a reserved nonce settles and debits once", async () => {
    const nonce: Hex = `0x${"c2".repeat(32)}`;
    const cap = 10_000n;
    const payment = await escrowPayment({ pk, buyer, cap, nonce });
    // Reserve via the real /verify route first (the gate path).
    const verifyRes = await app.request("/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payment: encodePayment(payment), resourceId: RESOURCE }),
    });
    expect(verifyRes.status).toBe(200);

    const res = await postSettle(payment, 5_000n);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean };
    expect(json.success).toBe(true);
    expect(debitState.debits).toBe(1);
  });

  // WR-04: a reserved-but-expired authorization is rejected 402 expired, released.
  it("WR-04: /settle for an expired reserved authorization is rejected 402 expired, zero debits", async () => {
    const nonce: Hex = `0x${"c3".repeat(32)}`;
    const cap = 10_000n;
    // Reserve a live lock directly (skip /verify's expiry check) so we can drive the
    // settle-time expiry guard in isolation.
    await store.reserve({
      idemKey: nonce,
      buyer,
      cap,
      resourceId: RESOURCE,
      expiresAt: Date.now() + 60_000,
    });
    // The signed authorization itself is already expired (validBefore in the past).
    const payment = await escrowPayment({
      pk,
      buyer,
      cap,
      nonce,
      validBefore: BigInt(Math.floor(Date.now() / 1000) - 1),
    });

    const res = await postSettle(payment, 5_000n);

    expect(res.status).toBe(402);
    const json = (await res.json()) as { success: boolean; reason: string };
    expect(json.success).toBe(false);
    expect(json.reason).toBe("expired");
    expect(debitState.debits).toBe(0);
    // The reservation was released so the buyer's cap is freed.
    expect(await store.isNoncePending(nonce)).toBe(false);
  });
});
