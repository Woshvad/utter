// resource-auth-routes suite (Security review C1): /verify, /settle, /release
// enforce the per-resource caller-auth token WHEN configured, and pass through
// UNCHANGED when not.
//
// Enforced path: a valid token bound to resource X allows the op on X; a missing/
// invalid token -> 401; a token for X on an op for Y -> 403. Unenforced path: the
// op proceeds with no token (today's in-process behavior). Fully offline: the
// relayer is mocked, the publicClient returns a funded buyer + instant receipts,
// and the gate's signing helpers build a real escrow payload.
import { describe, it, expect } from "vitest";
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
  type PaymentPayload,
} from "@utter/x402-arc";
import { createApp, type AppDeps } from "../src/app";
import { createInMemoryBuyerLock } from "../src/verify";
import { mintResourceAuthToken } from "../src/resource-auth";
import type { RelayerPool, RelayerSigner } from "../src/relayer";

const SECRET = "facilitator-auth-secret-at-least-32-chars-long";
const RESOURCE_X: Hex = `0x${"11".repeat(32)}`;
const RESOURCE_Y: Hex = `0x${"22".repeat(32)}`;
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

function mockPublicClient(balances: Record<string, bigint>): PublicClient {
  return {
    async readContract({ functionName, args }: { functionName: string; args: readonly unknown[] }) {
      if (functionName === "balanceOf") {
        return balances[(args[0] as string).toLowerCase()] ?? 0n;
      }
      if (functionName === "usedNonce") return false;
      throw new Error(`unexpected functionName ${functionName}`);
    },
    async waitForTransactionReceipt() {
      return { status: "success" };
    },
  } as unknown as PublicClient;
}

/** Build the facilitator app, optionally arming per-resource auth. */
function makeApp(opts: {
  authSecret?: string;
  authEnforced?: boolean;
  state?: DebitState;
  buyer?: Address;
}) {
  const deps: AppDeps = {
    store: new InMemoryPaymentStore(),
    resultStore: new InMemoryResultStore(),
    relayerPool: mockRelayerPool(opts.state ?? { debits: 0 }),
    publicClient: mockPublicClient(opts.buyer ? { [opts.buyer.toLowerCase()]: 1_000_000n } : {}),
    perBuyerLock: createInMemoryBuyerLock(),
    escrowAddress: PAYMENT_ESCROW,
    splitterAddress: PAYMENT_SPLITTER,
    usdcAddress: USDC,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    settleBufferSeconds: SETTLE_BUFFER_SECONDS,
    authSecret: opts.authSecret,
    authEnforced: opts.authEnforced,
  };
  return createApp(deps);
}

/** Build + sign an escrow payload bound to `resourceId`, then base64 it for the body. */
async function signedPayment(opts: {
  pk: Hex;
  buyer: Address;
  resourceId: Hex;
  cap: bigint;
  nonce: Hex;
}): Promise<{ header: string; payment: PaymentPayload }> {
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
    resourceId: opts.resourceId,
    maxAmount: opts.cap,
    nonce: opts.nonce,
    validBefore,
  });
  const payment: PaymentPayload = {
    x402Version: 2,
    scheme: "utter-escrow",
    network: "eip155:5042002",
    authorization: {
      buyer: opts.buyer,
      resourceId: opts.resourceId,
      maxAmount: opts.cap.toString(),
      nonce: opts.nonce,
      validBefore: validBefore.toString(),
    },
    signature: signed.signature,
  };
  return { header: encodePayment(payment), payment };
}

function verifyBody(payment: string, resourceId: Hex) {
  return JSON.stringify({ payment, resourceId, maxTimeoutSeconds: MAX_TIMEOUT_SECONDS });
}

