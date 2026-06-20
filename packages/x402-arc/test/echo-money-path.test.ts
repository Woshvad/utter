// echo-money-path suite (PAY-12, the integrating wave). This composes EVERY prior
// Phase 2 plan - the gate (05), the facilitator app/verify/settle (03/04), the
// signers/accepts/classify/metering (02), and the stores/echo fixtures (01) - and
// proves the full money path end to end:
//
//   Test 1 (unpaid 402): GET /echo with no X-PAYMENT -> 402 with the accepts body.
//   Test 2 (paid 200 debit<=cap): a funded buyer signs an X-PAYMENT, the echoed body
//           matches EchoSuccess, an X-PAYMENT-RESPONSE receipt is set, and EXACTLY ONE
//           debit <= cap is recorded at the in-process facilitator.
//   Test 3 (malformed no debit): a malfunction handler over the same gate -> 502, the
//           reservation is released, a strike is recorded, and ZERO debits occur.
//   Test 4 (idempotent recovery): after Test 2's success, retrieveByIdemKey(nonce)
//           returns the same receipt with NO additional debit (exactly-once across a
//           simulated disconnect - the buyer never re-signs).
//
// AUTONOMOUS + OFFLINE: the facilitator's relayer pool is mocked (it counts debits),
// the publicClient returns a funded balanceOf + an unused nonce + an instant receipt,
// and the in-memory stores are the test default. The gate's `fetcher` is wired to the
// in-process facilitator Hono app's `request`, so /verify, /settle, /release, and
// /results all exercise the REAL routes. No live RPC: the `debit <= cap` LOGIC is
// proven here against a mocked chain; the GENUINE on-chain Debited event is proven
// only by the operator-gated live-money-path.ts script (Task 2), like Phase 1's
// operator-gated ArcScan verify.
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
  retrieveByIdemKey,
  type Pricing,
  type PaymentPayload,
  type FetchLike,
} from "@utter/x402-arc";
import { createApp } from "@utter/facilitator/app";
import { createInMemoryBuyerLock } from "@utter/facilitator/verify";
import type { RelayerPool, RelayerSigner } from "@utter/facilitator/relayer";
import { createEchoServer } from "../examples/echo/server";

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

/** A debit counter the mocked relayer increments per writeContract (one per settle). */
interface DebitState {
  debits: number;
}

/** A mocked relayer pool: writeContract counts debits and returns a fixed tx hash. */
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

/** A stub public client: a funded buyer, no used nonces, instant tx receipts. */
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

/** Build the in-process facilitator app + a fetcher routing the gate's POSTs to it. */
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

/** Build a wallet client for a fresh local account (the buyer signs with it). */
function makeSigner(pk: Hex) {
  const account = privateKeyToAccount(pk);
  const wallet = createWalletClient({
    account,
    chain: arcTestnet,
    transport: http(arcTestnet.rpcUrls.default.http[0]),
  });
  return { account, wallet };
}

