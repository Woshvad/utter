// live-test-endpoint.test.ts - the OFFLINE proof for the buyer-side liveTestEndpoint
// pay flow (Playground-real D1, MONEY-CRITICAL).
//
// liveTestEndpoint is the BUYER-SIDE half: it pays a resource that is ALREADY DEPLOYED
// (its gate calls a DEPLOYED facilitator that owns the relayer and settles). This suite
// builds an IN-PROCESS "deployed resource" - a card app serving a finalized card + a
// gated /call app wired to an in-process facilitator (the proven runTestEndpoint setup,
// mock relayer debit counter + mock chain) - and injects a `fetcher` that routes the
// card URL to the card app and the pay URL to the /call app, plus the mock publicClient
// + an ephemeral buyerWallet. This proves the orchestration WITHOUT a real tx.
//
// Assertions (the threat-register mitigations):
//   - happy path: paid===true, status===200, debitAmount>0n and <=cap, EXACTLY ONE
//     relayer debit, cap===the card cap, idemKey set, receipt present
//   - card poison: a card whose x402.escrow != PAYMENT_ESCROW -> THROWS (refusing to
//     pay) and the relayer debit counter stays 0 (T-07-CARDPOISON: never pays)
//   - gating: no injected deps + no TEST_BUYER_PRIVATE_KEY -> RequiresFundedWalletError
//     before any network call
//   - non-402 unpaid: a fetcher whose unpaid call returns 200 -> "expected 402"
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  createWalletClient,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { arcTestnet, PAYMENT_ESCROW, PAYMENT_SPLITTER, USDC } from "@utter/chain";
import { buildAgentCard } from "@utter/ai-runtime";
import {
  buildClassifier,
  requirePayment,
  type AcceptsEntry,
  type FetchLike,
  type Pricing,
} from "@utter/x402-arc";
import { createApp } from "@utter/facilitator/app";
import { createInMemoryStores } from "@utter/facilitator/stores/memory";
import { createInMemoryBuyerLock } from "@utter/facilitator/verify";
import type { RelayerPool, RelayerSigner } from "@utter/facilitator/relayer";
import {
  liveTestEndpoint,
  RequiresFundedWalletError,
  type TestEndpointResult,
} from "../src/index.js";

const RESOURCE: Hex = `0x${"e7".repeat(32)}`;
const MAX_TIMEOUT_SECONDS = 30;
const SETTLE_BUFFER_SECONDS = 90;
const FACILITATOR_URL = "http://live-test-endpoint.local";
const CARD_URL = "https://my-endpoint.resources.utter.test";
const PAY_URL = "https://my-endpoint.resources.utter.test/call";

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

/**
 * A stub public client: a funded buyer, no used nonces, instant receipts, and a
 * decimals() read so liveTestEndpoint derives precision at RUNTIME (no decimals
 * literal). The decimals spy counts reads so the test proves the runtime read happened.
 */
function mockPublicClient(opts: {
  balances: Record<string, bigint>;
  decimals: number;
  decimalsReads: { count: number };
}): PublicClient {
  return {
    async readContract({ functionName, args }: { functionName: string; args?: readonly unknown[] }) {
      if (functionName === "decimals") {
        opts.decimalsReads.count += 1;
        return opts.decimals;
      }
      if (functionName === "balanceOf") {
        return opts.balances[((args?.[0] as string) ?? "").toLowerCase()] ?? 0n;
      }
      if (functionName === "usedNonce") return false;
      throw new Error(`mockPublicClient: unexpected functionName ${functionName}`);
    },
    async waitForTransactionReceipt() {
      return { status: "success" };
    },
  } as unknown as PublicClient;
}

/** Build a buyer wallet client for a fresh local account (signs only; no broadcast). */
function makeBuyer() {
  const account = privateKeyToAccount(generatePrivateKey());
  const wallet = createWalletClient({
    account,
    chain: arcTestnet,
    transport: http(arcTestnet.rpcUrls.default.http[0]),
  });
  return { account, buyer: account.address as Address, wallet };
}

/** The echo success/error OpenAPI the gate classifier validates the body against. */
const ECHO_OPENAPI: Record<string, unknown> = {
  openapi: "3.1.0",
  info: { title: "echo", version: "1.0.0" },
  paths: {},
  components: {
    schemas: {
      EchoSuccess: {
        type: "object",
        required: ["echo", "length"],
        properties: { echo: { type: "string" }, length: { type: "integer" } },
        additionalProperties: false,
      },
      EchoError: {
        type: "object",
        required: ["error", "code"],
        properties: { error: { type: "string" }, code: { type: "string" } },
        additionalProperties: false,
      },
    },
  },
};

/**
 * Build a finalized card with the deploy/Phase-5 fields the publish pipeline sets, so it
 * validates AND carries the payTo resourceId. `escrowOverride` lets a test poison the
 * pinned escrow field to prove the card-poison rejection.
 */