describe("C1 per-resource caller auth on the facilitator routes", () => {
  it("UNENFORCED (no secret): /verify proceeds with NO token (current behavior)", async () => {
    const pk = generatePrivateKey();
    const buyer = privateKeyToAccount(pk).address;
    const app = makeApp({ buyer });
    const { header } = await signedPayment({
      pk,
      buyer,
      resourceId: RESOURCE_X,
      cap: 10_000n,
      nonce: `0x${"01".repeat(32)}`,
    });
    const res = await app.request("/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: verifyBody(header, RESOURCE_X),
    });
    // No auth header, no secret -> the reserve runs as before (200 valid).
    expect(res.status).toBe(200);
    const body = (await res.json()) as { valid: boolean };
    expect(body.valid).toBe(true);
  });

  it("ENFORCED: a valid token for X ALLOWS /verify on X", async () => {
    const pk = generatePrivateKey();
    const buyer = privateKeyToAccount(pk).address;
    const app = makeApp({ authSecret: SECRET, authEnforced: true, buyer });
    const token = mintResourceAuthToken(RESOURCE_X, SECRET);
    const { header } = await signedPayment({
      pk,
      buyer,
      resourceId: RESOURCE_X,
      cap: 10_000n,
      nonce: `0x${"02".repeat(32)}`,
    });
    const res = await app.request("/verify", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: verifyBody(header, RESOURCE_X),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { valid: boolean }).valid).toBe(true);
  });

  it("ENFORCED: a MISSING token -> 401 on /verify (no reserve runs)", async () => {
    const pk = generatePrivateKey();
    const buyer = privateKeyToAccount(pk).address;
    const app = makeApp({ authSecret: SECRET, authEnforced: true, buyer });
    const { header } = await signedPayment({
      pk,
      buyer,
      resourceId: RESOURCE_X,
      cap: 10_000n,
      nonce: `0x${"03".repeat(32)}`,
    });
    const res = await app.request("/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: verifyBody(header, RESOURCE_X),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { reason: string }).reason).toBe("unauthorized");
  });

  it("ENFORCED: an INVALID token -> 401 on /verify", async () => {
    const pk = generatePrivateKey();
    const buyer = privateKeyToAccount(pk).address;
    const app = makeApp({ authSecret: SECRET, authEnforced: true, buyer });
    const { header } = await signedPayment({
      pk,
      buyer,
      resourceId: RESOURCE_X,
      cap: 10_000n,
      nonce: `0x${"04".repeat(32)}`,
    });
    const res = await app.request("/verify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Resource-Auth": "garbage.token",
      },
      body: verifyBody(header, RESOURCE_X),
    });
    expect(res.status).toBe(401);
  });

  it("ENFORCED: a token for X on an op for Y -> 403 on /verify", async () => {
    const pk = generatePrivateKey();
    const buyer = privateKeyToAccount(pk).address;
    const app = makeApp({ authSecret: SECRET, authEnforced: true, buyer });
    const tokenX = mintResourceAuthToken(RESOURCE_X, SECRET);
    const { header } = await signedPayment({
      pk,
      buyer,
      resourceId: RESOURCE_Y,
      cap: 10_000n,
      nonce: `0x${"05".repeat(32)}`,
    });
    const res = await app.request("/verify", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${tokenX}` },
      body: verifyBody(header, RESOURCE_Y),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { reason: string }).reason).toBe("forbidden_resource");
  });

  it("ENFORCED: /release requires a token bound to the release resourceId (401/403/allow)", async () => {
    const app = makeApp({ authSecret: SECRET, authEnforced: true });
    const idemKey: Hex = `0x${"06".repeat(32)}`;
    const tokenX = mintResourceAuthToken(RESOURCE_X, SECRET);

    // Missing token -> 401.
    const missing = await app.request("/release", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idemKey, resourceId: RESOURCE_X, strikeReason: "invalid_output" }),
    });
    expect(missing.status).toBe(401);

    // Token for X on a release for Y -> 403.
    const wrong = await app.request("/release", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${tokenX}` },
      body: JSON.stringify({ idemKey, resourceId: RESOURCE_Y, strikeReason: "invalid_output" }),
    });
    expect(wrong.status).toBe(403);

    // Token for X on a release for X -> allowed (releases + records the strike).
    const ok = await app.request("/release", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${tokenX}` },
      body: JSON.stringify({ idemKey, resourceId: RESOURCE_X, strikeReason: "invalid_output" }),
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { struck: boolean }).struck).toBe(true);
  });

  it("ENFORCED: /settle for an unauthorized resource is rejected BEFORE any debit", async () => {
    const pk = generatePrivateKey();
    const buyer = privateKeyToAccount(pk).address;
    const state: DebitState = { debits: 0 };
    const app = makeApp({ authSecret: SECRET, authEnforced: true, state, buyer });
    const tokenX = mintResourceAuthToken(RESOURCE_X, SECRET);
    const { header } = await signedPayment({
      pk,
      buyer,
      resourceId: RESOURCE_Y,
      cap: 10_000n,
      nonce: `0x${"07".repeat(32)}`,
    });
    const res = await app.request("/settle", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${tokenX}` },
      body: JSON.stringify({ payment: header, amount: "5000", response: "{}" }),
    });
    // Token bound to X, settle for Y -> 403, and NO on-chain debit happened.
    expect(res.status).toBe(403);
    expect(state.debits).toBe(0);
  });

  it("UNENFORCED: /release proceeds with no token even with no resourceId in the body", async () => {
    const app = makeApp({});
    const res = await app.request("/release", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idemKey: `0x${"08".repeat(32)}` }),
    });
    // No secret, no token, no resourceId -> the free-path release behaves as before.
    expect(res.status).toBe(200);
    expect(((await res.json()) as { released: boolean }).released).toBe(true);
  });
});
