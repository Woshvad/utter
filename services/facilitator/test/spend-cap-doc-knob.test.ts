// Doc-knob wiring suite: proves the DOCUMENTED env var arms the per-payer spend cap
// END TO END through buildDepsFromEnv (not by hand-passing perPayerDayCap to createApp).
//
// The .env.example documents SPEND_CAP_PER_PAYER_24H_BASE_UNITS, but server.ts used to
// read the legacy SPEND_CAP_PER_PAYER_DAY, so the documented knob was a silent no-op.
// This suite drives the gate THROUGH the env so a misnamed or unwired var FAILS it: it
// sets SPEND_CAP_PER_PAYER_24H_BASE_UNITS, calls buildDepsFromEnv(), and asserts the cap
// is armed and an over-cap /verify returns 402 over_cap with ZERO reservations (the
// free-compute guard holds). A second case proves the legacy var still works as a
// back-compat fallback.
//
// Fully offline: in-memory stores, a stub publicClient, a mocked relayer. The touched
// process.env keys are saved/restored so the test does not leak env into sibling suites.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
  encodePayment,
  type PaymentPayload,
} from "@utter/x402-arc";
import { arcTestnet } from "@utter/chain";
import { buildDepsFromEnv } from "../src/server";
import { createApp, type AppDeps } from "../src/app";
import type { RelayerPool, RelayerSigner } from "../src/relayer";

const RESOURCE: Hex = `0x${"77".repeat(32)}`;
const MAX_TIMEOUT_SECONDS = 30;
const SETTLE_BUFFER_SECONDS = 90;
const PER_PAYER_DAY_CAP = 1_000_000n; // 1 USDC at 6dp (a base-unit integer, never derived)

// The env keys this suite touches; saved/restored so it never leaks into siblings.
const TOUCHED_ENV = [
  "SPEND_CAP_PER_PAYER_24H_BASE_UNITS",
  "SPEND_CAP_PER_PAYER_DAY",
  "RELAYER_SIGNER_KEYS",
];

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

async function escrowPayment(opts: {
  pk: Hex;
  buyer: Address;
  cap: bigint;
  nonce: Hex;
}): Promise<PaymentPayload> {
  const account = privateKeyToAccount(opts.pk);
  const wallet = createWalletClient({
    account,
    chain: arcTestnet,
    transport: http(arcTestnet.rpcUrls.default.http[0]),
  });
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

describe("spend-cap doc-knob: the DOCUMENTED env var arms the per-payer gate via buildDepsFromEnv", () => {
  const saved: Record<string, string | undefined> = {};
  let pk: Hex;
  let buyer: Address;

  beforeEach(() => {
    for (const key of TOUCHED_ENV) saved[key] = process.env[key];
    // A throwaway generated relayer key so buildDepsFromEnv does not fail-fast. It
    // never signs anything (the app is rebuilt with a mocked relayer pool below).
    process.env.RELAYER_SIGNER_KEYS = generatePrivateKey();
    delete process.env.SPEND_CAP_PER_PAYER_24H_BASE_UNITS;
    delete process.env.SPEND_CAP_PER_PAYER_DAY;
    pk = generatePrivateKey();
    buyer = privateKeyToAccount(pk).address;
  });

  afterEach(() => {
    for (const key of TOUCHED_ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  // Rebuild the app from env-derived deps but swap in offline test doubles for the
  // chain client + relayer pool, so the cap/store under test come from buildDepsFromEnv
  // (the env wiring) while no real chain is reached.
  function appFromEnvDeps(): { app: ReturnType<typeof createApp>; deps: AppDeps; store: InMemoryPaymentStore } {
    const deps = buildDepsFromEnv();
    const store = new InMemoryPaymentStore();
    const app = createApp({
      ...deps,
      store,
      publicClient: mockPublicClient({ [buyer.toLowerCase()]: 50_000_000n }),
      relayerPool: mockRelayerPool(),
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      settleBufferSeconds: SETTLE_BUFFER_SECONDS,
    });
    return { app, deps, store };
  }

  async function postVerify(app: ReturnType<typeof createApp>, payment: PaymentPayload): Promise<Response> {
    return app.request("/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payment: encodePayment(payment), resourceId: RESOURCE }),
    });
  }

  it("arms the cap from SPEND_CAP_PER_PAYER_24H_BASE_UNITS and denies an over-cap /verify (402 over_cap, zero reservations)", async () => {
    process.env.SPEND_CAP_PER_PAYER_24H_BASE_UNITS = PER_PAYER_DAY_CAP.toString();

    const { app, deps, store } = appFromEnvDeps();
    // The documented var WIRED the cap + store (an unwired/misnamed var leaves these unset).
    expect(deps.perPayerDayCap).toBe(PER_PAYER_DAY_CAP);
    expect(deps.spendCapStore).toBeDefined();

    // Pre-fill the payer's 24h window to the cap so the next call is over-cap.
    await deps.spendCapStore!.recordSpend(buyer.toLowerCase(), PER_PAYER_DAY_CAP, Math.floor(Date.now() / 1000));

    const nonce: Hex = `0x${"d1".repeat(32)}`;
    const payment = await escrowPayment({ pk, buyer, cap: 200_000n, nonce });
    const res = await postVerify(app, payment);

    expect(res.status).toBe(402);
    const json = (await res.json()) as { valid: boolean; reason: string };
    expect(json.valid).toBe(false);
    expect(json.reason).toBe("over_cap");
    // THE GUARD: no reservation was created - the over-cap payer consumed zero compute.
    expect(await store.isNoncePending(nonce)).toBe(false);
    expect(await store.outstandingReserved(buyer)).toBe(0n);
  });

  it("falls back to the legacy SPEND_CAP_PER_PAYER_DAY when the documented var is absent (back-compat)", async () => {
    // Only the legacy var is set; the documented var stays unset.
    process.env.SPEND_CAP_PER_PAYER_DAY = PER_PAYER_DAY_CAP.toString();

    const { deps } = appFromEnvDeps();
    expect(deps.perPayerDayCap).toBe(PER_PAYER_DAY_CAP);
    expect(deps.spendCapStore).toBeDefined();
  });

  it("leaves the gate unarmed when neither var is set (existing back-compat behavior)", async () => {
    const { deps } = appFromEnvDeps();
    expect(deps.perPayerDayCap).toBeUndefined();
    expect(deps.spendCapStore).toBeUndefined();
  });
});
