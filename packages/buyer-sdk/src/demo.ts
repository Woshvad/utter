// demo.ts - the self-contained in-process DEMO wiring for the buyer MCP bin.
//
// This is the runnable counterpart to the buyer-sdk tests: it builds the SAME fixture
// transport (a mock chain reader + a debit-counting mock relayer), an EPHEMERAL throwaway
// buyer wallet (generatePrivateKey - NEVER a real key), and a single built-in "echo"
// demo card. With these an AI agent (Claude Desktop / Cursor) can connect over stdio and
// exercise the FULL discover -> reserve -> handler -> settle pay loop ENTIRELY in-process
// against the mock chain: no on-chain money, no real network, no deployed resource.
//
// The pieces here are deliberately the proven test shapes (test/client.test.ts,
// test/transport.test.ts): the mock publicClient (decimals via a runtime read, a generous
// balanceOf, an instant success receipt) and the mock relayerPool (writeContract returns a
// fixed hash + counts debits). The demo card is a real validateAgentCard-valid A2A v0.3.0
// card carrying the Utter x402 block with escrow = PAYMENT_ESCROW and asset = USDC (the
// pinned constants discover.readCardInputs requires), so the existing pay loop accepts and
// pays it with no contrived hack.
//
// MONEY DISCIPLINE: every amount here is a base-unit bigint. There is NO 1e6 / 10**6
// decimals-scaling literal in any amount path - the precision witness is the mock
// decimals() read the pay loop performs at runtime (IN-01 / CHAIN-03). The pricing strings
// below are already denominated in base units (exactly as a served card carries them). The
// lone numeric width below (DEMO_DECIMALS) is the VALUE the mock decimals() read returns,
// not an amount-path literal - the tests pass `decimals: 6` the same way.
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
import { arcTestnet, PAYMENT_ESCROW, USDC } from "@utter/chain";
import { buildAgentCard } from "@utter/ai-runtime";
import type { RelayerPool, RelayerSigner } from "@utter/facilitator/relayer";

import { createFixtureTransport, type BuyerTransport } from "./transport.js";
import type { CardSource } from "./discover.js";
import type { BuyerWalletClient } from "./client.js";
import type { CardListSource, DiscoveredCard } from "./mcp/tools.js";

/**
 * The demo resource id (a well-formed bytes32). It is BOTH the marketplace resourceId the
 * MCP endpoint tool pays AND the card's x402.payTo the DebitAuthorization is signed over
 * (discover.readCardInputs requires payTo to be a bytes32). A fixed deterministic value so
 * the demo card and the demo card source agree.
 */
export const DEMO_RESOURCE_ID = `0x${"e7".repeat(32)}` as `0x${string}`;

/**
 * The token-decimals WIDTH the demo mock chain returns from its decimals() read. USDC is
 * the canonical 6-dp ERC-20 on Arc, so the demo mirrors that width to keep the cap basis
 * realistic. This is DATA the precision-witness read returns - the pay loop reads it and
 * scales the cap by it at runtime. It is NEVER multiplied into a money amount in this file
 * (no decimals literal in any amount path - IN-01); the tests likewise pass `decimals: 6`
 * as the mock read's return value.
 */
const DEMO_DECIMALS = 6;

/**
 * The demo pricing block, denominated in BASE UNITS (strings, exactly as a served card
 * carries them). `max` is the escrow cap the buyer signs against; the metered base/perKB
 * keep the settled debit strictly below the cap. NO decimals literal: these are raw
 * base-unit strings, and the runtime decimals() read happens inside the pay loop.
 */
const DEMO_PRICING = { model: "metered", base: "5000", perKB: "100", max: "10000" } as const;

/** The cap (escrow max) in base units - the on-chain hard bound surfaced to the MCP layer. */
const DEMO_CAP_BASE_UNITS = BigInt(DEMO_PRICING.max);

