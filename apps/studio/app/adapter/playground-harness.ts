// playground-harness.ts - the criterion-3 in-process pay-flow harness.
//
// The FixtureAdapter.runPlayground (and the LiveAdapter's autonomous fallback) reuse the
// FROZEN Phase-5 runTestEndpoint VERBATIM with an in-process facilitator (createApp +
// createInMemoryStores, built INSIDE runTestEndpoint) + a mock chain (decimals/balanceOf/
// usedNonce/receipt) + a relayer that COUNTS debits - exactly as apps/marketplace/test/
// test-endpoint.test.ts does. This proves prompt->live->discover->pay->creator-share in
// LOGIC: the buyer reads EVERY pay input ONLY from the served agent card, the gate reserves
// the cap BEFORE the handler runs (reserve-before-run, T-06-FREECOMPUTE), and EXACTLY ONE
// debit <= cap settles. The cap derives from a RUNTIME decimals() read (no 1e6 literal).
//
// The LIVE funded-wallet HTTPS half (liveTestEndpoint / RequiresFundedWalletError) stays
// OPERATOR-GATED and is never invoked here.
import { createWalletClient, http, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { arcTestnet } from "@utter/chain";
import { buildAgentCard } from "@utter/ai-runtime";
import { createCardApp, runTestEndpoint, type TestEndpointResult } from "@utter/marketplace";
import type { RelayerPool, RelayerSigner } from "@utter/facilitator/relayer";

/** The 70/30 split (SPEC §16): PLATFORM_FEE_BPS=3000 -> creatorBps = 10000 - 3000. */
export const BPS_DENOMINATOR = 10_000n;
export const PLATFORM_FEE_BPS = 3_000n;
export const CREATOR_BPS = BPS_DENOMINATOR - PLATFORM_FEE_BPS; // 7000

/** Counts on-chain debits the mock relayer submits (exactly one per settle). */
export interface DebitState {
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

/** A mock public client: funded buyer, no used nonces, instant receipts, runtime decimals(). */
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
      throw new Error(`playground-harness mock: unexpected functionName ${functionName}`);
    },
    async waitForTransactionReceipt() {
      return { status: "success" };
    },
  } as unknown as PublicClient;
}

/** Build a fresh buyer wallet client (signs the DebitAuthorization for the card-derived cap). */
function makeBuyer() {
  const account = privateKeyToAccount(generatePrivateKey());
  const wallet = createWalletClient({
    account,
    chain: arcTestnet,
    transport: http(arcTestnet.rpcUrls.default.http[0]),
  });
  return { account, buyer: account.address as Address, wallet };
}

/**
 * Build the finalized agent card for the fixture resource (the prompt->live product). The
 * card is the SOLE discovery source - the buyer reads escrow/pricing/payTo/cap/bond from
 * here only (MKT-04). Metered pricing with a positive cap; decimals are read at runtime.
 */
function buildLiveCard(resourceId: Hex): Record<string, unknown> {
  const base = buildAgentCard({
    prompt: "Return the current weather for a city",
    runtime: "node",
    pricing: { model: "metered", base: "5000", perKB: "100", max: "10000" },
  });
  return {
    ...base,
    x402: { ...(base.x402 as Record<string, unknown>), payTo: resourceId },
    identity: { standard: "erc-8004", chainId: 5042002, agentId: "77" },
    health: { verified: true, score: null },
    bond: { posted: true, amount: "2000000" },
  };
}

/** The harness result: the pay-flow result + the debit count + the derived 70/30 split. */
export interface PlaygroundHarnessResult {
  result: TestEndpointResult;
  debits: number;
  decimalsReads: number;
  creatorShare: bigint;
  treasuryShare: bigint;
}

/**
 * Run the criterion-3 pay-flow for a fixture resourceId through the in-process facilitator
 * + mock chain, reusing runTestEndpoint verbatim. Returns the result, the debit count, and
 * the 70/30 creator/treasury split derived from the settled amount. The buyer reads ONLY
 * the served card; exactly one debit <= cap settles; the cap is a runtime-decimals read.
 */
export async function runPlaygroundHarness(
  resourceId: string,
  requestBody?: unknown,
): Promise<PlaygroundHarnessResult> {
  const id = resourceId as Hex;
  const card = buildLiveCard(id);
  const cardApp = createCardApp({
    source: { async getCard(cid: string) { return cid === id ? card : null; } },
  });
  const debitState: DebitState = { debits: 0 };
  const decimalsReads = { count: 0 };
  const buyerCtx = makeBuyer();

  const result = await runTestEndpoint({
    resourceId: id,
    // DISCOVER: read the card ONLY (the SOLE pay-input source).
    cardFetcher: async (cid) => {
      const res = await cardApp.request(`/${cid}/.well-known/agent-card.json`, { method: "GET" });
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
    requestBody,
  });

  // CREATOR-SHARE: derive the 70/30 split over the SETTLED amount (the PaymentSplitter
  // enforces this on-chain; here we project it from the single debit the demo settled).
  const settled = result.debitAmount;
  const creatorShare = (settled * CREATOR_BPS) / BPS_DENOMINATOR;
  const treasuryShare = settled - creatorShare;

  return {
    result,
    debits: debitState.debits,
    decimalsReads: decimalsReads.count,
    creatorShare,
    treasuryShare,
  };
}
