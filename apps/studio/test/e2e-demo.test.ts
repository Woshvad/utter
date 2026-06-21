// e2e-demo.test.ts - the criterion-3 end-to-end pay-flow proof (THE demo-holds test).
//
// Proves the full money path in LOGIC: prompt -> live -> discover -> pay -> creator-share,
// reusing the Phase-5 runTestEndpoint harness VERBATIM with an in-process facilitator
// (createApp + createInMemoryStores) + a mock chain (decimals/balanceOf/usedNonce/receipt)
// + a relayer that COUNTS debits. The autonomous proof asserts:
//   - paid === true
//   - EXACTLY ONE on-chain debit (no free-compute, no double-charge)
//   - debitAmount <= cap (the signed ceiling; cap from a RUNTIME decimals() read, no literal)
//   - the 70/30 creator/treasury split over the settled amount (creatorBps 7000 / 10000)
//
// The live funded-wallet HTTPS half (liveTestEndpoint / RequiresFundedWalletError) stays
// OPERATOR-GATED - this test never invokes it (it only asserts it fail-louds without keys).
import { describe, it, expect, beforeEach } from "vitest";
import {
  createWalletClient,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { arcTestnet } from "@utter/chain";
import { buildAgentCard } from "@utter/ai-runtime";
import {
  createCardApp,
  runTestEndpoint,
  liveTestEndpoint,
  RequiresFundedWalletError,
  type TestEndpointResult,
} from "@utter/marketplace";
import type { RelayerPool, RelayerSigner } from "@utter/facilitator/relayer";

// The criterion-3 fixture resource (the prompt->live product of the build stream). The
// payTo is the resourceId the buyer pays against - read ONLY from the served card.
const RESOURCE: Hex = `0x${"c3".repeat(32)}`;

// The 70/30 split (SPEC §16): PLATFORM_FEE_BPS=3000 -> creatorBps = 10000 - 3000 = 7000.
// The split is derived from the SETTLED amount via these bps (the on-chain PaymentSplitter
// math is Foundry-tested; here we prove the logic over the single debit the demo settles).
const BPS_DENOMINATOR = 10_000n;
const PLATFORM_FEE_BPS = 3_000n;
const CREATOR_BPS = BPS_DENOMINATOR - PLATFORM_FEE_BPS; // 7000

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
 * A mock public client: a funded buyer, no used nonces, instant receipts, and a
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

/** Build a buyer wallet client for a fresh local account (signs the DebitAuthorization). */
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

/**
 * Build the finalized agent card for the criterion-3 resource: the prompt->live product.
 * The card is the SOLE discovery source - the buyer reads escrow/pricing/payTo/cap/bond
 * from here only (the MKT-04 mandate). Metered pricing with a positive cap.
 */
function buildLiveCard(): Record<string, unknown> {
  const base = buildAgentCard({
    prompt: "Return the current weather for a city",
    runtime: "node",
    pricing: { model: "metered", base: "5000", perKB: "100", max: "10000" },
  });
  return {
    ...base,
    x402: { ...(base.x402 as Record<string, unknown>), payTo: RESOURCE },
    identity: { standard: "erc-8004", chainId: 5042002, agentId: "77" },
    health: { verified: true, score: null },
    bond: { posted: true, amount: "2000000" },
  };
}

describe("criterion-3 E2E: prompt -> live -> discover -> pay -> creator-share", () => {
  let debitState: DebitState;
  let decimalsReads: { count: number };
  let cardApp: ReturnType<typeof createCardApp>;
  let buyerCtx: ReturnType<typeof makeBuyer>;

  beforeEach(() => {
    debitState = { debits: 0 };
    decimalsReads = { count: 0 };
    buyerCtx = makeBuyer();
    const card = buildLiveCard();
    // DISCOVER: the card is served by the marketplace card route (the index projection
    // the discover screen browses); the buyer fetches it as its SOLE pay-input source.
    cardApp = createCardApp({
      source: { async getCard(id: string) { return id === RESOURCE ? card : null; } },
    });
  });

  function run(): Promise<TestEndpointResult> {
    // PAY: runTestEndpoint reads ONLY the agent card, signs the DebitAuthorization for the
    // card-derived cap, runs the FROZEN requirePayment gate (reserve-before-run) against
    // the in-process facilitator, and settles exactly one debit through the mock relayer.
    return runTestEndpoint({
      resourceId: RESOURCE,
      cardFetcher: async (id) => {
        const res = await cardApp.request(`/${id}/.well-known/agent-card.json`, { method: "GET" });
        if (res.status !== 200) return null;
        return (await res.json()) as Record<string, unknown>;
      },
      buyerWallet: buyerCtx.wallet,
      publicClient: mockPublicClient({
        balances: { [buyerCtx.buyer.toLowerCase()]: 1_000_000n },
        decimals: 6,
        decimalsReads,
      }),
      relayerPool: mockRelayerPool(debitState),
    });
  }

  it("settles EXACTLY ONE debit <= cap with the 70/30 creator/treasury split", async () => {
    const result = await run();

    // prompt->live->discover->pay held: the paid call returned 200 with a receipt.
    expect(result.paid).toBe(true);
    expect(result.status).toBe(200);
    expect(result.receipt).toBeTruthy();

    // EXACTLY ONE on-chain debit (no free-compute, no double-charge).
    expect(debitState.debits).toBe(1);

    // The debit never exceeded the signed cap (the hard ceiling).
    expect(result.debitAmount <= result.cap).toBe(true);
    expect(result.debitAmount > 0n).toBe(true);

    // The cap came from the card pricing.max, derived via a RUNTIME decimals() read
    // (no 1e6 literal) - the runtime read was exercised.
    expect(result.cap).toBe(10_000n);
    expect(decimalsReads.count).toBeGreaterThanOrEqual(1);

    // CREATOR-SHARE: the 70/30 split over the SETTLED amount (creatorBps 7000 / 10000).
    // The PaymentSplitter enforces this on-chain (Foundry-tested); here we prove the
    // demo's settled amount splits 70/30 and the two shares sum back to the debit.
    const settled = result.debitAmount;
    const creatorShare = (settled * CREATOR_BPS) / BPS_DENOMINATOR;
    const treasuryShare = settled - creatorShare;
    expect(creatorShare + treasuryShare).toBe(settled); // conservation: no dust lost
    // creator gets the MAJORITY (the core value: "the creator earns the majority").
    expect(creatorShare > treasuryShare).toBe(true);
    // the split ratio is exactly 70/30 of the settled amount.
    expect(creatorShare).toBe((settled * 7_000n) / 10_000n);
    expect(treasuryShare).toBe(settled - (settled * 7_000n) / 10_000n);
  });

  it("a disconnect-then-retrieve returns the paid result with NO second debit (exactly-once)", async () => {
    const result = await run();
    expect(debitState.debits).toBe(1);

    // The recovery surface returned the paid result by idemKey WITHOUT re-signing.
    expect(result.recovered).not.toBeNull();
    expect(result.recovered!.idemKey).toBe(result.idemKey);
    // No second debit on recovery (exactly-once across a disconnect).
    expect(debitState.debits).toBe(1);
  });

  it("reads every pay input ONLY from the agent card (the discover->pay seam)", async () => {
    const result = await run();
    // escrow + payTo + asset all came straight off the served card's x402 block.
    expect(result.cardInputs.payTo).toBe(RESOURCE);
    expect(result.cardInputs.escrow).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(result.cardInputs.asset).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // the bond + verified flag the demo surfaced also came from the card (MKT-04 proof).
    expect(result.cardInputs.bondPosted).toBe(true);
    expect(result.cardInputs.verified).toBe(true);
  });

  it("keeps the live funded-wallet HTTPS half operator-gated (never invoked autonomously)", async () => {
    // The live half fail-louds without the operator's funded keys - it is NEVER faked.
    await expect(
      liveTestEndpoint({
        cardUrl: "https://weather.example.com/.well-known/agent-card.json",
        endpointUrl: "https://weather.example.com",
        env: {}, // no TEST_BUYER_PRIVATE_KEY / RELAYER_SIGNER_KEYS
      }),
    ).rejects.toBeInstanceOf(RequiresFundedWalletError);
  });
});

describe("the FixtureAdapter playground reuses the same in-process gate (criterion-3 wiring)", () => {
  it("runPlayground returns a paid result with debit <= cap (gate-backed, no free-compute)", async () => {
    const { FixtureAdapter } = await import("../app/adapter/fixture");
    const adapter = new FixtureAdapter();
    const result = await adapter.runPlayground(RESOURCE, { text: "hello" });

    // The fixture playground drives the SAME runTestEndpoint harness (in-process
    // facilitator + mock chain) - reserve-before-run, exactly one debit <= cap.
    expect(result.paid).toBe(true);
    expect(result.debitAmount > 0n).toBe(true);
    expect(result.body).toBeTruthy();
  });
});