/** Build + sign an escrow PaymentPayload for a buyer, then base64 it for X-PAYMENT. */
async function signedHeader(opts: {
  pk: Hex;
  buyer: Address;
  cap: bigint;
  nonce: Hex;
  text: string;
}): Promise<string> {
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

describe("echo-money-path", () => {
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
      // Seed the buyer's mocked escrow balance so /verify's deposit-state check passes
      // WITHOUT a live deposit (the live deposit is the operator script, Task 2).
      publicClient: mockPublicClient({ balances: { [buyer.toLowerCase()]: 1_000_000n } }),
    });
  });

  it("Test 1 (unpaid 402): GET /echo with no X-PAYMENT returns 402 with the accepts body", async () => {
    const cap = 10_000n;
    const app = createEchoServer({
      facilitatorUrl: "http://facilitator.test",
      resourceId: RESOURCE,
      cap,
      pricing: PRICING,
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      fetcher,
    });
    const res = await app.request("/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { accepts: Array<{ scheme: string; maxAmountRequired?: string }> };
    expect(Array.isArray(body.accepts)).toBe(true);
    expect(body.accepts[0]?.scheme).toBe("utter-escrow");
    expect(body.accepts[0]?.maxAmountRequired).toBe(cap.toString());
    // The handler never ran -> no money moved.
    expect(debitState.debits).toBe(0);
  });

  it("Test 2 (paid 200 debit<=cap): echoed body + receipt header + exactly one debit <= cap", async () => {
    const cap = 10_000n;
    const nonce: Hex = `0x${"a2".repeat(32)}`;
    const app = createEchoServer({
      facilitatorUrl: "http://facilitator.test",
      resourceId: RESOURCE,
      cap,
      pricing: PRICING,
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      fetcher,
    });
    const header = await signedHeader({ pk, buyer, cap, nonce, text: "hello" });
    const res = await app.request("/echo", {
      method: "POST",
      headers: { "content-type": "application/json", "X-PAYMENT": header },
      body: JSON.stringify({ text: "hello" }),
    });

    expect(res.status).toBe(200);
    // The echoed body matches EchoSuccess and was not consumed by the gate.
    const echoed = (await res.json()) as { echo: string; length: number };
    expect(echoed).toEqual({ echo: "hello", length: 5 });
    // The receipt header is set.
    expect(res.headers.get("X-PAYMENT-RESPONSE")).toBeTruthy();
    // Exactly one on-chain debit was submitted.
    expect(debitState.debits).toBe(1);
    // The persisted receipt records amount <= cap.
    const stored = await resultStore.get(nonce);
    expect(stored).not.toBeNull();
    const amount = BigInt((stored!.receipt as { amount: string }).amount);
    expect(amount <= cap).toBe(true);
  });

  it("Test 3 (malformed no debit): malfunction -> 502, reservation released, strike recorded, zero debits", async () => {
    const cap = 10_000n;
    const nonce: Hex = `0x${"a3".repeat(32)}`;
    const app = createEchoServer({
      facilitatorUrl: "http://facilitator.test",
      resourceId: RESOURCE,
      cap,
      pricing: PRICING,
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      fetcher,
      malfunction: true,
    });
    const header = await signedHeader({ pk, buyer, cap, nonce, text: "hello" });
    const res = await app.request("/echo", {
      method: "POST",
      headers: { "content-type": "application/json", "X-PAYMENT": header },
      body: JSON.stringify({ text: "hello" }),
    });

    expect(res.status).toBe(502);
    // ZERO debits - a malfunction never charges.
    expect(debitState.debits).toBe(0);
    // The strike was recorded at the facilitator-side store (via /release).
    expect(await store.getStrikes(RESOURCE)).toBe(1);
    // The reservation was released (the nonce is no longer pending / locked).
    const released = await resultStore.get(nonce);
    expect(released).toBeNull();
  });

  it("Test 4 (idempotent recovery): retrieveByIdemKey returns the same receipt, no extra debit", async () => {
    const cap = 10_000n;
    const nonce: Hex = `0x${"a4".repeat(32)}`;
    const app = createEchoServer({
      facilitatorUrl: "http://facilitator.test",
      resourceId: RESOURCE,
      cap,
      pricing: PRICING,
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      fetcher,
    });
    const header = await signedHeader({ pk, buyer, cap, nonce, text: "world" });
    const res = await app.request("/echo", {
      method: "POST",
      headers: { "content-type": "application/json", "X-PAYMENT": header },
      body: JSON.stringify({ text: "world" }),
    });
    expect(res.status).toBe(200);
    expect(debitState.debits).toBe(1);

    // Simulate a buyer that disconnected after the debit: recover by idemKey (the
    // nonce) WITHOUT re-signing. Same receipt, no second debit (exactly-once).
    const retrieved = await retrieveByIdemKey("http://facilitator.test", nonce, fetcher);
    expect(retrieved).not.toBeNull();
    expect((retrieved!.receipt as { idemKey: string }).idemKey).toBe(nonce);
    // The recovered response is the paid body the buyer was owed.
    expect(JSON.parse(retrieved!.response)).toEqual({ echo: "world", length: 5 });
    // No second debit on recovery.
    expect(debitState.debits).toBe(1);
  });
});