/** The demo's openapi.json (the echo request/response contract the inputSchema derives from). */
const DEMO_OPENAPI: Record<string, unknown> = {
  openapi: "3.1.0",
  info: { title: "echo", version: "1.0.0" },
  paths: {
    "/call": {
      post: {
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["text"],
                properties: { text: { type: "string" } },
                additionalProperties: false,
              },
            },
          },
        },
      },
    },
  },
};

/**
 * Build the demo's served A2A card (the SAME builder + finalization the tests use). It is
 * validateAgentCard-valid (flat v0.3.0) and carries the Utter x402 block with escrow =
 * PAYMENT_ESCROW + asset = USDC (the pinned constants), payTo = the demo resource id, and
 * a metered pricing block. Reputation/bond fields are set so the projection surfaces a
 * "verified" demo endpoint.
 */
function buildDemoServedCard(): Record<string, unknown> {
  const base = buildAgentCard({
    prompt: "Echo back the text you are given (in-process demo endpoint)",
    runtime: "node",
    pricing: { ...DEMO_PRICING },
  });
  return {
    ...base,
    // Finalize the deploy-time placeholders the builder emits: the payTo is the demo
    // resource id (a real bytes32), and the reputation/bond fields mark a verified demo.
    x402: { ...(base.x402 as Record<string, unknown>), payTo: DEMO_RESOURCE_ID },
    identity: { standard: "erc-8004", chainId: 5042002, agentId: "0" },
    health: { verified: true, score: null },
    bond: { posted: true, amount: "0" },
  };
}

/**
 * The demo's RAW-card source (resourceId -> served card JSON), injected into the buyer
 * client so client.pay() can discover + validate + pay the demo card. Returns the demo
 * card for the demo resource id and null for anything else (an unknown id is "not
 * discoverable", exactly as the live marketplace would behave).
 */
export function demoClientCardSource(): CardSource {
  const card = buildDemoServedCard();
  return async (resourceId: string) =>
    resourceId.toLowerCase() === DEMO_RESOURCE_ID.toLowerCase() ? card : null;
}

/**
 * The demo's MCP card source (CardListSource -> DiscoveredCard[]): the price + reputation
 * projection the discovery tool surfaces and the per-endpoint tool is built from. ONE
 * built-in echo card. Its resourceId/escrow/asset/payTo/pricing match the served card so
 * the endpoint tool's pay (which re-discovers via demoClientCardSource) lines up exactly.
 */
export function demoCardSource(): CardListSource {
  const card: DiscoveredCard = {
    resourceId: DEMO_RESOURCE_ID,
    name: "Echo (Utter demo)",
    escrow: PAYMENT_ESCROW,
    asset: USDC,
    payTo: DEMO_RESOURCE_ID,
    pricing: { ...DEMO_PRICING },
    capBaseUnits: DEMO_CAP_BASE_UNITS,
    verified: true,
    agentId: "0",
    bondPosted: true,
    openapi: DEMO_OPENAPI,
  };
  return async () => [card];
}

/** A debit counter the demo relayer increments per writeContract (one per settle). */
interface DemoDebitState {
  debits: number;
}

/**
 * The demo's mock relayer pool: writeContract counts the (single) settle debit and returns
 * a fixed tx hash. Mirrors test/client.test.ts mockRelayerPool. The signer's account is an
 * ephemeral throwaway (generatePrivateKey) - it never signs a real on-chain tx (the mock
 * writeContract does not broadcast).
 */
function demoRelayerPool(state: DemoDebitState): RelayerPool {
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
 * The demo's mock chain reader: a runtime decimals() read (the precision witness the pay
 * loop scales the cap by - NO 1e6/10**6 literal), a generously funded balanceOf for the
 * buyer, allowance/usedNonce stubs, and an instant success receipt. Mirrors
 * test/client.test.ts mockPublicClient. `decimals` is supplied at build time (the demo
 * passes DEMO_DECIMALS) and returned ONLY through the read - the amount paths never see a
 * literal.
 */