function buildServedCard(escrowOverride?: string): Record<string, unknown> {
  const base = buildAgentCard({
    prompt: "Return the current weather for a city",
    runtime: "node",
    pricing: { model: "metered", base: "5000", perKB: "100", max: "10000" },
  });
  const x402 = base.x402 as Record<string, unknown>;
  return {
    ...base,
    x402: { ...x402, payTo: RESOURCE, ...(escrowOverride ? { escrow: escrowOverride } : {}) },
    identity: { standard: "erc-8004", chainId: 5042002, agentId: "42" },
    health: { verified: true, score: null },
    bond: { posted: true, amount: "2000000" },
  };
}

/**
 * Build the in-process "deployed resource": a card app serving the finalized card at the
 * A2A path + a gated /call app wired to an in-process facilitator (mock relayer + mock
 * chain). Returns a `fetcher` that routes the card URL to the card app and the pay URL to
 * the /call app - exactly the seam liveTestEndpoint injects in place of the global fetch.
 */
function buildDeployedResource(opts: {
  card: Record<string, unknown>;
  relayerPool: RelayerPool;
  publicClient: PublicClient;
}) {
  const cap = BigInt(
    ((opts.card.x402 as Record<string, unknown>).pricing as Record<string, unknown>).max as string,
  );
  const pricing: Pricing = {
    model: "metered",
    base: "5000",
    perKB: "100",
    computeMultiplier: "0",
    maxResponseBytes: 1_048_576,
  };

  const stores = createInMemoryStores();
  const facilitator = createApp({
    store: stores.payments,
    resultStore: stores.results,
    relayerPool: opts.relayerPool,
    publicClient: opts.publicClient as never,
    perBuyerLock: createInMemoryBuyerLock(),
    escrowAddress: PAYMENT_ESCROW,
    splitterAddress: PAYMENT_SPLITTER,
    usdcAddress: USDC,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    settleBufferSeconds: SETTLE_BUFFER_SECONDS,
  });
  const innerFetcher: FetchLike = async (input, init) =>
    facilitator.request(input, { method: init?.method, headers: init?.headers, body: init?.body });

  const classifier = buildClassifier(ECHO_OPENAPI);
  const quote = (): AcceptsEntry => ({
    scheme: "utter-escrow",
    network: "eip155:5042002",
    asset: USDC,
    escrow: PAYMENT_ESCROW,
    maxAmountRequired: cap.toString(),
    payTo: RESOURCE,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    pricing,
  });

  const resourceApp = new Hono();
  resourceApp.use(
    "/call",
    requirePayment({
      facilitatorUrl: FACILITATOR_URL,
      quote,
      classifier,
      pricing,
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      fetcher: innerFetcher,
    }),
  );
  resourceApp.post("/call", async (c) => {
    let body: { text?: unknown };
    try {
      body = (await c.req.json()) as { text?: unknown };
    } catch {
      return c.json({ error: "request body must be valid JSON", code: "BAD_JSON" }, 400);
    }
    const text = body?.text;
    if (typeof text !== "string") {
      return c.json({ error: "text must be a string", code: "BAD_INPUT" }, 400);
    }
    return c.json({ echo: text, length: text.length }, 200);
  });

  // The injected HTTP transport: route the card URL to the card JSON and the pay URL to
  // the gated /call app. This is the deployed-HTTPS seam without a real network.
  const fetcher = async (
    input: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<Response> => {
    if (input.endsWith("/.well-known/agent-card.json")) {
      return new Response(JSON.stringify(opts.card), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (input === PAY_URL) {
      return resourceApp.request("/call", {
        method: init?.method,
        headers: init?.headers,
        body: init?.body,
      });
    }
    throw new Error(`unexpected fetch to ${input}`);
  };

  return { fetcher, cap };
}

describe("liveTestEndpoint (the buyer-side live pay flow, Playground-real D1)", () => {
  let debitState: DebitState;
  let decimalsReads: { count: number };
  let buyerCtx: ReturnType<typeof makeBuyer>;

  beforeEach(() => {
    debitState = { debits: 0 };
    decimalsReads = { count: 0 };
    buyerCtx = makeBuyer();
  });

  function mkChain() {
    return mockPublicClient({
      balances: { [buyerCtx.buyer.toLowerCase()]: 1_000_000n },
      decimals: 6,
      decimalsReads,
    });
  }

  it("happy path: exactly one debit <= cap against the in-process gated endpoint", async () => {
    const publicClient = mkChain();
    const relayerPool = mockRelayerPool(debitState);
    const { fetcher, cap } = buildDeployedResource({
      card: buildServedCard(),
      relayerPool,
      publicClient,
    });

    const result: TestEndpointResult = await liveTestEndpoint({
      cardUrl: CARD_URL,
      endpointUrl: PAY_URL,
      env: {},
      fetcher,
      publicClient,
      buyerWallet: buyerCtx.wallet,
    });

    expect(result.paid).toBe(true);
    expect(result.status).toBe(200);
    // EXACTLY ONE on-chain debit was submitted (no free-compute, no double-charge).
    expect(debitState.debits).toBe(1);
    // The debit was positive and <= the card-derived cap.
    expect(result.debitAmount > 0n).toBe(true);
    expect(result.debitAmount <= result.cap).toBe(true);
    // The cap matches the card pricing.max (read only from the card).
    expect(result.cap).toBe(cap);
    expect(result.cap).toBe(10_000n);
    // The precision came from a RUNTIME decimals() read (no decimals literal).
    expect(decimalsReads.count).toBeGreaterThanOrEqual(1);
    // The idemKey (nonce) is set and a receipt came back.
    expect(result.idemKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.receipt).toBeTruthy();
    // Buyer-side runner: recovery is the deployed facilitator's concern, not addressed here.
    expect(result.recovered).toBeNull();
  });

  it("card poison: escrow != PAYMENT_ESCROW -> throws and NEVER pays (no debit)", async () => {
    const publicClient = mkChain();
    const relayerPool = mockRelayerPool(debitState);
    // Poison the pinned escrow with a well-formed but attacker-chosen address.
    const { fetcher } = buildDeployedResource({
      card: buildServedCard("0x000000000000000000000000000000000000dEaD"),
      relayerPool,
      publicClient,
    });

    await expect(
      liveTestEndpoint({
        cardUrl: CARD_URL,
        endpointUrl: PAY_URL,
        env: {},
        fetcher,
        publicClient,
        buyerWallet: buyerCtx.wallet,
      }),
    ).rejects.toThrow(/refusing to pay/i);
    // The poisoned card never paid -> no debit.
    expect(debitState.debits).toBe(0);
  });

  it("H4: a card whose payTo != the requested resourceId is refused and NEVER pays (no debit)", async () => {
    const publicClient = mkChain();
    const relayerPool = mockRelayerPool(debitState);
    // The served card's payTo is RESOURCE; the caller asks to pay a DIFFERENT resourceId,
    // so the payTo binding must refuse before any signature (payment-redirect guard).
    const { fetcher } = buildDeployedResource({
      card: buildServedCard(),
      relayerPool,
      publicClient,
    });
    const foreignResourceId = `0x${"c3".repeat(32)}` as Hex;

    await expect(
      liveTestEndpoint({
        cardUrl: CARD_URL,
        endpointUrl: PAY_URL,
        resourceId: foreignResourceId,
        env: {},
        fetcher,
        publicClient,
        buyerWallet: buyerCtx.wallet,
      }),
    ).rejects.toThrow(/does not match the requested resourceId|refusing to pay/i);
    // The mismatched card never paid -> no debit.
    expect(debitState.debits).toBe(0);
  });

  it("H4: a matching requested resourceId binds and still pays (exactly one debit <= cap)", async () => {
    const publicClient = mkChain();
    const relayerPool = mockRelayerPool(debitState);
    const { fetcher } = buildDeployedResource({
      card: buildServedCard(),
      relayerPool,
      publicClient,
    });

    const result = await liveTestEndpoint({
      cardUrl: CARD_URL,
      endpointUrl: PAY_URL,
      // The requested resourceId matches the served card's payTo -> the binding passes.
      resourceId: RESOURCE,
      env: {},
      fetcher,
      publicClient,
      buyerWallet: buyerCtx.wallet,
    });

    expect(result.paid).toBe(true);
    expect(debitState.debits).toBe(1);
    expect(result.debitAmount > 0n).toBe(true);
    expect(result.debitAmount <= result.cap).toBe(true);
  });

  it("gating: no injected deps and no TEST_BUYER_PRIVATE_KEY -> throws before any network call", async () => {
    let networkCalls = 0;
    const spyFetcher = async (): Promise<Response> => {
      networkCalls += 1;
      return new Response("{}", { status: 200 });
    };

    await expect(
      liveTestEndpoint({
        cardUrl: CARD_URL,
        endpointUrl: PAY_URL,
        env: {},
        // A fetcher is injected ONLY to prove it is never called; no wallet/publicClient.
        fetcher: spyFetcher,
      }),
    ).rejects.toBeInstanceOf(RequiresFundedWalletError);
    // The guard fired BEFORE any discovery/network call.
    expect(networkCalls).toBe(0);
    expect(debitState.debits).toBe(0);
  });

  it("non-402 unpaid: a fetcher whose unpaid call returns 200 -> throws 'expected 402'", async () => {
    const publicClient = mkChain();
    // A fetcher that serves a valid card but returns 200 on the unpaid pay call.
    const fetcher = async (input: string): Promise<Response> => {
      if (input.endsWith("/.well-known/agent-card.json")) {
        return new Response(JSON.stringify(buildServedCard()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ echo: "x", length: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await expect(
      liveTestEndpoint({
        cardUrl: CARD_URL,
        endpointUrl: PAY_URL,
        env: {},
        fetcher,
        publicClient,
        buyerWallet: buyerCtx.wallet,
      }),
    ).rejects.toThrow(/expected 402/i);
    // No payment was ever signed/sent -> no debit.
    expect(debitState.debits).toBe(0);
  });
});
