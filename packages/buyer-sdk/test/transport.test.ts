// transport.test.ts - Task 1 of Plan 07-02: the transport seam (fixture-default +
// live-fail-loud), ensureDeposit (deposit-once, runtime-decimals, approve-then-deposit),
// and discover (validateAgentCard HARD-gate; an invalid card never pays).
//
// No live network/chain: the fixture transport mounts the IN-PROCESS facilitator and a
// mock chain; the live transport is asserted to throw RequiresLiveBuyerError.
import { describe, it, expect, beforeEach } from "vitest";
import {
  createWalletClient,
  http,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { arcTestnet, PAYMENT_ESCROW } from "@utter/chain";
import { buildAgentCard } from "@utter/ai-runtime";
import type { RelayerPool, RelayerSigner } from "@utter/facilitator/relayer";

import {
  selectBuyerTransport,
  createFixtureTransport,
  RequiresLiveBuyerError,
} from "../src/transport.js";
import { ensureDeposit } from "../src/deposit.js";
import { discover } from "../src/discover.js";

const RESOURCE: Hex = `0x${"e7".repeat(32)}`;

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

/** A stub chain reader: configurable escrow balance, allowance, decimals (a runtime read). */
function mockPublicClient(opts: {
  escrowBalance: bigint;
  allowance: bigint;
  decimals: number;
  reads: { decimals: number; balanceOf: number; allowance: number };
}): PublicClient {
  return {
    async readContract({ functionName }: { functionName: string }) {
      if (functionName === "decimals") {
        opts.reads.decimals += 1;
        return opts.decimals;
      }
      if (functionName === "balanceOf") {
        opts.reads.balanceOf += 1;
        return opts.escrowBalance;
      }
      if (functionName === "allowance") {
        opts.reads.allowance += 1;
        return opts.allowance;
      }
      throw new Error(`mockPublicClient: unexpected functionName ${functionName}`);
    },
    async waitForTransactionReceipt() {
      return { status: "success" };
    },
  } as unknown as PublicClient;
}

/** A wallet client that records the ORDER of writeContract calls (approve before deposit). */
function mockWalletClient(calls: string[]): WalletClient<Transport, Chain | undefined, Account> {
  const account = privateKeyToAccount(generatePrivateKey());
  return {
    account,
    chain: arcTestnet,
    async writeContract({ functionName }: { functionName: string }) {
      calls.push(functionName);
      return ("0x" + "cd".repeat(32)) as Hex;
    },
  } as unknown as WalletClient<Transport, Chain | undefined, Account>;
}

/** A finalized, validateAgentCard-valid card (the SOLE discovery source). */
function buildValidCard(): Record<string, unknown> {
  const base = buildAgentCard({
    prompt: "Return the current weather for a city",
    runtime: "node",
    pricing: { model: "metered", base: "5000", perKB: "100", max: "10000" },
  });
  return {
    ...base,
    x402: { ...(base.x402 as Record<string, unknown>), payTo: RESOURCE },
    identity: { standard: "erc-8004", chainId: 5042002, agentId: "42" },
    health: { verified: true, score: null },
    bond: { posted: true, amount: "2000000" },
  };
}

describe("selectBuyerTransport (the seam, fixture default / live fail-loud)", () => {
  it("returns the in-process fixture transport by default (no live env)", () => {
    const t = selectBuyerTransport(
      {},
      {
        publicClient: mockPublicClient({
          escrowBalance: 0n,
          allowance: 0n,
          decimals: 6,
          reads: { decimals: 0, balanceOf: 0, allowance: 0 },
        }),
        relayerPool: mockRelayerPool({ debits: 0 }),
      },
    );
    expect(t.kind).toBe("fixture");
    // The fixture mounts an in-process facilitator; mountFacilitator returns a fetcher.
    const mounted = t.mountFacilitator({ escrow: PAYMENT_ESCROW, asset: PAYMENT_ESCROW });
    expect(typeof mounted.fetcher).toBe("function");
  });

  it("createFixtureTransport mounts a facilitator whose fetcher serves /results 404 for an unknown nonce", async () => {
    const t = createFixtureTransport({
      publicClient: mockPublicClient({
        escrowBalance: 0n,
        allowance: 0n,
        decimals: 6,
        reads: { decimals: 0, balanceOf: 0, allowance: 0 },
      }),
      relayerPool: mockRelayerPool({ debits: 0 }),
    });
    const { fetcher } = t.mountFacilitator({ escrow: PAYMENT_ESCROW, asset: PAYMENT_ESCROW });
    const res = await fetcher(`/results/0x${"00".repeat(32)}`, { method: "GET" });
    expect(res.status).toBe(404);
  });

  it("throws RequiresLiveBuyerError for the live transport (operator-gated, fail-loud)", () => {
    expect(() => selectBuyerTransport({ BUYER_SDK_TRANSPORT: "live" })).toThrow(
      RequiresLiveBuyerError,
    );
    try {
      selectBuyerTransport({ BUYER_SDK_TRANSPORT: "live" });
    } catch (e) {
      expect((e as RequiresLiveBuyerError).code).toBe("requiresLiveBuyer");
      expect((e as Error).message).toMatch(/BUYER_PRIVATE_KEY/);
    }
  });
});

describe("ensureDeposit (deposit-once, runtime-decimals, approve-then-deposit)", () => {
  let calls: string[];
  let wallet: WalletClient<Transport, Chain | undefined, Account>;
  let buyer: `0x${string}`;

  beforeEach(() => {
    calls = [];
    wallet = mockWalletClient(calls);
    buyer = wallet.account!.address as `0x${string}`;
  });

  it("makes ZERO writes when the escrow balance already covers the cap (deposit-once)", async () => {
    const reads = { decimals: 0, balanceOf: 0, allowance: 0 };
    const pub = mockPublicClient({ escrowBalance: 100_000n, allowance: 0n, decimals: 6, reads });
    const result = await ensureDeposit({
      publicClient: pub,
      walletClient: wallet,
      buyer,
      neededCap: 10_000n,
    });
    expect(result.deposited).toBe(false);
    expect(result.approved).toBe(false);
    expect(calls).toEqual([]); // no approve, no deposit
  });

  it("approves THEN deposits the shortfall when short, reading decimals at runtime", async () => {
    const reads = { decimals: 0, balanceOf: 0, allowance: 0 };
    const pub = mockPublicClient({ escrowBalance: 0n, allowance: 0n, decimals: 6, reads });
    const result = await ensureDeposit({
      publicClient: pub,
      walletClient: wallet,
      buyer,
      neededCap: 10_000n,
    });
    expect(result.deposited).toBe(true);
    expect(result.approved).toBe(true);
    expect(result.topUp).toBe(10_000n);
    // The ORDER is approve BEFORE deposit (Pitfall 5).
    expect(calls).toEqual(["approve", "deposit"]);
    // The decimals() read happened at runtime (no 6/18/1e6 literal).
    expect(reads.decimals).toBeGreaterThanOrEqual(1);
  });

  it("skips the approve when the allowance already covers the top-up", async () => {
    const reads = { decimals: 0, balanceOf: 0, allowance: 0 };
    const pub = mockPublicClient({
      escrowBalance: 0n,
      allowance: 1_000_000n,
      decimals: 6,
      reads,
    });
    const result = await ensureDeposit({
      publicClient: pub,
      walletClient: wallet,
      buyer,
      neededCap: 10_000n,
    });
    expect(result.deposited).toBe(true);
    expect(result.approved).toBe(false);
    expect(calls).toEqual(["deposit"]); // allowance sufficient -> deposit only
  });
});

describe("discover (validateAgentCard HARD-gate; an invalid card never pays)", () => {
  const fetchValid: (card: Record<string, unknown>, status?: number) => Parameters<typeof discover>[1] =
    (card, status = 200) => ({
      fetcher: async () => ({ status, json: async () => card }),
    });

  it("returns the validated card + the pay-input projection (inputs only from the card)", async () => {
    const card = buildValidCard();
    const { cardInputs } = await discover(
      { cardUrl: "https://res.example/.well-known/agent-card.json" },
      fetchValid(card),
    );
    expect(cardInputs.payTo).toBe(RESOURCE);
    expect(cardInputs.cap).toBe(10_000n);
    expect(cardInputs.bondPosted).toBe(true);
    expect(cardInputs.verified).toBe(true);
  });

  it("throws on a non-200 fetch (not discoverable) and reads no pay input", async () => {
    await expect(
      discover({ cardUrl: "https://res.example" }, fetchValid({}, 404)),
    ).rejects.toThrow(/not discoverable/i);
  });

  it("throws on a card that FAILS validateAgentCard (T-07-CARDPOISON: invalid card never pays)", async () => {
    // A poisoned card: a v1.0.0-shaped object validateAgentCard rejects, carrying a
    // malicious x402.payTo. The throw MUST happen before any pay input is read.
    const poisoned = {
      protocolVersion: "1.0.0",
      supportedInterfaces: [],
      x402: { payTo: `0x${"ff".repeat(32)}`, escrow: PAYMENT_ESCROW, pricing: { max: "999999999" } },
    };
    await expect(
      discover({ cardUrl: "https://evil.example" }, fetchValid(poisoned)),
    ).rejects.toThrow(/invalid agent card|never pays/i);
  });

  it("resolves a resourceId via the injected cardSource (fixture default)", async () => {
    const card = buildValidCard();
    const { cardInputs } = await discover(
      { resourceId: RESOURCE },
      { cardSource: async (id) => (id === RESOURCE ? card : null) },
    );
    expect(cardInputs.payTo).toBe(RESOURCE);
  });

  it("throws for an unresolvable resourceId (no card -> not discoverable)", async () => {
    await expect(
      discover({ resourceId: RESOURCE }, { cardSource: async () => null }),
    ).rejects.toThrow(/not discoverable/i);
  });
});

// Keep a live-wallet builder referenced so the type-only viem import path is exercised.
void createWalletClient;
void http;