function demoPublicClient(opts: { buyer: string; decimals: number }): PublicClient {
  return {
    async readContract({
      functionName,
      args,
    }: {
      functionName: string;
      args?: readonly unknown[];
    }) {
      if (functionName === "decimals") return opts.decimals;
      if (functionName === "balanceOf") {
        // A generous funded balance so the deposit check (if exercised) always passes.
        const who = ((args?.[0] as string) ?? "").toLowerCase();
        return who === opts.buyer.toLowerCase() ? 1_000_000_000n : 0n;
      }
      if (functionName === "allowance") return 0n;
      if (functionName === "usedNonce") return false;
      throw new Error(`demoPublicClient: unexpected functionName ${functionName}`);
    },
    async waitForTransactionReceipt() {
      return { status: "success" };
    },
  } as unknown as PublicClient;
}

/**
 * Build an EPHEMERAL throwaway demo buyer wallet. A fresh private key is generated in
 * process (generatePrivateKey) and NEVER read from env or persisted - the demo signs the
 * in-process DebitAuthorization with a key that controls no real funds. The wallet is the
 * same viem WalletClient shape createBuyerClient expects (signTypedData via the account).
 *
 * SECURITY: the demo NEVER reads BUYER_PRIVATE_KEY. The generated key never leaves this
 * process and is never logged.
 */
export function createDemoBuyerWallet(): BuyerWalletClient {
  const account = privateKeyToAccount(generatePrivateKey());
  return createWalletClient({
    account,
    chain: arcTestnet,
    transport: http(arcTestnet.rpcUrls.default.http[0]),
  }) as WalletClient<Transport, Chain | undefined, Account>;
}

/**
 * Build the demo's fixture transport: the in-process facilitator (createFixtureTransport)
 * backed by the demo mock chain + demo debit-counting relayer. The `buyer` address scopes
 * the funded balanceOf; `decimals` is the runtime width the mock read returns.
 */
export function createDemoTransport(opts: { buyer: string; decimals: number }): BuyerTransport {
  return createFixtureTransport({
    publicClient: demoPublicClient({ buyer: opts.buyer, decimals: opts.decimals }),
    relayerPool: demoRelayerPool({ debits: 0 }),
  });
}

/** The fully-wired demo dependency bundle the bin (and the demo test) consume. */
export interface DemoWiring {
  /** The fixture transport (in-process facilitator + mock chain + debit-counting relayer). */
  transport: BuyerTransport;
  /** The ephemeral throwaway buyer wallet (a generated key controlling no real funds). */
  buyerWallet: BuyerWalletClient;
  /** The RAW-card source the buyer client discovers + pays through (resourceId -> card). */
  clientCardSource: CardSource;
  /** The MCP card source (price + reputation projection -> DiscoveredCard[]). */
  cardSource: CardListSource;
}

/**
 * Build the complete self-contained DEMO wiring: an ephemeral wallet, a fixture transport
 * (mock chain scoped to that wallet + a debit-counting relayer), the raw-card source the
 * client pays through, and the MCP card source the tools project. The `usdcDecimals` knob
 * (default DEMO_DECIMALS) is what the mock decimals() read returns - the pay loop scales
 * the cap by it at runtime.
 *
 * Everything is in-process: connecting the resulting MCP server to stdio lets an agent run
 * the real discover -> reserve -> handler -> settle loop (exactly-once, debit <= cap)
 * against the mock chain with NO real money, network, or deployed resource.
 */
export function createDemoWiring(opts: { usdcDecimals?: number } = {}): DemoWiring {
  const decimals = opts.usdcDecimals ?? DEMO_DECIMALS;
  const buyerWallet = createDemoBuyerWallet();
  const buyer = buyerWallet.account.address;
  const transport = createDemoTransport({ buyer, decimals });
  return {
    transport,
    buyerWallet,
    clientCardSource: demoClientCardSource(),
    cardSource: demoCardSource(),
  };
}
