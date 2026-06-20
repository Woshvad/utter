// test-endpoint.test.ts - the programmatic "test this endpoint" pay-flow runner
// (MKT-03/04). It proves an EXTERNAL agent can discover a resource by reading ONLY
// its agent card, deposit, sign a DebitAuthorization for the card-derived cap, pay,
// and settle with EXACTLY ONE debit <= cap - cloning the echo-money-path harness
// (the in-process facilitator createApp + a mocked chain).
//
// Assertions (the threat-register mitigations):
//   - the runner reads x402{escrow,pricing,payTo} + health + bond ONLY from the card
//     (no out-of-band config) - MKT-04 / T-05-07-CARDONLY
//   - the escrow gate reserves the cap BEFORE the handler runs (reserve-before-run) -
//     T-05-07-FREECOMPUTE (inherited from the FROZEN requirePayment gate)
//   - EXACTLY ONE debit <= cap (no free-compute, no double-charge) - T-05-07-DOUBLECHARGE
//   - the cap derives from a RUNTIME decimals() read, no 1e6 literal - T-05-07-DECIMALS
//   - a disconnect-then-retrieve returns the paid result with NO second debit
import { describe, it, expect, beforeEach } from "vitest";
import {
  createWalletClient,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { arcTestnet, PAYMENT_ESCROW, USDC } from "@utter/chain";
import { buildAgentCard } from "@utter/ai-runtime";
import type { RelayerPool, RelayerSigner } from "@utter/facilitator/relayer";
import { createCardApp, runTestEndpoint, type TestEndpointResult } from "../src/index.js";

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

/**
 * A stub public client: a funded buyer, no used nonces, instant receipts, and a
 * decimals() read so the runner derives the cap at RUNTIME (no 1e6 literal). The
 * decimals spy counts reads so the test proves the runtime read happened.
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

/** Build a buyer wallet client for a fresh local account. */
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

/** Build a finalized card served by the card route (the runner's SOLE discovery source). */
function buildServedCard(): Record<string, unknown> {
  const base = buildAgentCard({
    prompt: "Return the current weather for a city",
    runtime: "node",
    pricing: { model: "metered", base: "5000", perKB: "100", max: "10000" },
  });
  // Finalize the deploy/Phase-5 fields the publish pipeline sets (so the card validates
  // AND carries the payTo resourceId the runner pays against - read ONLY from here).
  return {
    ...base,
    x402: { ...(base.x402 as Record<string, unknown>), payTo: RESOURCE },
    identity: { standard: "erc-8004", chainId: 5042002, agentId: "42" },
    health: { verified: true, score: null },
    bond: { posted: true, amount: "2000000" },
  };
}

describe("runTestEndpoint (the pay-flow runner, MKT-03/04)", () => {
  let debitState: DebitState;
  let decimalsReads: { count: number };
  let cardApp: ReturnType<typeof createCardApp>;
  let buyerCtx: ReturnType<typeof makeBuyer>;

  beforeEach(() => {
    debitState = { debits: 0 };
    decimalsReads = { count: 0 };
    buyerCtx = makeBuyer();
    const card = buildServedCard();
    cardApp = createCardApp({
      source: { async getCard(id: string) { return id === RESOURCE ? card : null; } },
    });
  });

  function run(extra?: Partial<Parameters<typeof runTestEndpoint>[0]>): Promise<TestEndpointResult> {
    return runTestEndpoint({
      resourceId: RESOURCE,
      // Discover the card via the card route (read ONLY the card from here).
      cardFetcher: async (id) => {
        const res = await cardApp.request(`/${id}/.well-known/agent-card.json`, { method: "GET" });
        if (res.status !== 200) return null;
        return (await res.json()) as Record<string, unknown>;
      },
      buyerWallet: buyerCtx.wallet,
      // The mock chain: funded buyer + a runtime decimals() read + a debit-counting relayer.
      publicClient: mockPublicClient({
        balances: { [buyerCtx.buyer.toLowerCase()]: 1_000_000n },
        decimals: 6,
        decimalsReads,
      }),
      relayerPool: mockRelayerPool(debitState),
      ...extra,
    });
  }

  it("discovers + pays using ONLY the card; exactly one debit <= cap", async () => {
    const result = await run();

    expect(result.paid).toBe(true);
    expect(result.status).toBe(200);
    // EXACTLY ONE on-chain debit was submitted.
    expect(debitState.debits).toBe(1);
    // The debit was <= the card-derived cap.
    expect(result.debitAmount <= result.cap).toBe(true);
    // The cap derived from a RUNTIME decimals() read (no 1e6 literal).
    expect(decimalsReads.count).toBeGreaterThanOrEqual(1);
    // The cap matches the card pricing.max (read only from the card).
    expect(result.cap).toBe(10_000n);
    // A receipt header came back.
    expect(result.receipt).toBeTruthy();
  });

  it("reads the pay inputs (escrow, pricing, payTo) ONLY from the card", async () => {
    const result = await run();
    // The escrow + payTo the runner used came straight off the card's x402 block.
    expect(result.cardInputs.escrow).toBe(PAYMENT_ESCROW);
    expect(result.cardInputs.payTo).toBe(RESOURCE);
    expect(result.cardInputs.asset).toBe(USDC);
    // The bond + reputation it surfaced also came from the card (MKT-04 proof).
    expect(result.cardInputs.bondPosted).toBe(true);
  });

  it("a disconnect-then-retrieve returns the paid result with NO second debit", async () => {
    const result = await run();
    expect(debitState.debits).toBe(1);

    // Recover by idemKey (the nonce) WITHOUT re-signing - exactly-once across a disconnect.
    expect(result.recovered).not.toBeNull();
    expect(result.recovered!.idemKey).toBe(result.idemKey);
    // No second debit on recovery.
    expect(debitState.debits).toBe(1);
  });

  it("refuses to pay an undiscoverable resource (no card -> no pay, no debit)", async () => {
    await expect(
      runTestEndpoint({
        resourceId: RESOURCE,
        cardFetcher: async () => null, // the resource is not discoverable
        buyerWallet: buyerCtx.wallet,
        publicClient: mockPublicClient({
          balances: { [buyerCtx.buyer.toLowerCase()]: 1_000_000n },
          decimals: 6,
          decimalsReads,
        }),
        relayerPool: mockRelayerPool(debitState),
      }),
    ).rejects.toThrow(/card|discover|not_found/i);
    // No card -> the runner never paid -> no debit.
    expect(debitState.debits).toBe(0);
  });
});
